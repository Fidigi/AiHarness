import type {
  McpConfigInventory,
  McpConfigScope,
  McpImportFieldValue,
  McpImportPreview,
  McpImportSyntax,
  McpImportWriteConfirmations,
  McpServerMutationOutcome,
} from '@ai-harness/core';
import { apiFetch } from './api';

export const MCP_ACTION_TIMEOUT_MS = 15_000;

export interface McpMutationResponse {
  inventory: McpConfigInventory;
  outcomes?: McpServerMutationOutcome[];
  undo?: { token: string; expiresAt: string };
  added?: { scope: McpConfigScope; name: string };
}

export interface McpImportPreviewRequest {
  text: string;
  syntax: McpImportSyntax;
  cwd?: string;
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
}

export interface McpActionResponse {
  success: boolean;
  data?: McpMutationResponse;
  error?: string;
  code?: string;
  /** True means the server may have committed before the client observed failure. */
  uncertain?: boolean;
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
  | {
    action: 'set-enabled';
    scope: McpConfigScope;
    cwd?: string;
    revision: string | null;
    names: string[];
    enabled: boolean;
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
    };
    if (!response.ok) {
      return {
        success: false,
        error: data.error || `HTTP ${response.status}`,
        code: data.code ?? 'request-failed',
        uncertain: data.uncertain ?? false,
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

export function importMcpConfigServer(request: McpImportWriteRequest): Promise<McpActionResponse> {
  return postMcpAction({ action: 'import', ...request });
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
