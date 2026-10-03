import { randomUUID } from 'node:crypto';
import type {
  ExtensionInteractionRequest,
  ExtensionInteractionResponse,
  ExtensionLogLevel,
} from '@ai-harness/core';

interface PendingInteraction {
  request: ExtensionInteractionRequest;
  resolve(response: ExtensionInteractionResponse): void;
  timer?: NodeJS.Timeout;
  abort?: () => void;
}

/** Bridge Core's declarative extension interactions onto Pi's RPC UI subprotocol. */
export class RpcExtensionUiBridge {
  private readonly pending = new Map<string, PendingInteraction>();

  constructor(private readonly emit: (record: Record<string, unknown>) => void | Promise<void>) {}

  request(request: ExtensionInteractionRequest): Promise<ExtensionInteractionResponse> {
    if (request.kind === 'custom' || request.signal?.aborted) return Promise.resolve({ cancelled: true });
    if (request.timeoutMs !== undefined
      && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1)) {
      return Promise.reject(new Error('Extension UI timeoutMs must be a positive safe integer.'));
    }
    const id = randomUUID();
    const method = request.kind;
    const record: Record<string, unknown> = {
      type: 'extension_ui_request',
      id,
      method,
      title: request.title,
      ...(request.timeoutMs === undefined ? {} : { timeout: request.timeoutMs }),
    };
    if (method === 'confirm') record.message = request.message ?? '';
    if (method === 'select') record.options = (request.options ?? []).map(option => option.label);
    if (method === 'input') record.placeholder = request.placeholder;
    if (method === 'editor') record.prefill = request.output ?? request.message ?? '';

    return new Promise(resolve => {
      const pending: PendingInteraction = { request, resolve };
      if (request.timeoutMs !== undefined) {
        pending.timer = setTimeout(() => {
          this.finish(id, request.kind === 'confirm'
            ? { cancelled: false, value: false }
            : { cancelled: true });
        }, request.timeoutMs);
        pending.timer.unref();
      }
      this.pending.set(id, pending);
      if (request.signal) {
        pending.abort = () => this.finish(id, { cancelled: true });
        if (request.signal.aborted) pending.abort();
        else request.signal.addEventListener('abort', pending.abort, { once: true });
      }
      if (this.pending.has(id)) {
        try {
          void Promise.resolve(this.emit(record)).catch(() => this.finish(id, { cancelled: true }));
        } catch {
          this.finish(id, { cancelled: true });
        }
      }
    });
  }

  notify(message: string, level: ExtensionLogLevel = 'info'): void {
    try {
      void Promise.resolve(this.emit({
        type: 'extension_ui_request',
        id: randomUUID(),
        method: 'notify',
        message,
        notifyType: level === 'success' ? 'info' : level,
      })).catch(() => undefined);
    } catch {
      // Notifications are fire-and-forget.
    }
  }

  handleResponse(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const response = value as Record<string, unknown>;
    if (response.type !== 'extension_ui_response' || typeof response.id !== 'string') return false;
    const pending = this.pending.get(response.id);
    if (!pending) return true;
    if (response.cancelled === true) {
      this.finish(response.id, { cancelled: true });
      return true;
    }
    if (pending.request.kind === 'confirm') {
      this.finish(response.id, { cancelled: false, value: response.confirmed === true });
      return true;
    }
    if (pending.request.kind === 'select') {
      const selected = typeof response.value === 'string' ? response.value : undefined;
      const option = pending.request.options?.find(candidate => candidate.label === selected || candidate.value === selected);
      this.finish(response.id, option ? { cancelled: false, value: option.value } : { cancelled: true });
      return true;
    }
    this.finish(response.id, typeof response.value === 'string'
      ? { cancelled: false, value: response.value }
      : { cancelled: true });
    return true;
  }

  close(): void {
    for (const id of [...this.pending.keys()]) this.finish(id, { cancelled: true });
  }

  private finish(id: string, response: ExtensionInteractionResponse): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.abort) pending.request.signal?.removeEventListener('abort', pending.abort);
    pending.resolve(response);
  }
}
