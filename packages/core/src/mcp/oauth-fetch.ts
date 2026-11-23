import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { boundedMcpFetch } from './server-test.js';

function linkSignals(primary: AbortSignal, secondary?: AbortSignal): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const abort = (signal: AbortSignal) => controller.abort(signal.reason);
  const onPrimary = () => abort(primary);
  const onSecondary = () => { if (secondary) abort(secondary); };
  if (primary.aborted) abort(primary);
  else primary.addEventListener('abort', onPrimary, { once: true });
  if (secondary?.aborted) abort(secondary);
  else secondary?.addEventListener('abort', onSecondary, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      primary.removeEventListener('abort', onPrimary);
      secondary?.removeEventListener('abort', onSecondary);
    },
  };
}

/** Bound SDK OAuth discovery/exchange/refresh even when the SDK omits a request signal. */
export function boundedMcpOAuthFetch(
  signal: AbortSignal,
  timeoutMs: number,
  notificationUrl?: string,
): FetchLike {
  return async (input, init) => {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort('mcp-oauth-request-timeout'), timeoutMs);
    timer.unref?.();
    const first = linkSignals(signal, init?.signal ?? undefined);
    const linked = linkSignals(first.signal, timeout.signal);
    const dispose = () => {
      clearTimeout(timer);
      linked.dispose();
      first.dispose();
    };
    try {
      const response = await boundedMcpFetch(input, { ...init, signal: linked.signal });
      if (!response.body) {
        dispose();
        return response;
      }
      // A persistent MCP notification stream is not a finite OAuth JSON response.
      // Keep connection/caller cancellation linked without imposing a wall-clock lifetime.
      const requestUrl = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (notificationUrl === requestUrl && method.toUpperCase() === 'GET'
        && response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'text/event-stream') {
        clearTimeout(timer);
      }
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const item = await reader.read();
            if (item.done) {
              dispose();
              controller.close();
            } else controller.enqueue(item.value);
          } catch (error) {
            dispose();
            controller.error(error);
          }
        },
        async cancel(reason) {
          try { await reader.cancel(reason); }
          finally { dispose(); }
        },
      });
      // Finite OAuth response bodies remain deadline- and cancellation-bound after headers.
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      dispose();
      throw error;
    }
  };
}
