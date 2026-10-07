import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openStableDirectoryHandle, readStableDirectoryEntries } from '../security/stable-directory.js';

export type ResourceScope = 'user' | 'project' | 'temporary';
export type ResourceSource = 'auto' | 'settings' | 'package' | 'cli';

export interface ResourceProvenance {
  scope: ResourceScope;
  source: ResourceSource;
  origin: 'top-level';
  path: string;
  selector: string;
  trusted: boolean;
}

export interface SkillDefinition {
  name: string;
  description: string;
  version?: string;
  disableModelInvocation: boolean;
  instructions: string;
  filePath: string;
  provenance: ResourceProvenance;
}

export interface PromptDefinition {
  name: string;
  description?: string;
  argumentHint?: string;
  content: string;
  filePath: string;
  provenance: ResourceProvenance;
}

export interface ResourceInventoryItem {
  kind: 'skill' | 'prompt';
  name: string;
  description?: string;
  active: boolean;
  provenance: ResourceProvenance;
}

export interface ResourceManagerOptions {
  cwd?: string;
  homeDir?: string;
  agentDir?: string;
  /** Composition-root assertion for an operator-owned agent directory, even when it is below cwd. */
  agentDirTrusted?: boolean;
  projectTrusted?: boolean;
  /** Backward-compatible explicit paths applied after all automatic roots. */
  skillPaths?: string[];
  promptPaths?: string[];
  globalSkillPaths?: string[];
  projectSkillPaths?: string[];
  globalPromptPaths?: string[];
  projectPromptPaths?: string[];
  globalPackageSkillPaths?: string[];
  projectPackageSkillPaths?: string[];
  globalPackagePromptPaths?: string[];
  projectPackagePromptPaths?: string[];
  disableSkills?: boolean;
  disablePrompts?: boolean;
  /** Enforce Agent Skills frontmatter/name/description rules for catalogue APIs. */
  strictSkills?: boolean;
}

export interface ResourceMarkdownDocument {
  attributes: Record<string, string>;
  body: string;
  frontmatter: boolean;
}

interface SelectedResourceFile {
  filePath: string;
  provenance: ResourceProvenance;
}

interface SelectorOrigin {
  scope: ResourceScope;
  source: ResourceSource;
  trusted: boolean;
}

export function parseResourceMarkdown(source: string): ResourceMarkdownDocument {
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { attributes: {}, body: normalized.trim(), frontmatter: false };
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) throw new Error('Resource frontmatter is not terminated.');

  const attributes: Record<string, string> = {};
  for (const line of normalized.slice(4, end).split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) throw new Error('Resource frontmatter contains an invalid line.');
    const key = match[1].toLowerCase();
    if (Object.hasOwn(attributes, key)) throw new Error(`Resource frontmatter repeats ${key}.`);
    if (Object.keys(attributes).length >= 64) throw new Error('Resource frontmatter has too many attributes.');
    attributes[key] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return { attributes, body: normalized.slice(end + 5).trim(), frontmatter: true };
}

function normalizeResourceName(value: string): string {
  const name = value.trim().toLowerCase().replace(/\s+/g, '-');
  if (Buffer.byteLength(name) > 128 || !/^[a-z][a-z0-9:_-]*$/.test(name)) {
    throw new Error('Resource name is invalid.');
  }
  return name;
}

function boundedMetadata(value: string | undefined, label: string, maxBytes: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.includes('\0') || Buffer.byteLength(normalized) > maxBytes) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

const MAX_RESOURCE_FILES = 10_000;
const MAX_RESOURCE_SCAN_ENTRIES = 100_000;
const MAX_RESOURCE_BYTES = 1024 * 1024;
const MAX_RESOURCE_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_RESOURCE_DESCRIPTION_BYTES = 4 * 1024;
const MAX_TEMPLATE_OUTPUT_BYTES = 4 * 1024 * 1024;
const GLOB_MAGIC = /[*?[\]{}]/;
const MAX_TEMPLATE_ARGUMENTS = 256;
const MAX_TEMPLATE_INPUT_BYTES = 64 * 1024;

class ResourceAggregateLimitError extends Error {
  constructor() {
    super('Resources exceed the aggregate size limit.');
    this.name = 'ResourceAggregateLimitError';
  }
}

/** Parse command arguments without invoking a shell. */
export function parseResourceCommandLine(input: string): string[] {
  if (Buffer.byteLength(input) > MAX_TEMPLATE_INPUT_BYTES) throw new Error('Resource command input is too large.');
  const result: string[] = [];
  let token = '';
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let tokenStarted = false;
  const push = (): void => {
    if (!tokenStarted) return;
    if (result.length >= MAX_TEMPLATE_ARGUMENTS) throw new Error('Resource command has too many arguments.');
    result.push(token);
    token = '';
    tokenStarted = false;
  };
  for (const character of input.trim()) {
    if (escaped) {
      token += character;
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
      tokenStarted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/\s/u.test(character)) {
      push();
      continue;
    }
    token += character;
    tokenStarted = true;
  }
  if (escaped) token += '\\';
  if (quote) throw new Error('Resource command contains an unterminated quote.');
  push();
  return result;
}

async function pathContainsSymbolicLink(candidate: string): Promise<boolean> {
  const absolute = path.resolve(candidate);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

async function findFiles(root: string, matcher: (name: string) => boolean, maxDepth = 3): Promise<string[]> {
  if (await pathContainsSymbolicLink(root)) return [];
  let rootInfo;
  try { rootInfo = await lstat(root); }
  catch { return []; }
  if (rootInfo.isSymbolicLink()) return [];
  if (rootInfo.isFile()) return matcher(path.basename(root)) ? [root] : [];
  if (!rootInfo.isDirectory()) return [];
  const found: string[] = [];
  let scannedEntries = 0;

  async function walk(directory: string, depth: number): Promise<void> {
    if (scannedEntries >= MAX_RESOURCE_SCAN_ENTRIES) {
      throw new Error('Resource inventory exceeds its entry limit.');
    }
    const listing = await readStableDirectoryEntries(directory, MAX_RESOURCE_SCAN_ENTRIES - scannedEntries);
    scannedEntries += listing.entries.length;
    if (listing.truncated) throw new Error('Resource inventory exceeds its entry limit.');
    listing.entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of listing.entries) {
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

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function applyResourceSelectors(
  selected: Map<string, SelectedResourceFile>,
  selectors: readonly string[],
  matcher: (name: string) => boolean,
  errors: Error[],
  origin: SelectorOrigin,
  blockedProjectRoot?: string,
  classificationProjectRoot?: string,
  trustedGlobalRoot?: string,
): Promise<void> {
  for (const rawSelector of selectors.slice(0, 512)) {
    const marker = rawSelector[0] === '+' || rawSelector[0] === '-' || rawSelector[0] === '!'
      ? rawSelector[0] : '';
    const value = marker ? rawSelector.slice(1) : rawSelector;
    if (!value) continue;
    const selector = path.resolve(value);
    const searchRoot = path.resolve(globSearchRoot(selector));
    const operatorOwned = trustedGlobalRoot !== undefined && inside(trustedGlobalRoot, searchRoot);
    const effectiveBlockedRoot = operatorOwned ? undefined : blockedProjectRoot;
    const effectiveClassificationRoot = operatorOwned ? undefined : classificationProjectRoot;
    if (effectiveBlockedRoot
      && (inside(effectiveBlockedRoot, searchRoot) || inside(searchRoot, effectiveBlockedRoot))) {
      continue;
    }
    if (marker === '-' || marker === '!') {
      for (const [key, selectedFile] of selected) {
        const excluded = marker === '!'
          ? matchesGlob(selectedFile.filePath, selector)
          : selectedFile.filePath === selector || selectedFile.filePath.startsWith(`${selector}${path.sep}`);
        if (excluded) selected.delete(key);
      }
      continue;
    }
    try {
      for (const filePath of await selectorFiles(selector, matcher)) {
        if (selected.size >= MAX_RESOURCE_FILES) break;
        const absolute = path.resolve(filePath);
        if (effectiveBlockedRoot && inside(effectiveBlockedRoot, absolute)) continue;
        selected.set(absolute, {
          filePath: absolute,
          provenance: {
            ...origin,
            ...(effectiveClassificationRoot && inside(effectiveClassificationRoot, absolute)
              ? { scope: 'project' as const, trusted: true }
              : {}),
            origin: 'top-level',
            path: absolute,
            selector: rawSelector,
          },
        });
      }
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

export async function readBoundedResourceText(
  filePath: string,
  maxBytes = MAX_RESOURCE_BYTES,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_RESOURCE_TOTAL_BYTES) {
    throw new Error('Resource size limit is invalid.');
  }
  const absolute = path.resolve(filePath);
  const parentPath = path.dirname(absolute);
  let parentHandle;
  let handle;
  try {
    parentHandle = await openStableDirectoryHandle(parentPath);
    const parentOpened = await parentHandle.stat();
    const parentBefore = await lstat(parentPath);
    if (!parentOpened.isDirectory() || !parentBefore.isDirectory() || parentBefore.isSymbolicLink()
      || parentOpened.dev !== parentBefore.dev || parentOpened.ino !== parentBefore.ino) {
      throw new Error(`Resource parent changed while it was being opened: ${filePath}`);
    }
    const anchoredPath = process.platform === 'linux'
      ? `/proc/self/fd/${parentHandle.fd}/${path.basename(absolute)}`
      : absolute;
    const before = await lstat(anchoredPath);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1) {
      throw new Error(`Resource must be a private regular file and cannot be a symbolic link or hard link: ${filePath}`);
    }
    if (before.size > maxBytes) throw new Error(`Resource exceeds the ${maxBytes} byte limit: ${filePath}`);
    handle = await open(
      anchoredPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
    );
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev
      || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error(`Resource changed while it was being opened: ${filePath}`);
    }
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const [after, targetAfter, parentAfter, parentPathAfter] = await Promise.all([
      handle.stat(),
      lstat(anchoredPath),
      parentHandle.stat(),
      lstat(parentPath),
    ]);
    if (offset !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino
      || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || after.nlink !== 1 || !targetAfter.isFile() || targetAfter.isSymbolicLink() || targetAfter.nlink !== 1
      || targetAfter.dev !== after.dev || targetAfter.ino !== after.ino || targetAfter.size !== after.size
      || targetAfter.mtimeMs !== after.mtimeMs || targetAfter.ctimeMs !== after.ctimeMs
      || parentAfter.dev !== parentOpened.dev || parentAfter.ino !== parentOpened.ino
      || !parentPathAfter.isDirectory() || parentPathAfter.isSymbolicLink()
      || parentPathAfter.dev !== parentOpened.dev || parentPathAfter.ino !== parentOpened.ino) {
      throw new Error(`Resource changed while it was being read: ${filePath}`);
    }
    const content = bytes.subarray(0, offset);
    if (content.includes(0)) throw new Error(`Resource must be UTF-8 text, not binary data: ${filePath}`);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(content); }
    catch { throw new Error(`Resource is not valid UTF-8 text: ${filePath}`); }
  } finally {
    await handle?.close().catch(() => undefined);
    await parentHandle?.close().catch(() => undefined);
  }
}

/** Agent Skills Spec and markdown prompt discovery for the CLI. */
export class ResourceManager {
  private readonly cwd: string;
  private readonly homeDir: string;
  private readonly agentDir: string;
  private readonly agentDirTrusted: boolean;
  private readonly projectTrusted: boolean;
  private readonly extraSkillPaths: string[];
  private readonly extraPromptPaths: string[];
  private readonly globalSkillPaths: string[];
  private readonly projectSkillPaths: string[];
  private readonly globalPromptPaths: string[];
  private readonly projectPromptPaths: string[];
  private readonly globalPackageSkillPaths: string[];
  private readonly projectPackageSkillPaths: string[];
  private readonly globalPackagePromptPaths: string[];
  private readonly projectPackagePromptPaths: string[];
  private readonly disableSkills: boolean;
  private readonly disablePrompts: boolean;
  private readonly strictSkills: boolean;
  private readonly skills = new Map<string, SkillDefinition>();
  private readonly skillCandidates: SkillDefinition[] = [];
  private readonly prompts = new Map<string, PromptDefinition>();
  private readonly shadowed: ResourceInventoryItem[] = [];
  private loadedResourceBytes = 0;

  constructor(options: ResourceManagerOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.homeDir = options.homeDir ?? os.homedir();
    this.agentDir = path.resolve(options.agentDir ?? path.join(this.homeDir, '.ai-harness'));
    this.agentDirTrusted = options.agentDirTrusted === true;
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
    this.globalPackageSkillPaths = resolve(options.globalPackageSkillPaths ?? []);
    this.projectPackageSkillPaths = resolve(options.projectPackageSkillPaths ?? []);
    this.globalPackagePromptPaths = resolve(options.globalPackagePromptPaths ?? []);
    this.projectPackagePromptPaths = resolve(options.projectPackagePromptPaths ?? []);
    this.disableSkills = options.disableSkills === true;
    this.disablePrompts = options.disablePrompts === true;
    this.strictSkills = options.strictSkills === true;
  }

  async loadAll(): Promise<{ skills: number; prompts: number; errors: Error[] }> {
    this.skills.clear();
    this.skillCandidates.length = 0;
    this.prompts.clear();
    this.shadowed.length = 0;
    this.loadedResourceBytes = 0;
    const errors: Error[] = [];
    const userAuto: SelectorOrigin = { scope: 'user', source: 'auto', trusted: true };
    const userPackage: SelectorOrigin = { scope: 'user', source: 'package', trusted: true };
    const userSettings: SelectorOrigin = { scope: 'user', source: 'settings', trusted: true };
    const projectAuto: SelectorOrigin = { scope: 'project', source: 'auto', trusted: true };
    const projectPackage: SelectorOrigin = { scope: 'project', source: 'package', trusted: true };
    const projectSettings: SelectorOrigin = { scope: 'project', source: 'settings', trusted: true };
    const explicit: SelectorOrigin = { scope: 'temporary', source: 'cli', trusted: true };
    const blockedExplicitProject = this.projectTrusted ? undefined : this.cwd;
    const trustedGlobalRoot = this.agentDirTrusted ? this.agentDir : undefined;

    const skillMatcher = (name: string): boolean => name.toLowerCase() === 'skill.md';
    const skillFiles = new Map<string, SelectedResourceFile>();
    if (!this.disableSkills) {
    await applyResourceSelectors(skillFiles, [
      path.join(this.homeDir, '.agents', 'skills'),
      path.join(this.agentDir, 'skills'),
    ], skillMatcher, errors, userAuto, blockedExplicitProject, this.cwd, trustedGlobalRoot);
    await applyResourceSelectors(
      skillFiles, this.globalPackageSkillPaths, skillMatcher, errors,
      userPackage, blockedExplicitProject, this.cwd, trustedGlobalRoot,
    );
    await applyResourceSelectors(
      skillFiles, this.globalSkillPaths, skillMatcher, errors,
      userSettings, blockedExplicitProject, this.cwd, trustedGlobalRoot,
    );
    if (this.projectTrusted) {
      await applyResourceSelectors(
        skillFiles, this.projectPackageSkillPaths, skillMatcher, errors, projectPackage, undefined, this.cwd,
      );
      await applyResourceSelectors(skillFiles, [
        path.join(this.cwd, '.agents', 'skills'),
        path.join(this.cwd, '.ai-harness', 'skills'),
      ], skillMatcher, errors, projectAuto, undefined, this.cwd);
      await applyResourceSelectors(
        skillFiles, this.projectSkillPaths, skillMatcher, errors, projectSettings, undefined, this.cwd,
      );
    }
    await applyResourceSelectors(
      skillFiles, this.extraSkillPaths, skillMatcher, errors,
      explicit, blockedExplicitProject, this.cwd, trustedGlobalRoot,
    );
    for (const selected of skillFiles.values()) {
      try {
        const skill = await this.parseSkill(selected);
        this.skillCandidates.push(skill);
        const previous = this.skills.get(skill.name);
        if (previous) this.shadowed.push(this.inventoryItem('skill', previous, false));
        this.skills.set(skill.name, skill);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
        if (error instanceof ResourceAggregateLimitError) break;
      }
    }
    }

    const promptMatcher = (name: string): boolean => name.toLowerCase().endsWith('.md');
    const promptFiles = new Map<string, SelectedResourceFile>();
    if (!this.disablePrompts) {
    await applyResourceSelectors(promptFiles, [
      path.join(this.agentDir, 'prompts'),
    ], promptMatcher, errors, userAuto, blockedExplicitProject, this.cwd, trustedGlobalRoot);
    await applyResourceSelectors(
      promptFiles, this.globalPackagePromptPaths, promptMatcher, errors,
      userPackage, blockedExplicitProject, this.cwd, trustedGlobalRoot,
    );
    await applyResourceSelectors(
      promptFiles, this.globalPromptPaths, promptMatcher, errors,
      userSettings, blockedExplicitProject, this.cwd, trustedGlobalRoot,
    );
    if (this.projectTrusted) {
      await applyResourceSelectors(
        promptFiles, this.projectPackagePromptPaths, promptMatcher, errors, projectPackage, undefined, this.cwd,
      );
      await applyResourceSelectors(promptFiles, [
        path.join(this.cwd, '.ai-harness', 'prompts'),
        path.join(this.cwd, 'prompts'),
      ], promptMatcher, errors, projectAuto, undefined, this.cwd);
      await applyResourceSelectors(
        promptFiles, this.projectPromptPaths, promptMatcher, errors, projectSettings, undefined, this.cwd,
      );
    }
    await applyResourceSelectors(
      promptFiles, this.extraPromptPaths, promptMatcher, errors,
      explicit, blockedExplicitProject, this.cwd, trustedGlobalRoot,
    );
    for (const selected of promptFiles.values()) {
      try {
        const prompt = await this.parsePrompt(selected);
        const previous = this.prompts.get(prompt.name);
        if (previous) this.shadowed.push(this.inventoryItem('prompt', previous, false));
        this.prompts.set(prompt.name, prompt);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
        if (error instanceof ResourceAggregateLimitError) break;
      }
    }
    }

    return { skills: this.skills.size, prompts: this.prompts.size, errors };
  }

  listSkills(): SkillDefinition[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Every valid candidate in precedence order, including collision losers. */
  listSkillCandidates(): SkillDefinition[] {
    return this.skillCandidates.map(skill => structuredClone(skill));
  }

  listPrompts(): PromptDefinition[] {
    return [...this.prompts.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Metadata-only inventory includes collision losers without resource bodies. */
  listInventory(): ResourceInventoryItem[] {
    return [
      ...this.shadowed,
      ...this.listSkills().map(skill => this.inventoryItem('skill', skill, true)),
      ...this.listPrompts().map(prompt => this.inventoryItem('prompt', prompt, true)),
    ].map(item => structuredClone(item)).sort((left, right) => left.kind.localeCompare(right.kind)
      || left.name.localeCompare(right.name)
      || Number(right.active) - Number(left.active)
      || left.provenance.path.localeCompare(right.provenance.path));
  }

  getSkill(name: string): SkillDefinition | undefined {
    if (typeof name !== 'string' || Buffer.byteLength(name) > 128) return undefined;
    return this.skills.get(name.trim().toLowerCase());
  }

  getPrompt(name: string): PromptDefinition | undefined {
    if (typeof name !== 'string' || Buffer.byteLength(name) > 128) return undefined;
    return this.prompts.get(name.trim().toLowerCase());
  }

  getModelInvocableSkills(): SkillDefinition[] {
    return this.listSkills().filter(skill => !skill.disableModelInvocation);
  }

  invokeSkill(name: string, request = ''): string {
    const skill = this.getSkill(name);
    if (!skill) throw new Error('Unknown skill.');
    if (typeof request !== 'string' || Buffer.byteLength(request) > MAX_RESOURCE_BYTES) {
      throw new Error('Skill invocation input is too large.');
    }
    return [
      `<skill name="${skill.name}">`,
      skill.instructions,
      '</skill>',
      request.trim(),
    ].filter(Boolean).join('\n\n');
  }

  expandPrompt(name: string, args: string[]): string {
    const prompt = this.getPrompt(name);
    if (!prompt) throw new Error('Unknown prompt.');
    if (!Array.isArray(args) || args.length > MAX_TEMPLATE_ARGUMENTS) {
      throw new Error('Resource command has too many arguments.');
    }
    let argumentBytes = Math.max(0, args.length - 1);
    for (const argument of args) {
      if (typeof argument !== 'string') throw new Error('Resource command argument is invalid.');
      argumentBytes += Buffer.byteLength(argument);
      if (argumentBytes > MAX_TEMPLATE_INPUT_BYTES) throw new Error('Resource command input is too large.');
    }
    const all = args.join(' ');
    const token = /\$\{@:-([^}]*)\}|\$\{@:(\d+):(\d+)\}|\$\{@:(\d+)\}|\$ARGUMENTS|\$@|\$\{(\d+):-([^}]*)\}|\$(\d+)/g;
    const output: string[] = [];
    let outputBytes = 0;
    let offset = 0;
    const append = (value: string): void => {
      outputBytes += Buffer.byteLength(value);
      if (outputBytes > MAX_TEMPLATE_OUTPUT_BYTES) throw new Error('Expanded prompt exceeds its output limit.');
      output.push(value);
    };
    for (const match of prompt.content.matchAll(token)) {
      const index = match.index!;
      append(prompt.content.slice(offset, index));
      let replacement: string;
      if (match[1] !== undefined) replacement = all || match[1];
      else if (match[2] !== undefined) {
        const start = Math.max(0, Number(match[2]) - 1);
        const length = Math.max(0, Number(match[3]));
        replacement = Number.isFinite(start) && Number.isFinite(length)
          ? args.slice(start, start + length).join(' ')
          : '';
      } else if (match[4] !== undefined) {
        const start = Math.max(0, Number(match[4]) - 1);
        replacement = Number.isFinite(start) ? args.slice(start).join(' ') : '';
      } else if (match[0] === '$ARGUMENTS' || match[0] === '$@') replacement = all;
      else if (match[5] !== undefined) replacement = args[Number(match[5]) - 1] ?? match[6] ?? '';
      else replacement = args[Number(match[7]) - 1] ?? '';
      append(replacement);
      offset = index + match[0].length;
    }
    append(prompt.content.slice(offset));
    return output.join('');
  }

  expandPromptLine(name: string, input: string): string {
    return this.expandPrompt(name, parseResourceCommandLine(input));
  }

  private inventoryItem(
    kind: ResourceInventoryItem['kind'],
    resource: SkillDefinition | PromptDefinition,
    active: boolean,
  ): ResourceInventoryItem {
    return {
      kind,
      name: resource.name,
      ...(resource.description ? { description: resource.description } : {}),
      active,
      provenance: structuredClone(resource.provenance),
    };
  }

  private async readResource(filePath: string): Promise<string> {
    if (this.loadedResourceBytes >= MAX_RESOURCE_TOTAL_BYTES) throw new ResourceAggregateLimitError();
    const content = await readBoundedResourceText(filePath);
    const bytes = Buffer.byteLength(content);
    if (bytes > MAX_RESOURCE_TOTAL_BYTES - this.loadedResourceBytes) throw new ResourceAggregateLimitError();
    this.loadedResourceBytes += bytes;
    return content;
  }

  private async parseSkill(selected: SelectedResourceFile): Promise<SkillDefinition> {
    const { filePath, provenance } = selected;
    const document = parseResourceMarkdown(await this.readResource(filePath));
    const fallbackName = path.basename(path.dirname(filePath));
    if (this.strictSkills && !document.frontmatter) throw new Error('Agent Skills frontmatter is required.');
    if (this.strictSkills && !document.attributes.name) throw new Error('Skill frontmatter requires name.');
    if (this.strictSkills && !document.attributes.description) throw new Error('Skill frontmatter requires description.');
    const name = normalizeResourceName(document.attributes.name || fallbackName);
    if (this.strictSkills && (document.attributes.name !== name || name !== normalizeResourceName(fallbackName))) {
      throw new Error('Skill name must match its directory name.');
    }
    if (!document.body) throw new Error(`Empty skill resource: ${filePath}`);
    const description = boundedMetadata(
      document.attributes.description || name,
      'Skill description',
      MAX_RESOURCE_DESCRIPTION_BYTES,
    )!;
    const version = boundedMetadata(document.attributes.version, 'Skill version', 128);
    const invocation = document.attributes['disable-model-invocation'];
    if (invocation !== undefined && invocation !== 'true' && invocation !== 'false') {
      throw new Error('disable-model-invocation must be true or false.');
    }
    return {
      name,
      description,
      ...(version ? { version } : {}),
      disableModelInvocation: invocation === 'true',
      instructions: document.body,
      filePath,
      provenance,
    };
  }

  private async parsePrompt(selected: SelectedResourceFile): Promise<PromptDefinition> {
    const { filePath, provenance } = selected;
    const document = parseResourceMarkdown(await this.readResource(filePath));
    const name = normalizeResourceName(document.attributes.name || path.basename(filePath, path.extname(filePath)));
    if (!document.body) throw new Error(`Empty prompt resource: ${filePath}`);
    const explicitDescription = boundedMetadata(
      document.attributes.description,
      'Prompt description',
      MAX_RESOURCE_DESCRIPTION_BYTES,
    );
    const firstLine = document.body.split('\n').find(line => line.trim())?.trim();
    const inferredDescription = firstLine && Buffer.byteLength(firstLine) <= MAX_RESOURCE_DESCRIPTION_BYTES
      ? firstLine
      : undefined;
    const argumentHint = boundedMetadata(document.attributes['argument-hint'], 'Prompt argument hint', 4_096);
    return {
      name,
      ...(explicitDescription || inferredDescription ? { description: explicitDescription ?? inferredDescription } : {}),
      ...(argumentHint ? { argumentHint } : {}),
      content: document.body,
      filePath,
      provenance,
    };
  }
}
