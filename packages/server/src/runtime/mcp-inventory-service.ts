import { inspectMcpConfig, type McpConfigInventory, type ProjectTrustManager, type WorkspaceManager } from '@ai-harness/core';

/** Read-only transport adapter around Core's file-only MCP inventory policy. */
export class McpInventoryService {
  constructor(
    private readonly agentDir: string,
    private readonly workspaceManager: WorkspaceManager,
    private readonly trustManager: ProjectTrustManager,
  ) {}

  async getOverview(cwdInput?: string): Promise<McpConfigInventory> {
    const cwd = cwdInput === undefined
      ? undefined
      : await this.workspaceManager.resolve(cwdInput, { kind: 'directory' });
    return inspectMcpConfig({
      agentDir: this.agentDir,
      ...(cwd ? { cwd, trustManager: this.trustManager } : {}),
    });
  }
}
