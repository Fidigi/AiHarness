import type { ThinkingLevel } from './index.js';

type Cost = { input: number; output: number; cacheRead: number; cacheWrite: number;
  tiers?: readonly { inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }[] };
type Declaration = readonly [string, string, number, number, readonly ('text' | 'image')[], Cost, Partial<Record<ThinkingLevel, string | null>> | null];
// Independently owned P declarations from the already pinned Radius catalogue. Never select a vendor API by model name.
const declarations: readonly Declaration[] = [
  ["balanced","Balanced",1048576,131072,["text","image"],{"input":3,"output":15,"cacheRead":0.3,"cacheWrite":0},{"off":null,"minimal":null,"low":"low","medium":null,"high":"high","xhigh":null,"max":"max"}],
  ["cheap","Cheap",1000000,32768,["text","image"],{"input":0.3,"output":1.2,"cacheRead":0.006,"cacheWrite":0},{"off":"none","minimal":null,"low":"low","medium":null,"high":"high","xhigh":null,"max":"max"}],
  ["claude-fable-5","Claude Fable 5",1000000,128000,["text","image"],{"input":10,"output":50,"cacheRead":1,"cacheWrite":12.5},{"off":null,"xhigh":"xhigh","max":"max"}],
  ["claude-fable-5-1","Claude Fable 5.1",1000000,128000,["text","image"],{"input":10,"output":50,"cacheRead":0.25,"cacheWrite":12.5},{"off":null,"xhigh":"xhigh","max":"max"}],
  ["claude-haiku-4-5","Claude Haiku 4.5",200000,64000,["text","image"],{"input":1,"output":5,"cacheRead":0.1,"cacheWrite":1.25},null],
  ["claude-haiku-5-5","Claude Haiku 5.5",1000000,128000,["text","image"],{"input":0.1,"output":0.5,"cacheRead":0.01,"cacheWrite":0.125,"tiers":[{"inputTokensAbove":100000,"input":0.5,"output":2.5,"cacheRead":0.05,"cacheWrite":0.625}]},{"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}],
  ["claude-opus-4-5","Claude Opus 4.5",200000,64000,["text","image"],{"input":5,"output":25,"cacheRead":0.5,"cacheWrite":6.25},null],
  ["claude-opus-4-8","Claude Opus 4.8",1000000,128000,["text","image"],{"input":5,"output":25,"cacheRead":0.5,"cacheWrite":6.25},{"xhigh":"xhigh","max":"max"}],
  ["claude-opus-5","Claude Opus 5",1000000,128000,["text","image"],{"input":5,"output":25,"cacheRead":0.5,"cacheWrite":6.25},{"off":null,"xhigh":"xhigh","max":"max"}],
  ["claude-opus-5-5","Claude Opus 5.5",1000000,128000,["text","image"],{"input":4,"output":20,"cacheRead":0.2,"cacheWrite":5},{"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}],
  ["claude-sonnet-4-5","Claude Sonnet 4.5",1000000,64000,["text","image"],{"input":3,"output":15,"cacheRead":0.3,"cacheWrite":3.75},null],
  ["claude-sonnet-5","Claude Sonnet 5",1000000,128000,["text","image"],{"input":2,"output":10,"cacheRead":0.2,"cacheWrite":2.5},{"xhigh":"xhigh","max":"max"}],
  ["claude-sonnet-5-5","Claude Sonnet 5.5",1000000,128000,["text","image"],{"input":2,"output":10,"cacheRead":0.2,"cacheWrite":2.5},{"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}],
  ["deepseek-v4.1-flash","DeepSeek V4.1 Flash",1000000,32768,["text","image"],{"input":0.3,"output":1.2,"cacheRead":0.006,"cacheWrite":0},{"off":"none","minimal":null,"low":"low","medium":null,"high":"high","xhigh":null,"max":"max"}],
  ["glm-5.3","GLM-5.3",1000000,131072,["text"],{"input":1.4,"output":4.4,"cacheRead":0.26,"cacheWrite":0},{"off":null,"minimal":"minimal","low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"xhigh"}],
  ["glm-5.3-flash","GLM-5.3 Flash",1000000,131072,["text"],{"input":0.15,"output":0.5,"cacheRead":0.03,"cacheWrite":0},{"off":null,"minimal":null,"low":"low","medium":null,"high":"high","xhigh":null,"max":"max"}],
  ["gpt-5.3-codex","GPT 5.3 Codex",400000,128000,["text","image"],{"input":1.75,"output":14,"cacheRead":0.175,"cacheWrite":0},{"off":"none","minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":null}],
  ["gpt-5.4","GPT 5.4",272000,128000,["text","image"],{"input":2.5,"output":15,"cacheRead":0.25,"cacheWrite":0,"tiers":[{"inputTokensAbove":272000,"input":5,"output":22.5,"cacheRead":0.5,"cacheWrite":0}]},{"off":"none","minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":null}],
  ["gpt-5.4-mini","GPT 5.4 Mini",400000,128000,["text","image"],{"input":0.75,"output":4.5,"cacheRead":0.075,"cacheWrite":0},{"off":"none","minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":null}],
  ["gpt-5.5","GPT 5.5",272000,128000,["text","image"],{"input":5,"output":30,"cacheRead":0.5,"cacheWrite":0,"tiers":[{"inputTokensAbove":272000,"input":10,"output":45,"cacheRead":1,"cacheWrite":0}]},{"off":"none","minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":null}],
  ["gpt-5.6-luna","GPT 5.6 Luna",272000,128000,["text","image"],{"input":0.2,"output":1.2,"cacheRead":0.02,"cacheWrite":0.25,"tiers":[{"inputTokensAbove":272000,"input":0.4,"output":1.8,"cacheRead":0.04,"cacheWrite":0.5}]},{"off":"none","minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}],
  ["gpt-5.6-sol","GPT 5.6 Sol",272000,128000,["text","image"],{"input":4,"output":20,"cacheRead":0.4,"cacheWrite":5,"tiers":[{"inputTokensAbove":272000,"input":8,"output":30,"cacheRead":0.8,"cacheWrite":10}]},{"off":"none","minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}],
  ["gpt-5.6-terra","GPT 5.6 Terra",272000,128000,["text","image"],{"input":2,"output":12,"cacheRead":0.2,"cacheWrite":2.5,"tiers":[{"inputTokensAbove":272000,"input":4,"output":18,"cacheRead":0.4,"cacheWrite":5}]},{"off":"none","minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}],
  ["gpt-6-astra","GPT 6 Astra",272000,128000,["text","image"],{"input":10,"output":50,"cacheRead":1,"cacheWrite":12.5,"tiers":[{"inputTokensAbove":272000,"input":20,"output":75,"cacheRead":2,"cacheWrite":25}]},{"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}],
  ["gpt-6-luna","GPT 6 Luna",1050000,128000,["text","image"],{"input":0.1,"output":0.5,"cacheRead":0.01,"cacheWrite":0.125,"tiers":[{"inputTokensAbove":272000,"input":0.2,"output":0.75,"cacheRead":0.02,"cacheWrite":0.25}]},{"off":"none","minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}],
  ["gpt-6-sol","GPT 6 Sol",1050000,128000,["text","image"],{"input":2,"output":10,"cacheRead":0.2,"cacheWrite":2.5,"tiers":[{"inputTokensAbove":272000,"input":4,"output":15,"cacheRead":0.4,"cacheWrite":5}]},{"off":"none","minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}],
  ["grok-4.7","Grok 4.7",500000,500000,["text","image"],{"input":2,"output":6,"cacheRead":0.5,"cacheWrite":0,"tiers":[{"inputTokensAbove":200000,"input":4,"output":12,"cacheRead":1,"cacheWrite":0}]},{"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":null}],
  ["kimi-k3","Kimi K3",1048576,131072,["text","image"],{"input":3,"output":15,"cacheRead":0.3,"cacheWrite":0},{"off":null,"minimal":null,"low":"low","medium":null,"high":"high","xhigh":null,"max":"max"}],
  ["precise","Precise",272000,128000,["text","image"],{"input":4,"output":20,"cacheRead":0.4,"cacheWrite":5,"tiers":[{"inputTokensAbove":272000,"input":8,"output":30,"cacheRead":0.8,"cacheWrite":10}]},{"off":"none","minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}],
];
export const RADIUS_MODELS = Object.freeze(declarations.map(([id, name, contextWindow, maxOutputTokens, input, cost, thinking]) => Object.freeze({
  id, name, api: 'pi-messages' as const, reasoning: true, contextWindow, maxOutputTokens, declaredInput: Object.freeze([...input]),
  ...(thinking ? { thinkingLevelMap: Object.freeze({ ...thinking }) } : {}),
  pricing: Object.freeze({ inputPerMillion: cost.input, outputPerMillion: cost.output, cacheReadPerMillion: cost.cacheRead, cacheWritePerMillion: cost.cacheWrite }),
  pricingTiers: Object.freeze((cost.tiers ?? []).map(tier => Object.freeze({ inputTokensAbove: tier.inputTokensAbove,
    inputPerMillion: tier.input, outputPerMillion: tier.output, cacheReadPerMillion: tier.cacheRead, cacheWritePerMillion: tier.cacheWrite }))),
  ...(input.includes('image') ? { imageResizeLimits: Object.freeze({ maxWidth: 2000, maxHeight: 2000, maxBytes: 4_718_592, jpegQuality: 80 }) } : {}),
})));
export function radiusModel(id: string) {
  const model = RADIUS_MODELS.find(model => model.id === id);
  if (!model) throw new Error('Radius model is not supported.');
  return model;
}
