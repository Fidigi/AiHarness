import type { ProviderDialect } from '../types/index.js';

/** Resolve discovery beside the configured API, never at the origin root.
 * Accept API bases or full request endpoints; reject URL credential/query state.
 */
export function resolveProviderDiscoveryEndpoint(dialect: ProviderDialect, baseUrl: string): string {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error('Invalid provider endpoint.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid provider endpoint.');
  }
  let pathname = url.pathname.replace(/\/+$/, '');
  if (dialect === 'openai-completions' || dialect === 'openai-responses') {
    pathname = pathname.replace(/\/(?:chat\/completions|responses|models)$/, '');
  } else if (dialect === 'anthropic') {
    pathname = pathname.replace(/\/(?:messages|models)$/, '');
    if (!pathname.endsWith('/v1')) pathname += '/v1';
  } else {
    pathname = pathname.replace(/\/models(?:\/[^/]+(?::(?:generateContent|streamGenerateContent))?)?$/, '');
  }
  url.pathname = `${pathname}/models`;
  return url.toString();
}
