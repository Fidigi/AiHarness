import { calculatePublishedModelCost, getPublishedModelMetadata } from '@ai-harness/core';
import type {
  ChatResponse,
  Message,
  MessageContentBlock,
  ToolCall,
  ToolExecutionResult,
  TokenUsage,
} from '@ai-harness/core';

interface JsonRecord {
  type: string;
  [key: string]: unknown;
}

export interface JsonUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}

type JsonMessage = Record<string, unknown> & { role: string; timestamp: number };

interface AssistantState {
  timestamp: number;
  provider: string;
  model?: string;
  text: string;
  reasoning: string;
  textIndex?: number;
  reasoningIndex?: number;
  nextContentIndex: number;
}

const EMPTY_USAGE: JsonUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function pricedUsage(
  tokens: Omit<JsonUsage, 'cost'>,
  costUsd: number | undefined,
  provider: string | undefined,
  model: string | undefined,
): JsonUsage {
  const pricing = provider && model ? getPublishedModelMetadata(provider, model)?.pricing : undefined;
  const calculatedTotal = provider && model
    ? calculatePublishedModelCost(provider, model, {
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cacheReadTokens: tokens.cacheRead,
      cacheWriteTokens: tokens.cacheWrite,
    })
    : undefined;
  const cost = {
    ...(pricing?.inputPerMillion === undefined ? {} : { input: tokens.input * pricing.inputPerMillion / 1_000_000 }),
    ...(pricing?.outputPerMillion === undefined ? {} : { output: tokens.output * pricing.outputPerMillion / 1_000_000 }),
    ...(pricing?.cacheReadPerMillion === undefined ? {} : { cacheRead: tokens.cacheRead * pricing.cacheReadPerMillion / 1_000_000 }),
    ...(pricing?.cacheWritePerMillion === undefined ? {} : { cacheWrite: tokens.cacheWrite * pricing.cacheWritePerMillion / 1_000_000 }),
    ...(costUsd === undefined && calculatedTotal === undefined ? {} : { total: costUsd ?? calculatedTotal }),
  };
  return {
    ...tokens,
    ...(Object.keys(cost).length ? { cost } : {}),
  };
}

function usageOf(
  usage: ChatResponse['usage'],
  provider?: string,
  model?: string,
): JsonUsage {
  if (!usage) return structuredClone(EMPTY_USAGE);
  return pricedUsage({
    input: usage.promptTokens,
    output: usage.completionTokens,
    cacheRead: usage.cacheReadTokens ?? 0,
    cacheWrite: usage.cacheWriteTokens ?? 0,
    totalTokens: usage.totalTokens,
  }, usage.costUsd, provider, model);
}

function providerApi(provider: string): string {
  switch (provider.toLowerCase()) {
    case 'anthropic': return 'anthropic-messages';
    case 'google': case 'vertex': return 'google-generative-ai';
    case 'bedrock': return 'bedrock-converse-stream';
    default: return 'openai-completions';
  }
}

function toolArguments(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : { value: input };
}

function toolCallBlock(call: ToolCall): Record<string, unknown> {
  return {
    type: 'toolCall',
    id: call.id,
    name: call.name,
    arguments: toolArguments(call.input),
  };
}

function imageContent(block: Extract<MessageContentBlock, { type: 'image' }>): Record<string, unknown> | undefined {
  const match = block.url.match(/^data:([^;,]+);base64,(.+)$/s);
  if (!match) return undefined;
  return { type: 'image', data: match[2], mimeType: match[1] };
}

function userMessage(
  content: string,
  blocks: MessageContentBlock[] | undefined,
  timestamp = Date.now(),
): JsonMessage {
  const richContent = (blocks ?? []).flatMap(block => {
    if (block.type === 'text') return [{ type: 'text', text: block.text }];
    if (block.type === 'image') {
      const image = imageContent(block);
      return image ? [image] : [];
    }
    return [];
  });
  return {
    role: 'user',
    content: richContent.some(block => block.type === 'image')
      ? richContent
      : content,
    timestamp,
  };
}

export function toJsonProtocolUsage(
  usage: TokenUsage | undefined,
  provider?: string,
  model?: string,
): JsonUsage {
  if (!usage) return structuredClone(EMPTY_USAGE);
  return pricedUsage({
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
    cacheRead: usage.cacheReadTokens ?? 0,
    cacheWrite: usage.cacheWriteTokens ?? 0,
    totalTokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
      + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
  }, usage.costUsd, provider, model);
}

function persistedUsage(message: Message): JsonUsage {
  return toJsonProtocolUsage(message.usage, message.provider, message.model);
}

/** Translate a persisted Core message to Pi's AgentMessage wire union. */
export function toJsonProtocolMessage(message: Message): JsonMessage {
  const timestamp = message.timestamp.getTime();
  if (message.role === 'user') return userMessage(message.content, message.blocks, timestamp);
  if (message.role === 'assistant') {
    const content = (message.blocks ?? []).flatMap(block => {
      if (block.type === 'text') return [{ type: 'text', text: block.text }];
      if (block.type === 'reasoning') return [{ type: 'thinking', thinking: block.text }];
      if (block.type === 'tool_call') return [toolCallBlock({ id: block.id, name: block.name, input: block.input })];
      return [];
    });
    if (content.length === 0 && message.content) content.push({ type: 'text', text: message.content });
    return {
      role: 'assistant',
      content,
      api: providerApi(message.provider ?? 'unknown'),
      provider: message.provider ?? 'unknown',
      model: message.model ?? 'unknown',
      usage: persistedUsage(message),
      stopReason: message.isError ? 'error' : message.toolCalls?.length ? 'toolUse' : 'stop',
      ...(message.isError ? { errorMessage: message.content } : {}),
      timestamp,
    };
  }
  if (message.role === 'tool') {
    const resultBlock = message.blocks?.find(block => block.type === 'tool_result');
    const content = [{ type: 'text', text: resultBlock?.content ?? message.content }];
    return {
      role: 'toolResult',
      toolCallId: message.toolCallId ?? resultBlock?.toolCallId ?? message.id,
      toolName: message.name ?? resultBlock?.name ?? 'tool',
      content,
      details: {
        ...(message.metadata ?? {}),
        ...(message.durationMs !== undefined ? { durationMs: message.durationMs } : {}),
        ...(resultBlock?.truncated !== undefined ? { truncated: resultBlock.truncated } : {}),
      },
      isError: message.isError ?? resultBlock?.isError ?? false,
      timestamp,
    };
  }
  return {
    role: 'custom',
    customType: 'system',
    content: message.content,
    display: false,
    timestamp,
  };
}

function toolResultContent(result: ToolExecutionResult): {
  executionResult: Record<string, unknown>;
  message: JsonMessage;
} {
  const content = [{ type: 'text', text: result.content }];
  const details = {
    durationMs: result.durationMs,
    truncated: result.truncated,
  };
  return {
    executionResult: { content, details },
    message: {
      role: 'toolResult',
      toolCallId: result.call.id,
      toolName: result.call.name,
      content,
      details,
      isError: result.isError,
      timestamp: Date.now(),
    },
  };
}

/**
 * Pi-compatible JSONL lifecycle encoder. It owns only wire translation; model,
 * tool, and persistence behavior remains in the shared Core loop.
 */
export class JsonEventStream {
  private pendingUser?: JsonMessage;
  private assistant?: AssistantState;
  private turnAssistant?: JsonMessage;
  private turnToolResults: JsonMessage[] = [];
  private runMessages: JsonMessage[] = [];
  private turnOpen = false;
  private runOpen = false;

  constructor(private readonly emit: (record: JsonRecord) => void | Promise<void>) {}

  sessionHeader(session: { id: string; createdAt: Date; cwd?: string }, cwd: string): Promise<void> {
    return Promise.resolve(this.emit({
      type: 'session',
      version: 3,
      id: session.id,
      timestamp: session.createdAt.toISOString(),
      cwd,
    }));
  }

  startAgent(input: string, blocks: MessageContentBlock[] | undefined): Promise<void> {
    this.pendingUser = userMessage(input, blocks);
    this.assistant = undefined;
    this.turnAssistant = undefined;
    this.turnToolResults = [];
    this.runMessages = [];
    this.turnOpen = false;
    this.runOpen = true;
    return Promise.resolve(this.emit({ type: 'agent_start' }));
  }

  /** Queue another user message inside the currently open agent lifecycle. */
  continueAgent(input: string, blocks: MessageContentBlock[] | undefined): void {
    if (!this.runOpen) return;
    this.pendingUser = userMessage(input, blocks);
  }

  startTurn(): Promise<void> {
    if (!this.runOpen) return Promise.resolve();
    this.turnOpen = true;
    this.turnAssistant = undefined;
    this.turnToolResults = [];
    const writes: Array<void | Promise<void>> = [this.emit({ type: 'turn_start' })];
    if (this.pendingUser) {
      writes.push(this.emit({ type: 'message_start', message: this.pendingUser }));
      writes.push(this.emit({ type: 'message_end', message: this.pendingUser }));
      this.runMessages.push(this.pendingUser);
      this.pendingUser = undefined;
    }
    return Promise.all(writes.map(write => Promise.resolve(write))).then(() => undefined);
  }

  startAssistant(provider: string, model?: string): Promise<void> {
    const state: AssistantState = {
      timestamp: Date.now(),
      provider,
      model,
      text: '',
      reasoning: '',
      nextContentIndex: 0,
    };
    this.assistant = state;
    return Promise.resolve(this.emit({
      type: 'message_start',
      message: this.assistantMessage(state, undefined, 'pending'),
    }));
  }

  textDelta(delta: string): Promise<void> {
    const state = this.assistant;
    if (!state || !delta) return Promise.resolve();
    const writes: Array<void | Promise<void>> = [];
    if (state.textIndex === undefined) {
      state.textIndex = state.nextContentIndex++;
      writes.push(this.update({ type: 'text_start', contentIndex: state.textIndex }));
    }
    state.text += delta;
    writes.push(this.update({ type: 'text_delta', contentIndex: state.textIndex, delta }));
    return Promise.all(writes.map(write => Promise.resolve(write))).then(() => undefined);
  }

  reasoningDelta(delta: string): Promise<void> {
    const state = this.assistant;
    if (!state || !delta) return Promise.resolve();
    const writes: Array<void | Promise<void>> = [];
    if (state.reasoningIndex === undefined) {
      state.reasoningIndex = state.nextContentIndex++;
      writes.push(this.update({ type: 'thinking_start', contentIndex: state.reasoningIndex }));
    }
    state.reasoning += delta;
    writes.push(this.update({ type: 'thinking_delta', contentIndex: state.reasoningIndex, delta }));
    return Promise.all(writes.map(write => Promise.resolve(write))).then(() => undefined);
  }

  finishAssistant(response: ChatResponse): Promise<void> {
    const state = this.assistant;
    if (!state) return Promise.resolve();
    const writes = this.completeTextBlocks(state, response);

    for (const call of response.toolCalls ?? []) {
      const contentIndex = state.nextContentIndex++;
      writes.push(this.update({
        type: 'toolcall_start',
        contentIndex,
        id: call.id,
        toolName: call.name,
      }, response.usage));
      writes.push(this.update({
        type: 'toolcall_end',
        contentIndex,
        toolCall: toolCallBlock(call),
      }, response.usage));
    }

    const stopReason = response.toolCalls?.length ? 'toolUse' : 'stop';
    const message = this.assistantMessage(state, response, stopReason);
    writes.push(this.emit({ type: 'message_end', message }));
    this.runMessages.push(message);
    this.turnAssistant = message;
    this.assistant = undefined;
    return Promise.all(writes.map(write => Promise.resolve(write))).then(() => undefined);
  }

  finishAssistantError(error: unknown, aborted = false): Promise<void> {
    const state = this.assistant;
    if (!state) return Promise.resolve();
    const message = this.assistantMessage(
      state,
      { content: state.text, reasoning: state.reasoning },
      aborted ? 'aborted' : 'error',
      error instanceof Error ? error.message : String(error),
    );
    const write = this.emit({ type: 'message_end', message });
    this.runMessages.push(message);
    this.turnAssistant = message;
    this.assistant = undefined;
    return Promise.resolve(write);
  }

  toolExecutionStart(call: ToolCall): Promise<void> {
    return Promise.resolve(this.emit({
      type: 'tool_execution_start',
      toolCallId: call.id,
      toolName: call.name,
      args: toolArguments(call.input),
    }));
  }

  toolExecutionUpdate(call: ToolCall, content: string): Promise<void> {
    return Promise.resolve(this.emit({
      type: 'tool_execution_update',
      toolCallId: call.id,
      toolName: call.name,
      args: toolArguments(call.input),
      partialResult: {
        content: [{ type: 'text', text: content }],
        details: {},
      },
    }));
  }

  toolExecutionEnd(result: ToolExecutionResult): Promise<void> {
    const mapped = toolResultContent(result);
    const writes = [
      this.emit({
        type: 'tool_execution_end',
        toolCallId: result.call.id,
        toolName: result.call.name,
        result: mapped.executionResult,
        isError: result.isError,
      }),
      this.emit({ type: 'message_start', message: mapped.message }),
      this.emit({ type: 'message_end', message: mapped.message }),
    ];
    this.turnToolResults.push(mapped.message);
    this.runMessages.push(mapped.message);
    return Promise.all(writes.map(write => Promise.resolve(write))).then(() => undefined);
  }

  endTurn(): Promise<void> {
    if (!this.turnOpen || !this.turnAssistant) return Promise.resolve();
    const write = this.emit({
      type: 'turn_end',
      message: this.turnAssistant,
      toolResults: this.turnToolResults,
    });
    this.turnOpen = false;
    return Promise.resolve(write);
  }

  endAgent(): Promise<void> {
    if (!this.runOpen) return Promise.resolve();
    const writes = [
      this.endTurn(),
      this.emit({ type: 'agent_end', messages: this.runMessages, willRetry: false }),
      this.emit({ type: 'agent_settled' }),
    ];
    this.runOpen = false;
    return Promise.all(writes.map(write => Promise.resolve(write))).then(() => undefined);
  }

  failAgent(error: unknown, aborted = false): Promise<void> {
    if (!this.runOpen) return Promise.resolve();
    const writes: Array<void | Promise<void>> = [];
    if (!this.turnOpen) writes.push(this.startTurn());
    if (!this.turnAssistant) {
      if (!this.assistant) writes.push(this.startAssistant('unknown'));
      writes.push(this.finishAssistantError(error, aborted));
    }
    writes.push(this.endAgent());
    return Promise.all(writes.map(write => Promise.resolve(write))).then(() => undefined);
  }

  retryStart(attempt: number, maxAttempts: number, delayMs: number, error: unknown): Promise<void> {
    return Promise.resolve(this.emit({
      type: 'auto_retry_start',
      attempt,
      maxAttempts,
      delayMs,
      errorMessage: error instanceof Error ? error.message : String(error),
    }));
  }

  retryEnd(success: boolean, attempt: number, finalError?: unknown): Promise<void> {
    return Promise.resolve(this.emit({
      type: 'auto_retry_end',
      success,
      attempt,
      ...(!success && finalError !== undefined
        ? { finalError: finalError instanceof Error ? finalError.message : String(finalError) }
        : {}),
    }));
  }

  summarizationRetryScheduled(
    attempt: number,
    maxAttempts: number,
    delayMs: number,
    error: unknown,
  ): Promise<void> {
    return Promise.resolve(this.emit({
      type: 'summarization_retry_scheduled',
      attempt,
      maxAttempts,
      delayMs,
      errorMessage: error instanceof Error ? error.message : String(error),
    }));
  }

  summarizationRetryAttemptStart(
    source: 'compaction' | 'branchSummary',
    reason?: 'manual' | 'threshold' | 'overflow',
  ): Promise<void> {
    return Promise.resolve(this.emit({
      type: 'summarization_retry_attempt_start',
      source,
      ...(reason ? { reason } : {}),
    }));
  }

  summarizationRetryFinished(): Promise<void> {
    return Promise.resolve(this.emit({ type: 'summarization_retry_finished' }));
  }

  compactionStart(reason: 'manual' | 'threshold' | 'overflow'): Promise<void> {
    return Promise.resolve(this.emit({ type: 'compaction_start', reason }));
  }

  compactionEnd(
    reason: 'manual' | 'threshold' | 'overflow',
    options: { result?: Record<string, unknown>; aborted?: boolean; willRetry?: boolean; error?: unknown },
  ): Promise<void> {
    return Promise.resolve(this.emit({
      type: 'compaction_end',
      reason,
      ...(options.result ? { result: options.result } : {}),
      aborted: options.aborted ?? false,
      willRetry: options.willRetry ?? false,
      ...(options.error !== undefined
        ? { errorMessage: options.error instanceof Error ? options.error.message : String(options.error) }
        : {}),
    }));
  }

  private completeTextBlocks(
    state: AssistantState,
    response: ChatResponse,
  ): Array<void | Promise<void>> {
    const writes: Array<void | Promise<void>> = [];
    if (response.reasoning && !state.reasoning) writes.push(this.reasoningDelta(response.reasoning));
    if (response.content && !state.text) writes.push(this.textDelta(response.content));

    if (state.reasoningIndex !== undefined) {
      writes.push(this.update({
        type: 'thinking_end',
        contentIndex: state.reasoningIndex,
        content: response.reasoning ?? state.reasoning,
      }, response.usage));
    }
    if (state.textIndex !== undefined) {
      writes.push(this.update({
        type: 'text_end',
        contentIndex: state.textIndex,
        content: response.content || state.text,
      }, response.usage));
    }
    return writes;
  }

  private update(
    assistantMessageEvent: Record<string, unknown>,
    usage?: ChatResponse['usage'],
  ): Promise<void> {
    return Promise.resolve(this.emit({
      type: 'message_update',
      usage: usageOf(usage, this.assistant?.provider, this.assistant?.model),
      assistantMessageEvent,
    }));
  }

  private assistantMessage(
    state: AssistantState,
    response: ChatResponse | undefined,
    stopReason: 'pending' | 'stop' | 'toolUse' | 'error' | 'aborted',
    errorMessage?: string,
  ): JsonMessage {
    const indexedContent: Array<{ index: number; block: Record<string, unknown> }> = [];
    const reasoning = response?.reasoning ?? state.reasoning;
    const text = response?.content ?? state.text;
    if (reasoning) indexedContent.push({
      index: state.reasoningIndex ?? indexedContent.length,
      block: { type: 'thinking', thinking: reasoning },
    });
    if (text) indexedContent.push({
      index: state.textIndex ?? indexedContent.length,
      block: { type: 'text', text },
    });
    const content = indexedContent.sort((left, right) => left.index - right.index).map(entry => entry.block);
    for (const call of response?.toolCalls ?? []) content.push(toolCallBlock(call));
    const provider = state.provider;
    return {
      role: 'assistant',
      content,
      api: providerApi(provider),
      provider,
      model: response?.model ?? state.model ?? 'unknown',
      usage: usageOf(response?.usage, provider, response?.model ?? state.model),
      stopReason,
      ...(errorMessage ? { errorMessage } : {}),
      timestamp: state.timestamp,
    };
  }
}

export interface ProcessJsonLinesOutput {
  /** Queue one LF-terminated record and resolve once the underlying stream accepts it. */
  write(record: unknown): Promise<void>;
  /** Wait until every queued record has reached the underlying stream. */
  flush(): Promise<void>;
  restore(): void;
}

const TRANSIENT_STDOUT_ERROR = new Set(['EAGAIN', 'ENOBUFS', 'EWOULDBLOCK']);

function writeRawChunk(
  rawWrite: typeof process.stdout.write,
  text: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      rawWrite(text, error => error ? reject(error) : resolve());
    } catch (error) {
      reject(error);
    }
  });
}

/** Reserve stdout for a serialized, backpressure-aware JSONL protocol and redirect accidental writes to stderr. */
export function reserveProcessStdoutForJsonLines(): ProcessJsonLinesOutput {
  const stdout = process.stdout;
  const originalWrite = stdout.write;
  const rawWrite = originalWrite.bind(stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  const redirectedWrite = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean => {
    if (typeof encodingOrCallback === 'string') return stderrWrite(chunk, encodingOrCallback, callback);
    return stderrWrite(chunk, encodingOrCallback);
  }) as typeof stdout.write;
  stdout.write = redirectedWrite;

  let tail = Promise.resolve();
  let failure: Error | undefined;
  const write = (record: unknown): Promise<void> => {
    const line = `${JSON.stringify(record)}\n`;
    const operation = tail.then(async () => {
      if (failure) throw failure;
      while (true) {
        try {
          await writeRawChunk(rawWrite, line);
          return;
        } catch (error) {
          const writeError = error instanceof Error ? error : new Error(String(error));
          const code = (writeError as NodeJS.ErrnoException).code;
          if (!code || !TRANSIENT_STDOUT_ERROR.has(code)) throw writeError;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
    });
    tail = operation.catch(error => {
      failure ??= error instanceof Error ? error : new Error(String(error));
    });
    return operation;
  };
  const flush = async (): Promise<void> => {
    while (true) {
      const pending = tail;
      await pending;
      if (pending === tail) break;
    }
    if (failure) throw failure;
  };

  return {
    write,
    flush,
    restore: () => {
      if (stdout.write === redirectedWrite) stdout.write = originalWrite;
    },
  };
}

export interface ProcessJsonOutput {
  events: JsonEventStream;
  flush(): Promise<void>;
  restore(): void;
}

export function reserveProcessStdoutForJson(): ProcessJsonOutput {
  const output = reserveProcessStdoutForJsonLines();
  return {
    events: new JsonEventStream(output.write),
    flush: output.flush,
    restore: output.restore,
  };
}
