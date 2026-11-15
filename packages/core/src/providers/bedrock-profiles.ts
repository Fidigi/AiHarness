import { simpleContextTokens } from './simple-context-estimate.js';
import type { ChatOptions, ChatResponse } from './index.js';
import type { Message } from '../types/index.js';
import type { PublishedModelMetadata } from './model-metadata.js';
import { copyThinkingBudgets } from './thinking-budgets.js';
import { ProviderOutputBudgetError, type PreparedNativeOutputBudget } from './provider-output-budget.js';

// Pi 1.2.0 / 06a4669, approved amazon-bedrock.json; the independent fixture binds
// its digest and executed AWS SDK observations. Declarations are not availability.
interface Rates { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number }
interface Cost extends Rates { readonly tiers?: readonly (Rates & { readonly inputTokensAbove: number })[] }
type Row = readonly [id: string, name: string, context: number, output: number, reasoning: boolean, image: boolean, cost: Cost];
const rows: readonly Row[] = [
  ["amazon.nova-2-lite-v1:0","Nova 2 Lite",1000000,65535,true,true,{"input":0.33,"output":2.75,"cacheRead":0.0825,"cacheWrite":0.33}],
  ["amazon.nova-lite-v1:0","Nova Lite",300000,10000,false,true,{"input":0.06,"output":0.24,"cacheRead":0.015,"cacheWrite":0.06}],
  ["amazon.nova-micro-v1:0","Nova Micro",128000,10000,false,false,{"input":0.035,"output":0.14,"cacheRead":0.00875,"cacheWrite":0.035}],
  ["amazon.nova-pro-v1:0","Nova Pro",300000,10000,false,true,{"input":0.8,"output":3.2,"cacheRead":0.2,"cacheWrite":0.8}],
  ["anthropic.claude-fable-5","Claude Fable 5",1000000,128000,true,true,{"input":10,"output":50,"cacheRead":1,"cacheWrite":12.5}],
  ["anthropic.claude-fable-5-1","Claude Fable 5.1",1000000,128000,true,true,{"input":10,"output":50,"cacheRead":0.25,"cacheWrite":12.5}],
  ["anthropic.claude-haiku-4-5-20251001-v1:0","Claude Haiku 4.5",200000,64000,true,true,{"input":1,"output":5,"cacheRead":0.1,"cacheWrite":1.25}],
  ["anthropic.claude-haiku-5-5","Claude Haiku 5.5",1000000,128000,true,true,{"input":0.1,"output":0.5,"cacheRead":0.01,"cacheWrite":0.125,"tiers":[{"inputTokensAbove":100000,"input":0.5,"output":2.5,"cacheRead":0.05,"cacheWrite":0.625}]}],
  ["anthropic.claude-opus-4-1-20250805-v1:0","Claude Opus 4.1",200000,32000,true,true,{"input":15,"output":75,"cacheRead":1.5,"cacheWrite":18.75}],
  ["anthropic.claude-opus-4-5-20251101-v1:0","Claude Opus 4.5",200000,64000,true,true,{"input":5,"output":25,"cacheRead":0.5,"cacheWrite":6.25}],
  ["anthropic.claude-opus-4-6-v1","Claude Opus 4.6",1000000,128000,true,true,{"input":5.5,"output":27.5,"cacheRead":0.55,"cacheWrite":6.875}],
  ["anthropic.claude-opus-4-7","Claude Opus 4.7",1000000,128000,true,true,{"input":5,"output":25,"cacheRead":0.5,"cacheWrite":6.25}],
  ["anthropic.claude-opus-4-8","Claude Opus 4.8",1000000,128000,true,true,{"input":5,"output":25,"cacheRead":0.5,"cacheWrite":6.25}],
  ["anthropic.claude-opus-5-5","Claude Opus 5.5",1000000,128000,true,true,{"input":4,"output":20,"cacheRead":0.2,"cacheWrite":5}],
  ["anthropic.claude-sonnet-4-5-20250929-v1:0","Claude Sonnet 4.5",200000,64000,true,true,{"input":3,"output":15,"cacheRead":0.3,"cacheWrite":3.75}],
  ["anthropic.claude-sonnet-4-6","Claude Sonnet 4.6",1000000,128000,true,true,{"input":3.3,"output":16.5,"cacheRead":0.33,"cacheWrite":4.125}],
  ["anthropic.claude-sonnet-5","Claude Sonnet 5",1000000,128000,true,true,{"input":2,"output":10,"cacheRead":0.2,"cacheWrite":2.5}],
  ["anthropic.claude-sonnet-5-5","Claude Sonnet 5.5",1000000,128000,true,true,{"input":2,"output":10,"cacheRead":0.1,"cacheWrite":2.5}],
  ["apac.amazon.nova-lite-v1:0","Nova Lite (APAC)",300000,10000,false,true,{"input":0.063,"output":0.252,"cacheRead":0.01575,"cacheWrite":0.063}],
  ["apac.amazon.nova-micro-v1:0","Nova Micro (APAC)",128000,10000,false,false,{"input":0.037,"output":0.148,"cacheRead":0.00925,"cacheWrite":0.037}],
  ["apac.amazon.nova-pro-v1:0","Nova Pro (APAC)",300000,10000,false,true,{"input":0.84,"output":3.36,"cacheRead":0.21,"cacheWrite":0.84}],
  ["apac.anthropic.claude-sonnet-4-20250514-v1:0","Claude Sonnet 4 (APAC)",200000,64000,true,true,{"input":3,"output":15,"cacheRead":0.3,"cacheWrite":3.75}],
  ["au.anthropic.claude-haiku-4-5-20251001-v1:0","Claude Haiku 4.5 (AU)",200000,64000,true,true,{"input":1.1,"output":5.5,"cacheRead":0.11,"cacheWrite":1.375}],
  ["au.anthropic.claude-haiku-5-5","Claude Haiku 5.5 (AU)",1000000,128000,true,true,{"input":0.11,"output":0.55,"cacheRead":0.011,"cacheWrite":0.1375,"tiers":[{"inputTokensAbove":100000,"input":0.55,"output":2.75,"cacheRead":0.055,"cacheWrite":0.6875}]}],
  ["au.anthropic.claude-opus-4-6-v1","AU Anthropic Claude Opus 4.6",1000000,128000,true,true,{"input":5.5,"output":27.5,"cacheRead":0.55,"cacheWrite":6.875}],
  ["au.anthropic.claude-opus-4-7","Claude Opus 4.7 (AU)",1000000,128000,true,true,{"input":5.5,"output":27.5,"cacheRead":0.55,"cacheWrite":6.875}],
  ["au.anthropic.claude-opus-4-8","Claude Opus 4.8 (AU)",1000000,128000,true,true,{"input":5.5,"output":27.5,"cacheRead":0.55,"cacheWrite":6.875}],
  ["au.anthropic.claude-opus-5","Claude Opus 5 (AU)",1000000,128000,true,true,{"input":5.5,"output":27.5,"cacheRead":0.55,"cacheWrite":6.875}],
  ["au.anthropic.claude-opus-5-5","Claude Opus 5.5 (AU)",1000000,128000,true,true,{"input":4.4,"output":22,"cacheRead":0.22,"cacheWrite":5.5}],
  ["au.anthropic.claude-sonnet-4-5-20250929-v1:0","Claude Sonnet 4.5 (AU)",200000,64000,true,true,{"input":3.3,"output":16.5,"cacheRead":0.33,"cacheWrite":4.125}],
  ["au.anthropic.claude-sonnet-4-6","AU Anthropic Claude Sonnet 4.6",1000000,128000,true,true,{"input":3.3,"output":16.5,"cacheRead":0.33,"cacheWrite":4.125}],
  ["au.anthropic.claude-sonnet-5","Claude Sonnet 5 (AU)",1000000,128000,true,true,{"input":2.2,"output":11,"cacheRead":0.22,"cacheWrite":2.75}],
  ["ca.amazon.nova-lite-v1:0","Nova Lite (CA)",300000,10000,false,true,{"input":0.064,"output":0.256,"cacheRead":0.016,"cacheWrite":0.064}],
  ["deepseek.v3-v1:0","DeepSeek-V3.1",163840,81920,true,false,{"input":0.58,"output":1.68,"cacheRead":0,"cacheWrite":0}],
  ["deepseek.v3.2","DeepSeek V3.2",163840,81920,true,false,{"input":0.62,"output":1.85,"cacheRead":0,"cacheWrite":0}],
  ["eu.amazon.nova-2-lite-v1:0","Nova 2 Lite (EU)",1000000,65535,true,true,{"input":0.374,"output":3.157,"cacheRead":0.0935,"cacheWrite":0.374}],
  ["eu.amazon.nova-lite-v1:0","Nova Lite (EU)",300000,10000,false,true,{"input":0.069,"output":0.276,"cacheRead":0.01725,"cacheWrite":0.069}],
  ["eu.amazon.nova-micro-v1:0","Nova Micro (EU)",128000,10000,false,false,{"input":0.04,"output":0.16,"cacheRead":0.01,"cacheWrite":0.04}],
  ["eu.amazon.nova-pro-v1:0","Nova Pro (EU)",300000,10000,false,true,{"input":0.92,"output":3.68,"cacheRead":0.23,"cacheWrite":0.92}],
  ["eu.anthropic.claude-fable-5","Claude Fable 5 (EU)",1000000,128000,true,true,{"input":11,"output":55,"cacheRead":1.1,"cacheWrite":13.75}],
  ["eu.anthropic.claude-haiku-4-5-20251001-v1:0","Claude Haiku 4.5 (EU)",200000,64000,true,true,{"input":1.1,"output":5.5,"cacheRead":0.11,"cacheWrite":1.375}],
  ["eu.anthropic.claude-haiku-5-5","Claude Haiku 5.5 (EU)",1000000,128000,true,true,{"input":0.11,"output":0.55,"cacheRead":0.011,"cacheWrite":0.1375,"tiers":[{"inputTokensAbove":100000,"input":0.55,"output":2.75,"cacheRead":0.055,"cacheWrite":0.6875}]}],
  ["eu.anthropic.claude-opus-4-5-20251101-v1:0","Claude Opus 4.5 (EU)",200000,64000,true,true,{"input":5.5,"output":27.5,"cacheRead":0.55,"cacheWrite":6.875}],
  ["eu.anthropic.claude-opus-4-6-v1","Claude Opus 4.6 (EU)",1000000,128000,true,true,{"input":5.5,"output":27.5,"cacheRead":0.55,"cacheWrite":6.875}],
  ["eu.anthropic.claude-opus-4-7","Claude Opus 4.7 (EU)",1000000,128000,true,true,{"input":5.5,"output":27.5,"cacheRead":0.55,"cacheWrite":6.875}],
  ["eu.anthropic.claude-opus-4-8","Claude Opus 4.8 (EU)",1000000,128000,true,true,{"input":5.5,"output":27.5,"cacheRead":0.55,"cacheWrite":6.875}],
  ["eu.anthropic.claude-opus-5","Claude Opus 5 (EU)",1000000,128000,true,true,{"input":5.5,"output":27.5,"cacheRead":0.55,"cacheWrite":6.875}],
  ["eu.anthropic.claude-opus-5-5","Claude Opus 5.5 (EU)",1000000,128000,true,true,{"input":4.4,"output":22,"cacheRead":0.22,"cacheWrite":5.5}],
  ["eu.anthropic.claude-sonnet-4-20250514-v1:0","Claude Sonnet 4 (EU)",200000,64000,true,true,{"input":3,"output":15,"cacheRead":0.3,"cacheWrite":3.75}],
  ["eu.anthropic.claude-sonnet-4-5-20250929-v1:0","Claude Sonnet 4.5 (EU)",200000,64000,true,true,{"input":3.3,"output":16.5,"cacheRead":0.33,"cacheWrite":4.125}],
  ["eu.anthropic.claude-sonnet-4-6","Claude Sonnet 4.6 (EU)",1000000,128000,true,true,{"input":3.3,"output":16.5,"cacheRead":0.33,"cacheWrite":4.125}],
  ["eu.anthropic.claude-sonnet-5","Claude Sonnet 5 (EU)",1000000,128000,true,true,{"input":2.2,"output":11,"cacheRead":0.22,"cacheWrite":2.75}],
  ["eu.anthropic.claude-sonnet-5-5","Claude Sonnet 5.5 (EU)",1000000,128000,true,true,{"input":2.2,"output":11,"cacheRead":0.11,"cacheWrite":2.75}],
  ["eu.mistral.pixtral-large-2502-v1:0","Pixtral Large (25.02) (EU)",128000,8192,false,true,{"input":2,"output":6,"cacheRead":0,"cacheWrite":0}],
  ["global.amazon.nova-2-lite-v1:0","Nova 2 Lite (Global)",1000000,65535,true,true,{"input":0.3,"output":2.5,"cacheRead":0.075,"cacheWrite":0.3}],
  ["global.anthropic.claude-fable-5","Claude Fable 5 (Global)",1000000,128000,true,true,{"input":10,"output":50,"cacheRead":1,"cacheWrite":12.5}],
  ["global.anthropic.claude-fable-5-1","Claude Fable 5.1 (Global)",1000000,128000,true,true,{"input":10,"output":50,"cacheRead":0.25,"cacheWrite":12.5}],
  ["global.anthropic.claude-haiku-4-5-20251001-v1:0","Claude Haiku 4.5 (Global)",200000,64000,true,true,{"input":1,"output":5,"cacheRead":0.1,"cacheWrite":1.25}],
  ["global.anthropic.claude-haiku-5-5","Claude Haiku 5.5 (Global)",1000000,128000,true,true,{"input":0.1,"output":0.5,"cacheRead":0.01,"cacheWrite":0.125,"tiers":[{"inputTokensAbove":100000,"input":0.5,"output":2.5,"cacheRead":0.05,"cacheWrite":0.625}]}],
  ["global.anthropic.claude-opus-4-5-20251101-v1:0","Claude Opus 4.5 (Global)",200000,64000,true,true,{"input":5,"output":25,"cacheRead":0.5,"cacheWrite":6.25}],
  ["global.anthropic.claude-opus-4-6-v1","Claude Opus 4.6 (Global)",1000000,128000,true,true,{"input":5,"output":25,"cacheRead":0.5,"cacheWrite":6.25}],
  ["global.anthropic.claude-opus-4-7","Claude Opus 4.7 (Global)",1000000,128000,true,true,{"input":5,"output":25,"cacheRead":0.5,"cacheWrite":6.25}],
  ["global.anthropic.claude-opus-4-8","Claude Opus 4.8 (Global)",1000000,128000,true,true,{"input":5,"output":25,"cacheRead":0.5,"cacheWrite":6.25}],
  ["global.anthropic.claude-opus-5","Claude Opus 5 (Global)",1000000,128000,true,true,{"input":5,"output":25,"cacheRead":0.5,"cacheWrite":6.25}],
  ["global.anthropic.claude-opus-5-5","Claude Opus 5.5 (Global)",1000000,128000,true,true,{"input":4,"output":20,"cacheRead":0.2,"cacheWrite":5}],
  ["global.anthropic.claude-sonnet-4-20250514-v1:0","Claude Sonnet 4 (Global)",200000,64000,true,true,{"input":3,"output":15,"cacheRead":0.3,"cacheWrite":3.75}],
  ["global.anthropic.claude-sonnet-4-5-20250929-v1:0","Claude Sonnet 4.5 (Global)",200000,64000,true,true,{"input":3,"output":15,"cacheRead":0.3,"cacheWrite":3.75}],
  ["global.anthropic.claude-sonnet-4-6","Claude Sonnet 4.6 (Global)",1000000,128000,true,true,{"input":3,"output":15,"cacheRead":0.3,"cacheWrite":3.75}],
  ["global.anthropic.claude-sonnet-5","Claude Sonnet 5 (Global)",1000000,128000,true,true,{"input":2,"output":10,"cacheRead":0.2,"cacheWrite":2.5}],
  ["global.anthropic.claude-sonnet-5-5","Claude Sonnet 5.5 (Global)",1000000,128000,true,true,{"input":2,"output":10,"cacheRead":0.1,"cacheWrite":2.5}],
  ["global.moonshotai.kimi-k3","Kimi K3 (Global)",1048576,128000,true,true,{"input":3,"output":15,"cacheRead":0.3,"cacheWrite":3.75}],
  ["global.openai.gpt-5.6-luna","GPT-5.6 Luna (Global)",1050000,128000,true,true,{"input":0.2,"output":1.2,"cacheRead":0.02,"cacheWrite":0.25,"tiers":[{"inputTokensAbove":272000,"input":0.4,"output":1.8,"cacheRead":0.04,"cacheWrite":0.5}]}],
  ["global.openai.gpt-5.6-sol","GPT-5.6 Sol (Global)",1050000,128000,true,true,{"input":4,"output":20,"cacheRead":0.4,"cacheWrite":5,"tiers":[{"inputTokensAbove":272000,"input":8,"output":30,"cacheRead":0.8,"cacheWrite":10}]}],
  ["global.openai.gpt-5.6-terra","GPT-5.6 Terra (Global)",1050000,128000,true,true,{"input":2,"output":12,"cacheRead":0.2,"cacheWrite":2.5,"tiers":[{"inputTokensAbove":272000,"input":4,"output":18,"cacheRead":0.4,"cacheWrite":5}]}],
  ["global.openai.gpt-6-astra","GPT-6 Astra (Global)",1050000,128000,true,true,{"input":10,"output":50,"cacheRead":1,"cacheWrite":12.5,"tiers":[{"inputTokensAbove":272000,"input":20,"output":75,"cacheRead":2,"cacheWrite":25}]}],
  ["global.openai.gpt-6-luna","GPT-6 Luna (Global)",1050000,128000,true,true,{"input":0.1,"output":0.5,"cacheRead":0.01,"cacheWrite":0.125,"tiers":[{"inputTokensAbove":272000,"input":0.2,"output":0.75,"cacheRead":0.02,"cacheWrite":0.25}]}],
  ["global.openai.gpt-6-sol","GPT-6 Sol (Global)",1050000,128000,true,true,{"input":2,"output":10,"cacheRead":0.2,"cacheWrite":2.5,"tiers":[{"inputTokensAbove":272000,"input":4,"output":15,"cacheRead":0.4,"cacheWrite":5}]}],
  ["global.openai.gpt-6.1-sol","GPT-6.1 Sol (Global)",1050000,128000,true,true,{"input":2,"output":10,"cacheRead":0.1,"cacheWrite":2.5,"tiers":[{"inputTokensAbove":272000,"input":4,"output":15,"cacheRead":0.2,"cacheWrite":5}]}],
  ["global.xai.grok-4.6","Grok 4.6 (Global)",500000,500000,true,true,{"input":2,"output":6,"cacheRead":0.5,"cacheWrite":0}],
  ["global.xai.grok-4.7","Grok 4.7 (Global)",500000,500000,true,true,{"input":2,"output":6,"cacheRead":0.5,"cacheWrite":0}],
  ["global.zai.glm-5.3","GLM-5.3 (Global)",1000000,128000,true,false,{"input":1.68,"output":5.28,"cacheRead":0.312,"cacheWrite":2.1}],
  ["google.gemma-4-26b-a4b","Gemma 4 26B A4B IT",262144,32768,true,true,{"input":0.13,"output":0.4,"cacheRead":0,"cacheWrite":0}],
  ["google.gemma-4-31b","Gemma 4 31B IT",262144,32768,true,true,{"input":0.14,"output":0.4,"cacheRead":0,"cacheWrite":0}],
  ["google.gemma-4-e2b","Gemma 4 E2B IT",131072,8192,true,true,{"input":0.04,"output":0.08,"cacheRead":0,"cacheWrite":0}],
  ["in.anthropic.claude-haiku-4-5-20251001-v1:0","Claude Haiku 4.5 (India)",200000,64000,true,true,{"input":1.1,"output":5.5,"cacheRead":0.11,"cacheWrite":1.375}],
  ["in.anthropic.claude-opus-5","Claude Opus 5 (India)",1000000,128000,true,true,{"input":5.5,"output":27.5,"cacheRead":0.55,"cacheWrite":6.875}],
  ["in.anthropic.claude-sonnet-5","Claude Sonnet 5 (India)",1000000,128000,true,true,{"input":2.2,"output":11,"cacheRead":0.22,"cacheWrite":2.75}],
  ["in.openai.gpt-5.6-luna","GPT-5.6 Luna (India)",1050000,128000,true,true,{"input":0.22,"output":1.32,"cacheRead":0.022,"cacheWrite":0.275,"tiers":[{"inputTokensAbove":272000,"input":0.44,"output":1.98,"cacheRead":0.044,"cacheWrite":0.55}]}],
  ["in.openai.gpt-5.6-terra","GPT-5.6 Terra (India)",1050000,128000,true,true,{"input":2.2,"output":13.2,"cacheRead":0.22,"cacheWrite":2.75,"tiers":[{"inputTokensAbove":272000,"input":4.4,"output":19.8,"cacheRead":0.44,"cacheWrite":5.5}]}],
  ["jp.amazon.nova-2-lite-v1:0","Nova 2 Lite (JP)",1000000,65535,true,true,{"input":0.396,"output":3.311,"cacheRead":0.099,"cacheWrite":0.396}],
  ["jp.anthropic.claude-haiku-4-5-20251001-v1:0","Claude Haiku 4.5 (JP)",200000,64000,true,true,{"input":1.1,"output":5.5,"cacheRead":0.11,"cacheWrite":1.375}],
  ["jp.anthropic.claude-haiku-5-5","Claude Haiku 5.5 (JP)",1000000,128000,true,true,{"input":0.11,"output":0.55,"cacheRead":0.011,"cacheWrite":0.1375,"tiers":[{"inputTokensAbove":100000,"input":0.55,"output":2.75,"cacheRead":0.055,"cacheWrite":0.6875}]}],
  ["jp.anthropic.claude-opus-4-7","Claude Opus 4.7 (JP)",1000000,128000,true,true,{"input":5.5,"output":27.5,"cacheRead":0.55,"cacheWrite":6.875}],
  ["jp.anthropic.claude-opus-4-8","Claude Opus 4.8 (JP)",1000000,128000,true,true,{"input":5.5,"output":27.5,"cacheRead":0.55,"cacheWrite":6.875}],
  ["jp.anthropic.claude-opus-5","Claude Opus 5 (JP)",1000000,128000,true,true,{"input":5.5,"output":27.5,"cacheRead":0.55,"cacheWrite":6.875}],
  ["jp.anthropic.claude-opus-5-5","Claude Opus 5.5 (JP)",1000000,128000,true,true,{"input":4.4,"output":22,"cacheRead":0.22,"cacheWrite":5.5}],
  ["jp.anthropic.claude-sonnet-4-5-20250929-v1:0","Claude Sonnet 4.5 (JP)",200000,64000,true,true,{"input":3.3,"output":16.5,"cacheRead":0.33,"cacheWrite":4.125}],
  ["jp.anthropic.claude-sonnet-4-6","Claude Sonnet 4.6 (JP)",1000000,128000,true,true,{"input":3.3,"output":16.5,"cacheRead":0.33,"cacheWrite":4.125}],
  ["jp.anthropic.claude-sonnet-5","Claude Sonnet 5 (JP)",1000000,128000,true,true,{"input":2.2,"output":11,"cacheRead":0.22,"cacheWrite":2.75}],
  ["meta.llama3-1-70b-instruct-v1:0","Llama 3.1 70B Instruct",128000,4096,false,false,{"input":0.72,"output":0.72,"cacheRead":0,"cacheWrite":0}],
  ["meta.llama3-1-8b-instruct-v1:0","Llama 3.1 8B Instruct",128000,4096,false,false,{"input":0.22,"output":0.22,"cacheRead":0,"cacheWrite":0}],
  ["meta.llama3-3-70b-instruct-v1:0","Llama 3.3 70B Instruct",128000,4096,false,false,{"input":0.72,"output":0.72,"cacheRead":0,"cacheWrite":0}],
  ["meta.llama4-maverick-17b-instruct-v1:0","Llama 4 Maverick 17B Instruct",1000000,8192,false,true,{"input":0.24,"output":0.97,"cacheRead":0,"cacheWrite":0}],
  ["meta.llama4-scout-17b-instruct-v1:0","Llama 4 Scout 17B Instruct",10000000,8192,false,true,{"input":0.17,"output":0.66,"cacheRead":0,"cacheWrite":0}],
  ["minimax.minimax-m2","MiniMax-M2",204608,128000,true,false,{"input":0.3,"output":1.2,"cacheRead":0,"cacheWrite":0}],
  ["minimax.minimax-m2.1","MiniMax-M2.1",196608,131072,true,false,{"input":0.3,"output":1.2,"cacheRead":0,"cacheWrite":0}],
  ["minimax.minimax-m2.5","MiniMax-M2.5",196608,98304,true,false,{"input":0.3,"output":1.2,"cacheRead":0,"cacheWrite":0}],
  ["mistral.devstral-2-123b","Devstral 2 123B",262144,8192,false,false,{"input":0.4,"output":2,"cacheRead":0,"cacheWrite":0}],
  ["mistral.magistral-small-2509","Magistral Small 1.2",128000,40000,true,true,{"input":0.5,"output":1.5,"cacheRead":0,"cacheWrite":0}],
  ["mistral.ministral-3-14b-instruct","Ministral 14B 3.0",128000,4096,false,true,{"input":0.2,"output":0.2,"cacheRead":0,"cacheWrite":0}],
  ["mistral.ministral-3-3b-instruct","Ministral 3 3B",256000,8192,false,true,{"input":0.1,"output":0.1,"cacheRead":0,"cacheWrite":0}],
  ["mistral.ministral-3-8b-instruct","Ministral 3 8B",128000,4096,false,true,{"input":0.15,"output":0.15,"cacheRead":0,"cacheWrite":0}],
  ["mistral.mistral-large-3-675b-instruct","Mistral Large 3",262144,8192,false,true,{"input":0.5,"output":1.5,"cacheRead":0,"cacheWrite":0}],
  ["mistral.pixtral-large-2502-v1:0","Pixtral Large (25.02)",128000,8192,false,true,{"input":2,"output":6,"cacheRead":0,"cacheWrite":0}],
  ["mistral.voxtral-mini-3b-2507","Voxtral Mini 3B 2507",32768,4096,false,false,{"input":0.04,"output":0.04,"cacheRead":0,"cacheWrite":0}],
  ["mistral.voxtral-small-24b-2507","Voxtral Small 24B 2507",32768,8192,false,false,{"input":0.1,"output":0.3,"cacheRead":0,"cacheWrite":0}],
  ["moonshot.kimi-k2-thinking","Kimi K2 Thinking",262144,16000,true,false,{"input":0.6,"output":2.5,"cacheRead":0,"cacheWrite":0}],
  ["moonshotai.kimi-k2.5","Kimi K2.5",262144,16384,true,true,{"input":0.6,"output":3,"cacheRead":0,"cacheWrite":0}],
  ["nvidia.nemotron-nano-12b-v2","NVIDIA Nemotron Nano 12B v2 VL BF16",131072,8192,false,true,{"input":0.2,"output":0.6,"cacheRead":0,"cacheWrite":0}],
  ["nvidia.nemotron-nano-3-30b","NVIDIA Nemotron Nano 3 30B",262144,8192,true,false,{"input":0.06,"output":0.24,"cacheRead":0,"cacheWrite":0}],
  ["nvidia.nemotron-nano-9b-v2","NVIDIA Nemotron Nano 9B v2",131072,8192,false,false,{"input":0.06,"output":0.23,"cacheRead":0,"cacheWrite":0}],
  ["nvidia.nemotron-super-3-120b","NVIDIA Nemotron 3 Super 120B A12B",262144,131072,true,false,{"input":0.15,"output":0.65,"cacheRead":0,"cacheWrite":0}],
  ["openai.gpt-5.4","GPT-5.4",1000000,128000,true,true,{"input":2.75,"output":16.5,"cacheRead":0.275,"cacheWrite":0}],
  ["openai.gpt-5.5","GPT-5.5",1000000,128000,true,true,{"input":5.5,"output":33,"cacheRead":0.55,"cacheWrite":0}],
  ["openai.gpt-5.6-luna","GPT-5.6 Luna",1050000,128000,true,true,{"input":0.22,"output":1.32,"cacheRead":0.022,"cacheWrite":0.275,"tiers":[{"inputTokensAbove":272000,"input":0.44,"output":1.98,"cacheRead":0.044,"cacheWrite":0.55}]}],
  ["openai.gpt-5.6-sol","GPT-5.6 Sol",1050000,128000,true,true,{"input":4.4,"output":22,"cacheRead":0.44,"cacheWrite":5.5,"tiers":[{"inputTokensAbove":272000,"input":8.8,"output":33,"cacheRead":0.88,"cacheWrite":11}]}],
  ["openai.gpt-5.6-terra","GPT-5.6 Terra",1050000,128000,true,true,{"input":2.2,"output":13.2,"cacheRead":0.22,"cacheWrite":2.75,"tiers":[{"inputTokensAbove":272000,"input":4.4,"output":19.8,"cacheRead":0.44,"cacheWrite":5.5}]}],
  ["openai.gpt-6-astra","GPT-6 Astra",1050000,128000,true,true,{"input":11,"output":55,"cacheRead":1.1,"cacheWrite":13.75,"tiers":[{"inputTokensAbove":272000,"input":22,"output":82.5,"cacheRead":2.2,"cacheWrite":27.5}]}],
  ["openai.gpt-6-luna","GPT-6 Luna",1050000,128000,true,true,{"input":0.11,"output":0.55,"cacheRead":0.011,"cacheWrite":0.1375,"tiers":[{"inputTokensAbove":272000,"input":0.22,"output":0.825,"cacheRead":0.022,"cacheWrite":0.275}]}],
  ["openai.gpt-6-sol","GPT-6 Sol",1050000,128000,true,true,{"input":2.2,"output":11,"cacheRead":0.22,"cacheWrite":2.75,"tiers":[{"inputTokensAbove":272000,"input":4.4,"output":16.5,"cacheRead":0.44,"cacheWrite":5.5}]}],
  ["openai.gpt-6.1-sol","GPT-6.1 Sol",1050000,128000,true,true,{"input":2.2,"output":11,"cacheRead":0.11,"cacheWrite":2.75,"tiers":[{"inputTokensAbove":272000,"input":4.4,"output":16.5,"cacheRead":0.22,"cacheWrite":5.5}]}],
  ["openai.gpt-oss-120b","gpt-oss-120b",131072,131072,true,false,{"input":0.15,"output":0.6,"cacheRead":0,"cacheWrite":0}],
  ["openai.gpt-oss-120b-1:0","gpt-oss-120b",131072,128000,true,false,{"input":0.15,"output":0.6,"cacheRead":0,"cacheWrite":0}],
  ["openai.gpt-oss-20b","gpt-oss-20b",131072,131072,true,false,{"input":0.07,"output":0.3,"cacheRead":0,"cacheWrite":0}],
  ["openai.gpt-oss-20b-1:0","gpt-oss-20b",131072,128000,true,false,{"input":0.07,"output":0.3,"cacheRead":0,"cacheWrite":0}],
  ["openai.gpt-oss-safeguard-120b","GPT OSS Safeguard 120B",128000,16384,true,false,{"input":0.15,"output":0.6,"cacheRead":0,"cacheWrite":0}],
  ["openai.gpt-oss-safeguard-20b","GPT OSS Safeguard 20B",128000,16384,true,false,{"input":0.07,"output":0.2,"cacheRead":0,"cacheWrite":0}],
  ["qwen.qwen3-235b-a22b-2507-v1:0","Qwen3 235B-A22B Instruct 2507",262144,131072,false,false,{"input":0.22,"output":0.88,"cacheRead":0,"cacheWrite":0}],
  ["qwen.qwen3-32b-v1:0","Qwen3 32B",32768,16384,true,false,{"input":0.15,"output":0.6,"cacheRead":0,"cacheWrite":0}],
  ["qwen.qwen3-coder-30b-a3b-v1:0","Qwen3-Coder 30B-A3B Instruct",262144,131072,false,false,{"input":0.15,"output":0.6,"cacheRead":0,"cacheWrite":0}],
  ["qwen.qwen3-coder-480b-a35b-v1:0","Qwen3-Coder 480B-A35B Instruct",131072,65536,false,false,{"input":0.45,"output":1.8,"cacheRead":0,"cacheWrite":0}],
  ["qwen.qwen3-coder-next","Qwen3 Coder Next",262144,65536,false,false,{"input":0.5,"output":1.2,"cacheRead":0,"cacheWrite":0}],
  ["qwen.qwen3-next-80b-a3b","Qwen3-Next 80B-A3B Instruct",262144,262000,false,false,{"input":0.15,"output":1.2,"cacheRead":0,"cacheWrite":0}],
  ["qwen.qwen3-vl-235b-a22b","Qwen3 VL 235B A22B Instruct",262144,262000,false,true,{"input":0.53,"output":2.66,"cacheRead":0,"cacheWrite":0}],
  ["us-gov.openai.gpt-oss-120b-1:0","gpt-oss-120b (GovCloud)",128000,16384,true,false,{"input":0.18,"output":0.72,"cacheRead":0,"cacheWrite":0}],
  ["us-gov.openai.gpt-oss-20b-1:0","gpt-oss-20b (GovCloud)",128000,16384,true,false,{"input":0.084,"output":0.36,"cacheRead":0,"cacheWrite":0}],
  ["us.amazon.nova-2-lite-v1:0","Nova 2 Lite (US)",1000000,65535,true,true,{"input":0.33,"output":2.75,"cacheRead":0.0825,"cacheWrite":0.33}],
  ["us.amazon.nova-lite-v1:0","Nova Lite (US)",300000,10000,false,true,{"input":0.06,"output":0.24,"cacheRead":0.015,"cacheWrite":0.06}],
  ["us.amazon.nova-micro-v1:0","Nova Micro (US)",128000,10000,false,false,{"input":0.035,"output":0.14,"cacheRead":0.00875,"cacheWrite":0.035}],
  ["us.amazon.nova-premier-v1:0","Nova Premier (US)",1000000,10000,false,true,{"input":2.5,"output":12.5,"cacheRead":0.625,"cacheWrite":2.5}],
  ["us.amazon.nova-pro-v1:0","Nova Pro (US)",300000,10000,false,true,{"input":0.8,"output":3.2,"cacheRead":0.2,"cacheWrite":0.8}],
  ["us.anthropic.claude-fable-5","Claude Fable 5 (US)",1000000,128000,true,true,{"input":11,"output":55,"cacheRead":1.1,"cacheWrite":13.75}],
  ["us.anthropic.claude-fable-5-1","Claude Fable 5.1 (US)",1000000,128000,true,true,{"input":11,"output":55,"cacheRead":0.275,"cacheWrite":13.75}],
  ["us.anthropic.claude-haiku-4-5-20251001-v1:0","Claude Haiku 4.5 (US)",200000,64000,true,true,{"input":1.1,"output":5.5,"cacheRead":0.11,"cacheWrite":1.375}],
  ["us.anthropic.claude-haiku-5-5","Claude Haiku 5.5 (US)",1000000,128000,true,true,{"input":0.11,"output":0.55,"cacheRead":0.011,"cacheWrite":0.1375,"tiers":[{"inputTokensAbove":100000,"input":0.55,"output":2.75,"cacheRead":0.055,"cacheWrite":0.6875}]}],
  ["us.anthropic.claude-opus-4-1-20250805-v1:0","Claude Opus 4.1 (US)",200000,32000,true,true,{"input":15,"output":75,"cacheRead":1.5,"cacheWrite":18.75}],
  ["us.anthropic.claude-opus-4-5-20251101-v1:0","Claude Opus 4.5 (US)",200000,64000,true,true,{"input":5.5,"output":27.5,"cacheRead":0.55,"cacheWrite":6.875}],
  ["us.anthropic.claude-opus-4-6-v1","Claude Opus 4.6 (US)",1000000,128000,true,true,{"input":5.5,"output":27.5,"cacheRead":0.55,"cacheWrite":6.875}],
  ["us.anthropic.claude-opus-4-7","Claude Opus 4.7 (US)",1000000,128000,true,true,{"input":5.5,"output":27.5,"cacheRead":0.55,"cacheWrite":6.875}],
  ["us.anthropic.claude-opus-4-8","Claude Opus 4.8 (US)",1000000,128000,true,true,{"input":5.5,"output":27.5,"cacheRead":0.55,"cacheWrite":6.875}],
  ["us.anthropic.claude-opus-5","Claude Opus 5 (US)",1000000,128000,true,true,{"input":5.5,"output":27.5,"cacheRead":0.55,"cacheWrite":6.875}],
  ["us.anthropic.claude-opus-5-5","Claude Opus 5.5 (US)",1000000,128000,true,true,{"input":4.4,"output":22,"cacheRead":0.22,"cacheWrite":5.5}],
  ["us.anthropic.claude-sonnet-4-20250514-v1:0","Claude Sonnet 4 (US)",200000,64000,true,true,{"input":3,"output":15,"cacheRead":0.3,"cacheWrite":3.75}],
  ["us.anthropic.claude-sonnet-4-5-20250929-v1:0","Claude Sonnet 4.5 (US)",200000,64000,true,true,{"input":3.3,"output":16.5,"cacheRead":0.33,"cacheWrite":4.125}],
  ["us.anthropic.claude-sonnet-4-6","Claude Sonnet 4.6 (US)",1000000,128000,true,true,{"input":3.3,"output":16.5,"cacheRead":0.33,"cacheWrite":4.125}],
  ["us.anthropic.claude-sonnet-5","Claude Sonnet 5 (US)",1000000,128000,true,true,{"input":2.2,"output":11,"cacheRead":0.22,"cacheWrite":2.75}],
  ["us.anthropic.claude-sonnet-5-5","Claude Sonnet 5.5 (US)",1000000,128000,true,true,{"input":2.2,"output":11,"cacheRead":0.11,"cacheWrite":2.75}],
  ["us.meta.llama3-1-70b-instruct-v1:0","Llama 3.1 70B Instruct (US)",128000,4096,false,false,{"input":0.72,"output":0.72,"cacheRead":0,"cacheWrite":0}],
  ["us.meta.llama3-1-8b-instruct-v1:0","Llama 3.1 8B Instruct (US)",128000,4096,false,false,{"input":0.22,"output":0.22,"cacheRead":0,"cacheWrite":0}],
  ["us.meta.llama3-3-70b-instruct-v1:0","Llama 3.3 70B Instruct (US)",128000,4096,false,false,{"input":0.72,"output":0.72,"cacheRead":0,"cacheWrite":0}],
  ["us.meta.llama4-maverick-17b-instruct-v1:0","Llama 4 Maverick 17B Instruct (US)",1000000,8192,false,true,{"input":0.24,"output":0.97,"cacheRead":0,"cacheWrite":0}],
  ["us.meta.llama4-scout-17b-instruct-v1:0","Llama 4 Scout 17B Instruct (US)",10000000,8192,false,true,{"input":0.17,"output":0.66,"cacheRead":0,"cacheWrite":0}],
  ["us.mistral.pixtral-large-2502-v1:0","Pixtral Large (25.02) (US)",128000,8192,false,true,{"input":2,"output":6,"cacheRead":0,"cacheWrite":0}],
  ["us.moonshotai.kimi-k3","Kimi K3 (US)",1048576,128000,true,true,{"input":3.3,"output":16.5,"cacheRead":0.33,"cacheWrite":4.125}],
  ["us.openai.gpt-5.6-luna","GPT-5.6 Luna (US)",1050000,128000,true,true,{"input":0.22,"output":1.32,"cacheRead":0.022,"cacheWrite":0.275,"tiers":[{"inputTokensAbove":272000,"input":0.44,"output":1.98,"cacheRead":0.044,"cacheWrite":0.55}]}],
  ["us.openai.gpt-5.6-sol","GPT-5.6 Sol (US)",1050000,128000,true,true,{"input":4.4,"output":22,"cacheRead":0.44,"cacheWrite":5.5,"tiers":[{"inputTokensAbove":272000,"input":8.8,"output":33,"cacheRead":0.88,"cacheWrite":11}]}],
  ["us.openai.gpt-5.6-terra","GPT-5.6 Terra (US)",1050000,128000,true,true,{"input":2.2,"output":13.2,"cacheRead":0.22,"cacheWrite":2.75,"tiers":[{"inputTokensAbove":272000,"input":4.4,"output":19.8,"cacheRead":0.44,"cacheWrite":5.5}]}],
  ["us.openai.gpt-6-astra","GPT-6 Astra (US)",1050000,128000,true,true,{"input":11,"output":55,"cacheRead":1.1,"cacheWrite":13.75,"tiers":[{"inputTokensAbove":272000,"input":22,"output":82.5,"cacheRead":2.2,"cacheWrite":27.5}]}],
  ["us.openai.gpt-6-luna","GPT-6 Luna (US)",1050000,128000,true,true,{"input":0.11,"output":0.55,"cacheRead":0.011,"cacheWrite":0.1375,"tiers":[{"inputTokensAbove":272000,"input":0.22,"output":0.825,"cacheRead":0.022,"cacheWrite":0.275}]}],
  ["us.openai.gpt-6-sol","GPT-6 Sol (US)",1050000,128000,true,true,{"input":2.2,"output":11,"cacheRead":0.22,"cacheWrite":2.75,"tiers":[{"inputTokensAbove":272000,"input":4.4,"output":16.5,"cacheRead":0.44,"cacheWrite":5.5}]}],
  ["us.openai.gpt-6.1-sol","GPT-6.1 Sol (US)",1050000,128000,true,true,{"input":2.2,"output":11,"cacheRead":0.11,"cacheWrite":2.75,"tiers":[{"inputTokensAbove":272000,"input":4.4,"output":16.5,"cacheRead":0.22,"cacheWrite":5.5}]}],
  ["us.writer.palmyra-x4-v1:0","Palmyra X4 (US)",122880,8192,true,false,{"input":2.5,"output":10,"cacheRead":0,"cacheWrite":0}],
  ["us.writer.palmyra-x5-v1:0","Palmyra X5 (US)",1040000,8192,true,false,{"input":0.6,"output":6,"cacheRead":0,"cacheWrite":0}],
  ["us.xai.grok-4.6","Grok 4.6 (US)",500000,500000,true,true,{"input":2.2,"output":6.6,"cacheRead":0.55,"cacheWrite":0}],
  ["us.xai.grok-4.7","Grok 4.7 (US)",500000,500000,true,true,{"input":2.2,"output":6.6,"cacheRead":0.55,"cacheWrite":0}],
  ["us.zai.glm-5.3","GLM-5.3 (US)",1000000,128000,true,false,{"input":1.848,"output":5.808,"cacheRead":0.3432,"cacheWrite":2.31}],
  ["writer.palmyra-x4-v1:0","Palmyra X4",122880,8192,true,false,{"input":2.5,"output":10,"cacheRead":0,"cacheWrite":0}],
  ["writer.palmyra-x5-v1:0","Palmyra X5",1040000,8192,true,false,{"input":0.6,"output":6,"cacheRead":0,"cacheWrite":0}],
  ["xai.grok-4.3","Grok 4.3",1000000,131072,true,true,{"input":1.25,"output":2.5,"cacheRead":0.2,"cacheWrite":0}],
  ["xai.grok-4.6","Grok 4.6",500000,500000,true,true,{"input":2.2,"output":6.6,"cacheRead":0.55,"cacheWrite":0}],
  ["zai.glm-4.7","GLM-4.7",202752,131072,true,false,{"input":0.6,"output":2.2,"cacheRead":0,"cacheWrite":0}],
  ["zai.glm-4.7-flash","GLM-4.7-Flash",202752,131072,true,false,{"input":0.07,"output":0.4,"cacheRead":0,"cacheWrite":0}],
  ["zai.glm-5","GLM-5",202752,131072,true,false,{"input":1,"output":3.2,"cacheRead":0,"cacheWrite":0}],
];
const numericModels = new Set([
  'anthropic.claude-haiku-4-5-20251001-v1:0',
  'anthropic.claude-opus-4-1-20250805-v1:0',
  'anthropic.claude-opus-4-5-20251101-v1:0',
  'anthropic.claude-sonnet-4-5-20250929-v1:0',
  'apac.anthropic.claude-sonnet-4-20250514-v1:0',
  'au.anthropic.claude-haiku-4-5-20251001-v1:0',
  'au.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
  'eu.anthropic.claude-opus-4-5-20251101-v1:0',
  'eu.anthropic.claude-sonnet-4-20250514-v1:0',
  'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'global.anthropic.claude-haiku-4-5-20251001-v1:0',
  'global.anthropic.claude-opus-4-5-20251101-v1:0',
  'global.anthropic.claude-sonnet-4-20250514-v1:0',
  'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'in.anthropic.claude-haiku-4-5-20251001-v1:0',
  'jp.anthropic.claude-haiku-4-5-20251001-v1:0',
  'jp.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  'us.anthropic.claude-opus-4-1-20250805-v1:0',
  'us.anthropic.claude-opus-4-5-20251101-v1:0',
  'us.anthropic.claude-sonnet-4-20250514-v1:0',
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
]);
const numericLevels = { off: 'off', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' };
const numericBudgets = { minimal: 1024, low: 2048, medium: 8192, high: 16384 };
const profiles = new Map(rows.map(([id, name, contextWindow, maxOutputTokens, reasoning, imageInput, cost]) => {
  const pricing = { inputPerMillion: cost.input, outputPerMillion: cost.output, cacheReadPerMillion: cost.cacheRead, cacheWritePerMillion: cost.cacheWrite };
  const metadata: PublishedModelMetadata = { id, name, api: 'bedrock-converse-stream', contextWindow, maxOutputTokens,
    capabilities: { reasoning, imageInput, toolCalls: true }, thinkingLevelMap: numericModels.has(id) ? {} : null,
    ...(Object.values(pricing).some(rate => rate > 0) ? { pricing } : {}) };
  return [id, { metadata, cost, contextWindow, maxOutputTokens, rawDefaultMaxTokens: id.includes('anthropic.claude') ? maxOutputTokens : undefined }] as const;
}));
export function hasBedrockProfile(model: string): boolean { return profiles.has(model); }
// Host levels follow the pinned catalogue, independently of accepted direct requests.
const nonnumericThinkingLevels = new Map<string, NonNullable<PublishedModelMetadata['thinkingLevelMap']>>([
  ...["anthropic.claude-fable-5","anthropic.claude-fable-5-1","eu.anthropic.claude-fable-5","global.anthropic.claude-fable-5","global.anthropic.claude-fable-5-1","us.anthropic.claude-fable-5","us.anthropic.claude-fable-5-1"].map(id => [id, {"off":null,"xhigh":"xhigh","max":"max"}] as const),
  ...["anthropic.claude-haiku-5-5","anthropic.claude-opus-4-7","anthropic.claude-opus-4-8","anthropic.claude-opus-5-5","anthropic.claude-sonnet-5","anthropic.claude-sonnet-5-5","au.anthropic.claude-haiku-5-5","au.anthropic.claude-opus-4-7","au.anthropic.claude-opus-4-8","au.anthropic.claude-opus-5","au.anthropic.claude-opus-5-5","au.anthropic.claude-sonnet-5","eu.anthropic.claude-haiku-5-5","eu.anthropic.claude-opus-4-7","eu.anthropic.claude-opus-4-8","eu.anthropic.claude-opus-5","eu.anthropic.claude-opus-5-5","eu.anthropic.claude-sonnet-5","eu.anthropic.claude-sonnet-5-5","global.anthropic.claude-haiku-5-5","global.anthropic.claude-opus-4-7","global.anthropic.claude-opus-4-8","global.anthropic.claude-opus-5","global.anthropic.claude-opus-5-5","global.anthropic.claude-sonnet-5","global.anthropic.claude-sonnet-5-5","in.anthropic.claude-opus-5","in.anthropic.claude-sonnet-5","jp.anthropic.claude-haiku-5-5","jp.anthropic.claude-opus-4-7","jp.anthropic.claude-opus-4-8","jp.anthropic.claude-opus-5","jp.anthropic.claude-opus-5-5","jp.anthropic.claude-sonnet-5","us.anthropic.claude-haiku-5-5","us.anthropic.claude-opus-4-7","us.anthropic.claude-opus-4-8","us.anthropic.claude-opus-5","us.anthropic.claude-opus-5-5","us.anthropic.claude-sonnet-5","us.anthropic.claude-sonnet-5-5"].map(id => [id, {"xhigh":"xhigh","max":"max"}] as const),
  ...["anthropic.claude-opus-4-6-v1","anthropic.claude-sonnet-4-6","au.anthropic.claude-opus-4-6-v1","au.anthropic.claude-sonnet-4-6","eu.anthropic.claude-opus-4-6-v1","eu.anthropic.claude-sonnet-4-6","global.anthropic.claude-opus-4-6-v1","global.anthropic.claude-sonnet-4-6","jp.anthropic.claude-sonnet-4-6","us.anthropic.claude-opus-4-6-v1","us.anthropic.claude-sonnet-4-6"].map(id => [id, {"max":"max"}] as const),
  ...["global.openai.gpt-5.6-luna","global.openai.gpt-5.6-sol","global.openai.gpt-5.6-terra","global.openai.gpt-6-astra","global.openai.gpt-6-luna","global.openai.gpt-6-sol","global.openai.gpt-6.1-sol","in.openai.gpt-5.6-luna","in.openai.gpt-5.6-terra","openai.gpt-5.4","openai.gpt-5.5","openai.gpt-5.6-luna","openai.gpt-5.6-sol","openai.gpt-5.6-terra","openai.gpt-6-astra","openai.gpt-6-luna","openai.gpt-6-sol","openai.gpt-6.1-sol","us.openai.gpt-5.6-luna","us.openai.gpt-5.6-sol","us.openai.gpt-5.6-terra","us.openai.gpt-6-astra","us.openai.gpt-6-luna","us.openai.gpt-6-sol","us.openai.gpt-6.1-sol"].map(id => [id, {"xhigh":"xhigh"}] as const),
  ...["openai.gpt-oss-120b","openai.gpt-oss-120b-1:0","openai.gpt-oss-20b","openai.gpt-oss-20b-1:0","openai.gpt-oss-safeguard-120b","openai.gpt-oss-safeguard-20b","us-gov.openai.gpt-oss-120b-1:0","us-gov.openai.gpt-oss-20b-1:0","amazon.nova-2-lite-v1:0","deepseek.v3-v1:0","deepseek.v3.2","eu.amazon.nova-2-lite-v1:0","global.amazon.nova-2-lite-v1:0","global.moonshotai.kimi-k3","global.xai.grok-4.6","global.xai.grok-4.7","global.zai.glm-5.3","google.gemma-4-26b-a4b","google.gemma-4-31b","google.gemma-4-e2b","jp.amazon.nova-2-lite-v1:0","minimax.minimax-m2","minimax.minimax-m2.1","minimax.minimax-m2.5","mistral.magistral-small-2509","moonshot.kimi-k2-thinking","moonshotai.kimi-k2.5","nvidia.nemotron-nano-3-30b","nvidia.nemotron-super-3-120b","qwen.qwen3-32b-v1:0","us.amazon.nova-2-lite-v1:0","us.moonshotai.kimi-k3","us.writer.palmyra-x4-v1:0","us.writer.palmyra-x5-v1:0","us.xai.grok-4.6","us.xai.grok-4.7","us.zai.glm-5.3","writer.palmyra-x4-v1:0","writer.palmyra-x5-v1:0","xai.grok-4.3","xai.grok-4.6","zai.glm-4.7","zai.glm-4.7-flash","zai.glm-5"].map(id => [id, {}] as const),
]);
export function bedrockPublishedProfiles(): PublishedModelMetadata[] {
  return [...profiles.values()].map(({ metadata }) => {
    const thinkingLevelMap = nonnumericThinkingLevels.get(metadata.id) ?? metadata.thinkingLevelMap;
    return { ...metadata, capabilities: { ...metadata.capabilities },
      ...(thinkingLevelMap ? { thinkingLevelMap: { ...thinkingLevelMap } } : {}),
      ...(metadata.pricing ? { pricing: { ...metadata.pricing } } : {}) };
  });
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const counter = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Exact admitted pinned profiles only; labels, ARNs and ambient force-cache flags grant no policy. */
export function applyBedrockProfilePromptCache(model: string, body: Record<string, unknown>, retention: ChatOptions['cacheRetention'] = 'short'): void {
  if (retention === 'none' || !profiles.has(model)
    || !/anthropic\.claude-(?:fable-5|haiku-(?:4-|5)|opus-(?:4-|5)|sonnet-(?:4-|5))/u.test(model)) return;
  const point = () => ({ cachePoint: { type: 'default', ...(retention === 'long' ? { ttl: '1h' } : {}) } });
  if (Array.isArray(body.system) && body.system.length) body.system.push(point());
  const last = Array.isArray(body.messages) ? body.messages.at(-1) : undefined;
  if (record(last) && last.role === 'user' && Array.isArray(last.content)) last.content.push(point());
}

/** Raw native omitted-output defaults and explicit/effective ceilings; simple/context/host preparation remain separate. */
export function applyBedrockProfileOutputPolicy(model: string, body: Record<string, unknown>, requested: unknown): void {
  const profile = profiles.get(model);
  if (!profile) return;
  const valid = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= profile.maxOutputTokens;
  if ((requested !== undefined && !valid(requested)) || !record(body.inferenceConfig)
    || (body.inferenceConfig.maxTokens !== undefined && !valid(body.inferenceConfig.maxTokens))) throw new Error('Invalid Bedrock output limit.');
  if (requested === undefined && body.inferenceConfig.maxTokens === undefined && profile.rawDefaultMaxTokens !== undefined) {
    body.inferenceConfig.maxTokens = profile.rawDefaultMaxTokens;
  }
}

/** Selected full-simple allocation; the raw output module above remains separate. */
export function applyBedrockProfileSimplePolicy(model: string, body: Record<string, unknown>, options: ChatOptions | undefined,
  messages: readonly Message[] = [], region = 'us-east-1'): { maxTokens: number; thinkingBudget?: number; thinkingBudgets?: ChatOptions['thinkingBudgets'] } | undefined {
  const profile = profiles.get(model);
  if (!profile) return undefined;
  applyBedrockProfileOutputPolicy(model, body, options?.maxTokens);
  const available = Math.max(1, profile.contextWindow - simpleContextTokens(messages, options) - 4096);
  let maxTokens = Math.min(options?.maxTokens ?? profile.maxOutputTokens, available);
  let thinkingBudget: number | undefined, thinkingBudgets: ChatOptions['thinkingBudgets'];
  const level = options?.thinking;
  if (model === 'anthropic.claude-opus-4-6-v1' && level !== undefined && level !== 'off') {
    const efforts = { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'max' } as const;
    if (typeof level !== 'string' || !Object.hasOwn(efforts, level)) throw new Error('Invalid Bedrock reasoning level.');
    body.additionalModelRequestFields = { thinking: { type: 'adaptive',
      ...(region.toLowerCase().startsWith('us-gov-') ? {} : { display: 'summarized' }) }, output_config: { effort: efforts[level] } };
  }
  applyBedrockProfileReasoningPolicy(model, body, options, region);
  if (numericModels.has(model) && level !== undefined && level !== 'off') {
    if (typeof level !== 'string' || !Object.hasOwn(numericLevels, level)) throw new Error('Invalid Bedrock reasoning level.');
    const selected = level === 'xhigh' || level === 'max' ? 'high' : level;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(options, 'thinkingBudgets');
      if (descriptor && !('value' in descriptor)) throw new Error();
      thinkingBudgets = copyThinkingBudgets(descriptor?.value);
    } catch { throw new ProviderOutputBudgetError('thinking'); }
    thinkingBudget = thinkingBudgets?.[selected] ?? numericBudgets[selected];
    // Saturating addition preserves a valid MAX_SAFE_INTEGER custom budget without unsafe intermediate arithmetic.
    maxTokens = thinkingBudget >= profile.maxOutputTokens - maxTokens ? profile.maxOutputTokens : maxTokens + thinkingBudget;
    if (maxTokens <= thinkingBudget) thinkingBudget = Math.min(thinkingBudget, Math.max(0, maxTokens - 1024));
    maxTokens = Math.min(maxTokens, available);
    thinkingBudget = Math.min(thinkingBudget, Math.max(0, maxTokens - 1024));
    if (thinkingBudget < 1024 || maxTokens - thinkingBudget < 1024) throw new Error('Invalid Bedrock thinking allocation.');
    body.additionalModelRequestFields = { thinking: { type: 'enabled', budget_tokens: thinkingBudget,
      ...(region.toLowerCase().startsWith('us-gov-') ? {} : { display: 'summarized' }) }, anthropic_beta: ['interleaved-thinking-2025-05-14'] };
  }
  (body.inferenceConfig as Record<string, unknown>).maxTokens = maxTokens;
  return { maxTokens, thinkingBudget, thinkingBudgets };
}

export function prepareBedrockOutputBudget(options: ChatOptions, configuredModel: string, messages: readonly Message[] = [], region = 'us-east-1'): Readonly<PreparedNativeOutputBudget> {
  try {
    const model = options.model || configuredModel;
    const allocation = applyBedrockProfileSimplePolicy(model, { inferenceConfig: {} }, options, messages, region);
    const owned = { ...options, model, ...(allocation?.thinkingBudget !== undefined ? { thinkingBudgets: allocation.thinkingBudgets } : {}) };
    return Object.freeze({ options: owned, maxTokens: allocation?.maxTokens ?? options.maxTokens ?? 0 });
  } catch (error) {
    if (error instanceof ProviderOutputBudgetError) throw error;
    throw new ProviderOutputBudgetError();
  }
}

/** Input counters exclude cache reads/writes; tiers use their gross sum, never output. */
export function bedrockProfileUsage(value: unknown, model: string): ChatResponse['usage'] {
  const profile = profiles.get(model);
  if (!profile || !record(value) || !counter(value.inputTokens) || !counter(value.outputTokens) || !counter(value.totalTokens)) return undefined;
  const read = value.cacheReadInputTokens === undefined ? 0 : value.cacheReadInputTokens;
  const write = value.cacheWriteInputTokens === undefined ? 0 : value.cacheWriteInputTokens;
  if (!counter(read) || !counter(write)) return undefined;
  const gross = value.inputTokens + read + write, total = gross + value.outputTokens;
  if (!Number.isSafeInteger(gross) || !Number.isSafeInteger(total) || value.totalTokens < total) return undefined;
  let longWrite = 0, detailed = 0;
  if (value.cacheDetails !== undefined) {
    if (!Array.isArray(value.cacheDetails)) return undefined;
    for (const detail of value.cacheDetails) {
      if (!record(detail) || typeof detail.ttl !== 'string' || !['5m', '1h'].includes(detail.ttl) || !counter(detail.inputTokens)) return undefined;
      detailed += detail.inputTokens;
      if (!Number.isSafeInteger(detailed) || detailed > write) return undefined;
      if (detail.ttl === '1h') longWrite += detail.inputTokens;
    }
  }
  const usage = { promptTokens: value.inputTokens, completionTokens: value.outputTokens, totalTokens: value.totalTokens,
    cacheReadTokens: read, cacheWriteTokens: write };
  if (value.totalTokens !== total || !profile.metadata.pricing) return usage;
  let rates: Rates = profile.cost, threshold = -1;
  for (const tier of profile.cost.tiers ?? []) if (gross > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
    rates = tier; threshold = tier.inputTokensAbove;
  }
  const costUsd = rates.input / 1_000_000 * value.inputTokens + rates.output / 1_000_000 * value.outputTokens
    + rates.cacheRead / 1_000_000 * read + (rates.cacheWrite * (write - longWrite) + rates.input * 2 * longWrite) / 1_000_000;
  return { ...usage, costUsd };
}

// Explicit caller thinking: retained raw/simple whole bodies agree at output64 on these91 IDs.
// The exact Opus4.6 request policy and catalogue-owned host levels remain separate.
const reasoningGroups: readonly { models: readonly string[]; fields: Record<string, unknown>; efforts: Readonly<Record<string, string>> }[] = [
  { models: ["anthropic.claude-fable-5","anthropic.claude-fable-5-1","anthropic.claude-haiku-5-5","anthropic.claude-opus-4-7","anthropic.claude-opus-4-8","anthropic.claude-opus-5-5","anthropic.claude-sonnet-5","anthropic.claude-sonnet-5-5","au.anthropic.claude-haiku-5-5","au.anthropic.claude-opus-4-7","au.anthropic.claude-opus-4-8","au.anthropic.claude-opus-5","au.anthropic.claude-opus-5-5","au.anthropic.claude-sonnet-5","eu.anthropic.claude-fable-5","eu.anthropic.claude-haiku-5-5","eu.anthropic.claude-opus-4-7","eu.anthropic.claude-opus-4-8","eu.anthropic.claude-opus-5","eu.anthropic.claude-opus-5-5","eu.anthropic.claude-sonnet-5","eu.anthropic.claude-sonnet-5-5","global.anthropic.claude-fable-5","global.anthropic.claude-fable-5-1","global.anthropic.claude-haiku-5-5","global.anthropic.claude-opus-4-7","global.anthropic.claude-opus-4-8","global.anthropic.claude-opus-5","global.anthropic.claude-opus-5-5","global.anthropic.claude-sonnet-5","global.anthropic.claude-sonnet-5-5","in.anthropic.claude-opus-5","in.anthropic.claude-sonnet-5","jp.anthropic.claude-haiku-5-5","jp.anthropic.claude-opus-4-7","jp.anthropic.claude-opus-4-8","jp.anthropic.claude-opus-5","jp.anthropic.claude-opus-5-5","jp.anthropic.claude-sonnet-5","us.anthropic.claude-fable-5","us.anthropic.claude-fable-5-1","us.anthropic.claude-haiku-5-5","us.anthropic.claude-opus-4-7","us.anthropic.claude-opus-4-8","us.anthropic.claude-opus-5","us.anthropic.claude-opus-5-5","us.anthropic.claude-sonnet-5","us.anthropic.claude-sonnet-5-5"],
    fields: {"thinking":{"type":"adaptive","display":"summarized","block_binding":{"prefix_mismatch_behavior":"drop_block"}},"output_config":{},"anthropic_beta":["thinking-binding-controls-2026-08-01"]},
    efforts: {"minimal":"low","low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"} },
  { models: ["anthropic.claude-sonnet-4-6","au.anthropic.claude-opus-4-6-v1","au.anthropic.claude-sonnet-4-6","eu.anthropic.claude-opus-4-6-v1","eu.anthropic.claude-sonnet-4-6","global.anthropic.claude-opus-4-6-v1","global.anthropic.claude-sonnet-4-6","jp.anthropic.claude-sonnet-4-6","us.anthropic.claude-opus-4-6-v1","us.anthropic.claude-sonnet-4-6"],
    fields: {"thinking":{"type":"adaptive","display":"summarized"},"output_config":{}},
    efforts: {"minimal":"low","low":"low","medium":"medium","high":"high","xhigh":"high","max":"max"} },
  { models: ["global.openai.gpt-5.6-luna","global.openai.gpt-5.6-sol","global.openai.gpt-5.6-terra","global.openai.gpt-6-astra","global.openai.gpt-6-luna","global.openai.gpt-6-sol","global.openai.gpt-6.1-sol","in.openai.gpt-5.6-luna","in.openai.gpt-5.6-terra","openai.gpt-5.4","openai.gpt-5.5","openai.gpt-5.6-luna","openai.gpt-5.6-sol","openai.gpt-5.6-terra","openai.gpt-6-astra","openai.gpt-6-luna","openai.gpt-6-sol","openai.gpt-6.1-sol","us.openai.gpt-5.6-luna","us.openai.gpt-5.6-sol","us.openai.gpt-5.6-terra","us.openai.gpt-6-astra","us.openai.gpt-6-luna","us.openai.gpt-6-sol","us.openai.gpt-6.1-sol"],
    fields: {"reasoning":{}},
    efforts: {"minimal":"low","low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"} },
  { models: ["openai.gpt-oss-120b","openai.gpt-oss-120b-1:0","openai.gpt-oss-20b","openai.gpt-oss-20b-1:0","openai.gpt-oss-safeguard-120b","openai.gpt-oss-safeguard-20b","us-gov.openai.gpt-oss-120b-1:0","us-gov.openai.gpt-oss-20b-1:0"],
    fields: {},
    efforts: {"minimal":"low","low":"low","medium":"medium","high":"high","xhigh":"high","max":"high"} },
];
const reasoningProfiles = new Map(reasoningGroups.flatMap(profile => profile.models.map(model => [model, profile] as const)));

/** Private exact-ID caller policy; unused numeric budgets and public metadata stay opaque. */
function applyBedrockProfileReasoningPolicy(model: string, body: Record<string, unknown>, options: ChatOptions | undefined, region: string): void {
  const profile = reasoningProfiles.get(model);
  if (!profile) return;
  const level = options?.thinking;
  if (level === undefined || level === 'off') return;
  if (typeof level !== 'string' || !Object.hasOwn(profile.efforts, level)) throw new Error('Invalid Bedrock reasoning level.');
  const fields = structuredClone(profile.fields), effort = profile.efforts[level];
  if (record(fields.output_config)) fields.output_config.effort = effort;
  else if (record(fields.reasoning)) fields.reasoning.effort = effort;
  else fields.reasoning_effort = effort;
  // Pinned GovCloud policy omits both display and managed binding controls/beta.
  if (region.toLowerCase().startsWith('us-gov-') && record(fields.thinking)) {
    delete fields.thinking.display; delete fields.thinking.block_binding; delete fields.anthropic_beta;
  }
  body.additionalModelRequestFields = fields;
}
