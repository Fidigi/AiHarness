import type { PublishedModelMetadata } from './model-metadata.js';

// Native projection of dist/providers/data/mistral.json from Pi AI 1.2.0.
// Provenance and refresh/qualification limits: docs/ai/topics/provider-matrix.md.
// No source or vendor fetch occurs at runtime; aliases retain their pinned meaning.
type Row = [id: string, name: string, context: number, output: number, inputPrice: number,
  outputPrice: number, cachePrice: number, vision: boolean, thinking?: 'effort' | 'max' | 'required-max'];
const rows: Row[] = [
  ['codestral-2508', 'Codestral 25.08', 256000, 8192, 0.3, 0.9, 0.03, false],
  ['codestral-latest', 'Codestral (latest)', 256000, 4096, 0.3, 0.9, 0.03, false],
  ['devstral-2512', 'Devstral 2', 262144, 262144, 0.4, 2, 0.04, false],
  ['devstral-latest', 'Devstral 2', 262144, 262144, 0.4, 2, 0.04, false],
  ['devstral-medium-2507', 'Devstral Medium', 128000, 128000, 0.4, 2, 0.04, false],
  ['devstral-medium-latest', 'Devstral 2 (latest)', 262144, 262144, 0.4, 2, 0.04, false],
  ['devstral-small-2505', 'Devstral Small 2505', 128000, 128000, 0.1, 0.3, 0.01, false],
  ['devstral-small-2507', 'Devstral Small', 128000, 128000, 0.1, 0.3, 0.01, false],
  ['glm-5-2', 'GLM-5.2', 1048576, 131072, 1.4, 4.4, 0.14, false, 'max'],
  ['labs-devstral-small-2512', 'Devstral Small 2', 256000, 256000, 0, 0, 0, true],
  ['labs-leanstral-1-5-1', 'Leanstral 1.5', 262144, 128000, 0, 0, 0, true, 'effort'],
  ['magistral-medium-latest', 'Magistral Medium (latest)', 262144, 16384, 2, 5, 0.2, true, 'effort'],
  ['ministral-14b-2512', 'Ministral 3 14B', 262144, 262144, 0.2, 0.2, 0.02, true],
  ['ministral-3b-2512', 'Ministral 3 3B', 131072, 262144, 0.1, 0.1, 0.01, true],
  ['ministral-3b-latest', 'Ministral 3B (latest)', 131072, 128000, 0.04, 0.04, 0.004, true],
  ['ministral-8b-2512', 'Ministral 3 8B', 262144, 262144, 0.15, 0.15, 0.015, true],
  ['ministral-8b-latest', 'Ministral 8B (latest)', 262144, 128000, 0.1, 0.1, 0.01, true],
  ['mistral-large-2411', 'Mistral Large 2.1', 131072, 16384, 2, 6, 0.2, false],
  ['mistral-large-2512', 'Mistral Large 3', 262144, 262144, 0.5, 1.5, 0.05, true],
  ['mistral-large-4', 'Mistral Large 4', 1048576, 262144, 0.68, 2.09, 0.07, true, 'effort'],
  ['mistral-large-latest', 'Mistral Large (latest)', 262144, 262144, 0.5, 1.5, 0.05, true],
  ['mistral-medium-2505', 'Mistral Medium 3', 131072, 131072, 0.4, 2, 0.04, true],
  ['mistral-medium-2508', 'Mistral Medium 3.1', 262144, 262144, 0.4, 2, 0.04, true],
  ['mistral-medium-2604', 'Mistral Medium 3.5', 262144, 262144, 1.5, 7.5, 0.15, true, 'effort'],
  ['mistral-medium-3.5', 'Mistral Medium 3.5', 262144, 262144, 1.5, 7.5, 0, true, 'effort'],
  ['mistral-medium-latest', 'Mistral Medium (latest)', 262144, 262144, 1.5, 7.5, 0.15, true, 'effort'],
  ['mistral-nemo', 'Mistral Nemo', 128000, 128000, 0.15, 0.15, 0.015, false],
  ['mistral-small-2506', 'Mistral Small 3.2', 128000, 16384, 0.1, 0.3, 0.01, true],
  ['mistral-small-2603', 'Mistral Small 4', 262144, 256000, 0.15, 0.6, 0.015, true, 'effort'],
  ['mistral-small-latest', 'Mistral Small (latest)', 262144, 256000, 0.15, 0.6, 0.015, true, 'effort'],
  ['open-mistral-7b', 'Mistral 7B', 8000, 8000, 0.25, 0.25, 0.025, false],
  ['open-mistral-nemo', 'Open Mistral Nemo', 128000, 128000, 0.15, 0.15, 0.015, false],
  ['open-mixtral-8x22b', 'Mixtral 8x22B', 64000, 64000, 2, 6, 0.2, false],
  ['open-mixtral-8x7b', 'Mixtral 8x7B', 32000, 32000, 0.7, 0.7, 0.07, false],
  ['pixtral-12b', 'Pixtral 12B', 128000, 128000, 0.15, 0.15, 0.015, true],
  ['pixtral-large-latest', 'Pixtral Large (latest)', 128000, 128000, 2, 6, 0.2, true],
  ['voxtral-small-2507', 'Voxtral Small', 32768, 32000, 0.1, 0.4, 0.01, false],
  ['voxtral-small-latest', 'Voxtral Small (latest)', 32768, 32000, 0.1, 0.3, 0.01, false],
  ['zai-glm-5-2', 'GLM-5.2', 1048576, 131072, 1.4, 4.4, 0.14, false, 'max'],
  ['zai-glm-5-3', 'GLM-5.3', 1048576, 131072, 1.4, 4.4, 0.14, false, 'required-max'],
];

export const MISTRAL_MODELS: readonly PublishedModelMetadata[] = rows.map(([id, name, contextWindow, maxOutputTokens,
  inputPerMillion, outputPerMillion, cacheReadPerMillion, imageInput, thinking]) => ({
  id, name, contextWindow, maxOutputTokens,
  capabilities: { reasoning: Boolean(thinking), imageInput, toolCalls: true },
  pricing: { inputPerMillion, outputPerMillion, cacheReadPerMillion, cacheWritePerMillion: 0 },
  thinkingLevelMap: thinking ? { off: thinking === 'required-max' ? null : 'none', minimal: null,
    low: thinking === 'required-max' ? 'low' : null, medium: null, high: 'high', xhigh: null,
    max: thinking === 'effort' ? null : 'max' } : null,
}));
