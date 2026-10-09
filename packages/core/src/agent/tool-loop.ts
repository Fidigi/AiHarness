import type { ChatResponse, ChatToolDefinition } from '../providers/index.js';
import type {
  ExtensionRegistry,
  ExtensionRuntimeContext,
  ExtensionToolResult,
} from '../extensions/extension-registry.js';
import type { Message, TokenUsage, ToolCall } from '../types/index.js';
import type { SessionManager } from '../sessions/session-manager.js';
import { agentToolExposure, isDeclaredToolExposure } from '../tools/tool-selection.js';
import { toolSearchActivationMetadata } from '../tools/tool-search.js';

export interface ToolExecutionResult {
  call: ToolCall;
  content: string;
  fullContent?: string;
  isError: boolean;
  durationMs: number;
  truncated: boolean;
  /** Branch-local declarations activated by a trusted host-owned discovery tool. */
  activatedTools?: string[];
}

export interface ToolLoopOptions {
  sessionManager: SessionManager;
  sessionId: string;
  extensionRegistry: ExtensionRegistry;
  toolContext: ExtensionRuntimeContext;
  streamTurn(messages: Message[], tools: ChatToolDefinition[], round: number): Promise<ChatResponse>;
  tools?: ChatToolDefinition[];
  /** Recompute declarations before every model call after dynamic activation. */
  resolveTools?(): ChatToolDefinition[];
  /** Optional composite executor for tools hosted outside the static extension registry. */
  executeTool?(
    name: string,
    input: unknown,
    context: ExtensionRuntimeContext,
    signal?: AbortSignal,
  ): ExtensionToolResult | Promise<ExtensionToolResult>;
  /** Accept activation names only from a host-owned tool/result pair. */
  getActivatedTools?(name: string, result: ExtensionToolResult): string[] | undefined;
  /** Additional metadata authenticated by a host-owned executor (for example codemode store). */
  getToolResultMetadata?(name: string, result: ExtensionToolResult): Record<string, unknown> | undefined;
  onTurnStart?(round: number): void | Promise<void>;
  onAssistantResponse?(response: ChatResponse, round: number, durationMs: number): void | Promise<void>;
  onToolCall?(call: ToolCall): void | Promise<void>;
  onToolResult?(result: ToolExecutionResult): void | Promise<void>;
  onTurnEnd?(response: ChatResponse, toolResults: ToolExecutionResult[], round: number): void | Promise<void>;
  /** Persist or transform queued input after tools and before the next provider turn. */
  beforeNextTurn?(response: ChatResponse, toolResults: ToolExecutionResult[], round: number): void | Promise<void>;
  onUsage?(response: ChatResponse, round: number): void | Promise<void>;
  onFinalResponse?(content: string, response: ChatResponse): void | Promise<void>;
  maxToolRounds?: number;
  maxToolResultLength?: number;
  signal?: AbortSignal;
  provider?: string;
  /** Process-local scrubber applied before extension/tool output is persisted or emitted. */
  redactText?(value: string): string;
}

function normalizeUsage(usage: ChatResponse['usage']): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    totalTokens: usage.totalTokens,
    costUsd: usage.costUsd,
  };
}

/** Stable error used by the CLI and detached Web runtime. */
export class AgentAbortError extends Error {
  constructor() {
    super("Exécution de l'agent interrompue.");
    this.name = 'AbortError';
  }
}

/**
 * Run model turns until a final assistant response is produced. Tool calls and
 * results are persisted before the next provider turn, so every interface uses
 * the same effective context and cancellation semantics.
 */
export async function runToolLoop(options: ToolLoopOptions): Promise<string> {
  const maxToolRounds = options.maxToolRounds ?? 8;
  const maxToolResultLength = options.maxToolResultLength ?? 50_000;
  const defaultTools = options.tools ?? options.extensionRegistry.getTools()
    .filter(tool => isDeclaredToolExposure(agentToolExposure(tool)))
    .map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    }));
  const effectiveMessages = (): Message[] => options.sessionManager.getEffectiveContext(options.sessionId)
    .filter(entry => entry.type === 'message')
    .map(entry => ({
      id: entry.id,
      role: entry.role,
      content: entry.content,
      timestamp: new Date(entry.timestamp),
      blocks: entry.blocks,
      toolCalls: entry.toolCalls,
      toolCallId: entry.toolCallId,
      name: entry.name,
      isError: entry.isError,
      provider: entry.provider,
      model: entry.model,
      usage: entry.usage,
      durationMs: entry.durationMs,
      parentMessageId: entry.parentMessageId,
      agentId: entry.agentId,
      metadata: entry.metadata,
    }));
  let messages = effectiveMessages();

  const throwIfAborted = (): void => {
    if (options.signal?.aborted) throw new AgentAbortError();
  };

  for (let round = 0; round < maxToolRounds; round++) {
    throwIfAborted();
    await options.onTurnStart?.(round);
    const tools = options.resolveTools?.() ?? defaultTools;
    const enabledToolNames = new Set(tools.map(tool => tool.name.toLowerCase()));
    const startedAt = Date.now();
    const response = await options.streamTurn(messages, tools, round);
    throwIfAborted();
    if (response.usage) await options.onUsage?.(response, round);
    const durationMs = Date.now() - startedAt;
    await options.onAssistantResponse?.(response, round, durationMs);
    const toolCalls = response.toolCalls ?? [];

    if (toolCalls.length === 0) {
      if (response.content || response.reasoning) {
        await options.sessionManager.addMessage(options.sessionId, {
          role: 'assistant',
          content: response.content,
          blocks: [
            ...(response.reasoning ? [{ type: 'reasoning' as const, text: response.reasoning }] : []),
            ...(response.content ? [{ type: 'text' as const, text: response.content }] : []),
          ],
          provider: options.provider,
          model: response.model,
          usage: normalizeUsage(response.usage),
          durationMs,
        }, { signal: options.signal });
      }
      await options.onTurnEnd?.(response, [], round);
      await options.onFinalResponse?.(response.content, response);
      return response.content;
    }

    await options.sessionManager.addMessage(options.sessionId, {
      role: 'assistant',
      content: response.content,
      blocks: [
        ...(response.reasoning ? [{ type: 'reasoning' as const, text: response.reasoning }] : []),
        ...(response.content ? [{ type: 'text' as const, text: response.content }] : []),
        ...toolCalls.map(call => ({ type: 'tool_call' as const, ...call })),
      ],
      toolCalls,
      provider: options.provider,
      model: response.model,
      usage: normalizeUsage(response.usage),
      durationMs,
    }, { signal: options.signal });

    const toolResults: ToolExecutionResult[] = [];
    for (const call of toolCalls) {
      throwIfAborted();
      await options.onToolCall?.(call);
      const toolStartedAt = Date.now();
      let content: string;
      let isError = false;
      let activatedTools: string[] | undefined;
      let resultMetadata: Record<string, unknown> | undefined;
      try {
        const normalizedToolName = call.name.toLowerCase();
        if (!enabledToolNames.has(normalizedToolName)) {
          throw new Error(`Tool is not enabled for this run: ${call.name}`);
        }
        const result = await (options.executeTool
          ? options.executeTool(call.name, call.input, options.toolContext, options.signal)
          : options.extensionRegistry.executeTool(
              call.name,
              call.input,
              options.toolContext,
              options.signal,
            ));
        content = options.redactText?.(result.content) ?? result.content;
        isError = Boolean(result.isError);
        if (!isError) activatedTools = options.getActivatedTools?.(call.name, result);
        resultMetadata = options.getToolResultMetadata?.(call.name, result);
      } catch (error) {
        isError = true;
        const message = error instanceof Error ? error.message : String(error);
        content = options.redactText?.(message) ?? message;
      }

      throwIfAborted();
      const fullContent = content;
      const truncated = content.length > maxToolResultLength;
      if (truncated) content = `${content.slice(0, maxToolResultLength)}\n[Résultat tronqué — sortie complète disponible]`;
      const durationMs = Date.now() - toolStartedAt;
      await options.sessionManager.addMessage(options.sessionId, {
        role: 'tool',
        content,
        blocks: [{
          type: 'tool_result',
          toolCallId: call.id,
          name: call.name,
          content,
          ...(truncated ? { fullContent } : {}),
          isError,
          truncated,
        }],
        toolCallId: call.id,
        name: call.name,
        isError,
        durationMs,
        ...((activatedTools?.length || resultMetadata) ? { metadata: {
          ...toolSearchActivationMetadata(activatedTools ?? []), ...resultMetadata,
        } } : {}),
      }, { signal: options.signal });
      const toolResult: ToolExecutionResult = {
        call,
        content,
        ...(truncated ? { fullContent } : {}),
        isError,
        durationMs,
        truncated,
        ...(activatedTools?.length ? { activatedTools: [...activatedTools] } : {}),
      };
      toolResults.push(toolResult);
      await options.onToolResult?.(toolResult);
    }

    await options.onTurnEnd?.(response, toolResults, round);
    await options.beforeNextTurn?.(response, toolResults, round);
    throwIfAborted();
    messages = effectiveMessages();
  }

  throw new Error(`Limite de ${maxToolRounds} tours d'outils atteinte.`);
}
