const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const validFinish = (value: unknown): boolean => typeof value === 'string'
  && ['end_turn', 'stop_sequence', 'tool_use', 'max_tokens', 'pause_turn'].includes(value);
function invalid(): never { throw new Error('Invalid Anthropic response.'); }
function validateEnvelope(value: Record<string, unknown>): void {
  if (value.error || (value.type !== undefined && value.type !== 'message')
    || (value.role !== undefined && value.role !== 'assistant')) invalid();
}

export function anthropicResponseToolInput(value: unknown): Record<string, unknown> {
  if (!record(value)) invalid();
  return value;
}
function validateBlock(value: unknown, complete: boolean): void {
  if (!record(value)) invalid();
  if (value.type === 'text') {
    if ((complete || value.text !== undefined) && typeof value.text !== 'string') invalid();
  } else if (value.type === 'thinking') {
    if ((complete || value.thinking !== undefined) && typeof value.thinking !== 'string') invalid();
    if (value.signature !== undefined && typeof value.signature !== 'string') invalid();
  } else if (value.type === 'redacted_thinking') {
    if (typeof value.data !== 'string') invalid();
  } else if (value.type === 'tool_use') {
    if (typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' || !value.name) invalid();
    if (complete || value.input !== undefined) anthropicResponseToolInput(value.input);
  } else invalid();
}
export function validateAnthropicResponse(value: unknown): void {
  if (!record(value)) invalid();
  validateEnvelope(value);
  if (!Array.isArray(value.content) || !validFinish(value.stop_reason)) invalid();
  for (const block of value.content) validateBlock(block, true);
}

/** Native terminal authority only; complete block lifecycle/replay qualification is separate. */
export function anthropicResponseStreamValidator(): (value?: unknown) => void {
  let started = false, finished = false, stopped = false;
  return value => {
    if (value === undefined) { if (!started || !finished || !stopped) invalid(); return; }
    if (!record(value) || typeof value.type !== 'string') invalid();
    if (value.type === 'ping') return;
    if (stopped) invalid();
    if (value.type === 'message_start') {
      if (started || !record(value.message)) invalid();
      validateEnvelope(value.message);
      started = true;
    } else if (value.type === 'message_delta') {
      if (!started || !record(value.delta)) invalid();
      if (value.delta.stop_reason !== undefined && value.delta.stop_reason !== null) {
        if (finished || !validFinish(value.delta.stop_reason)) invalid();
        finished = true;
      }
    } else if (value.type === 'message_stop') {
      if (!started || !finished) invalid();
      stopped = true;
    } else if (['content_block_start', 'content_block_delta', 'content_block_stop'].includes(value.type)) {
      if (!started || finished || !Number.isSafeInteger(value.index) || (value.index as number) < 0) invalid();
      if (value.type === 'content_block_start') validateBlock(value.content_block, false);
      else if (value.type === 'content_block_delta') {
        const delta = value.delta;
        if (!record(delta)) invalid();
        const key = delta.type === 'text_delta' ? 'text' : delta.type === 'thinking_delta' ? 'thinking'
          : delta.type === 'input_json_delta' ? 'partial_json' : delta.type === 'signature_delta' ? 'signature' : undefined;
        if (!key || typeof delta[key] !== 'string') invalid();
      }
    } else invalid();
  };
}
export function assertAnthropicResponseActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Anthropic request aborted.');
}
