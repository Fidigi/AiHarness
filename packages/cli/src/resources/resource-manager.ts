import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
  agentDir?: string;
  projectTrusted?: boolean;
  /** Backward-compatible explicit paths applied after all automatic roots. */
  skillPaths?: string[];
  promptPaths?: string[];
  globalSkillPaths?: string[];
  projectSkillPaths?: string[];
  globalPromptPaths?: string[];
  projectPromptPaths?: string[];
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

const MAX_RESOURCE_FILES = 10_000;
const MAX_RESOURCE_BYTES = 1024 * 1024;
const GLOB_MAGIC = /[*?[\]{}]/;

async function findFiles(root: string, matcher: (name: string) => boolean, maxDepth = 3): Promise<string[]> {
  let rootInfo;
  try { rootInfo = await lstat(root); }
  catch { return []; }
  if (rootInfo.isSymbolicLink()) return [];
  if (rootInfo.isFile()) return matcher(path.basename(root)) ? [root] : [];
  if (!rootInfo.isDirectory()) return [];
  const found: string[] = [];

  async function walk(directory: string, depth: number): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (found.length >= MAX_RESOURCE_FILES) return;
      const entryPath = path.join(directory, entry.name);
      if (entry.isFile() && matcher(entry.name)) found.push(entryPath);
      else if (entry.isDirectory() && !entry.isSymbolicLink() && depth < maxDepth) await walk(entryPath, depth + 1);
    }
  }

  await walk(root, 0);
  return found;
}

function normalizedGlobPath(value: string): string {
  return value.split(path.sep).join('/');
}

function matchesGlob(filePath: string, pattern: string): boolean {
  try { return path.posix.matchesGlob(normalizedGlobPath(filePath), normalizedGlobPath(pattern)); }
  catch { return false; }
}

function globSearchRoot(pattern: string): string {
  const magic = pattern.search(GLOB_MAGIC);
  if (magic < 0) return pattern;
  const before = pattern.slice(0, magic);
  const separator = Math.max(before.lastIndexOf('/'), before.lastIndexOf('\\'));
  return separator < 0 ? path.parse(pattern).root || '.' : pattern.slice(0, separator) || path.parse(pattern).root;
}

async function selectorFiles(
  selector: string,
  matcher: (name: string) => boolean,
): Promise<string[]> {
  if (!GLOB_MAGIC.test(selector)) return findFiles(selector, matcher, 8);
  const candidates = await findFiles(globSearchRoot(selector), matcher, 8);
  return candidates.filter(candidate => matchesGlob(candidate, selector));
}

async function applyResourceSelectors(
  selected: Map<string, string>,
  selectors: readonly string[],
  matcher: (name: string) => boolean,
  errors: Error[],
): Promise<void> {
  for (const rawSelector of selectors.slice(0, 512)) {
    const marker = rawSelector[0] === '+' || rawSelector[0] === '-' || rawSelector[0] === '!'
      ? rawSelector[0] : '';
    const value = marker ? rawSelector.slice(1) : rawSelector;
    if (!value) continue;
    const selector = path.resolve(value);
    if (marker === '-' || marker === '!') {
      for (const [key, filePath] of selected) {
        const excluded = marker === '!'
          ? matchesGlob(filePath, selector)
          : filePath === selector || filePath.startsWith(`${selector}${path.sep}`);
        if (excluded) selected.delete(key);
      }
      continue;
    }
    try {
      for (const filePath of await selectorFiles(selector, matcher)) {
        if (selected.size >= MAX_RESOURCE_FILES) break;
        selected.set(path.resolve(filePath), filePath);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

async function readMarkdownFile(filePath: string): Promise<string> {
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Resource must be a regular file and cannot be a symbolic link: ${filePath}`);
  }
  if (before.size > MAX_RESOURCE_BYTES) throw new Error(`Resource exceeds the ${MAX_RESOURCE_BYTES} byte limit: ${filePath}`);
  const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error(`Resource changed while it was being opened: ${filePath}`);
    }
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino
      || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error(`Resource changed while it was being read: ${filePath}`);
    }
    const content = bytes.subarray(0, offset);
    if (content.includes(0)) throw new Error(`Resource must be UTF-8 text, not binary data: ${filePath}`);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(content); }
    catch { throw new Error(`Resource is not valid UTF-8 text: ${filePath}`); }
  } finally {
    await handle.close();
  }
}

/** Agent Skills Spec and markdown prompt discovery for the CLI. */
export class ResourceManager {
  private readonly cwd: string;
  private readonly homeDir: string;
  private readonly agentDir: string;
  private readonly projectTrusted: boolean;
  private readonly extraSkillPaths: string[];
  private readonly extraPromptPaths: string[];
  private readonly globalSkillPaths: string[];
  private readonly projectSkillPaths: string[];
  private readonly globalPromptPaths: string[];
  private readonly projectPromptPaths: string[];
  private readonly skills = new Map<string, SkillDefinition>();
  private readonly prompts = new Map<string, PromptDefinition>();

  constructor(options: ResourceManagerOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.homeDir = options.homeDir ?? os.homedir();
    this.agentDir = options.agentDir ?? path.join(this.homeDir, '.ai-harness');
    this.projectTrusted = options.projectTrusted === true;
    const resolve = (entries: readonly string[]): string[] => entries.map(entry => {
      const marker = entry[0] === '+' || entry[0] === '-' || entry[0] === '!' ? entry[0] : '';
      const value = marker ? entry.slice(1) : entry;
      return `${marker}${path.resolve(this.cwd, value)}`;
    });
    this.extraSkillPaths = resolve(options.skillPaths ?? []);
    this.extraPromptPaths = resolve(options.promptPaths ?? []);
    this.globalSkillPaths = resolve(options.globalSkillPaths ?? []);
    this.projectSkillPaths = resolve(options.projectSkillPaths ?? []);
    this.globalPromptPaths = resolve(options.globalPromptPaths ?? []);
    this.projectPromptPaths = resolve(options.projectPromptPaths ?? []);
  }

  async loadAll(): Promise<{ skills: number; prompts: number; errors: Error[] }> {
    this.skills.clear();
    this.prompts.clear();
    const errors: Error[] = [];

    const skillMatcher = (name: string): boolean => name.toLowerCase() === 'skill.md';
    const skillFiles = new Map<string, string>();
    await applyResourceSelectors(skillFiles, [
      path.join(this.homeDir, '.agents', 'skills'),
      path.join(this.agentDir, 'skills'),
    ], skillMatcher, errors);
    await applyResourceSelectors(skillFiles, this.globalSkillPaths, skillMatcher, errors);
    if (this.projectTrusted) {
      await applyResourceSelectors(skillFiles, [
        path.join(this.cwd, '.agents', 'skills'),
        path.join(this.cwd, '.ai-harness', 'skills'),
      ], skillMatcher, errors);
      await applyResourceSelectors(skillFiles, this.projectSkillPaths, skillMatcher, errors);
    }
    await applyResourceSelectors(skillFiles, this.extraSkillPaths, skillMatcher, errors);
    for (const filePath of skillFiles.values()) {
      try {
        const skill = await this.parseSkill(filePath);
        this.skills.set(skill.name, skill);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    const promptMatcher = (name: string): boolean => name.toLowerCase().endsWith('.md');
    const promptFiles = new Map<string, string>();
    await applyResourceSelectors(promptFiles, [
      path.join(this.agentDir, 'prompts'),
    ], promptMatcher, errors);
    await applyResourceSelectors(promptFiles, this.globalPromptPaths, promptMatcher, errors);
    if (this.projectTrusted) {
      await applyResourceSelectors(promptFiles, [
        path.join(this.cwd, '.ai-harness', 'prompts'),
        path.join(this.cwd, 'prompts'),
      ], promptMatcher, errors);
      await applyResourceSelectors(promptFiles, this.projectPromptPaths, promptMatcher, errors);
    }
    await applyResourceSelectors(promptFiles, this.extraPromptPaths, promptMatcher, errors);
    for (const filePath of promptFiles.values()) {
      try {
        const prompt = await this.parsePrompt(filePath);
        this.prompts.set(prompt.name, prompt);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
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
    const document = parseMarkdownDocument(await readMarkdownFile(filePath));
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
    const document = parseMarkdownDocument(await readMarkdownFile(filePath));
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
