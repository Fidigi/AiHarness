/** Value-free signal from a recognized provider error, never arbitrary error prose. */
export class ProviderContextOverflowError extends Error {
  constructor() {
    super('The provider context window was exceeded.');
    this.name = 'ProviderContextOverflowError';
  }
}

/** Read only bounded failed HTTP bodies; never reflect them into diagnostics. */
export async function rejectProviderHttpResponse(response: Response, message: string): Promise<never> {
  let body = '';
  try {
    if (response.status === 400 || response.status === 413) {
      const reader = response.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder(); let bytes = 0;
        try {
          for (;;) {
            const item = await reader.read(); if (item.done) break;
            bytes += item.value.byteLength;
            if (bytes > 64 * 1024) break;
            body += decoder.decode(item.value, { stream: true });
          }
          if (bytes > 64 * 1024) body = '';
          else body += decoder.decode();
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      }
      if (body) {
        const value = JSON.parse(body) as { error?: { code?: unknown; type?: unknown; message?: unknown } };
        const error = value?.error;
        if (['context_length_exceeded', 'context_window_exceeded', 'prompt_too_long', 'max_context_length'].some(code => error?.code === code || error?.type === code)
          || (error?.type === 'invalid_request_error' && typeof error.message === 'string' && /^prompt is too long:/u.test(error.message))) {
          throw new ProviderContextOverflowError();
        }
      }
    }
  } catch (error) { if (error instanceof ProviderContextOverflowError) throw error; }
  void response.body?.cancel().catch(() => undefined);
  throw new Error(message);
}
