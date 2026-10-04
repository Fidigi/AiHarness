import type { ChatResponse, ChatToolDefinition } from '../providers/index.js';
import type { ExtensionRegistry, ExtensionRuntimeContext } from '../extensions/extension-registry.js';
import type { Message, TokenUsage, ToolCall } from '../types/index.js';
import type { SessionManager } from '../sessions/session-manager.js';

export interface ToolExecutionResult {
  call: ToolCall;
  content: string;
  fullContent?: string;
  isError: boolean;
  durationMs: number;
  truncated: boolean;
}

export interface ToolLoopOptions {
  sessionManager: SessionManager;
  sessionId: string;
  extensionRegistry: ExtensionRegistry;
  toolContext: ExtensionRuntimeContext;
  streamTurn(messages: Message[], tools: ChatToolDefinition[], round: number): Promise<ChatResponse>;
  tools?: ChatToolDefinition[];
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
  const tools = options.tools ?? options.extensionRegistry.getTools().map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters ?? { type: 'object', properties: {} },
  }));
  const enabledToolNames = new Set(tools.map(tool => tool.name.toLowerCase()));
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
      try {
        const normalizedToolName = call.name.toLowerCase();
        if (!enabledToolNames.has(normalizedToolName)
          && options.extensionRegistry.getTools().some(tool => tool.name === normalizedToolName)) {
          throw new Error(`Tool is not enabled for this run: ${call.name}`);
        }
        const result = await options.extensionRegistry.executeTool(
          call.name,
          call.input,
          options.toolContext,
          options.signal,
        );
        content = result.content;
        isError = Boolean(result.isError);
      } catch (error) {
        isError = true;
        content = error instanceof Error ? error.message : String(error);
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
      }, { signal: options.signal });
      const toolResult: ToolExecutionResult = {
        call,
        content,
        ...(truncated ? { fullContent } : {}),
        isError,
        durationMs,
        truncated,
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
