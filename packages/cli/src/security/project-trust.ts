import { chmod, mkdir, readFile, realpath, rename, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';

interface TrustFile {
  version: 1;
  trustedProjects: string[];
}

export class ProjectTrustManager {
  private readonly filePath: string;
  private trusted = new Set<string>();

  constructor(filePath = path.join(os.homedir(), '.ai-harness', 'trust.json')) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as TrustFile;
      this.trusted = new Set(parsed.trustedProjects ?? []);
    } catch {
      this.trusted.clear();
    }
  }

  async isTrusted(projectPath: string): Promise<boolean> {
    return this.trusted.has(await this.normalize(projectPath));
  }

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
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, trustedProjects: this.list() }, null, 2), { mode: 0o600 });
    await rename(temporary, this.filePath);
    await chmod(this.filePath, 0o600);
  }
}
