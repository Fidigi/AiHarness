import type {
  McpConfigInventory,
  McpConfigScope,
  McpServerMutationOutcome,
} from '@ai-harness/core';
import { apiFetch } from './api';

export const MCP_ACTION_TIMEOUT_MS = 15_000;

export interface McpMutationResponse {
  inventory: McpConfigInventory;
  outcomes?: McpServerMutationOutcome[];
  undo?: { token: string; expiresAt: string };
}

export interface McpActionResponse {
  success: boolean;
  data?: McpMutationResponse;
  error?: string;
  code?: string;
  /** True means the server may have committed before the client observed failure. */
  uncertain?: boolean;
}

type McpActionRequest =
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
