import type { ChatToolDefinition } from '../providers/index.js';
import type { Session } from '../types/index.js';
import { READ_ONLY_CODING_TOOL_NAMES } from './workspace-tools.js';

/** Minimum shape needed to apply one selection policy to built-in and extension tools. */
export interface RegisteredAgentTool {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  extensionId: string;
}

export interface ToolSelectionOptions {
  /** Session policy shared by the Web runtime and other agent hosts. */
  preset?: Session['toolPreset'];
  /** Exact replacement allowlist. An empty array intentionally disables every tool. */
  allowedTools?: readonly string[];
  /** Applied after defaults and allowlists. */
  excludedTools?: readonly string[];
  /** Restrict non-platform extensions while retaining built-in/server-owned tools. */
  allowedExtensions?: readonly string[];
  /** Default names used when no explicit allowlist was supplied. */
  defaultTools?: readonly string[];
  /** Owner of the direct built-in tools, used by no-builtins/default selection. */
  builtInExtensionId?: string;
  /** Keep tools from other owners enabled alongside defaultTools. */
  includeNonBuiltInByDefault?: boolean;
  /** Disable the direct built-ins only when there is no explicit allowlist. */
  noBuiltInTools?: boolean;
  /** Disable all defaults only when there is no explicit allowlist. */
  noTools?: boolean;
  /** Override the names available under the read-only preset. */
  readOnlyTools?: readonly string[];
}

export const READ_ONLY_AGENT_TOOL_NAMES = [
  ...READ_ONLY_CODING_TOOL_NAMES,
  'load_skill',
  'spawn_subagent',
] as const;

function names(values: readonly string[] | undefined): Set<string> | undefined {
  return values === undefined
    ? undefined
    : new Set(values.map(value => value.trim().toLowerCase()).filter(Boolean));
}

/**
 * Resolve active tools without mutating the registry. The same ordering as the
 * registry is retained so provider declarations and UI inventories stay stable.
 */
export function selectRegisteredTools<T extends RegisteredAgentTool>(
  tools: readonly T[],
  options: ToolSelectionOptions = {},
): T[] {
  if (options.preset === 'chat-only') return [];

  const explicit = names(options.allowedTools);
  const excluded = names(options.excludedTools);
  const defaults = names(options.defaultTools);
  const readOnly = names(options.readOnlyTools ?? READ_ONLY_AGENT_TOOL_NAMES)!;
  const extensionAllowlist = names(options.allowedExtensions);
  const builtInExtensionId = options.builtInExtensionId;

  return tools.filter(tool => {
    const name = tool.name.toLowerCase();

    if (explicit) {
      if (!explicit.has(name)) return false;
    } else {
      if (options.noTools) return false;
      if (options.noBuiltInTools && builtInExtensionId && tool.extensionId === builtInExtensionId) return false;
      if (defaults) {
        const nonBuiltIn = Boolean(
          options.includeNonBuiltInByDefault
          && builtInExtensionId
          && tool.extensionId !== builtInExtensionId,
        );
        if (!defaults.has(name) && !nonBuiltIn) return false;
      }
    }

    if (options.preset === 'read-only' && !readOnly.has(name)) return false;
    if (extensionAllowlist
      && !tool.extensionId.startsWith('server:')
      && !tool.extensionId.startsWith('builtin:')
      && !extensionAllowlist.has(tool.extensionId.toLowerCase())) return false;
    return !excluded?.has(name);
  });
}

/** Return requested names that are not currently registered. */
export function unknownToolNames(
  tools: readonly Pick<RegisteredAgentTool, 'name'>[],
  ...requestedLists: Array<readonly string[] | undefined>
): string[] {
  const known = new Set(tools.map(tool => tool.name.toLowerCase()));
  return [...new Set(requestedLists.flatMap(values => values ?? [])
    .map(value => value.trim().toLowerCase())
    .filter(value => value && !known.has(value)))].sort();
}

export function toChatToolDefinitions(
  tools: readonly Pick<RegisteredAgentTool, 'name' | 'description' | 'parameters'>[],
): ChatToolDefinition[] {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters ?? { type: 'object', properties: {} },
  }));
}
