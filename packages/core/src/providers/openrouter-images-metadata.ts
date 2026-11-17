import type { ModelPricing } from '../types/index.js';

const imageLimits = Object.freeze({ images: Object.freeze({ resize: Object.freeze({
  maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80,
}) }) });
export interface OpenRouterImageProfile {
  readonly id: string; readonly name: string; readonly type: 'image'; readonly api: 'openrouter-images';
  readonly input: readonly ('text' | 'image')[]; readonly output: readonly ('text' | 'image')[];
  readonly pricing: Readonly<Required<ModelPricing>>; readonly inputLimits?: typeof imageLimits;
}
// Reviewed projection of the frozen openrouter.json catalogue, not live availability or effective resize policy.
// Zero-only tables are ambiguous: upstream also uses zero for missing/invalid/router prices, not proof of free images.
const rows: ReadonlyArray<readonly [string, string, string, string, (readonly [number, number, number, number])?]> = [
  ["black-forest-labs/flux-3-image","Black Forest Labs: FLUX.3 Image","ti","i"],
  ["black-forest-labs/flux.2-flex","Black Forest Labs: FLUX.2 Flex","ti","i"],
  ["black-forest-labs/flux.2-klein-4b","Black Forest Labs: FLUX.2 Klein 4B","ti","i"],
  ["black-forest-labs/flux.2-max","Black Forest Labs: FLUX.2 Max","ti","i"],
  ["black-forest-labs/flux.2-pro","Black Forest Labs: FLUX.2 Pro","ti","i"],
  ["bytedance-seed/seedream-4.5","ByteDance Seed: Seedream 4.5","it","i"],
  ["bytedance-seed/seedream-5-0-flash","ByteDance Seed: Seedream 5.0 Flash","ti","i"],
  ["bytedance-seed/seedream-5-0-lite","ByteDance Seed: Seedream 5.0 Lite","ti","i"],
  ["bytedance-seed/seedream-5-0-pro","ByteDance Seed: Seedream 5.0 Pro","ti","i"],
  ["google/gemini-2.5-flash-image","Google: Nano Banana (Gemini 2.5 Flash Image)","it","it",[0.3,2.5,0.03,0.083333]],
  ["google/gemini-3-pro-image","Google: Nano Banana Pro (Gemini 3 Pro Image)","it","it",[2,12,0.2,0.375]],
  ["google/gemini-3-pro-image-preview","Google: Nano Banana Pro (Gemini 3 Pro Image Preview)","it","it",[2,12,0.2,0.375]],
  ["google/gemini-3.1-flash-image","Google: Nano Banana 2 (Gemini 3.1 Flash Image)","it","it",[0.5,3,0,0]],
  ["google/gemini-3.1-flash-image-preview","Google: Nano Banana 2 (Gemini 3.1 Flash Image Preview)","it","it",[0.5,3,0,0]],
  ["google/gemini-3.1-flash-lite-image","Google: Nano Banana 2 Lite (Gemini 3.1 Flash Lite Image)","it","it",[0.25,1.5,0,0]],
  ["google/gemini-nano-banana-2.1","Google: Nano Banana 2.1","it","it",[1.5,7.5,0,0]],
  ["inclusionai/ming-image-0.1-design","inclusionAI: Ming Image 0.1 Design","t","i"],
  ["inclusionai/ming-image-0.1-design-layer","inclusionAI: Ming Image 0.1 Design Layer","ti","i"],
  ["krea/krea-2-large","Krea: Krea 2 Large","ti","i"],
  ["krea/krea-2-medium","Krea: Krea 2 Medium","ti","i"],
  ["krea/krea-2-medium-turbo","Krea: Krea 2 Medium Turbo","ti","i"],
  ["meta/muse-image","Meta: Muse Image","ti","i"],
  ["microsoft/mai-image-2.5","Microsoft AI: MAI-Image-2.5","ti","i",[5,0,0,0]],
  ["microsoft/mai-image-2.5-pro","Microsoft AI: MAI-Image-2.5 Pro","ti","i",[5,0,0,0]],
  ["microsoft/mai-image-2.6","Microsoft AI: MAI-Image-2.6","ti","i",[5,0,0,0]],
  ["microsoft/mai-image-2.6-flash","Microsoft AI: MAI-Image-2.6 Flash","ti","i",[1.75,0,0,0]],
  ["openai/gpt-5-image","OpenAI: GPT-5 Image","it","it",[10,10,1.25,0]],
  ["openai/gpt-5-image-mini","OpenAI: GPT-5 Image Mini","it","it",[2.5,2,0.25,0]],
  ["openai/gpt-5.4-image-2","OpenAI: GPT-5.4 Image 2","it","it",[8,15,2,0]],
  ["openai/gpt-image-1","OpenAI: GPT Image 1","ti","i",[10,10,1.25,0]],
  ["openai/gpt-image-1-mini","OpenAI: GPT Image 1 Mini","ti","i",[2.5,2.5,0.25,0]],
  ["openai/gpt-image-2","OpenAI: GPT Image 2","ti","i",[8,8,2,0]],
  ["openai/gpt-image-2.5-flare","OpenAI: GPT Image 2.5 Flare","ti","i",[8,8,2,0]],
  ["openai/gpt-image-2.5-sunburst","OpenAI: GPT Image 2.5 Sunburst","ti","i",[8,8,2,0]],
  ["openrouter/auto","Auto Router","ti","ti"],
  ["openrouter/auto-beta","Auto Router (Beta)","ti","ti"],
  ["qwen/qwen-image-3","Qwen: Qwen Image 3","ti","i"],
  ["qwen/qwen-image-3-pro","Qwen: Qwen Image 3 Pro","ti","i"],
  ["recraft/recraft-v3","Recraft: Recraft V3","ti","i"],
  ["recraft/recraft-v4","Recraft: Recraft V4","ti","i"],
  ["recraft/recraft-v4-pro","Recraft: Recraft V4 Pro","ti","i"],
  ["recraft/recraft-v4-pro-vector","Recraft: Recraft V4 Pro Vector","ti","i"],
  ["recraft/recraft-v4-styles","Recraft: Recraft V4 Styles","ti","i"],
  ["recraft/recraft-v4-styles-pro","Recraft: Recraft V4 Styles Pro","ti","i"],
  ["recraft/recraft-v4-styles-pro-vector","Recraft: Recraft V4 Styles Pro Vector","ti","i"],
  ["recraft/recraft-v4-styles-vector","Recraft: Recraft V4 Styles Vector","ti","i"],
  ["recraft/recraft-v4-vector","Recraft: Recraft V4 Vector","ti","i"],
  ["recraft/recraft-v4.1","Recraft: Recraft V4.1","ti","i"],
  ["recraft/recraft-v4.1-flash","Recraft: Recraft V4.1 Flash","t","i"],
  ["recraft/recraft-v4.1-pro","Recraft: Recraft V4.1 Pro","ti","i"],
  ["recraft/recraft-v4.1-pro-vector","Recraft: Recraft V4.1 Pro Vector","ti","i"],
  ["recraft/recraft-v4.1-utility","Recraft: Recraft V4.1 Utility","ti","i"],
  ["recraft/recraft-v4.1-utility-pro","Recraft: Recraft V4.1 Utility Pro","ti","i"],
  ["recraft/recraft-v4.1-vector","Recraft: Recraft V4.1 Vector","ti","i"],
  ["sourceful/riverflow-v2-fast","Sourceful: Riverflow V2 Fast","ti","i"],
  ["sourceful/riverflow-v2-pro","Sourceful: Riverflow V2 Pro","ti","i"],
  ["sourceful/riverflow-v2.5-fast","Sourceful: Riverflow V2.5 Fast","ti","i"],
  ["sourceful/riverflow-v2.5-pro","Sourceful: Riverflow V2.5 Pro","ti","i"],
  ["tencent/hy-image-v3.5-preview","Tencent: Hy Image 3.5 Preview","ti","i"],
  ["x-ai/grok-imagine-image-2.0","xAI: Grok Imagine Image 2.0","ti","i"],
  ["x-ai/grok-imagine-image-quality","SpaceXAI: Grok Imagine Image Quality","ti","i"],
];
const media = (flags: string): readonly ('text' | 'image')[] => Object.freeze(Array.from(flags, flag => flag === 't' ? 'text' : 'image'));
export const OPENROUTER_IMAGE_MODELS: readonly OpenRouterImageProfile[] = Object.freeze(rows.map(([id, name, input, output, rates]) => {
  const [inputPerMillion, outputPerMillion, cacheReadPerMillion, cacheWritePerMillion] = rates ?? [0, 0, 0, 0];
  return Object.freeze({ id, name, type: 'image' as const, api: 'openrouter-images' as const, input: media(input), output: media(output),
    pricing: Object.freeze({ inputPerMillion, outputPerMillion, cacheReadPerMillion, cacheWritePerMillion }),
    ...(input.includes('i') ? { inputLimits: imageLimits } : {}),
  });
}));
export function openRouterImagePricing(model: string): OpenRouterImageProfile['pricing'] | undefined {
  const pricing = OPENROUTER_IMAGE_MODELS.find(profile => profile.id === model)?.pricing;
  return pricing && Object.values(pricing).some(price => price > 0) ? pricing : undefined;
}
