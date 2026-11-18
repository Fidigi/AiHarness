import { expect, it, vi } from 'vitest';
import { ProviderContextOverflowError, rejectProviderHttpResponse } from './context-overflow.js';

it.each(['context_length_exceeded', 'context_window_exceeded', 'prompt_too_long', 'max_context_length'])('recognizes structured %s without reflecting provider diagnostics', async code => {
  const result = rejectProviderHttpResponse(new Response(JSON.stringify({ error: { code, message: 'disposable-private-body' } }), { status: 400 }), 'Safe refusal');
  await expect(result).rejects.toBeInstanceOf(ProviderContextOverflowError);
  await expect(result).rejects.toThrow('The provider context window was exceeded.');
});
it('recognizes only the bounded Anthropic invalid-request prefix, not arbitrary overflow prose', async () => {
  await expect(rejectProviderHttpResponse(new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'prompt is too long: private-body' } }), { status: 413 }), 'Safe refusal'))
    .rejects.toBeInstanceOf(ProviderContextOverflowError);
  await expect(rejectProviderHttpResponse(new Response('{"error":{"message":"context_length_exceeded private-body"}}', { status: 400 }), 'Safe refusal')).rejects.toThrow('Safe refusal');
});
it.each([401, 500, 'oversize'])('cancels %s bodies and never turns auth/transient/oversized content into context recovery', async status => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(65_537))); }, cancel });
  await expect(rejectProviderHttpResponse(new Response(body, { status: typeof status === 'number' ? status : 400 }), 'Safe refusal')).rejects.toThrow('Safe refusal');
  expect(cancel).toHaveBeenCalledOnce();
});
