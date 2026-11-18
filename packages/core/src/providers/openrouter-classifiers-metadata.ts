import type { ModelPricing } from '../types/index.js';

export interface OpenRouterClassifierProfile {
  readonly id: string; readonly name: string; readonly type: 'classifier'; readonly api: 'typesafe-system-one';
  readonly contextWindow: number;
  /** Catalogue declarations only: the pinned System One transport refuses every image. */
  readonly declaredInput: readonly ('text' | 'image')[];
  readonly declaredPricing: Readonly<Required<ModelPricing>>;
  /** Zero-only fallback tables do not establish free calls. */
  readonly pricing?: Readonly<Required<ModelPricing>>;
}
// Reviewed frozen openrouter.json catalogue projection, not live availability or complete effective profiles.
const rows: ReadonlyArray<readonly [string, string, number, boolean, number, number?]> = [
  ['~perplexity/pplx-decider-27b-latest', 'Perplexity: Decider 27B Latest', 262144, true, 0.02],
  ['~typesafe/jev-latest', 'TypeSafe: Jev Latest', 64000, false, 0.042],
  ['cloudflare/clef', 'Cloudflare: Clef', 16384, true, 0.042],
  ['cloudflare/clef-flash', 'Cloudflare: Clef Flash', 16384, true, 0.021],
  ['cloudflare/clef-omni', 'Cloudflare: Clef Omni', 65536, true, 0.15],
  ['inception/mercury-decide', 'Inception: Mercury Decide', 65536, false, 0.02],
  ['inception/mercury-decide:free', 'Inception: Mercury Decide (free)', 65536, false, 0],
  ['jaredpalmer/kev-4b', 'Jared Palmer: Kev 4B', 8192, false, 0.042],
  ['liquid/d1', 'LiquidAI: d1', 65536, false, 0.04, 0.04],
  ['microsoft/microsoft-decision-1', 'Microsoft: Microsoft-Decision-1', 32768, false, 0.042],
  ['nace-ai/drex-v1.5', 'Nace.AI: Drex v1.5', 131072, false, 0.04],
  ['nace-ai/drex-v2.0', 'Nace.AI: Drex v2.0', 131072, false, 0.06],
  ['openai/gpt-6-luna-decisions', 'OpenAI: GPT-6 Luna Decisions', 1050000, true, 0.1],
  ['perplexity/pplx-decider-v1.1-27b', 'Perplexity: Decider V1.1 27B', 262144, true, 0.02],
  ['respan/span-01', 'Respan: Span-01', 4096, false, 0.02],
  ['respan/span-01-lite', 'Respan: Span-01 Lite', 4096, false, 0],
  ['respan/span-01-lite:free', 'Respan: Span-01 Lite (free)', 4096, false, 0],
  ['togethercomputer/tev1-4b-experimental', 'Together: Tev1 4B Experimental', 32768, false, 0.042],
  ['typesafe/jev-1.13', 'TypeSafe: Jev 1.13', 64000, false, 0.042],
  ['upstage/solar-decide', 'Upstage: Solar Decide', 524288, false, 0.05, 0.05],
  ['upstage/solar-decide-flash', 'Upstage: Solar Decide Flash', 524288, false, 0.05, 0.05],
];
export const OPENROUTER_CLASSIFIER_MODELS: readonly OpenRouterClassifierProfile[] = Object.freeze(rows.map(([id, name, contextWindow, image, inputPerMillion, cacheReadPerMillion = 0]) => {
  const declaredPricing = Object.freeze({ inputPerMillion, outputPerMillion: 0, cacheReadPerMillion, cacheWritePerMillion: 0 });
  return Object.freeze({ id, name, contextWindow, type: 'classifier' as const, api: 'typesafe-system-one' as const,
    declaredInput: Object.freeze(image ? ['text', 'image'] as const : ['text'] as const), declaredPricing,
    ...(inputPerMillion > 0 ? { pricing: declaredPricing } : {}),
  });
}));
