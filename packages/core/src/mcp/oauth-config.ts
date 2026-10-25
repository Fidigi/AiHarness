import type { McpHttpRuntimeConfig } from './config-inventory.js';

export interface McpOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  scope?: string;
  clientName?: string;
  callbackPort?: number;
  callbackUrl?: string;
  authServerMetadataUrl?: string;
  /** CIMD uses an operator-owned document, never Pi's public client identity. */
  clientRegistration?: 'dynamic' | 'cimd';
  clientMetadataUrl?: string;
}

export function safeOAuthUrl(value: string, loopbackOnly = false): boolean {
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return !url.username && !url.password && !url.hash && !url.search
      && (loopbackOnly ? url.protocol === 'http:' && loopback
        : url.protocol === 'https:' || (url.protocol === 'http:' && loopback));
  } catch { return false; }
}

export function validMcpOAuthConfig(value: unknown): value is McpOAuthConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  const strings = ['clientId', 'clientSecret', 'scope', 'clientName', 'callbackUrl', 'authServerMetadataUrl', 'clientMetadataUrl'];
  if (Object.keys(config).some(key => ![...strings, 'scopes', 'callbackPort', 'clientRegistration'].includes(key))) return false;
  if (strings.some(key => config[key] !== undefined && (typeof config[key] !== 'string'
    || !(config[key] as string).trim() || Buffer.byteLength(config[key] as string) > 16 * 1024
    || /[\u0000-\u001f\u007f]/u.test(config[key] as string)))) return false;
  if (config.scopes !== undefined && (!Array.isArray(config.scopes) || config.scopes.length > 128
    || config.scopes.some(scope => typeof scope !== 'string' || !scope.trim()
      || Buffer.byteLength(scope) > 16 * 1024 || /[\u0000-\u001f\u007f]/u.test(scope)))) return false;
  if (config.scope !== undefined && config.scopes !== undefined) return false;
  if (config.callbackPort !== undefined && (!Number.isSafeInteger(config.callbackPort)
    || (config.callbackPort as number) < 1 || (config.callbackPort as number) > 65_535)) return false;
  if (config.callbackUrl !== undefined) {
    if (!safeOAuthUrl(config.callbackUrl as string, true)) return false;
    const port = new URL(config.callbackUrl as string).port;
    if (port && config.callbackPort !== undefined && Number(port) !== config.callbackPort) return false;
  }
  if (config.authServerMetadataUrl !== undefined && !safeOAuthUrl(config.authServerMetadataUrl as string)) return false;
  if (config.clientRegistration !== undefined && !['dynamic', 'cimd'].includes(config.clientRegistration as string)) return false;
  if (config.clientRegistration === 'cimd') {
    if (config.clientId !== undefined || config.clientSecret !== undefined || config.clientName !== undefined
      || typeof config.clientMetadataUrl !== 'string' || !safeOAuthUrl(config.clientMetadataUrl)
      || !config.clientMetadataUrl.startsWith('https:') || new URL(config.clientMetadataUrl).pathname === '/') return false;
  } else if (config.clientMetadataUrl !== undefined) return false;
  return true;
}

export function mcpOAuthScopes(config: McpHttpRuntimeConfig['oauth']): string[] | undefined {
  return config?.scopes ? [...config.scopes] : config?.scope?.split(/\s+/u).filter(Boolean);
}
