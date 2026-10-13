import { randomUUID } from 'node:crypto';
import type {
  ExtensionInteractionPromise,
  ExtensionInteractionRequest,
  ExtensionInteractionResponse,
  ExtensionInteractionUpdate,
  ExtensionLogLevel,
  ExtensionRuntimeUI,
} from '@ai-harness/core';

const MAX_REQUESTS = 16;
const MAX_RECORD_BYTES = 128_000;
const MAX_STATE_BYTES = 512_000;
const MAX_PRESENTATION_KEYS = 100;
const MAX_PENDING_DELIVERIES = 256;
const CAPABILITIES = Object.freeze({
  dialogs: Object.freeze(['select', 'confirm', 'input', 'editor'] as const),
  presentation: Object.freeze(['setStatus', 'setWidget', 'setTitle', 'setEditorText'] as const),
  custom: false as const,
  terminal: false as const,
});

interface PendingInteraction {
  request: ExtensionInteractionRequest;
  record: Record<string, unknown>;
  resolve(response: ExtensionInteractionResponse): void;
  signal?: AbortSignal;
  timer?: NodeJS.Timeout;
  abort?: () => void;
}

/** Bounded, process-local RPC UI state. Replay is explicit and never re-admits requests. */
export class RpcExtensionUiBridge {
  private readonly pending = new Map<string, PendingInteraction>();
  private readonly presentation = new Map<string, Record<string, unknown>>();
  private closed = false;
  private deliveries = 0;
  readonly ui: ExtensionRuntimeUI;

  constructor(
    private readonly emit: (record: Record<string, unknown>) => void | Promise<void>,
    private readonly redactText: (value: string) => string = value => value,
    private readonly redactJson: <T>(value: T) => T = value => value,
  ) {
    this.ui = Object.freeze({
      mode: 'rpc' as const,
      capabilities: CAPABILITIES,
      setStatus: (key: string, text?: string) => this.setPresentation('setStatus', key, text),
      setWidget: (key: string, lines?: readonly string[]) => this.setPresentation('setWidget', key, lines),
      setTitle: (text?: string) => this.setPresentation('setTitle', '', text),
      setEditorText: (text?: string) => this.setPresentation('setEditorText', '', text),
    });
  }

  request(request: ExtensionInteractionRequest): ExtensionInteractionPromise {
    const signal = request.signal;
    if (this.closed || request.kind === 'custom' || signal?.aborted) return Promise.resolve({ cancelled: true });
    if (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs)
      || request.timeoutMs < 1 || request.timeoutMs > 2_147_483_647)) {
      return Promise.reject(new Error('Extension UI timeoutMs must be an integer from 1 to 2147483647.'));
    }
    const id = randomUUID();
    const timeoutMs = request.timeoutMs;
    // AbortSignal is host authority, not JSON. Never pass it through a redactor/clone.
    const normalized = this.normalize(request);
    const record = this.record(id, normalized, timeoutMs);
    if (this.pending.size >= MAX_REQUESTS) throw new Error('Extension UI queue is full.');
    this.checkState(record, undefined, normalized);
    let settle!: (response: ExtensionInteractionResponse) => void;
    const promise: ExtensionInteractionPromise = new Promise(resolve => { settle = resolve; });
    const pending: PendingInteraction = { request: normalized, record, signal, resolve: settle };
    this.pending.set(id, pending);
    Object.defineProperties(promise, {
      id: { value: id, enumerable: true },
      update: { value: (replacement: ExtensionInteractionUpdate): boolean => {
        if (!this.pending.has(id) || this.closed) return false;
        const next = this.normalize(replacement);
        const nextRecord = this.record(id, next, timeoutMs);
        this.checkState(nextRecord, id, next);
        pending.request = next;
        pending.record = nextRecord;
        this.deliver(nextRecord, () => this.finish(id, { cancelled: true }, 'delivery-failed'));
        return true;
      } },
      close: { value: (): boolean => this.finish(id, { cancelled: true }, 'closed') },
    });
    if (timeoutMs !== undefined) {
      pending.timer = setTimeout(() => this.finish(id, pending.request.kind === 'confirm'
        ? { cancelled: false, value: false } : { cancelled: true }, 'timeout'), timeoutMs);
      pending.timer.unref();
    }
    if (signal) {
      pending.abort = () => { this.finish(id, { cancelled: true }, 'aborted'); };
      signal.addEventListener('abort', pending.abort, { once: true });
      if (signal.aborted) pending.abort();
    }
    if (this.pending.has(id)) this.deliver(record, () => this.finish(id, { cancelled: true }, 'delivery-failed'));
    return promise;
  }

  notify(message: string, level: ExtensionLogLevel = 'info'): void {
    if (this.closed) return;
    this.checkText(message);
    const record = {
      type: 'extension_ui_request', id: randomUUID(), method: 'notify',
      message: this.redactText(message), notifyType: level === 'success' ? 'info' : level,
    };
    this.checkRecord(record);
    this.deliver(record);
  }

  /** Detached copies; notifications are intentionally not replayed. */
  snapshot(): Record<string, unknown> {
    return JSON.parse(JSON.stringify({
      version: 1, mode: 'rpc', capabilities: CAPABILITIES, closed: this.closed,
      requests: [...this.pending.values()].map(value => value.record),
      presentation: [...this.presentation.values()],
    })) as Record<string, unknown>;
  }

  handleResponse(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const response = value as Record<string, unknown>;
    if (response.type !== 'extension_ui_response') return false;
    // Malformed UI replies never fall through into commands or settle a live dialog.
    if (typeof response.id !== 'string' || response.id.length > 256) return true;
    const pending = this.pending.get(response.id);
    if (!pending) return true;
    if (Object.keys(response).some(key => !['type', 'id', 'cancelled', 'confirmed', 'value'].includes(key))) return true;
    if (response.cancelled !== undefined && typeof response.cancelled !== 'boolean') return true;
    if (response.cancelled === true) {
      this.finish(response.id, { cancelled: true });
    } else if (pending.request.kind === 'confirm') {
      if (typeof response.confirmed !== 'boolean' || response.value !== undefined) return true;
      this.finish(response.id, { cancelled: false, value: response.confirmed });
    } else {
      if (typeof response.value !== 'string' || response.confirmed !== undefined) return true;
      if (Buffer.byteLength(response.value) > MAX_RECORD_BYTES) return true;
      const selected = this.redactText(response.value);
      if (pending.request.kind === 'select') {
        const option = pending.request.options?.find(candidate => candidate.label === selected || candidate.value === selected);
        if (!option) return true;
        this.finish(response.id, { cancelled: false, value: option.value });
      } else this.finish(response.id, { cancelled: false, value: selected });
    }
    return true;
  }

  cancelPending(reason = 'aborted'): void {
    for (const id of [...this.pending.keys()]) this.finish(id, { cancelled: true }, reason);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelPending('shutdown');
    this.presentation.clear();
  }

  private normalize(request: ExtensionInteractionUpdate): ExtensionInteractionRequest {
    if (!['select', 'confirm', 'input', 'editor'].includes(request.kind)) throw new Error('Unsupported RPC UI dialog.');
    this.checkText(request.title);
    for (const text of [request.message, request.placeholder, request.output]) if (text !== undefined) this.checkText(text);
    if (request.options !== undefined) {
      if (!Array.isArray(request.options) || request.options.length > 100) throw new Error('Invalid RPC UI options.');
      for (const option of request.options) { this.checkText(option.label); this.checkText(option.value); }
    }
    const safe = this.redactJson({
      kind: request.kind, title: request.title,
      message: request.message, placeholder: request.placeholder, output: request.output,
      options: request.options?.map(option => ({ label: option.label, value: option.value })),
    });
    this.checkRecord(safe);
    return JSON.parse(JSON.stringify(safe)) as ExtensionInteractionRequest;
  }

  private record(id: string, request: ExtensionInteractionRequest, timeout?: number): Record<string, unknown> {
    const record: Record<string, unknown> = {
      type: 'extension_ui_request', id, method: request.kind, title: request.title,
      ...(timeout === undefined ? {} : { timeout }),
    };
    if (request.kind === 'confirm') record.message = request.message ?? '';
    if (request.kind === 'select') record.options = (request.options ?? []).map(option => option.label);
    if (request.kind === 'input') record.placeholder = request.placeholder;
    if (request.kind === 'editor') record.prefill = request.output ?? request.message ?? '';
    this.checkRecord(record);
    return record;
  }

  private setPresentation(method: string, key: string, value?: string | readonly string[]): void {
    if (this.closed) return;
    if (typeof key !== 'string' || Buffer.byteLength(key) > 256) throw new Error('Invalid RPC UI key.');
    if (Array.isArray(value)) {
      if (value.length > 100) throw new Error('Invalid RPC UI widget.');
      for (const line of value) this.checkText(line);
    } else if (value !== undefined) this.checkText(value);
    const safeKey = this.redactText(key);
    const record = this.redactJson({
      type: 'extension_ui_request', id: randomUUID(), method, key: safeKey,
      ...(value === undefined ? { cleared: true } : { value }),
    });
    const stateKey = `${method}:${safeKey}`;
    if (value !== undefined && !this.presentation.has(stateKey) && this.presentation.size >= MAX_PRESENTATION_KEYS) {
      throw new Error('Extension UI presentation is full.');
    }
    this.checkRecord(record);
    this.checkState(record, stateKey);
    if (value === undefined) this.presentation.delete(stateKey);
    else this.presentation.set(stateKey, JSON.parse(JSON.stringify(record)) as Record<string, unknown>);
    this.deliver(record);
  }

  private checkText(value: unknown): asserts value is string {
    if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_RECORD_BYTES) throw new Error('Invalid RPC UI text.');
  }

  private checkRecord(value: unknown): number {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > MAX_RECORD_BYTES) throw new Error('RPC UI record is too large.');
    return bytes;
  }

  private checkState(record: Record<string, unknown>, replacing?: string, request?: ExtensionInteractionRequest): void {
    let bytes = this.checkRecord(record) + (request ? this.checkRecord(request) : 0);
    for (const [id, value] of this.pending) if (id !== replacing) bytes += this.checkRecord(value.record) + this.checkRecord(value.request);
    for (const [key, value] of this.presentation) if (key !== replacing) bytes += this.checkRecord(value);
    if (bytes > MAX_STATE_BYTES) throw new Error('Extension UI state is full.');
  }

  private deliver(record: Record<string, unknown>, failed: () => void = () => undefined): void {
    if (this.deliveries >= MAX_PENDING_DELIVERIES) { failed(); return; }
    this.deliveries++;
    try {
      const copy = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
      void Promise.resolve(this.emit(copy)).then(
        () => { this.deliveries--; },
        () => { this.deliveries--; failed(); },
      );
    } catch { this.deliveries--; failed(); }
  }

  private finish(id: string, response: ExtensionInteractionResponse, reason?: string): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.abort) pending.signal?.removeEventListener('abort', pending.abort);
    pending.resolve(response);
    if (reason) this.deliver({ type: 'extension_ui_closed', id, reason });
    return true;
  }
}
