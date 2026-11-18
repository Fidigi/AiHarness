import type { Message } from '../types/index.js';
import type { ChatOptions } from './index.js';
import { resolveThinkingBudget } from './thinking-budgets.js';
import { clampPublishedThinkingLevel, PUBLISHED_THINKING_LEVELS } from './model-metadata.js';
import type { ProviderOAuthCredential } from './credentials.js';
import { getGitHubCopilotBaseUrl } from './github-copilot-oauth.js';

export interface GitHubCopilotChatOptions extends ChatOptions {
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; name: string };
}

export type GitHubCopilotApi = 'anthropic-messages' | 'openai-completions' | 'openai-responses';
export interface GitHubCopilotModel {
  readonly id: string; readonly name: string; readonly api: GitHubCopilotApi; readonly provider: 'github-copilot';
  readonly type: 'chat'; readonly baseUrl: string; readonly reasoning: boolean;
  readonly input: readonly ('text' | 'image')[]; readonly contextWindow: number; readonly maxTokens: number;
  readonly cost: Readonly<{ input: number; output: number; cacheRead: number; cacheWrite: number;
    tiers?: readonly Readonly<{ inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }>[] }>;
  readonly headers: Readonly<Record<string, string>>;
  readonly compat?: Readonly<Partial<Record<'supportsMidConvoSystemMessages' | 'forceAdaptiveThinking' | 'supportsEagerToolInputStreaming' | 'supportsTemperature' | 'supportsStrictMode' | 'supportsStore' | 'supportsDeveloperRole' | 'supportsReasoningEffort' | 'supportsOpenAIGrammarTools' | 'supportsAdditionalTools', boolean>>>;
  readonly thinkingLevelMap?: Readonly<Partial<Record<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max', string | null>>>;
  readonly inputLimits?: Readonly<{ images: Readonly<{ resize: Readonly<{ maxWidth: number; maxHeight: number; maxBytes: number; jpegQuality: number }> }> }>;
}

// Pinned Copilot declarations, independently bound by github-copilot-routing-reference.json.
// Vendor list prices and image limits are declarations, not subscription billing or image preparation.
const models: GitHubCopilotModel[] = [
  {"id":"claude-fable-5","name":"Claude Fable 5","api":"anthropic-messages","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":10,"output":50,"cacheRead":1,"cacheWrite":12.5},"contextWindow":1000000,"maxTokens":128000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"compat":{"supportsMidConvoSystemMessages":true,"forceAdaptiveThinking":true},"thinkingLevelMap":{"off":null,"xhigh":"xhigh","max":"max"},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"claude-fable-5.1","name":"Claude Fable 5.1","api":"anthropic-messages","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":10,"output":50,"cacheRead":0.25,"cacheWrite":12.5},"contextWindow":1000000,"maxTokens":128000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"compat":{"supportsMidConvoSystemMessages":true,"forceAdaptiveThinking":true},"thinkingLevelMap":{"off":null,"xhigh":"xhigh","max":"max"},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"claude-haiku-4.5","name":"Claude Haiku 4.5 (latest)","api":"anthropic-messages","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":1,"output":5,"cacheRead":0.1,"cacheWrite":1.25},"contextWindow":200000,"maxTokens":64000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"compat":{"supportsEagerToolInputStreaming":false},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"claude-haiku-5.5","name":"Claude Haiku 5.5","api":"anthropic-messages","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":0.1,"output":0.5,"cacheRead":0.01,"cacheWrite":0.125,"tiers":[{"inputTokensAbove":100000,"input":0.5,"output":2.5,"cacheRead":0.05,"cacheWrite":0.625}]},"contextWindow":1000000,"maxTokens":128000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"compat":{"supportsMidConvoSystemMessages":true,"forceAdaptiveThinking":true,"supportsTemperature":false},"thinkingLevelMap":{"xhigh":"xhigh","max":"max"},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"claude-opus-4.7","name":"Claude Opus 4.7","api":"anthropic-messages","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":5,"output":25,"cacheRead":0.5,"cacheWrite":6.25},"contextWindow":1000000,"maxTokens":32000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"thinkingLevelMap":{"xhigh":"xhigh","max":"max","minimal":"low"},"compat":{"forceAdaptiveThinking":true,"supportsTemperature":false},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"claude-opus-4.8","name":"Claude Opus 4.8","api":"anthropic-messages","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":5,"output":25,"cacheRead":0.5,"cacheWrite":6.25},"contextWindow":1000000,"maxTokens":64000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"compat":{"supportsMidConvoSystemMessages":true,"forceAdaptiveThinking":true,"supportsTemperature":false},"thinkingLevelMap":{"xhigh":"xhigh","max":"max","minimal":"low"},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"claude-opus-5","name":"Claude Opus 5","api":"anthropic-messages","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":5,"output":25,"cacheRead":0.5,"cacheWrite":6.25},"contextWindow":1000000,"maxTokens":64000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"compat":{"supportsMidConvoSystemMessages":true,"forceAdaptiveThinking":true,"supportsTemperature":false},"thinkingLevelMap":{"xhigh":"xhigh","max":"max","minimal":"low"},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"claude-opus-5.5","name":"Claude Opus 5.5","api":"anthropic-messages","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":4,"output":20,"cacheRead":0.2,"cacheWrite":5},"contextWindow":1000000,"maxTokens":128000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"compat":{"supportsMidConvoSystemMessages":true,"forceAdaptiveThinking":true,"supportsTemperature":false},"thinkingLevelMap":{"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"claude-sonnet-4.6","name":"Claude Sonnet 4.6","api":"anthropic-messages","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":3,"output":15,"cacheRead":0.3,"cacheWrite":3.75},"contextWindow":1000000,"maxTokens":32000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"thinkingLevelMap":{"max":"max","minimal":"low"},"compat":{"forceAdaptiveThinking":true},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"claude-sonnet-5","name":"Claude Sonnet 5","api":"anthropic-messages","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":2,"output":10,"cacheRead":0.2,"cacheWrite":2.5},"contextWindow":1000000,"maxTokens":128000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"thinkingLevelMap":{"xhigh":"xhigh","max":"max"},"compat":{"forceAdaptiveThinking":true},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"claude-sonnet-5.5","name":"Claude Sonnet 5.5","api":"anthropic-messages","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":2,"output":10,"cacheRead":0.1,"cacheWrite":2.5},"contextWindow":1000000,"maxTokens":128000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"compat":{"supportsMidConvoSystemMessages":true,"forceAdaptiveThinking":true,"supportsTemperature":false},"thinkingLevelMap":{"xhigh":"xhigh","max":"max"},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"gemini-3.5-flash","name":"Gemini 3.5 Flash","api":"openai-completions","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":1.5,"output":9,"cacheRead":0.15,"cacheWrite":0},"contextWindow":200000,"maxTokens":64000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"compat":{"supportsStrictMode":true,"supportsStore":false,"supportsDeveloperRole":false,"supportsReasoningEffort":false},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"gemini-3.6-flash","name":"Gemini 3.6 Flash","api":"openai-completions","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":0.75,"output":3.75,"cacheRead":0.075,"cacheWrite":0},"contextWindow":1000000,"maxTokens":64000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"compat":{"supportsStrictMode":true,"supportsStore":false,"supportsDeveloperRole":false,"supportsReasoningEffort":false},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"gemini-3.7-flash","name":"Gemini 3.7 Flash","api":"openai-completions","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":0.75,"output":3.75,"cacheRead":0.075,"cacheWrite":0},"contextWindow":1000000,"maxTokens":64000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"compat":{"supportsStrictMode":true,"supportsStore":false,"supportsDeveloperRole":false,"supportsReasoningEffort":false},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"gemini-3.8-flash","name":"Gemini 3.8 Flash","api":"openai-completions","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":0.75,"output":3.75,"cacheRead":0.075,"cacheWrite":0},"contextWindow":1000000,"maxTokens":64000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"compat":{"supportsStrictMode":true,"supportsStore":false,"supportsDeveloperRole":false,"supportsReasoningEffort":false},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"kimi-k2.7-code","name":"Kimi K2.7 Code","api":"openai-completions","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":0.95,"output":4,"cacheRead":0.19,"cacheWrite":0},"contextWindow":256000,"maxTokens":32000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"compat":{"supportsStrictMode":true,"supportsStore":false,"supportsDeveloperRole":false,"supportsReasoningEffort":false},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"kimi-k3","name":"Kimi K3","api":"openai-completions","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":3,"output":15,"cacheRead":0.3,"cacheWrite":0},"contextWindow":1048576,"maxTokens":131072,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"compat":{"supportsStrictMode":true,"supportsStore":false,"supportsDeveloperRole":false,"supportsReasoningEffort":false,"supportsMidConvoSystemMessages":true},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"gpt-5-mini","name":"GPT-5 Mini","api":"openai-responses","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":0.25,"output":2,"cacheRead":0.025,"cacheWrite":0},"contextWindow":264000,"maxTokens":64000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"thinkingLevelMap":{"off":null,"minimal":"low","low":"low","medium":"medium","high":"high","xhigh":null,"max":null},"compat":{"supportsOpenAIGrammarTools":true},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"gpt-5.3-codex","name":"GPT-5.3 Codex","api":"openai-responses","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":1.75,"output":14,"cacheRead":0.175,"cacheWrite":0},"contextWindow":1000000,"maxTokens":128000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"thinkingLevelMap":{"off":null,"minimal":"low","low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":null},"compat":{"supportsOpenAIGrammarTools":true},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"gpt-5.4","name":"GPT-5.4","api":"openai-responses","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":2.5,"output":15,"cacheRead":0.25,"cacheWrite":0,"tiers":[{"inputTokensAbove":272000,"input":5,"output":22.5,"cacheRead":0.5,"cacheWrite":0}]},"contextWindow":1000000,"maxTokens":128000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"thinkingLevelMap":{"off":null,"minimal":"low","low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":null},"compat":{"supportsOpenAIGrammarTools":true,"supportsMidConvoSystemMessages":true,"supportsAdditionalTools":true},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"gpt-5.4-mini","name":"GPT-5.4 mini","api":"openai-responses","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":0.75,"output":4.5,"cacheRead":0.075,"cacheWrite":0},"contextWindow":400000,"maxTokens":128000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"thinkingLevelMap":{"off":null,"minimal":"low","low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":null},"compat":{"supportsOpenAIGrammarTools":true,"supportsMidConvoSystemMessages":true,"supportsAdditionalTools":true},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"gpt-5.4-nano","name":"GPT-5.4 nano","api":"openai-responses","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":0.2,"output":1.25,"cacheRead":0.02,"cacheWrite":0},"contextWindow":400000,"maxTokens":128000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"thinkingLevelMap":{"off":null,"minimal":"low","xhigh":"xhigh"},"compat":{"supportsOpenAIGrammarTools":true},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"gpt-5.5","name":"GPT-5.5","api":"openai-responses","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":5,"output":30,"cacheRead":0.5,"cacheWrite":0,"tiers":[{"inputTokensAbove":272000,"input":10,"output":45,"cacheRead":1,"cacheWrite":0}]},"contextWindow":1000000,"maxTokens":128000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"thinkingLevelMap":{"off":null,"minimal":"low","low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":null},"compat":{"supportsOpenAIGrammarTools":true,"supportsMidConvoSystemMessages":true,"supportsAdditionalTools":true},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"gpt-5.6-luna","name":"GPT-5.6 Luna","api":"openai-responses","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":0.2,"output":1.2,"cacheRead":0.02,"cacheWrite":0.25,"tiers":[{"inputTokensAbove":200000,"input":0.4,"output":1.8,"cacheRead":0.04,"cacheWrite":0.5}]},"contextWindow":1050000,"maxTokens":128000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"thinkingLevelMap":{"off":null,"minimal":"low","low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"},"compat":{"supportsOpenAIGrammarTools":true,"supportsMidConvoSystemMessages":true,"supportsAdditionalTools":true},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"gpt-5.6-sol","name":"GPT-5.6 Sol","api":"openai-responses","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":4,"output":20,"cacheRead":0.4,"cacheWrite":5,"tiers":[{"inputTokensAbove":272000,"input":8,"output":30,"cacheRead":0.8,"cacheWrite":10}]},"contextWindow":1050000,"maxTokens":128000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"thinkingLevelMap":{"off":null,"minimal":"low","low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"},"compat":{"supportsOpenAIGrammarTools":true,"supportsMidConvoSystemMessages":true,"supportsAdditionalTools":true},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"gpt-5.6-terra","name":"GPT-5.6 Terra","api":"openai-responses","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":2,"output":12,"cacheRead":0.2,"cacheWrite":2.5,"tiers":[{"inputTokensAbove":272000,"input":4,"output":18,"cacheRead":0.4,"cacheWrite":5}]},"contextWindow":1050000,"maxTokens":128000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"thinkingLevelMap":{"off":null,"minimal":"low","low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"},"compat":{"supportsOpenAIGrammarTools":true,"supportsMidConvoSystemMessages":true,"supportsAdditionalTools":true},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"gpt-6-astra","name":"GPT-6 Astra","api":"openai-responses","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":10,"output":50,"cacheRead":1,"cacheWrite":12.5,"tiers":[{"inputTokensAbove":272000,"input":20,"output":75,"cacheRead":2,"cacheWrite":25}]},"contextWindow":1000000,"maxTokens":128000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"thinkingLevelMap":{"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"},"compat":{"supportsOpenAIGrammarTools":true,"supportsMidConvoSystemMessages":true,"supportsAdditionalTools":true},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"gpt-6-luna","name":"GPT-6 Luna","api":"openai-responses","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":0.1,"output":0.5,"cacheRead":0.01,"cacheWrite":0.125,"tiers":[{"inputTokensAbove":272000,"input":0.2,"output":0.75,"cacheRead":0.02,"cacheWrite":0.25}]},"contextWindow":1000000,"maxTokens":128000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"thinkingLevelMap":{"off":"none","minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"},"compat":{"supportsOpenAIGrammarTools":true,"supportsMidConvoSystemMessages":true,"supportsAdditionalTools":true},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"gpt-6-sol","name":"GPT-6 Sol","api":"openai-responses","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":2,"output":10,"cacheRead":0.2,"cacheWrite":2.5,"tiers":[{"inputTokensAbove":272000,"input":4,"output":15,"cacheRead":0.4,"cacheWrite":5}]},"contextWindow":1000000,"maxTokens":128000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"thinkingLevelMap":{"off":"none","minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"},"compat":{"supportsOpenAIGrammarTools":true,"supportsMidConvoSystemMessages":true,"supportsAdditionalTools":true},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"gpt-6.1-sol","name":"GPT-6.1 Sol","api":"openai-responses","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":2,"output":10,"cacheRead":0.1,"cacheWrite":2.5,"tiers":[{"inputTokensAbove":272000,"input":4,"output":15,"cacheRead":0.2,"cacheWrite":5}]},"contextWindow":1050000,"maxTokens":128000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"thinkingLevelMap":{"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"},"compat":{"supportsOpenAIGrammarTools":true,"supportsMidConvoSystemMessages":true,"supportsAdditionalTools":true},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"grok-4.5","name":"Grok 4.5","api":"openai-responses","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":2,"output":6,"cacheRead":0.5,"cacheWrite":0,"tiers":[{"inputTokensAbove":200000,"input":4,"output":12,"cacheRead":1,"cacheWrite":0}]},"contextWindow":500000,"maxTokens":128000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"thinkingLevelMap":{"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":null,"max":null},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"grok-4.6","name":"Grok 4.6","api":"openai-responses","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":2,"output":6,"cacheRead":0.5,"cacheWrite":0,"tiers":[{"inputTokensAbove":200000,"input":4,"output":12,"cacheRead":1,"cacheWrite":0}]},"contextWindow":500000,"maxTokens":128000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"thinkingLevelMap":{"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":null},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"grok-4.7","name":"Grok 4.7","api":"openai-responses","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":2,"output":6,"cacheRead":0.5,"cacheWrite":0,"tiers":[{"inputTokensAbove":200000,"input":4,"output":12,"cacheRead":1,"cacheWrite":0}]},"contextWindow":500000,"maxTokens":128000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"thinkingLevelMap":{"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":null},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
  {"id":"mai-code-1-flash-picker","name":"MAI-Code-1-Flash","api":"openai-responses","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text"],"cost":{"input":0.75,"output":4.5,"cacheRead":0.075,"cacheWrite":0},"contextWindow":256000,"maxTokens":128000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"thinkingLevelMap":{"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":null,"max":null},"type":"chat"},
  {"id":"mai-code-1.1-flash","name":"MAI-Code-1.1-Flash","api":"openai-responses","provider":"github-copilot","baseUrl":"https://api.individual.githubcopilot.com","reasoning":true,"input":["text","image"],"cost":{"input":0.2,"output":1.2,"cacheRead":0.02,"cacheWrite":0},"contextWindow":256000,"maxTokens":128000,"headers":{"User-Agent":"GitHubCopilotChat/0.35.0","Editor-Version":"vscode/1.107.0","Editor-Plugin-Version":"copilot-chat/0.35.0","Copilot-Integration-Id":"vscode-chat"},"thinkingLevelMap":{"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":null,"max":null},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},
];
// The catalogue owns route/policy selection; its public metadata must not be writable.
function freeze(value: object): void {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  Object.freeze(value);
}
freeze(models);
export const GITHUB_COPILOT_MODELS: readonly GitHubCopilotModel[] = models;
const byId = new Map(models.map(model => [model.id, model]));

export function githubCopilotModel(id: string): GitHubCopilotModel {
  const model = byId.get(id);
  if (!model) throw new Error('GitHub Copilot model is not supported.');
  return model;
}

export function githubCopilotAccountModels(availableModelIds: readonly string[]): readonly GitHubCopilotModel[] {
  const available = new Set(availableModelIds);
  return models.filter(model => available.has(model.id));
}

/** Resolve only an explicit subscription and an account-visible, pinned model. */
export function githubCopilotRoute(credential: ProviderOAuthCredential, id: string, now = Date.now()): { model: GitHubCopilotModel; url: string } {
  if (credential?.version !== 1 || credential.type !== 'oauth' || credential.subscription?.provider !== 'github-copilot'
    || !Number.isSafeInteger(credential.expiresAt) || credential.expiresAt! <= now
    || !Array.isArray(credential.subscription.availableModelIds) || !credential.subscription.availableModelIds.includes(id)) {
    throw new Error('GitHub Copilot subscription or model is unavailable.');
  }
  const model = githubCopilotModel(id);
  const baseUrl = getGitHubCopilotBaseUrl(credential.accessToken, credential.subscription.enterpriseDomain);
  const suffix = model.api === 'anthropic-messages' ? '/v1/messages?beta=true'
    : model.api === 'openai-completions' ? '/chat/completions' : '/responses';
  return { model, url: baseUrl + suffix };
}

function copilotRequestOptions(model: GitHubCopilotModel, options: GitHubCopilotChatOptions): GitHubCopilotChatOptions {
  if (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > model.maxTokens)) {
    throw new Error('Invalid GitHub Copilot output limit.');
  }
  const requested = options.thinking;
  if (requested !== undefined && !PUBLISHED_THINKING_LEVELS.includes(requested)) throw new Error('Invalid GitHub Copilot thinking level.');
  // Raw omission/off stays omission or native disabled; it does not force an unsupported disable effort.
  if (requested === undefined || requested === 'off') return options;
  const available = PUBLISHED_THINKING_LEVELS.filter(level => model.thinkingLevelMap?.[level] !== null
    && (!['xhigh', 'max'].includes(level) || model.thinkingLevelMap?.[level] !== undefined));
  return { ...options, thinking: clampPublishedThinkingLevel(requested, available) };
}

/** Copilot C lowering is independent of the original-vendor and OpenCode dialects. */
export function githubCopilotCompletionsBody(model: GitHubCopilotModel, messages: readonly Message[], options: GitHubCopilotChatOptions = {}, native = false): Record<string, unknown> {
  if (model.api !== 'openai-completions') throw new Error('GitHub Copilot model protocol is unavailable.');
  options = copilotRequestOptions(model, options);
  const rows: Record<string, unknown>[] = [];
  let pendingImages: Array<{ type: string; image_url: { url: string } }> = [];
  const flushImages = () => {
    if (pendingImages.length) rows.push({ role: 'user', content: [{ type: 'text', text: 'Attached image(s) from tool result:' }, ...pendingImages] });
    pendingImages = [];
  };
  if (options.systemPrompt) rows.push({ role: 'system', content: options.systemPrompt });
  for (const message of messages) {
    if (message.role !== 'tool') flushImages();
    const images = message.blocks?.filter(block => block.type === 'image') ?? [];
    if (message.role === 'tool') {
      rows.push({ role: 'tool', content: message.content || (images.length ? '(see attached image)' : '(no tool output)'), tool_call_id: message.toolCallId });
      pendingImages.push(...images.map(image => ({ type: 'image_url', image_url: { url: image.url } })));
    } else if (message.role === 'assistant') {
      if (!native && message.metadata?.outputError) continue;
      // Until private continuation is independently admitted, only ordered visible text is portable.
      const visible = message.blocks?.flatMap(block => block.type === 'text' ? [block.text]
        : block.type === 'reasoning' && !block.redacted ? [block.text] : []).join('');
      const calls = message.toolCalls ?? message.blocks?.flatMap(block => block.type === 'tool_call' ? [block] : []);
      rows.push({ role: 'assistant', content: visible || message.content || null,
        ...(calls?.length ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } })) } : {}) });
    } else rows.push({ role: message.role, content: images.length ? [
      ...(message.content ? [{ type: 'text', text: message.content }] : []),
      ...images.map(image => ({ type: 'image_url', image_url: { url: image.url } })),
    ] : message.content });
  }
  flushImages();
  return { model: model.id, messages: rows, stream: true, stream_options: { include_usage: true },
    ...(options.maxTokens === undefined ? {} : { max_completion_tokens: options.maxTokens }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.tools?.length ? { tools: options.tools.map(tool => ({ type: 'function', function: {
      name: tool.name, description: tool.description, parameters: structuredClone(tool.parameters), strict: false,
    } })) } : messages.some(message => message.role === 'tool' || message.toolCalls?.length) ? { tools: [] } : {}),
    ...(options.toolChoice === undefined ? {} : { tool_choice: options.toolChoice }) };
}

export function githubCopilotResponsesBody(model: GitHubCopilotModel, messages: readonly Message[], options: GitHubCopilotChatOptions = {}, native = false): Record<string, unknown> & { model: string; input: Record<string, unknown>[]; stream: true } {
  if (model.api !== 'openai-responses') throw new Error('GitHub Copilot model protocol is unavailable.');
  options = copilotRequestOptions(model, options);
  const input: Record<string, unknown>[] = [];
  if (options.systemPrompt) input.push({ role: 'developer', content: options.systemPrompt });
  for (const message of messages) {
    const images = message.blocks?.filter(block => block.type === 'image') ?? [];
    if (message.role === 'tool') {
      const output = images.length && model.input.includes('image') ? [
        ...(message.content ? [{ type: 'input_text', text: message.content }] : []),
        ...images.map(image => ({ type: 'input_image', image_url: image.url, detail: 'auto' })),
      ] : message.content + (images.length ? '\n(tool image omitted: model does not support images)' : '');
      input.push({ type: 'function_call_output', call_id: message.toolCallId ?? message.id, output });
    } else if (message.role === 'assistant') {
      if (!native && message.metadata?.outputError) continue;
      const visible = message.blocks?.flatMap(block => block.type === 'text' ? [block.text]
        : block.type === 'reasoning' && !block.redacted ? [block.text] : []).join('') || message.content;
      if (visible) input.push({ role: 'assistant', content: [{ type: 'output_text', text: visible, annotations: [] }] });
      for (const call of message.toolCalls ?? message.blocks?.flatMap(block => block.type === 'tool_call' ? [block] : []) ?? []) {
        input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.input) });
      }
    } else if (message.role === 'system') input.push({ role: 'developer', content: message.content });
    else input.push({ role: 'user', content: [
      ...(message.content ? [{ type: 'input_text', text: message.content }] : []),
      ...images.map(image => model.input.includes('image') ? { type: 'input_image', image_url: image.url, detail: 'auto' }
        : { type: 'input_text', text: '(image omitted: model does not support images)' }),
    ] });
  }
  return { model: model.id, input, stream: true, store: false,
    ...(options.maxTokens === undefined ? {} : { max_output_tokens: options.maxTokens }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.tools?.length ? { tools: options.tools.map(tool => ({ type: 'function', name: tool.name,
      description: tool.description, parameters: structuredClone(tool.parameters) })) } : {}),
    ...(options.toolChoice === undefined ? {} : { tool_choice: options.toolChoice }),
    ...(options.thinking && options.thinking !== 'off' ? { reasoning: { effort: model.thinkingLevelMap?.[options.thinking] ?? options.thinking, summary: 'auto' }, include: ['reasoning.encrypted_content'] } : {}) };
}

export function githubCopilotMessagesBody(model: GitHubCopilotModel, messages: readonly Message[], options: GitHubCopilotChatOptions = {}, nativeAssistantContent?: unknown[]): Record<string, unknown> {
  if (model.api !== 'anthropic-messages') throw new Error('GitHub Copilot model protocol is unavailable.');
  options = copilotRequestOptions(model, options);
  const rows: Array<{ role: string; content: string | Array<Record<string, unknown>> }> = [];
  const systems = options.systemPrompt ? [options.systemPrompt] : [];
  let assistantIndex = 0;
  for (const message of messages) {
    if (message.role === 'system') { systems.push(message.content); continue; }
    const images = (message.blocks ?? []).flatMap(block => {
      if (block.type !== 'image') return [];
      const data = /^data:([^;,]+);base64,(.+)$/su.exec(block.url);
      if (!data) throw new Error('Invalid GitHub Copilot image input.');
      return [{ type: 'image', source: { type: 'base64', media_type: data[1], data: data[2] } }];
    });
    if (message.role === 'tool') {
      rows.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: message.toolCallId, is_error: message.isError === true,
        content: images.length ? [...(message.content ? [{ type: 'text', text: message.content }] : []), ...images] : message.content }] });
    } else if (message.role === 'assistant') {
      if (message.metadata?.outputError) continue;
      const content: Array<Record<string, unknown>> = message.blocks?.flatMap(block => block.type === 'text' ? [{ type: 'text', text: block.text }]
        : block.type === 'reasoning' && !block.redacted && block.text ? [{ type: 'text', text: block.text }] : []) ?? [];
      if (!content.length && message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls ?? message.blocks?.flatMap(block => block.type === 'tool_call' ? [block] : []) ?? []) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: structuredClone(call.input) });
      }
      const ownedContent = nativeAssistantContent?.[assistantIndex++];
      if (ownedContent !== undefined) rows.push({ role: 'assistant', content: ownedContent as Array<Record<string, unknown>> });
      else if (content.length) rows.push({ role: 'assistant', content });
    } else rows.push({ role: 'user', content: images.length ? [...(message.content ? [{ type: 'text', text: message.content }] : []), ...images] : message.content });
  }
  const tools: Array<Record<string, unknown>> = (options.tools ?? []).map(tool => ({ name: tool.name, description: tool.description,
    ...(model.compat?.supportsEagerToolInputStreaming === false ? {} : { eager_input_streaming: true }),
    input_schema: { type: 'object', properties: structuredClone(tool.parameters.properties ?? {}), required: structuredClone(tool.parameters.required ?? []) } }));
  const system: Array<Record<string, unknown>> = systems.filter(Boolean).map(text => ({ type: 'text', text }));
  if (options.cacheRetention !== 'none') {
    const cache = { type: 'ephemeral', ...(options.cacheRetention === 'long' ? { ttl: '1h' } : {}) };
    if (system.length) system[system.length - 1].cache_control = cache;
    if (tools.length) tools[tools.length - 1].cache_control = cache;
    const last = rows.at(-1);
    if (last) {
      if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
      const block = last.content.at(-1); if (block) block.cache_control = cache;
    }
  }
  const thinking = options.thinking && options.thinking !== 'off';
  const body: Record<string, unknown> = { model: model.id, messages: rows, max_tokens: options.maxTokens ?? model.maxTokens, stream: true,
    ...(system.length ? { system } : {}), ...(tools.length ? { tools } : {}),
    ...(options.temperature !== undefined && !thinking && model.compat?.supportsTemperature !== false ? { temperature: options.temperature } : {}) };
  if (options.thinking && options.thinking !== 'off') {
    if (model.compat?.forceAdaptiveThinking) {
      body.thinking = { type: 'adaptive', display: 'summarized' }; body.output_config = { effort: model.thinkingLevelMap?.[options.thinking] ?? options.thinking };
    } else {
      const maximum = options.maxTokens ?? model.maxTokens;
      if (maximum < 2048) throw new Error('Invalid GitHub Copilot thinking allocation.');
      body.thinking = { type: 'enabled', budget_tokens: resolveThinkingBudget(options.thinking, options.thinkingBudgets, 1024, 1024, maximum - 1024), display: 'summarized' };
    }
  } else if (options.thinking === 'off' && model.thinkingLevelMap?.off !== null) body.thinking = { type: 'disabled' };
  if (options.toolChoice !== undefined) body.tool_choice = typeof options.toolChoice === 'string'
    ? { type: options.toolChoice === 'required' ? 'any' : options.toolChoice } : { type: 'tool', name: options.toolChoice.name };
  return body;
}

export function githubCopilotMessageHeaders(model: GitHubCopilotModel, headers: Record<string, string>, options?: GitHubCopilotChatOptions): Record<string, string> {
  const betas = model.compat?.supportsEagerToolInputStreaming === false ? ['fine-grained-tool-streaming-2025-05-14'] : [];
  if (!model.compat?.forceAdaptiveThinking && options?.thinking && options.thinking !== 'off') betas.push('interleaved-thinking-2025-05-14');
  return { ...headers, 'anthropic-version': '2023-06-01', ...(betas.length ? { 'anthropic-beta': betas.join(',') } : {}) };
}

export function githubCopilotCompletionsValidator(native = false): (value?: unknown) => void {
  let finished = false;
  const invalid = (): never => { throw new Error('Invalid GitHub Copilot completion stream.'); };
  return value => {
    if (value === undefined) { if (!finished) invalid(); return; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
    const choices = (value as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length > 1) invalid();
    for (const item of choices as Array<{ delta?: Record<string, unknown>; finish_reason?: unknown }>) {
      if (!item || typeof item !== 'object' || !item.delta || typeof item.delta !== 'object' || Array.isArray(item.delta) || finished) return invalid();
      if (!native && item.delta.reasoning_details !== undefined) throw new Error('Unsupported GitHub Copilot private continuation.');
      if (item.finish_reason !== undefined && item.finish_reason !== null) {
        if (!['stop', 'length', 'tool_calls'].includes(String(item.finish_reason))) invalid();
        finished = true;
      }
    }
  };
}

/** Compute intent before tool-result images are lowered into synthetic user messages. */
export function githubCopilotHeaders(accessToken: string, messages: readonly Message[]): Record<string, string> {
  if (!accessToken || Buffer.byteLength(accessToken) > 64 * 1024 || /[\u0000-\u0020\u007f-\u009f]/u.test(accessToken)) {
    throw new Error('Invalid GitHub Copilot token.');
  }
  const last = messages.at(-1);
  const images = messages.some(message => (message.role === 'user' || message.role === 'tool') && message.blocks?.some(block => block.type === 'image'));
  return { ...models[0].headers, 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken,
    'X-Initiator': last && last.role !== 'user' ? 'agent' : 'user', 'Openai-Intent': 'conversation-edits',
    ...(images ? { 'Copilot-Vision-Request': 'true' } : {}) };
}
