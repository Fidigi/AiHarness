import {
  CODEMODE_TOOL_NAME, TOOL_SEARCH_TOOL_NAME, selectRegisteredTools, unknownToolNames,
  type RegisteredAgentTool, type ToolSelectionOptions,
} from '@ai-harness/core';

export interface CliToolSelection extends Omit<ToolSelectionOptions, 'allowedTools' | 'excludedTools'> {
  tools?: readonly string[];
  excludeTools?: readonly string[];
  /** Existing hosted helper activation, not permission to enable a new capability. */
  codemodeConfigured?: boolean;
  hasPotentialSearchableTools?: boolean;
}

const modifier = (entry: string): boolean => /^[+-]/.test(entry);
const controls: RegisteredAgentTool[] = [
  { name: CODEMODE_TOOL_NAME, extensionId: 'builtin:codemode', description: '' },
  { name: TOOL_SEARCH_TOOL_NAME, extensionId: 'builtin:tool-search', description: '' },
];

/** CLI grammar only: replacement patterns OR ordered exact-name adjustments. */
export function cliToolListError(tools?: readonly string[], excluded?: readonly string[]): string | undefined {
  tools = tools?.map(entry => entry.trim().toLowerCase());
  excluded = excluded?.map(entry => entry.trim().toLowerCase());
  if (tools?.some(modifier)) {
    if (!tools.every(modifier)) return 'Tool names/patterns cannot be mixed with +name or -name entries.';
    if (tools.some(entry => entry.length === 1 || entry.includes('*'))) {
      return '+name and -name require exact non-empty tool names, not patterns.';
    }
  }
  if (excluded?.some(modifier)) return '--exclude-tools requires plain tool names or patterns.';
  return undefined;
}

/** Only * is special; punctuation is literal. No user-controlled regular expression. */
function matches(name: string, pattern: string): boolean {
  const parts = pattern.split('*');
  if (parts.length === 1) return name === pattern;
  if (!name.startsWith(parts[0])) return false;
  let offset = parts[0].length;
  for (const part of parts.slice(1, -1)) {
    const index = name.indexOf(part, offset);
    if (index < 0) return false;
    offset = index + part.length;
  }
  const last = parts[parts.length - 1];
  return name.length - offset >= last.length && name.endsWith(last);
}

export function unknownCliToolNames(tools: readonly RegisteredAgentTool[], selection: CliToolSelection): string[] {
  return unknownToolNames(tools, selection.tools?.map(value => { const entry = value.trim(); return modifier(entry) ? entry.slice(1) : entry; }), selection.excludeTools)
    .filter(name => !name.includes('*') && !name.startsWith('mcp__')
      && name !== TOOL_SEARCH_TOOL_NAME && name !== CODEMODE_TOOL_NAME);
}

export function cliToolsDisabled(selection: CliToolSelection): boolean {
  return selection.tools?.length === 0 || Boolean(selection.noTools
    && (selection.tools === undefined || selection.tools.every(entry => entry.trim().startsWith('-'))));
}

/**
 * Translate CLI intent into concrete Core allow/deny lists. Getters re-resolve
 * against current metadata when deferred discovery refreshes; Core still sees
 * only exact names and retains ownership, exposure, preset and execution gates.
 */
export function cliToolSelectionOptions(
  currentTools: () => readonly RegisteredAgentTool[],
  options: CliToolSelection,
): ToolSelectionOptions {
  const error = cliToolListError(options.tools, options.excludeTools);
  if (error) throw new Error(error);
  const { tools: rawTools, excludeTools: rawExcluded, codemodeConfigured, hasPotentialSearchableTools, ...base } = options;
  const tools = rawTools?.map(entry => entry.trim().toLowerCase());
  const excludeTools = rawExcluded?.map(entry => entry.trim().toLowerCase());
  const available = (): RegisteredAgentTool[] => {
    const registered = [...currentTools()];
    for (const control of controls) {
      if (!registered.some(tool => tool.name.toLowerCase() === control.name)) registered.push(control);
    }
    return registered;
  };
  const expand = (entries: readonly string[], registered: readonly RegisteredAgentTool[]): string[] => [...new Set(entries.flatMap(entry => {
    const pattern = entry.trim().toLowerCase();
    return pattern.includes('*') ? registered.filter(tool => matches(tool.name.toLowerCase(), pattern)).map(tool => tool.name) : [pattern];
  }))];
  return {
    ...base,
    get allowedTools() {
      if (tools === undefined) return undefined;
      const registered = available();
      if (!tools.some(modifier)) return expand(tools, registered);
      const baseline = selectRegisteredTools(registered, { ...base, preset: undefined,
        excludedTools: excludeTools === undefined ? undefined : expand(excludeTools, registered) });
      const defaultCodemode = base.defaultTools?.some(name => name.trim().toLowerCase() === CODEMODE_TOOL_NAME)
        || (codemodeConfigured && (hasPotentialSearchableTools || selectRegisteredTools(baseline, { preset: base.preset })
          .some(tool => tool.exposure === 'deferred' || tool.exposure === 'codemode')));
      const selected = new Set(baseline.filter(tool => !controls.includes(tool)
        || (!base.noBuiltInTools && (tool.name !== CODEMODE_TOOL_NAME || defaultCodemode)))
        .map(tool => tool.name.toLowerCase()));
      for (const entry of tools) {
        const name = entry.slice(1).toLowerCase();
        if (entry.startsWith('+')) selected.add(name);
        else selected.delete(name);
      }
      return [...selected];
    },
    get excludedTools() {
      return excludeTools === undefined ? undefined : expand(excludeTools, available());
    },
  };
}
