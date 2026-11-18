import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { copySessionCustomValue } from '../sessions/session-custom-data.js';
import { describeMcpConfigEntry, type McpConfigInventory, type McpServerInventoryEntry, type McpServerRuntimeConfig } from './config-inventory.js';

/** Loader-owned provenance, never supplied by the extension factory. */
export interface ExtensionMcpSource {
  cwd: string;
  project: boolean;
  isTrusted(): boolean | Promise<boolean>;
}

interface Registration {
  owner: object;
  source?: ExtensionMcpSource;
  config: McpServerRuntimeConfig;
  entry: McpServerInventoryEntry;
}

/** Process-local, bounded registrations. The extension API supplies ownership. */
export class RegisteredMcpServers {
  private readonly registrations = new Map<string, Registration>();
  private readonly listeners = new Set<(name: string) => void>();

  register(owner: object, extensionId: string, name: string, config: McpServerRuntimeConfig,
    source?: ExtensionMcpSource): () => void {
    // Reject getters, cycles and non-data values before native schema validation.
    let owned: McpServerRuntimeConfig;
    try { owned = copySessionCustomValue(config, 256 * 1024) as unknown as McpServerRuntimeConfig; }
    catch { throw new Error('Invalid extension MCP server configuration.'); }
    if (typeof name !== 'string') throw new Error('Invalid extension MCP server configuration.');
    const entry = describeMcpConfigEntry(name, owned);
    if (!entry.valid) throw new Error('Invalid extension MCP server configuration.');
    const previous = this.registrations.get(name);
    if (previous && previous.owner !== owner) throw new Error('Extension MCP server name is already registered.');
    if (!previous && this.registrations.size >= 32) throw new Error('Extension MCP server limit reached.');
    const id = randomUUID();
    const registration: Registration = { owner, config: owned, source, entry: {
      ...entry, scope: source?.project ? 'project' : 'global', sourcePath: `extension:${extensionId}`,
      configKey: `${entry.configKey}:${id}`, registration: { extensionId, id },
    } };
    this.registrations.set(name, registration);
    this.changed(name);
    return () => {
      if (this.registrations.get(name) !== registration) return;
      this.registrations.delete(name);
      this.changed(name);
    };
  }

  unregister(owner: object, name: string): boolean {
    if (this.registrations.get(name)?.owner !== owner) return false;
    this.registrations.delete(name);
    this.changed(name);
    return true;
  }

  removeOwner(owner: object): void {
    for (const [name, registration] of this.registrations) {
      if (registration.owner === owner) this.unregister(owner, name);
    }
  }

  isCurrent(entry: Pick<McpServerInventoryEntry, 'name' | 'configKey'>): boolean {
    return this.registrations.get(entry.name)?.entry.configKey === entry.configKey;
  }

  subscribe(listener: (name: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Passive metadata only; files always win, including disabled/invalid entries. */
  list(inventory: McpConfigInventory, cwd?: string): McpServerInventoryEntry[] {
    return [...this.registrations.values()].filter(item => !item.source
      || (cwd !== undefined && path.resolve(cwd) === path.resolve(item.source.cwd)))
      .map(item => ({ ...structuredClone(item.entry), registration: {
        ...item.entry.registration!, shadowedByFile: this.fileBlocks(inventory, item.entry.name),
      } }));
  }

  async resolve(entry: McpServerInventoryEntry, inventory: McpConfigInventory, cwd: string): Promise<McpServerRuntimeConfig> {
    const current = this.registrations.get(entry.name);
    if (!current || current.entry.configKey !== entry.configKey || this.fileBlocks(inventory, entry.name)
      || (current.source && path.resolve(cwd) !== path.resolve(current.source.cwd))
      || (current.source?.project && !await current.source.isTrusted())
      || this.registrations.get(entry.name) !== current) {
      throw new Error('Extension MCP server registration is no longer available.');
    }
    return structuredClone(current.config);
  }

  private fileBlocks(inventory: McpConfigInventory, name: string): boolean {
    return inventory.servers.some(entry => !entry.registration && entry.name === name)
      || inventory.files.some(file => file.exists && file.problems.some(problem =>
        problem.reason !== 'trust-required' && problem.reason !== 'trust-unavailable'));
  }

  private changed(name: string): void { for (const listener of this.listeners) listener(name); }
}
