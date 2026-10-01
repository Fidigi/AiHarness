import { chmod, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

interface TrustFile {
  version: 1;
  trustedProjects: string[];
}

/** Persistent allow-list for project code and dangerous workspace actions. */
export class ProjectTrustManager {
  private readonly filePath: string;
  private trusted = new Set<string>();

  constructor(filePath = path.join(os.homedir(), '.ai-harness', 'trust.json')) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<TrustFile>;
      this.trusted = new Set(Array.isArray(parsed.trustedProjects)
        ? parsed.trustedProjects.filter((item): item is string => typeof item === 'string')
        : []);
    } catch {
      this.trusted.clear();
    }
  }

  async isTrusted(projectPath: string): Promise<boolean> {
    return this.trusted.has(await this.normalize(projectPath));
  }

  /** Only use after `load`; asynchronous `isTrusted` is symlink-safe. */
  isTrustedSync(projectPath: string): boolean {
    return this.trusted.has(path.resolve(projectPath));
  }

  async trust(projectPath: string): Promise<string> {
    const normalized = await this.normalize(projectPath);
    this.trusted.add(normalized);
    await this.save();
    return normalized;
  }

  async untrust(projectPath: string): Promise<string> {
    const normalized = await this.normalize(projectPath);
    this.trusted.delete(normalized);
    await this.save();
    return normalized;
  }

  list(): string[] {
    return [...this.trusted].sort();
  }

  private async normalize(projectPath: string): Promise<string> {
    try {
      return await realpath(projectPath);
    } catch {
      return path.resolve(projectPath);
    }
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify({ version: 1, trustedProjects: this.list() }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await rename(temporary, this.filePath);
    await chmod(this.filePath, 0o600);
  }
}
