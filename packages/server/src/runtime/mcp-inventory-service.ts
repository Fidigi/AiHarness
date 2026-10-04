import { randomUUID } from 'node:crypto';
import {
  inspectMcpConfig,
  McpConfigMutationError,
  type McpConfigInventory,
  type McpConfigScope,
  type McpRemovedServerRecord,
  type McpServerMutationOutcome,
  type ProjectTrustManager,
  removeMcpServer,
  restoreMcpServer,
  setMcpServersEnabled,
  WorkspaceManager,
} from '@ai-harness/core';

export const MCP_UNDO_TTL_MS = 60_000;
export const MCP_UNDO_MAX_RECORDS = 100;

interface StoredUndoRecord {
  removed: McpRemovedServerRecord;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface McpMutationOverview {
  inventory: McpConfigInventory;
  outcomes?: McpServerMutationOutcome[];
  undo?: {
    token: string;
    expiresAt: string;
  };
}

export interface McpSetEnabledRequest {
  scope: McpConfigScope;
  cwd?: string;
  revision: string | null;
  names: string[];
  enabled: boolean;
}

export interface McpRemoveRequest {
  scope: McpConfigScope;
  cwd?: string;
  revision: string | null;
  name: string;
}

export interface McpRestoreRequest {
  cwd?: string;
  undoToken: string;
}

export interface McpInventoryServiceOptions {
  undoTtlMs?: number;
  undoMaxRecords?: number;
  now?: () => number;
  createToken?: () => string;
}

export class McpInventoryService {
  private readonly undoRecords = new Map<string, StoredUndoRecord>();
  private readonly undoTtlMs: number;
  private readonly undoMaxRecords: number;
  private readonly now: () => number;
  private readonly createToken: () => string;

  constructor(
    private readonly agentDir: string,
    private readonly workspaceManager: WorkspaceManager,
    private readonly trustManager: ProjectTrustManager,
    options: McpInventoryServiceOptions = {},
  ) {
    this.undoTtlMs = Number.isSafeInteger(options.undoTtlMs) && options.undoTtlMs! > 0
      ? options.undoTtlMs!
      : MCP_UNDO_TTL_MS;
    this.undoMaxRecords = Number.isSafeInteger(options.undoMaxRecords) && options.undoMaxRecords! > 0
      ? options.undoMaxRecords!
      : MCP_UNDO_MAX_RECORDS;
    this.now = options.now ?? Date.now;
    this.createToken = options.createToken ?? randomUUID;
  }

  async getOverview(cwd?: string): Promise<McpConfigInventory> {
    const canonicalCwd = await this.resolveOptionalWorkspace(cwd);
    return inspectMcpConfig({
      agentDir: this.agentDir,
      ...(canonicalCwd ? { cwd: canonicalCwd } : {}),
      trustManager: this.trustManager,
    });
  }

  async setEnabled(request: McpSetEnabledRequest): Promise<McpMutationOverview> {
    const canonicalCwd = await this.resolveOptionalWorkspace(request.cwd);
    const activation = await setMcpServersEnabled({
      agentDir: this.agentDir,
      scope: request.scope,
      expectedRevision: request.revision,
      names: request.names,
      enabled: request.enabled,
      ...(request.scope === 'project' && canonicalCwd ? { cwd: canonicalCwd } : {}),
      trustManager: this.trustManager,
    });
    // Read the committed inventory rather than constructing browser data from source values.
    try {
      return {
        inventory: await this.getOverview(canonicalCwd),
        outcomes: activation.outcomes,
      };
    } catch (error) {
      if (!activation.changed) throw error;
      throw this.postCommitFailure(error);
    }
  }

  async remove(request: McpRemoveRequest): Promise<McpMutationOverview> {
    const canonicalCwd = await this.resolveOptionalWorkspace(request.cwd);
    const removal = await removeMcpServer({
      agentDir: this.agentDir,
      scope: request.scope,
      expectedRevision: request.revision,
      name: request.name,
      ...(request.scope === 'project' && canonicalCwd ? { cwd: canonicalCwd } : {}),
      trustManager: this.trustManager,
    });
    try {
      const inventory = await this.getOverview(canonicalCwd);
      const undo = this.rememberUndo(removal.removed);
      return { inventory, undo };
    } catch (error) {
      throw this.postCommitFailure(error);
    }
  }

  async restore(request: McpRestoreRequest): Promise<McpMutationOverview> {
    const canonicalCwd = await this.resolveOptionalWorkspace(request.cwd);
    const removed = this.takeUndo(request.undoToken);
    if (removed.scope === 'project' && (!canonicalCwd || canonicalCwd !== removed.cwd)) {
      throw new McpConfigMutationError(
        'invalid-request',
        'The MCP restoration token does not belong to this project.',
      );
    }
    await restoreMcpServer({
      agentDir: this.agentDir,
      trustManager: this.trustManager,
      record: removed,
    });
    try {
      return { inventory: await this.getOverview(canonicalCwd) };
    } catch (error) {
      throw this.postCommitFailure(error);
    }
  }

  private postCommitFailure(error: unknown): McpConfigMutationError {
    if (error instanceof McpConfigMutationError && error.uncertain) return error;
    return new McpConfigMutationError(
      'write-failed',
      'The MCP action committed, but its canonical inventory could not be reloaded.',
      true,
    );
  }

  private async resolveOptionalWorkspace(cwd?: string): Promise<string | undefined> {
    if (cwd === undefined) return undefined;
    try {
      return await this.workspaceManager.resolve(cwd, {
        mustExist: true,
        kind: 'directory',
      });
    } catch {
      throw new McpConfigMutationError('invalid-request', 'cwd invalide.');
    }
  }

  private forgetUndo(token: string, expected?: StoredUndoRecord): void {
    const record = this.undoRecords.get(token);
    if (!record || (expected && record !== expected)) return;
    clearTimeout(record.timer);
    this.undoRecords.delete(token);
  }

  private sweepUndo(): void {
    const now = this.now();
    for (const [token, record] of this.undoRecords) {
      if (record.expiresAt <= now) this.forgetUndo(token, record);
    }
  }

  private rememberUndo(removed: McpRemovedServerRecord): { token: string; expiresAt: string } {
    this.sweepUndo();
    while (this.undoRecords.size >= this.undoMaxRecords) {
      const oldest = this.undoRecords.keys().next().value as string | undefined;
      if (!oldest) break;
      this.forgetUndo(oldest);
    }
    const token = this.createToken();
    this.forgetUndo(token);
    const now = this.now();
    const expiresAt = now + this.undoTtlMs;
    const record = { removed, expiresAt } as StoredUndoRecord;
    record.timer = setTimeout(() => this.forgetUndo(token, record), Math.max(0, expiresAt - now));
    record.timer.unref?.();
    this.undoRecords.set(token, record);
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  private takeUndo(token: string): McpRemovedServerRecord {
    this.sweepUndo();
    const record = this.undoRecords.get(token);
    if (record) this.forgetUndo(token, record);
    if (!record) {
      throw new McpConfigMutationError('target-not-found', 'The MCP restoration token is unavailable or expired.');
    }
    return record.removed;
  }
}
