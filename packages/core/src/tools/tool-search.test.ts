import { describe, expect, it, vi } from 'vitest';
import { runToolLoop } from '../agent/tool-loop.js';
import { ExtensionRegistry, type ExtensionRuntimeContext, type ExtensionTool } from '../extensions/extension-registry.js';
import { SessionManager } from '../sessions/session-manager.js';
import { deserializeSession, serializeSession } from '../sessions/serialization.js';
import { toChatToolDefinitions } from './tool-selection.js';
import {
  Bm25ToolRanker,
  DEFAULT_TOOL_SEARCH_LIMIT,
  TOOL_SEARCH_TOOL_NAME,
  collectToolSearchLoadedNames,
  createAgentToolLoadout,
  createToolSearchDocument,
  createToolSearchLoadout,
  toolSearchActivationMetadata,
} from './tool-search.js';

const context = {} as ExtensionRuntimeContext;

function tool(
  name: string,
  description: string,
  exposure: ExtensionTool['exposure'] = 'deferred',
): ExtensionTool & { extensionId: string } {
  return {
    name,
    description,
    exposure,
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: `Path handled by ${name}` } },
    },
    extensionId: 'test:tools',
    execute: vi.fn(async () => ({ content: name })),
  };
}

describe('tool search', () => {
  it('ranks names, descriptions, schemas, and namespace metadata with stable BM25 ties', () => {
    const documents = [
      createToolSearchDocument(tool('read_file', 'Read text from disk')),
      createToolSearchDocument(tool('query_docs', 'Search reference pages'), {
        name: 'knowledgeBase',
        instructions: 'Use for handbook questions.',
      }),
      createToolSearchDocument(tool('write_file', 'Write text to disk')),
    ];
    const ranker = new Bm25ToolRanker();

    expect(ranker.rank('handbook knowledge base', documents, DEFAULT_TOOL_SEARCH_LIMIT)[0]?.name)
      .toBe('query_docs');
    expect(ranker.rank('path disk', documents, 2).map(match => match.name))
      .toEqual(['read_file', 'write_file']);
    expect(ranker.rank('unmatched vocabulary', documents, 8)).toEqual([]);
  });

  it('bounds search input and cyclic schema traversal', async () => {
    const parameters: Record<string, unknown> = { type: 'object' };
    parameters.items = parameters;
    const cyclic = {
      ...tool('cyclic_lookup', 'Search cyclic documentation'),
      parameters,
    };
    expect(createToolSearchDocument(cyclic).text.length).toBeLessThanOrEqual(8 * 1024);
    const loadout = createToolSearchLoadout([cyclic]);
    await expect(loadout.executeToolSearch({ query: '' }, context)).rejects.toThrow('must not be empty');
    await expect(loadout.executeToolSearch({ query: 'docs', limit: 51 }, context))
      .rejects.toThrow('from 1 to 50');
    await expect(loadout.executeToolSearch({ query: 'x'.repeat(4_097) }, context))
      .rejects.toThrow('exceeds 4096 bytes');
  });

  it('withholds deferred schemas until search and authenticates activation metadata', async () => {
    const direct = tool('always_on', 'Always declared', 'direct');
    const lookup = tool('docs_lookup', 'Search product documentation');
    const mutate = tool('records_mutate', 'Mutate customer records', 'codemode');
    const hidden = tool('secret_admin', 'Hidden administrative operation', 'hidden');
    const loadout = createToolSearchLoadout([direct, lookup, mutate, hidden]);

    expect(loadout.getTools().map(candidate => candidate.name)).toEqual([
      'always_on',
      TOOL_SEARCH_TOOL_NAME,
    ]);
    const result = await loadout.executeToolSearch({ query: 'product documentation' }, context);
    expect(result.details).toEqual({ loaded: ['docs_lookup'] });
    expect(loadout.activatedTools(TOOL_SEARCH_TOOL_NAME, result)).toEqual(['docs_lookup']);
    expect(loadout.activatedTools(TOOL_SEARCH_TOOL_NAME, {
      content: result.content,
      details: { loaded: ['secret_admin'] },
    })).toBeUndefined();
    expect(loadout.getTools().map(candidate => candidate.name)).toEqual([
      'always_on',
      TOOL_SEARCH_TOOL_NAME,
      'docs_lookup',
    ]);
    expect(loadout.getTools().some(candidate => candidate.name === 'secret_admin')).toBe(false);
  });

  it('keeps codemode tools script-only after discovery and offers bounded on/only presentation', async () => {
    const direct = tool('read', 'Read text', 'direct');
    const script = tool('script_lookup', 'Search scripting handbook', 'codemode');
    const hidden = tool('secret', 'Search secret handbook', 'hidden');
    const modelOnly = tool('spawn_subagent', 'Delegate', 'model-only');
    const loadout = createAgentToolLoadout({ staticTools: [direct, script, hidden, modelOnly], codemode: { enabled: true } });
    const result = await loadout.executeToolSearch({ query: 'scripting handbook' }, context);
    expect(result.details).toEqual({ loaded: [script.name] });
    expect(loadout.getTools().map(tool => tool.name)).toEqual(['read', 'spawn_subagent', 'tool_search', 'codemode']);
    const code = loadout.getTools().find(tool => tool.name === 'codemode')!;
    expect(code.description).toContain('script_lookup');
    expect(code.description).not.toContain('secret');
    expect(code.description).not.toContain('spawn_subagent');
    const metadata = loadout.resultMetadata('codemode', { content: '', data: { store: { forged: true } } });
    expect(metadata).toBeUndefined();
    const only = createAgentToolLoadout({ staticTools: [direct, script, modelOnly], codemode: { enabled: true, mode: 'only', inlineBudget: 0 } });
    expect(only.getTools().map(tool => tool.name)).toEqual(['spawn_subagent', 'tool_search', 'codemode']);
    expect(only.getTools().find(tool => tool.name === 'codemode')!.description).not.toContain('script_lookup');
    const ordinary = createAgentToolLoadout({ staticTools: [direct], selection: { allowedTools: ['read', 'codemode'] }, codemode: { activation: 'automatic' } });
    expect(ordinary.getTools().map(tool => tool.name)).toEqual(['read']);
    expect(createAgentToolLoadout({ staticTools: [script], codemode: { activation: 'automatic' } }).getTools().map(tool => tool.name))
      .toEqual(['tool_search', 'codemode']);
  });

  it('applies allowlists and exclusions before candidates can be discovered', async () => {
    const lookup = tool('mcp__docs__lookup', 'Search documentation');
    const mutate = tool('mcp__docs__mutate', 'Change documentation');
    const source = {
      directTools: [] as Array<ReturnType<typeof tool>>,
      hasPotentialSearchableTools: true,
      currentSearchableTools: () => [lookup, mutate],
      waitForSearchableTools: vi.fn(async () => [lookup, mutate]),
      has: (name: string) => name === lookup.name || name === mutate.name,
    };
    const loadout = createAgentToolLoadout({
      staticTools: [],
      dynamicSource: source,
      selection: {
        allowedTools: [TOOL_SEARCH_TOOL_NAME, lookup.name, mutate.name],
        excludedTools: [mutate.name],
      },
    });

    const result = await loadout.executeToolSearch({ query: 'documentation', limit: 8 }, context);
    expect(source.waitForSearchableTools).toHaveBeenCalledOnce();
    expect(result.details).toEqual({ loaded: [lookup.name] });
    expect(loadout.getTools().map(candidate => candidate.name)).toEqual([
      TOOL_SEARCH_TOOL_NAME,
      lookup.name,
    ]);
    expect(loadout.isDynamicTool(lookup.name)).toBe(true);
  });

  it('honors no-tools and no-builtins unless discovery is explicitly allowlisted', () => {
    const deferred = tool('deferred_lookup', 'Search product documentation');
    expect(createAgentToolLoadout({
      staticTools: [deferred],
      selection: { noTools: true },
    }).getTools()).toEqual([]);
    expect(createAgentToolLoadout({
      staticTools: [deferred],
      selection: { noBuiltInTools: true, builtInExtensionId: 'builtin:workspace-tools' },
    }).getTools()).toEqual([]);
    expect(createAgentToolLoadout({
      staticTools: [deferred],
      selection: {
        noBuiltInTools: true,
        builtInExtensionId: 'builtin:workspace-tools',
        allowedTools: [TOOL_SEARCH_TOOL_NAME, deferred.name],
      },
    }).getTools().map(candidate => candidate.name)).toEqual([TOOL_SEARCH_TOOL_NAME]);
  });

  it('restores an activated deferred extension tool after registry reload', async () => {
    const registry = new ExtensionRegistry();
    const register = () => registry.load('test:reloadable', api => api.registerTool({
      name: 'reloadable_lookup',
      description: 'Search reloadable documentation',
      exposure: 'deferred',
      execute: async () => ({ content: 'ok' }),
    }));
    await register();
    const first = createAgentToolLoadout({ staticTools: registry.getTools() });
    const result = await first.executeToolSearch({ query: 'reloadable documentation' }, context);
    const metadata = toolSearchActivationMetadata(first.activatedTools(TOOL_SEARCH_TOOL_NAME, result) ?? []);

    await registry.unload('test:reloadable');
    await register();
    const restored = createAgentToolLoadout({
      staticTools: registry.getTools(),
      initialLoadedTools: collectToolSearchLoadedNames([{ metadata }]),
    });
    expect(restored.getTools().map(candidate => candidate.name)).toEqual([
      TOOL_SEARCH_TOOL_NAME,
      'reloadable_lookup',
    ]);
  });

  it('does not permit a newly found tool in the same provider response', async () => {
    const sessionManager = new SessionManager();
    const session = await sessionManager.create();
    const registry = new ExtensionRegistry();
    registry.attachSessionManager(sessionManager);
    const executeDeferred = vi.fn(async () => ({ content: 'unsafe same-turn execution' }));
    await registry.load('test:deferred', api => api.registerTool({
      name: 'deferred_lookup',
      description: 'Search product documentation',
      exposure: 'deferred',
      execute: executeDeferred,
    }));
    const loadout = createToolSearchLoadout(registry.getTools());

    await runToolLoop({
      sessionManager,
      sessionId: session.id,
      extensionRegistry: registry,
      tools: toChatToolDefinitions(loadout.getTools()),
      resolveTools: () => toChatToolDefinitions(loadout.getTools()),
      executeTool: (name, input, runtimeContext, signal) => loadout.isToolSearch(name)
        ? loadout.executeToolSearch(input, runtimeContext, signal)
        : registry.executeTool(name, input, runtimeContext, signal),
      getActivatedTools: (name, result) => loadout.activatedTools(name, result),
      toolContext: { sessionManager, currentSessionId: session.id } as ExtensionRuntimeContext,
      streamTurn: async (_messages, definitions, round) => {
        if (round === 0) {
          expect(definitions.map(definition => definition.name)).toEqual([TOOL_SEARCH_TOOL_NAME]);
          return {
            content: '',
            toolCalls: [
              { id: 'search', name: TOOL_SEARCH_TOOL_NAME, input: { query: 'documentation' } },
              { id: 'early', name: 'deferred_lookup', input: {} },
            ],
          };
        }
        expect(definitions.map(definition => definition.name)).toEqual([
          TOOL_SEARCH_TOOL_NAME,
          'deferred_lookup',
        ]);
        return { content: 'done' };
      },
    });

    expect(executeDeferred).not.toHaveBeenCalled();
    expect(sessionManager.get(session.id)?.messages.find(message => message.name === 'deferred_lookup'))
      .toMatchObject({ isError: true, content: 'Tool is not enabled for this run: deferred_lookup' });
  });

  it('keeps activation metadata across the durable session wire format', async () => {
    const sessionManager = new SessionManager();
    const session = await sessionManager.create();
    await sessionManager.addMessage(session.id, {
      role: 'tool',
      content: 'loaded',
      name: TOOL_SEARCH_TOOL_NAME,
      toolCallId: 'search',
      metadata: toolSearchActivationMetadata(['deferred_lookup']),
    });

    const restored = deserializeSession(serializeSession(sessionManager.get(session.id)!));
    expect(collectToolSearchLoadedNames(restored.messages)).toEqual(['deferred_lookup']);
  });

  it('restores only bounded, well-formed branch activation metadata', () => {
    const metadata = toolSearchActivationMetadata(['Docs_Lookup', 'docs_lookup', '', 'other']);
    expect(metadata).toEqual({ toolSearch: { loaded: ['docs_lookup', 'other'] } });
    expect(collectToolSearchLoadedNames([
      { type: 'message', metadata },
      { type: 'message', metadata: { toolSearch: { loaded: ['third', 42] } } },
      { type: 'message', metadata: { toolSearch: { loaded: 'forged' } } },
    ])).toEqual(['docs_lookup', 'other', 'third']);
    expect(collectToolSearchLoadedNames([
      { id: 'root', type: 'message' },
      { id: 'activation', type: 'message', parentMessageId: 'root', metadata },
      { id: 'abandoned', type: 'message', parentMessageId: 'root', metadata: {
        toolSearch: { loaded: ['wrong_branch'] },
      } },
      { id: 'compaction', type: 'compaction', parentEntryId: 'activation' },
      { id: 'leaf', type: 'message', parentMessageId: 'compaction' },
    ], 'leaf')).toEqual(['docs_lookup', 'other']);
  });
});
