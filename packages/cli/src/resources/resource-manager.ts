import { readFile, readdir, stat } from 'fs/promises';
import os from 'os';
import path from 'path';

export interface SkillDefinition {
  name: string;
  description: string;
  version?: string;
  disableModelInvocation: boolean;
  instructions: string;
  filePath: string;
}

export interface PromptDefinition {
  name: string;
  description?: string;
  content: string;
  filePath: string;
}

export interface ResourceManagerOptions {
  cwd?: string;
  homeDir?: string;
  skillPaths?: string[];
  promptPaths?: string[];
}

interface MarkdownDocument {
  attributes: Record<string, string>;
  body: string;
}

function parseMarkdownDocument(source: string): MarkdownDocument {
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { attributes: {}, body: normalized.trim() };
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) return { attributes: {}, body: normalized.trim() };

  const attributes: Record<string, string> = {};
  for (const line of normalized.slice(4, end).split('\n')) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    attributes[match[1].toLowerCase()] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return { attributes, body: normalized.slice(end + 5).trim() };
}

function normalizeResourceName(value: string): string {
  const name = value.trim().toLowerCase().replace(/\s+/g, '-');
  if (!/^[a-z][a-z0-9:_-]*$/.test(name)) throw new Error(`Nom de ressource invalide : ${value}`);
  return name;
}

async function existsDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function findFiles(root: string, matcher: (name: string) => boolean, maxDepth = 3): Promise<string[]> {
  if (!(await existsDirectory(root))) return [];
  const found: string[] = [];

  async function walk(directory: string, depth: number): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isFile() && matcher(entry.name)) found.push(entryPath);
      else if (entry.isDirectory() && depth < maxDepth) await walk(entryPath, depth + 1);
    }
  }

  await walk(root, 0);
  return found.sort();
}

/** Agent Skills Spec and markdown prompt discovery for the CLI. */
export class ResourceManager {
  private readonly cwd: string;
  private readonly homeDir: string;
  private readonly extraSkillPaths: string[];
  private readonly extraPromptPaths: string[];
  private readonly skills = new Map<string, SkillDefinition>();
  private readonly prompts = new Map<string, PromptDefinition>();

  constructor(options: ResourceManagerOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.homeDir = options.homeDir ?? os.homedir();
    this.extraSkillPaths = options.skillPaths ?? [];
    this.extraPromptPaths = options.promptPaths ?? [];
  }

  async loadAll(): Promise<{ skills: number; prompts: number; errors: Error[] }> {
    this.skills.clear();
    this.prompts.clear();
    const errors: Error[] = [];

    const skillRoots = [
      path.join(this.homeDir, '.agents', 'skills'),
      path.join(this.homeDir, '.ai-harness', 'skills'),
      path.join(this.cwd, '.agents', 'skills'),
      path.join(this.cwd, '.ai-harness', 'skills'),
      ...this.extraSkillPaths.map(item => path.resolve(this.cwd, item)),
    ];
    for (const root of skillRoots) {
      for (const filePath of await findFiles(root, name => name.toLowerCase() === 'skill.md')) {
        try {
          const skill = await this.parseSkill(filePath);
          this.skills.set(skill.name, skill);
        } catch (error) {
          errors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
    }

    const promptRoots = [
      path.join(this.homeDir, '.ai-harness', 'prompts'),
      path.join(this.cwd, '.ai-harness', 'prompts'),
      path.join(this.cwd, 'prompts'),
      ...this.extraPromptPaths.map(item => path.resolve(this.cwd, item)),
    ];
    for (const root of promptRoots) {
      for (const filePath of await findFiles(root, name => name.toLowerCase().endsWith('.md'))) {
        try {
          const prompt = await this.parsePrompt(filePath);
          this.prompts.set(prompt.name, prompt);
        } catch (error) {
          errors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
    }

    return { skills: this.skills.size, prompts: this.prompts.size, errors };
  }

  listSkills(): SkillDefinition[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  listPrompts(): PromptDefinition[] {
    return [...this.prompts.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  getSkill(name: string): SkillDefinition | undefined {
    return this.skills.get(name.trim().toLowerCase());
  }

  getPrompt(name: string): PromptDefinition | undefined {
    return this.prompts.get(name.trim().toLowerCase());
  }

  getModelInvocableSkills(): SkillDefinition[] {
    return this.listSkills().filter(skill => !skill.disableModelInvocation);
  }

  invokeSkill(name: string, request = ''): string {
    const skill = this.getSkill(name);
    if (!skill) throw new Error(`Skill inconnu : ${name}`);
    return [
      `<skill name="${skill.name}">`,
      skill.instructions,
      '</skill>',
      request.trim(),
    ].filter(Boolean).join('\n\n');
  }

  expandPrompt(name: string, args: string[]): string {
    const prompt = this.getPrompt(name);
    if (!prompt) throw new Error(`Prompt inconnu : ${name}`);
    const all = args.join(' ');
    return prompt.content
      .replace(/\$\{@:-([^}]*)\}/g, (_match, fallback: string) => all || fallback)
      .replace(/\$@/g, all)
      .replace(/\$\{(\d+):-([^}]*)\}/g, (_match, index: string, fallback: string) => args[Number(index) - 1] ?? fallback)
      .replace(/\$(\d+)/g, (_match, index: string) => args[Number(index) - 1] ?? '');
  }

  private async parseSkill(filePath: string): Promise<SkillDefinition> {
    const document = parseMarkdownDocument(await readFile(filePath, 'utf8'));
    const fallbackName = path.basename(path.dirname(filePath));
    const name = normalizeResourceName(document.attributes.name || fallbackName);
    if (!document.body) throw new Error(`Skill vide : ${filePath}`);
    return {
      name,
      description: document.attributes.description || name,
      version: document.attributes.version,
      disableModelInvocation: document.attributes['disable-model-invocation']?.toLowerCase() === 'true',
      instructions: document.body,
      filePath,
    };
  }

  private async parsePrompt(filePath: string): Promise<PromptDefinition> {
    const document = parseMarkdownDocument(await readFile(filePath, 'utf8'));
    const name = normalizeResourceName(document.attributes.name || path.basename(filePath, path.extname(filePath)));
    if (!document.body) throw new Error(`Prompt vide : ${filePath}`);
    return {
      name,
      description: document.attributes.description,
      content: document.body,
      filePath,
    };
  }
}
