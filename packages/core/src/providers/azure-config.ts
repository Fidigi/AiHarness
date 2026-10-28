import type { ProviderConfig } from '../types/index.js';

function invalid(): never { throw new Error('Invalid Azure Responses configuration.'); }

/** Native versioned Azure endpoints opt into Responses; unversioned legacy endpoints do not. */
export function usesAzureResponses(config: ProviderConfig): boolean {
  if (config.azureApi !== undefined && !['responses', 'completions', 'native'].includes(config.azureApi)) {
    throw new Error('Invalid Azure API selection.');
  }
  if (config.azureApi !== undefined) return config.azureApi === 'responses';
  try { return /\/openai\/v1(?:\/responses)?\/?$/u.test(new URL(String(config.baseUrl)).pathname); }
  catch { return false; }
}

export function normalizeAzureResponsesBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2_000 || /[\u0000-\u001f\u007f]/u.test(value)) invalid();
  let url: URL;
  try { url = new URL(value); } catch { return invalid(); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || /\/deployments(?:\/|$)/u.test(url.pathname)) invalid();
  let path = url.pathname.replace(/\/+$/, '');
  if (!path || path === '/openai') path = '/openai/v1';
  else path = path.replace(/\/responses$/, '');
  url.pathname = path;
  return url.toString().replace(/\/$/, '');
}

/** Shared explicit deployment selection, not credential or model discovery. */
export function azureDeployments(config: ProviderConfig): ReadonlyMap<string, string> {
  if (config.apiVersion !== undefined) azureIdentifier(config.apiVersion);
  if (config.deployment !== undefined) azureIdentifier(config.deployment);
  const map = config.azureDeploymentMap;
  if (map !== undefined && (!map || typeof map !== 'object' || Array.isArray(map) || Object.keys(map).length > 256)) invalid();
  return new Map(Object.entries(map ?? {}).map(([model, deployment]) => [azureIdentifier(model), azureIdentifier(deployment)]));
}

export function azureIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500 || /[\u0000-\u001f\u007f]/u.test(value)) invalid();
  return value.trim();
}

/** Shared CLI/Server environment composition; no ambient environment or token files are read. */
export function azureEnvironmentConfig(
  env: Readonly<Record<string, string | undefined>>,
  apiKey = env.AZURE_OPENAI_API_KEY,
): ProviderConfig | undefined {
  if (!apiKey) return undefined;
  const responses = Boolean(env.AZURE_OPENAI_BASE_URL || env.AZURE_OPENAI_RESOURCE_NAME)
    || usesAzureResponses({ type: 'azure', baseUrl: env.AZURE_OPENAI_ENDPOINT });
  let baseUrl = env.AZURE_OPENAI_BASE_URL || env.AZURE_OPENAI_ENDPOINT;
  if (!env.AZURE_OPENAI_BASE_URL && env.AZURE_OPENAI_RESOURCE_NAME) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/u.test(env.AZURE_OPENAI_RESOURCE_NAME)) invalid();
    baseUrl = `https://${env.AZURE_OPENAI_RESOURCE_NAME}.openai.azure.com/openai/v1`;
  }
  if (!baseUrl) return undefined;
  const deploymentMap: Record<string, string> = Object.create(null) as Record<string, string>;
  const mapping = env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP;
  if (responses && mapping) {
    if (mapping.length > 64 * 1024) invalid();
    const entries = mapping.split(',').filter(entry => entry.trim());
    if (entries.length > 256) invalid();
    for (const entry of entries) {
      const parts = entry.split('=');
      if (parts.length !== 2) invalid();
      const id = azureIdentifier(parts[0]);
      if (Object.hasOwn(deploymentMap, id)) invalid();
      deploymentMap[id] = azureIdentifier(parts[1]);
    }
  }
  return {
    type: 'azure', apiKey,
    baseUrl: responses ? normalizeAzureResponsesBaseUrl(baseUrl) : baseUrl,
    ...(responses ? { azureApi: 'native' as const, azureDeploymentMap: deploymentMap } : {}),
    ...(env.AZURE_OPENAI_DEPLOYMENT ? { deployment: env.AZURE_OPENAI_DEPLOYMENT } : {}),
    model: env.AZURE_OPENAI_MODEL || env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o',
    ...(env.AZURE_OPENAI_API_VERSION ? { apiVersion: env.AZURE_OPENAI_API_VERSION } : {}),
  };
}
