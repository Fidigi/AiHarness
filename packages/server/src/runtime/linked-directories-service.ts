import {
  LinkedDirectoryConsent,
  LinkedDirectoryError,
  type LinkedDirectoryAccess,
  type LinkedDirectorySelector,
  type ProjectTrustManager,
  type WorkspaceManager,
} from '@ai-harness/core';

/** HTTP policy adapter. Filesystem authorization and persistence belong exclusively to Core. */
export class LinkedDirectoriesService {
  private readonly boundary: LinkedDirectoryConsent;
  constructor(
    private readonly workspaces: WorkspaceManager,
    private readonly trust: ProjectTrustManager,
    options: { storeDirectory: string; protectedPaths?: string[] },
    private readonly redact: (value: string) => string,
  ) { this.boundary = new LinkedDirectoryConsent(workspaces, options); }

  async list(cwd: string, directory = '.') {
    const inventory = await this.boundary.list(cwd, directory);
    return { ...inventory, entries: inventory.entries.map(entry => {
      const sensitive = [entry.name, entry.rawTarget, entry.canonicalTarget]
        .some(value => value !== undefined && this.redact(value) !== value);
      return sensitive ? {
        ...entry, name: this.redact(entry.name),
        ...(entry.rawTarget === undefined ? {} : { rawTarget: this.redact(entry.rawTarget) }),
        ...(entry.canonicalTarget === undefined ? {} : { canonicalTarget: this.redact(entry.canonicalTarget) }),
        reason: 'unsafe-target' as const, allowed: false,
      } : entry;
    }) };
  }
  private async requireUnredactedTarget(selector: LinkedDirectorySelector): Promise<void> {
    const inventory = await this.list(selector.cwd, selector.directory);
    const entry = inventory.entries.find(entry => entry.id === selector.id);
    if (!entry || entry.reason !== 'directory') throw new LinkedDirectoryError('unsafe-target');
  }
  async setConsent(selector: LinkedDirectorySelector, allowed: boolean, confirm: true) {
    if (allowed) await this.requireUnredactedTarget(selector);
    await this.boundary.setConsent(selector, allowed, confirm);
    return this.list(selector.cwd, selector.directory);
  }
  private async requireSourceTrust(cwd: string): Promise<void> {
    const source = await this.workspaces.resolve(cwd, { kind: 'directory' });
    if (!await this.trust.isTrusted(source)) {
      throw Object.assign(new Error('Source workspace trust is required.'), { code: 'source-trust-required' });
    }
  }
  async browse(selector: LinkedDirectoryAccess) {
    await this.requireSourceTrust(selector.cwd);
    await this.requireUnredactedTarget(selector);
    if (this.redact(selector.path) !== selector.path) throw new LinkedDirectoryError('unsafe-target');
    const result = await this.boundary.browse(selector, () => this.requireSourceTrust(selector.cwd));
    await this.requireSourceTrust(selector.cwd);
    return { ...result, entries: result.entries.map(entry => ({
      ...entry, name: this.redact(entry.name), path: this.redact(entry.path),
      blocked: entry.blocked || this.redact(entry.name) !== entry.name || this.redact(entry.path) !== entry.path,
    })) };
  }
  async read(selector: LinkedDirectoryAccess) {
    await this.requireSourceTrust(selector.cwd);
    await this.requireUnredactedTarget(selector);
    if (this.redact(selector.path) !== selector.path) throw new LinkedDirectoryError('unsafe-target');
    const result = await this.boundary.read(selector, () => this.requireSourceTrust(selector.cwd));
    await this.requireSourceTrust(selector.cwd);
    return { ...result, content: this.redact(result.content) };
  }
}
