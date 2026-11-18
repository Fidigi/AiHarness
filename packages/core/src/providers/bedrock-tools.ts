import type { BedrockChatOptions } from './index.js';
import { makeStrictToolSchema, UnsupportedStrictToolSchema } from './strict-tool-schema.js';
// Exact supportsStrictMode=true declarations in approved amazon-bedrock.json (Pi06a4669), not model-name inference.
const strictModels = new Set([
  'anthropic.claude-haiku-4-5-20251001-v1:0', 'anthropic.claude-opus-4-5-20251101-v1:0', 'anthropic.claude-opus-4-6-v1', 'anthropic.claude-sonnet-4-5-20250929-v1:0', 'anthropic.claude-sonnet-4-6',
  'au.anthropic.claude-haiku-4-5-20251001-v1:0', 'au.anthropic.claude-opus-4-6-v1', 'au.anthropic.claude-sonnet-4-5-20250929-v1:0', 'au.anthropic.claude-sonnet-4-6', 'deepseek.v3-v1:0', 'deepseek.v3.2',
  'eu.anthropic.claude-haiku-4-5-20251001-v1:0', 'eu.anthropic.claude-opus-4-5-20251101-v1:0', 'eu.anthropic.claude-opus-4-6-v1', 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0', 'eu.anthropic.claude-sonnet-4-6',
  'global.anthropic.claude-haiku-4-5-20251001-v1:0', 'global.anthropic.claude-opus-4-5-20251101-v1:0', 'global.anthropic.claude-opus-4-6-v1', 'global.anthropic.claude-sonnet-4-5-20250929-v1:0', 'global.anthropic.claude-sonnet-4-6',
  'global.moonshotai.kimi-k3', 'global.openai.gpt-5.6-luna', 'global.openai.gpt-6-astra', 'global.openai.gpt-6-luna', 'global.openai.gpt-6-sol', 'global.openai.gpt-6.1-sol', 'global.xai.grok-4.7', 'global.zai.glm-5.3',
  'google.gemma-4-26b-a4b', 'google.gemma-4-31b', 'google.gemma-4-e2b', 'in.openai.gpt-5.6-luna', 'jp.anthropic.claude-haiku-4-5-20251001-v1:0', 'jp.anthropic.claude-sonnet-4-5-20250929-v1:0', 'jp.anthropic.claude-sonnet-4-6',
  'minimax.minimax-m2', 'minimax.minimax-m2.1', 'minimax.minimax-m2.5', 'mistral.devstral-2-123b', 'mistral.magistral-small-2509', 'mistral.ministral-3-14b-instruct', 'mistral.ministral-3-3b-instruct', 'mistral.ministral-3-8b-instruct', 'mistral.mistral-large-3-675b-instruct', 'mistral.voxtral-mini-3b-2507', 'mistral.voxtral-small-24b-2507',
  'moonshot.kimi-k2-thinking', 'moonshotai.kimi-k2.5', 'nvidia.nemotron-nano-12b-v2', 'nvidia.nemotron-nano-3-30b', 'nvidia.nemotron-nano-9b-v2', 'nvidia.nemotron-super-3-120b',
  'openai.gpt-5.4', 'openai.gpt-5.5', 'openai.gpt-5.6-luna', 'openai.gpt-5.6-sol', 'openai.gpt-5.6-terra', 'openai.gpt-6-astra', 'openai.gpt-6-luna', 'openai.gpt-6-sol', 'openai.gpt-6.1-sol',
  'openai.gpt-oss-120b', 'openai.gpt-oss-120b-1:0', 'openai.gpt-oss-20b', 'openai.gpt-oss-20b-1:0', 'openai.gpt-oss-safeguard-120b', 'openai.gpt-oss-safeguard-20b',
  'qwen.qwen3-235b-a22b-2507-v1:0', 'qwen.qwen3-32b-v1:0', 'qwen.qwen3-coder-30b-a3b-v1:0', 'qwen.qwen3-coder-480b-a35b-v1:0', 'qwen.qwen3-coder-next', 'qwen.qwen3-next-80b-a3b', 'qwen.qwen3-vl-235b-a22b', 'us-gov.openai.gpt-oss-120b-1:0', 'us-gov.openai.gpt-oss-20b-1:0',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0', 'us.anthropic.claude-opus-4-5-20251101-v1:0', 'us.anthropic.claude-opus-4-6-v1', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'us.anthropic.claude-sonnet-4-6', 'us.moonshotai.kimi-k3',
  'us.openai.gpt-5.6-luna', 'us.openai.gpt-6-astra', 'us.openai.gpt-6-luna', 'us.openai.gpt-6-sol', 'us.openai.gpt-6.1-sol', 'us.xai.grok-4.7', 'us.zai.glm-5.3', 'xai.grok-4.3', 'xai.grok-4.6', 'zai.glm-4.7', 'zai.glm-4.7-flash', 'zai.glm-5',
]);

/** Caller tool policy only. Native constructor/exact model admission occurs before this helper. */
export function prepareBedrockTools(nativeModel: string | undefined, options?: BedrockChatOptions): Record<string, unknown> | undefined {
  const tools = options?.tools, choice = options?.toolChoice;
  if (!tools?.length || choice === 'none') return undefined;
  const invalid = (): never => { throw new Error('Invalid Bedrock tool policy.'); };
  const unsupported = (): never => { throw new Error('Bedrock tool requires unsupported constrained sampling.'); };
  const selectedTool = choice && typeof choice === 'object' && choice.type === 'tool' && typeof choice.name === 'string' && choice.name.length > 0 && tools.some(tool => tool.name === choice.name) ? choice.name : undefined;
  if (choice !== undefined && (!nativeModel || choice !== 'auto' && choice !== 'any' && selectedTool === undefined)) invalid();
  const supportsStrict = nativeModel !== undefined && strictModels.has(nativeModel);
  const definitions = tools.map(tool => {
    let parameters = tool.parameters, strict = false; const sampling = tool.constrainedSampling;
    if (sampling !== undefined && sampling !== false) {
      if (!sampling || sampling.type !== 'json_schema' || !['prefer', 'require'].includes(sampling.strict)) return invalid();
      if (!supportsStrict) { if (sampling.strict === 'require') unsupported(); }
      else {
        try { parameters = makeStrictToolSchema(parameters); strict = true; }
        catch (error) { if (!(error instanceof UnsupportedStrictToolSchema)) return invalid(); if (sampling.strict === 'require') unsupported(); }
      }
    }
    return { toolSpec: { name: tool.name, description: tool.description, inputSchema: { json: parameters }, ...(strict ? { strict: true } : {}) } };
  });
  return { tools: definitions, ...(choice === 'auto' ? { toolChoice: { auto: {} } } : choice === 'any' ? { toolChoice: { any: {} } } : selectedTool !== undefined ? { toolChoice: { tool: { name: selectedTool } } } : {}) };
}
