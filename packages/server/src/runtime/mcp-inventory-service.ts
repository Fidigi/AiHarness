import { randomUUID } from 'node:crypto';
import {
  importMcpServer,
  inspectMcpConfig,
  McpConfigMutationError,
  previewMcpImport,
  replaceMcpServer,
  type McpConfigInventory,
  type McpConfigScope,
  type McpExposure,
  type McpImportFieldValue,
  type McpImportPreview,
  type McpImportScopeContext,
  type McpImportSyntax,
  type McpImportWriteConfirmations,
  type McpRemovedServerRecord,
  type McpServerMutationOutcome,
  type ProjectTrustManager,
  removeMcpServer,
  restoreMcpServer,
  setMcpServerExposure,
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
  added?: {
    scope: McpConfigScope;
    name: string;
  };
  updated?: {
    scope: McpConfigScope;
    previousName: string;
    name: string;
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

export interface McpSetExposureRequest {
  scope: McpConfigScope;
  cwd?: string;
  revision: string | null;
  name: string;
  exposure: McpExposure;
}

export interface McpRestoreRequest {
  cwd?: string;
  undoToken: string;
}

export interface McpImportRequest {
  scope: McpConfigScope;
  cwd?: string;
  revision: string | null;
  /** Explicitly request the one-time fresh-project trust-plus-write transaction. */
  trustProject?: true;
  text: string;
  syntax: McpImportSyntax;
  entryIndex: number;
  name?: string;
  values?: Record<string, McpImportFieldValue>;
  secretReferences?: Record<string, string>;
  confirmations?: McpImportWriteConfirmations;
}

export interface McpReplacePreviewTarget {
  scope: McpConfigScope;
  name: string;
  revision: string;
}

export interface McpReplaceRequest extends McpImportRequest {
  targetName: string;
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
      ...(canonicalCwd ? {
        cwd: canonicalCwd,
        freshProjectTrust: {
          knownFolders: this.workspaceManager.getAllowedRoots(),
          protectedPaths: [this.agentDir],
        },
      } : {}),
      trustManager: this.trustManager,
    });
  }

  /**
   * Re-parse an untrusted paste in Core. Only environment names and redacted
   * inventory metadata cross this boundary: values are never expanded or
   * returned, and preview never opens a resolver or credential store.
   */
  async previewImport(
    text: string,
    syntax: McpImportSyntax,
    cwd?: string,
    replacement?: McpReplacePreviewTarget,
  ): Promise<McpImportPreview> {
    const inventory = await this.getOverview(cwd);
    const file = (scope: McpConfigScope) => inventory.files.find(item => item.scope === scope);
    if (replacement) {
      if (replacement.scope === 'project'
        && (!inventory.project || inventory.project.trustError || inventory.project.decision !== true)) {
        throw new McpConfigMutationError(
          inventory.project?.trustError ? 'trust-unavailable' : 'trust-required',
          'A persisted project allow is required for this MCP replacement preview.',
        );
      }
      if (file(replacement.scope)?.revision !== replacement.revision) {
        throw new McpConfigMutationError(
          'stale-revision',
          'The MCP configuration changed; reload it before retrying.',
        );
      }
      const target = inventory.servers.find(server => (
        server.scope === replacement.scope && server.name === replacement.name
      ));
      if (!target) throw new McpConfigMutationError('target-not-found', 'The MCP server no longer exists.');
      if (!target.valid) throw new McpConfigMutationError('target-invalid', 'The MCP server entry is invalid.');
    }
    const names = (scope: McpConfigScope) => inventory.servers
      .filter(server => server.scope === scope
        && (replacement?.scope !== scope || server.name !== replacement.name))
      .map(server => server.name);
    const available = (scope: McpConfigScope): boolean => {
      const target = file(scope);
      return Boolean(target && (!target.exists || (target.contentRead && target.problems.length === 0)));
    };
    const globalAvailable = available('global');
    const global: McpImportScopeContext = {
      available: globalAvailable,
      ...(!globalAvailable ? { unavailableReason: 'config-unavailable' as const } : {}),
      names: names('global'),
    };
    let project: McpImportScopeContext;
    if (!inventory.project) {
      project = { available: false, unavailableReason: 'no-project', names: [] };
    } else if (inventory.project.trustError) {
      project = { available: false, unavailableReason: 'trust-unavailable', names: [] };
    } else if (!inventory.project.contentTrusted || inventory.project.decision !== true) {
      const fresh = inventory.project.trustAndWrite;
      if (fresh?.allowed && available('project')) {
        project = {
          available: true,
          names: names('project'),
          confirmations: ['fresh-project-trust'],
        };
      } else {
        const unavailableReason = fresh && !fresh.allowed
          ? fresh.reason
          : 'trust-required';
        project = { available: false, unavailableReason, names: [] };
      }
    } else {
      const projectAvailable = available('project');
      project = {
        available: projectAvailable,
        ...(!projectAvailable ? { unavailableReason: 'config-unavailable' as const } : {}),
        names: names('project'),
      };
    }
    return previewMcpImport(text, {
      syntax,
      availableVariableNames: Object.keys(process.env),
      scopes: { global, project },
    });
  }

  async importServer(request: McpImportRequest): Promise<McpMutationOverview> {
    const canonicalCwd = await this.resolveOptionalWorkspace(request.cwd);
    const imported = await importMcpServer({
      agentDir: this.agentDir,
      scope: request.scope,
      expectedRevision: request.revision,
      text: request.text,
      syntax: request.syntax,
      entryIndex: request.entryIndex,
      availableVariableNames: Object.keys(process.env),
      ...(request.name !== undefined ? { name: request.name } : {}),
      ...(request.values ? { values: request.values } : {}),
      ...(request.secretReferences ? { secretReferences: request.secretReferences } : {}),
      ...(request.confirmations ? { confirmations: request.confirmations } : {}),
      ...(request.scope === 'project' && canonicalCwd ? { cwd: canonicalCwd } : {}),
      ...(request.trustProject === true ? {
        trustFreshProject: {
          knownFolders: this.workspaceManager.getAllowedRoots(),
          protectedPaths: [this.agentDir],
        },
      } : {}),
      trustManager: this.trustManager,
    });
    try {
      return {
        inventory: await this.getOverview(canonicalCwd),
        added: { scope: imported.scope, name: imported.name },
      };
    } catch (error) {
      throw this.postCommitFailure(error);
    }
  }

  async replaceServer(request: McpReplaceRequest): Promise<McpMutationOverview> {
    const canonicalCwd = await this.resolveOptionalWorkspace(request.cwd);
    const replaced = await replaceMcpServer({
      agentDir: this.agentDir,
      scope: request.scope,
      expectedRevision: request.revision,
      targetName: request.targetName,
      text: request.text,
      syntax: request.syntax,
      entryIndex: request.entryIndex,
      availableVariableNames: Object.keys(process.env),
      ...(request.name !== undefined ? { name: request.name } : {}),
      ...(request.values ? { values: request.values } : {}),
      ...(request.secretReferences ? { secretReferences: request.secretReferences } : {}),
      ...(request.confirmations ? { confirmations: request.confirmations } : {}),
      ...(request.scope === 'project' && canonicalCwd ? { cwd: canonicalCwd } : {}),
      trustManager: this.trustManager,
    });
    try {
      return {
        inventory: await this.getOverview(canonicalCwd),
        updated: {
          scope: replaced.scope,
          previousName: replaced.previousName,
          name: replaced.name,
        },
      };
    } catch (error) {
      if (!replaced.changed) throw error;
      throw this.postCommitFailure(error);
    }
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

  async setExposure(request: McpSetExposureRequest): Promise<McpMutationOverview> {
    const canonicalCwd = await this.resolveOptionalWorkspace(request.cwd);
    const exposure = await setMcpServerExposure({
      agentDir: this.agentDir,
      scope: request.scope,
      expectedRevision: request.revision,
      name: request.name,
      exposure: request.exposure,
      ...(request.scope === 'project' && canonicalCwd ? { cwd: canonicalCwd } : {}),
      trustManager: this.trustManager,
    });
    try {
      return { inventory: await this.getOverview(canonicalCwd) };
    } catch (error) {
      if (!exposure.changed) throw error;
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
