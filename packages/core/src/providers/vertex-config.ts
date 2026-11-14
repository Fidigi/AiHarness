import type { ProviderConfig } from '../types/index.js';

/** Pinned Vertex API-key collection root; legacy Bearer bases retain their prior resource path. */
export function vertexApiKeyBase(value?: string): string {
  try {
    const url = new URL(value ?? 'https://aiplatform.googleapis.com');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    const base = url.href.replace(/\/+$/u, '');
    if (url.pathname.replace(/\/+$/u, '').endsWith('/publishers/google')) return base;
    const versioned = url.pathname.split('/').some(part => /^v\d+(?:beta\d*)?$/.test(part));
    return base + (versioned ? '' : '/v1') + '/publishers/google';
  } catch { throw new Error('Invalid Vertex API-key endpoint.'); }
}

/** Trusted host configuration; existing access-token consumers retain Bearer priority. */
export function vertexEnvironmentConfig(env: NodeJS.ProcessEnv, credential?: string): ProviderConfig | undefined {
  const apiKey = credential ?? (env.GOOGLE_VERTEX_ACCESS_TOKEN || env.GOOGLE_CLOUD_API_KEY);
  if (!apiKey) return undefined;
  const vertexAuthMode = env.GOOGLE_VERTEX_ACCESS_TOKEN || !env.GOOGLE_CLOUD_API_KEY ? 'bearer' : 'api-key';
  const project = env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT;
  if (vertexAuthMode === 'bearer' && !project && !env.VERTEX_BASE_URL) return undefined;
  return { type: 'vertex', apiKey, vertexAuthMode, project, location: env.GOOGLE_CLOUD_LOCATION,
    baseUrl: env.VERTEX_BASE_URL, model: env.VERTEX_MODEL };
}
