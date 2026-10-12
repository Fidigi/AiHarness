import {
  CODEMODE_REGISTRATION, CODEMODE_TOOL_NAME, collectCodemodeStore, isNestedCallable, runCodemode,
  CODEMODE_EXTENSION_ID, CODEMODE_LIMITS, type CodemodeSettings, type HostedCodemodeTool,
} from './codemode.js';
import type {
  ExtensionRuntimeContext,
  ExtensionTool,
  ExtensionToolResult,
} from '../extensions/extension-registry.js';
import {
  agentToolExposure,
  isDeclaredToolExposure,
  isSearchableToolExposure,
  selectRegisteredTools,
  type AgentToolNamespace,
  type RegisteredAgentTool,
  type ToolSelectionOptions,
} from './tool-selection.js';

export const TOOL_SEARCH_TOOL_NAME = 'tool_search';
export const TOOL_SEARCH_EXTENSION_ID = 'builtin:tool-search';
export const DEFAULT_TOOL_SEARCH_LIMIT = 8;
export const MAX_TOOL_SEARCH_LIMIT = 50;
export const MAX_TOOL_SEARCH_CANDIDATES = 2_000;
export const MAX_TOOL_SEARCH_LOADED = 1_000;
export const TOOL_SEARCH_METADATA_KEY = 'toolSearch';

const MAX_QUERY_BYTES = 4 * 1024;
const MAX_DOCUMENT_CHARS = 8 * 1024;
const MAX_SCHEMA_NODES = 1_000;
const MAX_SCHEMA_DEPTH = 64;
const MAX_RESULT_DESCRIPTION_CHARS = 500;
const MAX_PERSISTED_TOOL_NAME_CHARS = 256;
const MAX_TOOL_SEARCH_BRANCH_ENTRIES = 100_000;

export const TOOL_SEARCH_DESCRIPTION = [
  '# Tool discovery',
  '',
  'Searches deferred tool metadata with BM25 and exposes matching tools for the next model call.',
  '',
  `Some tools, including MCP tools, are intentionally not declared up front. Use \`${TOOL_SEARCH_TOOL_NAME}\` to find and load only the tools needed for the task.`,
].join('\n');

export const TOOL_SEARCH_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', description: 'Search query for deferred tools.' },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_TOOL_SEARCH_LIMIT,
      description: `Maximum number of tools to load. Defaults to ${DEFAULT_TOOL_SEARCH_LIMIT}.`,
    },
  },
  required: ['query'],
};

/** Metadata-only descriptor used to apply the normal tool-selection policy. */
export const TOOL_SEARCH_REGISTRATION: RegisteredAgentTool = {
  name: TOOL_SEARCH_TOOL_NAME,
  description: TOOL_SEARCH_DESCRIPTION,
  parameters: TOOL_SEARCH_PARAMETERS,
  extensionId: TOOL_SEARCH_EXTENSION_ID,
  exposure: 'model-only',
};

export interface ToolSearchDocument {
  name: string;
  text: string;
}

export interface ToolSearchMatch {
  name: string;
  score: number;
}

export interface ToolRanker {
  rank(query: string, documents: readonly ToolSearchDocument[], limit: number): ToolSearchMatch[];
}

export interface ToolSearchResultDetails {
  loaded: string[];
}

export interface ToolSearchInput {
  query: string;
  limit?: number;
}

export type HostedToolSearchTool = ExtensionTool<Record<string, unknown>, ToolSearchResultDetails> & {
  extensionId: typeof TOOL_SEARCH_EXTENSION_ID;
  exposure: 'model-only';
};

export interface ToolSearchLoadout<T extends RegisteredAgentTool> {
  /** Direct/model-only tools, the discovery tool, and branch-loaded matches. */
  getTools(): Array<T | HostedToolSearchTool | HostedCodemodeTool>;
  /** True only for the synthetic search tool owned by this loadout. */
  isToolSearch(name: string): boolean;
  executeToolSearch(
    input: unknown,
    context: ExtensionRuntimeContext,
    signal?: AbortSignal,
  ): Promise<ExtensionToolResult<ToolSearchResultDetails>>;
  /** Trusted activation metadata for a result issued by this loadout. */
  activatedTools(name: string, result: ExtensionToolResult): string[] | undefined;
}

export interface CreateToolSearchLoadoutOptions<T extends RegisteredAgentTool> {
  enabled?: boolean;
  /** A connecting dynamic source can make discovery useful before its schemas are available. */
  potentialSearchableTools?: boolean;
  initialLoadedTools?: Iterable<string>;
  /** Current non-direct tools; called before each model turn without waiting for connections. */
  currentSearchableTools?: () => readonly T[];
  /** Wait for dynamic metadata only when the model explicitly searches. */
  refreshSearchableTools?: (signal?: AbortSignal) => Promise<readonly T[]>;
}

export interface DynamicAgentToolSource<T extends RegisteredAgentTool> {
  directTools: readonly T[];
  hasPotentialSearchableTools: boolean;
  currentSearchableTools(): readonly T[];
  waitForSearchableTools(signal?: AbortSignal): Promise<readonly T[]>;
  has(name: string): boolean;
}

export interface AgentToolLoadout<TStatic extends RegisteredAgentTool, TDynamic extends RegisteredAgentTool>
  extends ToolSearchLoadout<TStatic | TDynamic> {
  /** True when a selected dynamic source, rather than the static registry, owns this name. */
  isDynamicTool(name: string): boolean;
  isCodemode(name: string): boolean;
  executeCodemode(input: unknown, context: ExtensionRuntimeContext,
    execute: (name: string, input: unknown, context: ExtensionRuntimeContext, signal?: AbortSignal) => Promise<ExtensionToolResult>,
    signal?: AbortSignal): Promise<ExtensionToolResult>;
  resultMetadata(name: string, result: ExtensionToolResult): Record<string, unknown> | undefined;
}

export interface CreateAgentToolLoadoutOptions<
  TStatic extends RegisteredAgentTool,
  TDynamic extends RegisteredAgentTool,
> {
  staticTools: readonly TStatic[];
  dynamicSource?: DynamicAgentToolSource<TDynamic>;
  selection?: ToolSelectionOptions;
  initialLoadedTools?: Iterable<string>;
  codemode?: CodemodeSettings;
  redactText?: (value: string) => string;
  currentStaticTools?: () => readonly TStatic[];
}

const STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it',
  'of', 'on', 'or', 'that', 'the', 'this', 'to', 'with',
]);

function stem(term: string): string {
  if (term.length > 4 && term.endsWith('ies')) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && /(ches|shes|sses|xes|zes)$/u.test(term)) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith('s') && !term.endsWith('ss')) return term.slice(0, -1);
  return term;
}

/** Lowercase terms, split camelCase/non-alphanumerics, drop stop words, and fold basic plurals. */
export function tokenizeToolSearchText(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(term => term.length > 0 && !STOP_WORDS.has(term))
    .map(stem);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface DocumentBudget {
  nodes: number;
  chars: number;
  seen: WeakSet<object>;
}

function appendDocumentPart(parts: string[], value: string, budget: DocumentBudget): void {
  const remaining = MAX_DOCUMENT_CHARS - budget.chars;
  if (remaining <= 0) return;
  const part = value.slice(0, remaining);
  if (!part.trim()) return;
  parts.push(part);
  budget.chars += part.length + 1;
}

function schemaText(schema: unknown, parts: string[], budget: DocumentBudget, depth = 0): void {
  if (!isRecord(schema) || depth >= MAX_SCHEMA_DEPTH || budget.nodes >= MAX_SCHEMA_NODES
    || budget.chars >= MAX_DOCUMENT_CHARS || budget.seen.has(schema)) return;
  budget.nodes++;
  budget.seen.add(schema);
  if (typeof schema.description === 'string') appendDocumentPart(parts, schema.description, budget);
  if (isRecord(schema.properties)) {
    for (const [name, property] of Object.entries(schema.properties)) {
      if (budget.nodes >= MAX_SCHEMA_NODES || budget.chars >= MAX_DOCUMENT_CHARS) break;
      appendDocumentPart(parts, name, budget);
      schemaText(property, parts, budget, depth + 1);
    }
  }
  schemaText(schema.items, parts, budget, depth + 1);
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const variants = schema[key];
    if (!Array.isArray(variants)) continue;
    for (const variant of variants) schemaText(variant, parts, budget, depth + 1);
  }
}

/** Build bounded ranking text from a tool declaration and optional namespace metadata. */
export function createToolSearchDocument(
  tool: Pick<RegisteredAgentTool, 'name' | 'description' | 'parameters'>,
  namespace?: AgentToolNamespace,
): ToolSearchDocument {
  const parts: string[] = [];
  const budget: DocumentBudget = { nodes: 0, chars: 0, seen: new WeakSet() };
  appendDocumentPart(parts, tool.name, budget);
  appendDocumentPart(parts, tool.name.replaceAll('_', ' '), budget);
  appendDocumentPart(parts, tool.description, budget);
  schemaText(tool.parameters, parts, budget);
  if (namespace) {
    appendDocumentPart(parts, namespace.name, budget);
    appendDocumentPart(parts, namespace.description ?? '', budget);
    appendDocumentPart(parts, namespace.instructions ?? '', budget);
  }
  return { name: tool.name, text: parts.join(' ').slice(0, MAX_DOCUMENT_CHARS) };
}

/** Deterministic Okapi BM25 ranker. Ties retain input order. */
export class Bm25ToolRanker implements ToolRanker {
  private readonly k1: number;
  private readonly b: number;

  constructor(options: { k1?: number; b?: number } = {}) {
    this.k1 = options.k1 ?? 1.2;
    this.b = options.b ?? 0.75;
  }

  rank(query: string, documents: readonly ToolSearchDocument[], limit: number): ToolSearchMatch[] {
    const queryTerms = [...new Set(tokenizeToolSearchText(query))].slice(0, 64);
    if (queryTerms.length === 0 || documents.length === 0 || limit <= 0) return [];
    const termCounts = documents.map(document => {
      const counts = new Map<string, number>();
      for (const term of tokenizeToolSearchText(document.text)) {
        counts.set(term, (counts.get(term) ?? 0) + 1);
      }
      return counts;
    });
    const lengths = termCounts.map(counts => [...counts.values()].reduce((sum, count) => sum + count, 0));
    const averageLength = lengths.reduce((sum, length) => sum + length, 0) / documents.length || 1;
    const idf = new Map(queryTerms.map(term => {
      const frequency = termCounts.filter(counts => counts.has(term)).length;
      return [term, Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))] as const;
    }));
    const matches: Array<ToolSearchMatch & { index: number }> = [];
    documents.forEach((document, index) => {
      let score = 0;
      for (const term of queryTerms) {
        const count = termCounts[index]!.get(term);
        if (!count) continue;
        const norm = this.k1 * (1 - this.b + (this.b * lengths[index]!) / averageLength);
        score += (idf.get(term) ?? 0) * ((count * (this.k1 + 1)) / (count + norm));
      }
      if (score > 0) matches.push({ name: document.name, score, index });
    });
    return matches
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, limit)
      .map(({ name, score }) => ({ name, score }));
  }
}

function normalizedName(name: string): string {
  return name.trim().toLowerCase();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Tool search was aborted.');
  error.name = 'AbortError';
  throw error;
}

function parseInput(input: unknown): ToolSearchInput {
  if (!isRecord(input) || typeof input.query !== 'string') {
    throw new Error('tool_search input must contain a string query.');
  }
  const query = input.query.trim();
  if (!query) throw new Error('tool_search query must not be empty.');
  if (Buffer.byteLength(query, 'utf8') > MAX_QUERY_BYTES) {
    throw new Error(`tool_search query exceeds ${MAX_QUERY_BYTES} bytes.`);
  }
  const limit = input.limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > MAX_TOOL_SEARCH_LIMIT) {
    throw new Error(`tool_search limit must be an integer from 1 to ${MAX_TOOL_SEARCH_LIMIT}.`);
  }
  return { query, limit: Number(limit) };
}

function boundedToolNames(values: Iterable<string>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' || value.length > MAX_PERSISTED_TOOL_NAME_CHARS) continue;
    const normalized = normalizedName(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= MAX_TOOL_SEARCH_LOADED) break;
  }
  return result;
}

function firstLine(value: string): string {
  return value.slice(0, MAX_RESULT_DESCRIPTION_CHARS + 1)
    .trim()
    .split(/\r?\n/u, 1)[0]!
    .slice(0, MAX_RESULT_DESCRIPTION_CHARS);
}

function uniqueTools<T extends RegisteredAgentTool>(tools: readonly T[], blocked: ReadonlySet<string> = new Set()): T[] {
  const result: T[] = [];
  const seen = new Set(blocked);
  for (const tool of tools) {
    const name = normalizedName(tool.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push(tool);
    if (result.length >= MAX_TOOL_SEARCH_CANDIDATES) break;
  }
  return result;
}

/**
 * Compose a stable discovery tool without registering candidates globally. Searchable schemas are
 * withheld until a successful search, and each search result can be persisted by the shared loop.
 */
export function createToolSearchLoadout<T extends RegisteredAgentTool>(
  tools: readonly T[],
  options: CreateToolSearchLoadoutOptions<T> = {},
): ToolSearchLoadout<T> {
  const direct = uniqueTools(tools.filter(tool => isDeclaredToolExposure(agentToolExposure(tool))));
  const directNames = new Set(direct.map(tool => normalizedName(tool.name)));
  const registeredSearch = tools.some(tool => normalizedName(tool.name) === TOOL_SEARCH_TOOL_NAME);
  const loadedNames = new Set(boundedToolNames(options.initialLoadedTools ?? []));
  const issuedDetails = new WeakSet<object>();
  let searchable = new Map<string, T>();

  const replaceSearchable = (values: readonly T[]): void => {
    const blocked = new Set(directNames);
    blocked.add(TOOL_SEARCH_TOOL_NAME);
    const next = uniqueTools(
      values.filter(tool => isSearchableToolExposure(agentToolExposure(tool))),
      blocked,
    );
    searchable = new Map(next.map(tool => [normalizedName(tool.name), tool]));
  };
  replaceSearchable(tools);

  const refreshCurrent = (): void => {
    if (options.currentSearchableTools) replaceSearchable(options.currentSearchableTools());
  };

  const searchEnabled = options.enabled !== false
    && !registeredSearch
    && (searchable.size > 0 || options.potentialSearchableTools === true);

  const searchTool: HostedToolSearchTool | undefined = searchEnabled ? {
    ...TOOL_SEARCH_REGISTRATION,
    extensionId: TOOL_SEARCH_EXTENSION_ID,
    exposure: 'model-only',
    async execute(input, _context, signal) {
      throwIfAborted(signal);
      const parsed = parseInput(input);
      if (options.refreshSearchableTools) {
        replaceSearchable(await options.refreshSearchableTools(signal));
        throwIfAborted(signal);
      } else {
        refreshCurrent();
      }
      for (const name of loadedNames) if (!searchable.has(name)) loadedNames.delete(name);
      const remaining = Math.max(0, MAX_TOOL_SEARCH_LOADED - loadedNames.size);
      const limit = Math.min(parsed.limit ?? DEFAULT_TOOL_SEARCH_LIMIT, remaining);
      const candidates = [...searchable.values()].filter(tool => !loadedNames.has(normalizedName(tool.name)));
      const documents = candidates.map(tool => createToolSearchDocument(tool, tool.namespace));
      const matches = new Bm25ToolRanker().rank(parsed.query, documents, limit);
      const loaded = matches.map(match => normalizedName(match.name));
      for (const name of loaded) loadedNames.add(name);
      const resultTools = loaded.map(name => searchable.get(name)).filter((tool): tool is T => Boolean(tool));
      const content = resultTools.length === 0
        ? remaining === 0
          ? `No tools loaded: the ${MAX_TOOL_SEARCH_LOADED}-tool activation limit was reached.`
          : 'No matching tools found.'
        : `Found ${resultTools.length} tool${resultTools.length === 1 ? '' : 's'}. Deferred tools are available from the next model call; codemode tools are script-only:\n${resultTools
            .map(tool => `- ${tool.name} (${agentToolExposure(tool)}): ${firstLine(tool.description)}`)
            .join('\n')}`;
      const details: ToolSearchResultDetails = { loaded };
      issuedDetails.add(details);
      return { content, details };
    },
  } : undefined;

  return {
    getTools() {
      refreshCurrent();
      const loaded = [...loadedNames]
        .map(name => searchable.get(name))
        .filter((tool): tool is T => Boolean(tool) && agentToolExposure(tool!) !== 'codemode');
      return [...direct, ...(searchTool ? [searchTool] : []), ...loaded];
    },
    isToolSearch(name) {
      return Boolean(searchTool) && normalizedName(name) === TOOL_SEARCH_TOOL_NAME;
    },
    async executeToolSearch(input, context, signal) {
      if (!searchTool) throw new Error('tool_search is not enabled for this tool loadout.');
      return searchTool.execute(input as Record<string, unknown>, context, signal);
    },
    activatedTools(name, result) {
      if (!searchTool || normalizedName(name) !== TOOL_SEARCH_TOOL_NAME) return undefined;
      const details = result.details;
      if (!isRecord(details) || !issuedDetails.has(details)) return undefined;
      return boundedToolNames(Array.isArray(details.loaded) ? details.loaded.filter(value => typeof value === 'string') : []);
    },
  };
}

function searchToolEnabled(selection: ToolSelectionOptions): boolean {
  if (selection.noBuiltInTools && selection.allowedTools === undefined) return false;
  return selectRegisteredTools([TOOL_SEARCH_REGISTRATION], selection).length === 1;
}

function selectedDynamicTools<T extends RegisteredAgentTool>(
  tools: readonly T[],
  selection: ToolSelectionOptions,
): T[] {
  return selectRegisteredTools(tools, {
    ...selection,
    // Dynamic MCP sources enforce read-only annotations before this generic policy sees names.
    preset: selection.preset === 'read-only' ? 'default' : selection.preset,
  });
}

/**
 * Apply one selection/collision policy to static extension tools and a prompt-local dynamic source.
 * Static selected tools win names. Deferred/codemode tools remain metadata-only until tool_search
 * loads them; hidden tools are unreachable.
 */
export function createAgentToolLoadout<
  TStatic extends RegisteredAgentTool,
  TDynamic extends RegisteredAgentTool,
>(options: CreateAgentToolLoadoutOptions<TStatic, TDynamic>): AgentToolLoadout<TStatic, TDynamic> {
  const selection = options.selection ?? {};
  const selectedStatic = selectRegisteredTools(options.staticTools, selection);
  const staticNames = new Set(selectedStatic.map(tool => normalizedName(tool.name)));
  const selectedDynamic = options.dynamicSource
    ? selectedDynamicTools(options.dynamicSource.directTools, selection)
      .filter(tool => !staticNames.has(normalizedName(tool.name)))
    : [];

  const currentSearchable = (): Array<TStatic | TDynamic> => {
    const staticSearchable = selectedStatic.filter(tool => isSearchableToolExposure(agentToolExposure(tool)));
    const dynamic = options.dynamicSource
      ? selectedDynamicTools(options.dynamicSource.currentSearchableTools(), selection)
        .filter(tool => !staticNames.has(normalizedName(tool.name)))
      : [];
    return [...staticSearchable, ...dynamic];
  };

  const loadout = createToolSearchLoadout<TStatic | TDynamic>(
    [...selectedStatic, ...selectedDynamic, ...currentSearchable()],
    {
      enabled: searchToolEnabled(selection),
      potentialSearchableTools: selectedStatic.some(tool => isSearchableToolExposure(agentToolExposure(tool)))
        || Boolean(options.dynamicSource?.hasPotentialSearchableTools),
      initialLoadedTools: options.initialLoadedTools,
      currentSearchableTools: currentSearchable,
      refreshSearchableTools: options.dynamicSource ? async signal => {
        const dynamic = selectedDynamicTools(
          await options.dynamicSource!.waitForSearchableTools(signal),
          selection,
        ).filter(tool => !staticNames.has(normalizedName(tool.name)));
        const staticSearchable = selectedStatic.filter(tool => isSearchableToolExposure(agentToolExposure(tool)));
        return [...staticSearchable, ...dynamic];
      } : undefined,
    },
  );

  const explicitlySelected = [...selection.allowedTools ?? [], ...selection.defaultTools ?? []]
    .some(name => normalizedName(name) === CODEMODE_TOOL_NAME);
  const eligible = selectRegisteredTools([CODEMODE_REGISTRATION], selection).length === 1
    && !(selection.noBuiltInTools && selection.allowedTools === undefined);
  const codemodeEnabled = options.codemode?.enabled !== false && eligible
    && !options.staticTools.some(tool => normalizedName(tool.name) === CODEMODE_TOOL_NAME)
    && ((explicitlySelected && options.codemode?.activation !== 'automatic')
      || options.codemode?.enabled === true || options.codemode?.activation === 'on'
      || (options.codemode !== undefined && (Boolean(options.dynamicSource?.hasPotentialSearchableTools)
        || selectedStatic.some(tool => isSearchableToolExposure(agentToolExposure(tool))))));
  const issuedResults = new WeakSet<ExtensionToolResult>();
  const nestedTools = (): Array<TStatic | TDynamic> => {
    const currentStatic = selectRegisteredTools(options.currentStaticTools?.() ?? options.staticTools, selection);
    const currentNames = new Set(currentStatic.map(tool => normalizedName(tool.name)));
    const dynamic = options.dynamicSource ? selectedDynamicTools([
      ...options.dynamicSource.directTools, ...options.dynamicSource.currentSearchableTools(),
    ], selection).filter(tool => !currentNames.has(normalizedName(tool.name))) : [];
    return [...currentStatic, ...dynamic].filter(isNestedCallable);
  };
  const codemodeTool: HostedCodemodeTool = {
    ...CODEMODE_REGISTRATION,
    extensionId: CODEMODE_EXTENSION_ID,
    exposure: 'model-only',
    execute: async () => { throw new Error('Codemode requires a hosted executor.'); },
  };
  return {
    ...loadout,
    getTools() {
      const tools = loadout.getTools();
      if (!codemodeEnabled) return tools;
      const budget = Math.min(12_000, Math.max(0, (options.codemode?.inlineBudget ?? 3_000) * 4));
      let inline = '';
      for (const tool of nestedTools()) {
        if (inline.length >= budget) break;
        let schema = '';
        try { schema = JSON.stringify(tool.parameters ?? {}); } catch { /* Cyclic trusted extension schema: use describeTool. */ }
        inline += `${tool.name}: ${tool.description.slice(0, 200)} ${schema}\n`.slice(0, budget - inline.length);
      }
      codemodeTool.description = `${CODEMODE_REGISTRATION.description}\n${inline}`;
      return [...(options.codemode?.mode === 'only' ? tools.filter(tool => !isNestedCallable(tool)) : tools), codemodeTool];
    },
    isCodemode: name => codemodeEnabled && normalizedName(name) === CODEMODE_TOOL_NAME,
    async executeCodemode(input, context, execute, signal) {
      if (!codemodeEnabled || !isRecord(input) || typeof input.code !== 'string'
        || Object.keys(input).some(key => key !== 'code')) throw new Error('Invalid or disabled codemode input.');
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(new Error('Codemode deadline exceeded.')), CODEMODE_LIMITS.timeoutMs);
      const boundedSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
      let rejectAbort!: (error: unknown) => void;
      const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
      const abort = () => rejectAbort(boundedSignal.reason ?? new Error('Codemode cancelled.'));
      boundedSignal.addEventListener('abort', abort, { once: true });
      if (boundedSignal.aborted) abort();
      try {
        const preparation = async () => {
          if (options.dynamicSource) await options.dynamicSource.waitForSearchableTools(boundedSignal);
          const session = context.currentSessionId ? context.sessionManager.get(context.currentSessionId) : undefined;
          const entries = session ? await context.sessionManager.getRawEntries(session.id) : [];
          return collectCodemodeStore(entries, session?.activeLeafId);
        };
        const store = await Promise.race([preparation(), cancelled]);
        const result = await runCodemode({ code: input.code, context, signal: boundedSignal, store,
          tools: nestedTools, execute, redact: options.redactText });
        issuedResults.add(result);
        return result;
      } finally {
        clearTimeout(timer);
        boundedSignal.removeEventListener('abort', abort);
      }
    },
    resultMetadata(name, result) {
      if (normalizedName(name) !== CODEMODE_TOOL_NAME || !issuedResults.has(result)) return undefined;
      return { codemode: result.details };
    },
    isDynamicTool(name) {
      const normalized = normalizedName(name);
      return !staticNames.has(normalized) && Boolean(options.dynamicSource?.has(normalized));
    },
  };
}

/** Read branch-local activations from trusted metadata emitted by the shared tool loop. */
export function collectToolSearchLoadedNames(
  entries: readonly unknown[],
  activeLeafId?: string,
): string[] {
  let branchEntries = entries;
  if (activeLeafId) {
    const byId = new Map<string, Record<string, unknown>>();
    for (const entry of entries) {
      if (isRecord(entry) && typeof entry.id === 'string') byId.set(entry.id, entry);
    }
    const reversed: Record<string, unknown>[] = [];
    const visited = new Set<string>();
    let cursor: string | undefined = activeLeafId;
    while (cursor && !visited.has(cursor) && reversed.length < MAX_TOOL_SEARCH_BRANCH_ENTRIES) {
      visited.add(cursor);
      const entry = byId.get(cursor);
      if (!entry) return [];
      reversed.push(entry);
      cursor = typeof entry.parentMessageId === 'string'
        ? entry.parentMessageId
        : typeof entry.parentEntryId === 'string'
          ? entry.parentEntryId
          : undefined;
    }
    if (cursor) return [];
    branchEntries = reversed.reverse();
  }
  const newestFirst: string[] = [];
  const seen = new Set<string>();
  for (let index = branchEntries.length - 1;
    index >= 0 && newestFirst.length < MAX_TOOL_SEARCH_LOADED;
    index--) {
    const entry = branchEntries[index];
    if (!isRecord(entry) || !isRecord(entry.metadata)) continue;
    const metadata = entry.metadata[TOOL_SEARCH_METADATA_KEY];
    if (!isRecord(metadata) || !Array.isArray(metadata.loaded)) continue;
    for (let loadedIndex = metadata.loaded.length - 1;
      loadedIndex >= 0 && newestFirst.length < MAX_TOOL_SEARCH_LOADED;
      loadedIndex--) {
      const value = metadata.loaded[loadedIndex];
      if (typeof value !== 'string' || value.length > MAX_PERSISTED_TOOL_NAME_CHARS) continue;
      const name = normalizedName(value);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      newestFirst.push(name);
    }
  }
  return newestFirst.reverse();
}

/** Create the only persisted shape accepted by {@link collectToolSearchLoadedNames}. */
export function toolSearchActivationMetadata(names: readonly string[]): Record<string, unknown> | undefined {
  const loaded = boundedToolNames(names);
  return loaded.length > 0 ? { [TOOL_SEARCH_METADATA_KEY]: { loaded } } : undefined;
}
