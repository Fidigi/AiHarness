import type {
  McpConfigInventory,
  McpConfigScope,
  McpExposure,
  McpImportFieldValue,
  McpImportPreview,
  McpImportSyntax,
  McpImportWriteConfirmations,
  McpOAuthFlowInfo,
  McpOAuthStatus,
  McpServerMutationOutcome,
  McpServerTestResult,
} from '@ai-harness/core';
import { apiFetch } from './api';

export const MCP_ACTION_TIMEOUT_MS = 15_000;
export const MCP_TEST_CLIENT_TIMEOUT_MS = 25_000;
export const MCP_OAUTH_CLIENT_TIMEOUT_MS = 15_000;

export interface McpMutationResponse {
  inventory: McpConfigInventory;
  outcomes?: McpServerMutationOutcome[];
  undo?: { token: string; expiresAt: string };
  added?: { scope: McpConfigScope; name: string };
  updated?: { scope: McpConfigScope; previousName: string; name: string };
}

export interface McpReplaceTarget {
  scope: McpConfigScope;
  name: string;
  revision: string;
}

export interface McpImportPreviewRequest {
  text: string;
  syntax: McpImportSyntax;
  cwd?: string;
  replacement?: McpReplaceTarget;
}

export interface McpImportWriteRequest {
  scope: McpConfigScope;
  cwd?: string;
  revision: string | null;
  text: string;
  syntax: McpImportSyntax;
  entryIndex: number;
  name?: string;
  values?: Record<string, McpImportFieldValue>;
  secretReferences?: Record<string, string>;
  confirmations?: McpImportWriteConfirmations;
  /** Explicitly trust a fresh project as part of this first write. */
  trustProject?: true;
}

export interface McpReplaceWriteRequest extends Omit<McpImportWriteRequest, 'trustProject'> {
  targetName: string;
}

export interface McpTestResponse {
  scope: McpConfigScope;
  name: string;
  configKey: string;
  result: McpServerTestResult;
}

export interface McpTestRequestResponse {
  success: boolean;
  data?: McpTestResponse;
  error?: string;
  code?: string;
}

export interface McpActionResponse {
  success: boolean;
  data?: McpMutationResponse;
  error?: string;
  code?: string;
  /** True means the server may have committed before the client observed failure. */
  uncertain?: boolean;
  /** The first project write failed and its exact trust allow could not be removed. */
  trustKept?: boolean;
}

export interface McpOAuthStatusEntry extends McpOAuthStatus {
  scope: McpConfigScope;
  name: string;
  configKey: string;
}

export interface McpOAuthResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
}

export async function previewMcpImport(
  request: McpImportPreviewRequest,
  signal?: AbortSignal,
): Promise<McpImportPreview> {
  const response = await apiFetch('/api/mcp/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    ...(signal ? { signal } : {}),
  });
  const data = await response.json().catch(() => ({})) as McpImportPreview & { error?: string };
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

type McpActionRequest =
  | ({ action: 'import' } & McpImportWriteRequest)
  | ({ action: 'replace' } & McpReplaceWriteRequest)
  | {
    action: 'set-enabled';
    scope: McpConfigScope;
    cwd?: string;
    revision: string | null;
    names: string[];
    enabled: boolean;
  }
  | {
    action: 'set-exposure';
    scope: McpConfigScope;
    cwd?: string;
    revision: string | null;
    name: string;
    exposure: McpExposure;
    tool?: string;
  }
  | {
    action: 'remove';
    scope: McpConfigScope;
    cwd?: string;
    revision: string | null;
    name: string;
  }
  | { action: 'restore'; cwd?: string; undoToken: string };

async function postMcpAction(action: McpActionRequest): Promise<McpActionResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MCP_ACTION_TIMEOUT_MS);
  try {
    const response = await apiFetch('/api/mcp/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({})) as McpMutationResponse & {
      error?: string;
      code?: string;
      uncertain?: boolean;
      trustKept?: boolean;
    };
    if (!response.ok) {
      return {
        success: false,
        error: data.error || `HTTP ${response.status}`,
        code: data.code ?? 'request-failed',
        uncertain: data.uncertain ?? false,
        ...(data.trustKept ? { trustKept: true } : {}),
      };
    }
    return { success: true, data };
  } catch (error) {
    if (controller.signal.aborted) {
      return { success: false, error: 'The MCP action timed out.', code: 'timeout', uncertain: true };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'The MCP action failed.',
      code: 'network-error',
      uncertain: true,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function testMcpConfigServer(
  scope: McpConfigScope,
  name: string,
  cwd?: string,
): Promise<McpTestRequestResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MCP_TEST_CLIENT_TIMEOUT_MS);
  try {
    const response = await apiFetch('/api/mcp/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, name, ...(cwd ? { cwd } : {}) }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({})) as McpTestResponse & {
      error?: string;
      code?: string;
    };
    if (!response.ok) {
      return {
        success: false,
        error: data.error || `HTTP ${response.status}`,
        code: data.code ?? 'request-failed',
      };
    }
    return { success: true, data };
  } catch (error) {
    if (controller.signal.aborted) {
      return { success: false, error: 'The MCP test timed out.', code: 'timeout' };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'The MCP test failed.',
      code: 'network-error',
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function importMcpConfigServer(request: McpImportWriteRequest): Promise<McpActionResponse> {
  return postMcpAction({ action: 'import', ...request });
}

export function replaceMcpConfigServer(request: McpReplaceWriteRequest): Promise<McpActionResponse> {
  return postMcpAction({ action: 'replace', ...request });
}

export function setMcpConfigEnabled(
  scope: McpConfigScope,
  names: string[],
  enabled: boolean,
  revision: string | null,
  cwd?: string,
): Promise<McpActionResponse> {
  return postMcpAction({
    action: 'set-enabled', scope, names, enabled, revision, ...(cwd ? { cwd } : {}),
  });
}

export function setMcpConfigExposure(
  scope: McpConfigScope,
  name: string,
  exposure: McpExposure,
  revision: string | null,
  cwd?: string,
  tool?: string,
): Promise<McpActionResponse> {
  return postMcpAction({
    action: 'set-exposure', scope, name, exposure, revision, ...(cwd ? { cwd } : {}), ...(tool ? { tool } : {}),
  });
}

export function removeMcpConfigServer(
  scope: McpConfigScope,
  name: string,
  revision: string | null,
  cwd?: string,
): Promise<McpActionResponse> {
  return postMcpAction({ action: 'remove', scope, name, revision, ...(cwd ? { cwd } : {}) });
}

export function restoreMcpConfigServer(undoToken: string, cwd?: string): Promise<McpActionResponse> {
  return postMcpAction({ action: 'restore', undoToken, ...(cwd ? { cwd } : {}) });
}

async function mcpOAuthRequest<T>(
  path: string,
  init: RequestInit,
): Promise<McpOAuthResponse<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MCP_OAUTH_CLIENT_TIMEOUT_MS);
  try {
    const response = await apiFetch(path, { ...init, signal: controller.signal });
    const data = await response.json().catch(() => ({})) as T & { error?: string; code?: string };
    if (!response.ok) return {
      success: false,
      error: data.error || `HTTP ${response.status}`,
      code: data.code ?? 'request-failed',
    };
    return { success: true, data };
  } catch (error) {
    return {
      success: false,
      error: controller.signal.aborted
        ? 'The MCP OAuth request timed out.'
        : error instanceof Error ? error.message : 'The MCP OAuth request failed.',
      code: controller.signal.aborted ? 'timeout' : 'network-error',
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function getMcpOAuthStatuses(
  servers: Array<{ scope: McpConfigScope; name: string; configKey: string }>,
  cwd?: string,
): Promise<McpOAuthResponse<{ statuses: McpOAuthStatusEntry[] }>> {
  return mcpOAuthRequest('/api/mcp/oauth/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      servers: servers.map(server => ({ scope: server.scope, name: server.name, configKey: server.configKey })),
      ...(cwd ? { cwd } : {}),
    }),
  });
}

export function startMcpOAuth(
  server: { scope: McpConfigScope; name: string; configKey: string },
  cwd?: string,
): Promise<McpOAuthResponse<McpOAuthFlowInfo & { joined?: true }>> {
  return mcpOAuthRequest('/api/mcp/oauth/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: server.scope, name: server.name, configKey: server.configKey, ...(cwd ? { cwd } : {}) }),
  });
}

export function readMcpOAuthFlow(flowId: string): Promise<McpOAuthResponse<McpOAuthFlowInfo>> {
  return mcpOAuthRequest(`/api/mcp/oauth/flows/${encodeURIComponent(flowId)}`, { method: 'GET' });
}

export function pasteMcpOAuthRedirect(
  flowId: string,
  redirectUrl: string,
): Promise<McpOAuthResponse<McpOAuthFlowInfo>> {
  return mcpOAuthRequest(`/api/mcp/oauth/flows/${encodeURIComponent(flowId)}/redirect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirectUrl }),
  });
}

export function cancelMcpOAuthFlow(flowId: string): Promise<McpOAuthResponse<McpOAuthFlowInfo>> {
  return mcpOAuthRequest(`/api/mcp/oauth/flows/${encodeURIComponent(flowId)}`, { method: 'DELETE' });
}

export function logoutMcpOAuth(
  server: { scope: McpConfigScope; name: string; configKey: string },
  cwd?: string,
): Promise<McpOAuthResponse<{
  scope: McpConfigScope;
  name: string;
  configKey: string;
  removed: boolean;
}>> {
  return mcpOAuthRequest('/api/mcp/oauth/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: server.scope, name: server.name, configKey: server.configKey, ...(cwd ? { cwd } : {}) }),
  });
}
