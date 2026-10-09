import type { ChatResponse, ChatToolDefinition } from '../providers/index.js';
import type {
  ExtensionRegistry,
  ExtensionRuntimeContext,
  ExtensionToolResult,
} from '../extensions/extension-registry.js';
import type { CodemodeDetails, CodemodeProgress, Message, TokenUsage, ToolCall } from '../types/index.js';
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
  metadata?: Record<string, unknown>;
  usage?: TokenUsage;
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
  onCodemodeProgress?(progress: CodemodeProgress): void;
  onToolUsage?(usage: TokenUsage): void | Promise<void>;
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
        const context: ExtensionRuntimeContext = { ...options.toolContext, toolCallId: call.id,
          onCodemodeProgress: options.onCodemodeProgress,
          beforeSpecializedModel: async (type, request, signal) => {
            if (signal.aborted) throw new AgentAbortError();
            const hookContext: ExtensionRuntimeContext = { ...options.toolContext,
              notify: (message, level) => { if (!signal.aborted) options.toolContext.notify(message, level); },
              requestInteraction: options.toolContext.requestInteraction ? interaction => signal.aborted
                ? Promise.resolve({ cancelled: true })
                : options.toolContext.requestInteraction!({ ...interaction,
                  signal: interaction.signal ? AbortSignal.any([signal, interaction.signal]) : signal }) : undefined,
            };
            const hook = await options.extensionRegistry.runBefore('before:model', { type, request, context: hookContext, signal });
            if (hook.cancelled || hook.data.type !== type || signal.aborted) throw new Error('Model request cancelled.');
            return hook.data.request;
          },
        };
        const normalizedToolName = call.name.toLowerCase();
        if (!enabledToolNames.has(normalizedToolName)) {
          throw new Error(`Tool is not enabled for this run: ${call.name}`);
        }
        const result = await (options.executeTool
          ? options.executeTool(call.name, call.input, context, options.signal)
          : options.extensionRegistry.executeTool(
              call.name,
              call.input,
              context,
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

      // Cancellation stops execution, not the durable record of work already done.
      // In particular, authenticated code-mode metadata contains completed model usage.
      const interrupted = options.signal?.aborted === true;
      if (interrupted) {
        isError = true;
        activatedTools = undefined;
        content = options.redactText?.('Tool execution interrupted.') ?? 'Tool execution interrupted.';
        resultMetadata = { ...resultMetadata, interrupted: true };
        const codemode = resultMetadata.codemode as CodemodeDetails | undefined;
        if (codemode) {
          const { store: _store, ...details } = codemode;
          resultMetadata.codemode = details;
        }
      }
      const fullContent = content;
      const truncated = content.length > maxToolResultLength;
      if (truncated) content = `${content.slice(0, maxToolResultLength)}\n[Résultat tronqué — sortie complète disponible]`;
      const durationMs = Date.now() - toolStartedAt;
      const usage = (resultMetadata?.codemode as CodemodeDetails | undefined)?.usage;
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
        ...(usage ? { usage } : {}),
        ...((activatedTools?.length || resultMetadata) ? { metadata: {
          ...toolSearchActivationMetadata(activatedTools ?? []), ...resultMetadata,
        } } : {}),
      }, { skipAutoCompaction: true });
      if (usage) await options.onToolUsage?.(usage);
      const toolResult: ToolExecutionResult = {
        call,
        content,
        ...(truncated ? { fullContent } : {}),
        isError,
        durationMs,
        truncated,
        ...(activatedTools?.length ? { activatedTools: [...activatedTools] } : {}),
        ...(resultMetadata ? { metadata: resultMetadata } : {}),
        ...(usage ? { usage } : {}),
      };
      toolResults.push(toolResult);
      await options.onToolResult?.(toolResult);
      throwIfAborted();
      await options.sessionManager.checkAndTriggerCompaction(options.sessionId, options.signal);
    }

    await options.onTurnEnd?.(response, toolResults, round);
    await options.beforeNextTurn?.(response, toolResults, round);
    throwIfAborted();
    messages = effectiveMessages();
  }

  throw new Error(`Limite de ${maxToolRounds} tours d'outils atteinte.`);
}
