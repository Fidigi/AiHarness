import type { ProviderDialect } from '../types/index.js';

/** Resolve discovery beside the configured API, never at the origin root.
 * Accept API bases or full request endpoints; reject URL credential/query state.
 */
export function resolveProviderDiscoveryEndpoint(dialect: ProviderDialect, baseUrl: string): string {
  if (!['openai-completions', 'openai-responses', 'mistral-conversations', 'anthropic', 'google'].includes(dialect)) throw new Error('Provider does not support connection discovery.');
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error('Invalid provider endpoint.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid provider endpoint.');
  }
  let pathname = url.pathname.replace(/\/+$/, '');
  if (dialect === 'openai-completions' || dialect === 'openai-responses' || dialect === 'mistral-conversations') {
    pathname = pathname.replace(/\/(?:chat\/completions|responses|models)$/, '');
    if (dialect === 'mistral-conversations' && !pathname.endsWith('/v1')) pathname += '/v1';
  } else if (dialect === 'anthropic') {
    pathname = pathname.replace(/\/(?:messages|models)$/, '');
    if (!pathname.endsWith('/v1')) pathname += '/v1';
  } else {
    pathname = pathname.replace(/\/models(?:\/[^/]+(?::(?:generateContent|streamGenerateContent))?)?$/, '');
  }
  url.pathname = `${pathname}/models`;
  return url.toString();
}
