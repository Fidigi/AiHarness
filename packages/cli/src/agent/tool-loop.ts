import type {
  ChatResponse,
  ChatToolDefinition,
  ExtensionRegistry,
  ExtensionRuntimeContext,
  Message,
  SessionManager,
  ToolCall,
} from '@ai-harness/core';

export interface ToolExecutionResult {
  call: ToolCall;
  content: string;
  isError: boolean;
}

export interface ToolLoopOptions {
  sessionManager: SessionManager;
  sessionId: string;
  extensionRegistry: ExtensionRegistry;
  toolContext: ExtensionRuntimeContext;
  streamTurn(messages: Message[], tools: ChatToolDefinition[]): Promise<ChatResponse>;
  onToolCall?(call: ToolCall): void;
  onToolResult?(result: ToolExecutionResult): void;
  onFinalResponse?(content: string): void;
  maxToolRounds?: number;
  maxToolResultLength?: number;
  signal?: AbortSignal;
}

/**
 * Runs model turns until a final assistant response is produced. Tool calls and
 * their results are persisted between turns so providers receive the complete
 * conversation state.
 */
export async function runToolLoop(options: ToolLoopOptions): Promise<string> {
  const maxToolRounds = options.maxToolRounds ?? 8;
  const maxToolResultLength = options.maxToolResultLength ?? 50_000;
  const tools = options.extensionRegistry.getTools().map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters ?? { type: 'object', properties: {} },
  }));
  let messages = options.sessionManager.get(options.sessionId)?.messages.map(message => ({ ...message })) ?? [];

  const throwIfAborted = (): void => {
    if (options.signal?.aborted) throw new Error("Exécution de l'agent interrompue.");
  };

  for (let round = 0; round < maxToolRounds; round++) {
    throwIfAborted();
    const response = await options.streamTurn(messages, tools);
    throwIfAborted();
    const toolCalls = response.toolCalls ?? [];

    if (toolCalls.length === 0) {
      if (response.content) {
        await options.sessionManager.addMessage(options.sessionId, {
          role: 'assistant',
          content: response.content,
        });
      }
      options.onFinalResponse?.(response.content);
      return response.content;
    }

    await options.sessionManager.addMessage(options.sessionId, {
      role: 'assistant',
      content: response.content,
      toolCalls,
    });

    for (const call of toolCalls) {
      throwIfAborted();
      options.onToolCall?.(call);
      let content: string;
      let isError = false;
      try {
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
      if (content.length > maxToolResultLength) {
        content = `${content.slice(0, maxToolResultLength)}\n[Résultat tronqué]`;
      }
      await options.sessionManager.addMessage(options.sessionId, {
        role: 'tool',
        content,
        toolCallId: call.id,
        name: call.name,
        isError,
      });
      options.onToolResult?.({ call, content, isError });
    }

    messages = options.sessionManager.get(options.sessionId)?.messages.map(message => ({ ...message })) ?? messages;
  }

  throw new Error(`Limite de ${maxToolRounds} tours d'outils atteinte.`);
}
