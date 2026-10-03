import type {
  EffectiveConfiguration,
  ScopedConfigurationValues,
  Session,
} from '@ai-harness/core';
import type { RuntimeServices } from '../runtime/services.js';

export const DEFAULT_SCOPED_CONFIGURATION: Readonly<ScopedConfigurationValues> = {
  provider: 'mock',
  thinking: 'off',
  toolPreset: 'default',
  autoCompaction: true,
  powershellEnabled: false,
};

function environmentConfiguration(): ScopedConfigurationValues {
  const thinking = process.env.AI_HARNESS_DEFAULT_THINKING;
  const toolPreset = process.env.AI_HARNESS_DEFAULT_TOOL_PRESET;
  const autoCompaction = process.env.AI_HARNESS_AUTO_COMPACTION?.trim().toLowerCase();
  return {
    ...(process.env.AI_HARNESS_DEFAULT_PROVIDER ? { provider: process.env.AI_HARNESS_DEFAULT_PROVIDER } : {}),
    ...(process.env.AI_HARNESS_DEFAULT_MODEL ? { model: process.env.AI_HARNESS_DEFAULT_MODEL } : {}),
    ...(thinking && ['off', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking)
      ? { thinking: thinking as NonNullable<ScopedConfigurationValues['thinking']> }
      : {}),
    ...(toolPreset && ['configured', 'chat-only', 'read-only', 'default', 'full'].includes(toolPreset)
      ? { toolPreset: toolPreset as NonNullable<ScopedConfigurationValues['toolPreset']> }
      : {}),
    ...(['true', '1', 'on', 'yes'].includes(autoCompaction ?? '') ? { autoCompaction: true } : {}),
    ...(['false', '0', 'off', 'no'].includes(autoCompaction ?? '') ? { autoCompaction: false } : {}),
  };
}

function runtimeSessionConfiguration(session?: Session): ScopedConfigurationValues | undefined {
  if (!session) return undefined;
  return {
    ...(session.providerConfig?.type ? { provider: String(session.providerConfig.type) } : {}),
    ...(session.model !== undefined ? { model: session.model } : {}),
    ...(session.thinking !== undefined ? { thinking: session.thinking } : {}),
    ...(session.toolPreset !== undefined ? { toolPreset: session.toolPreset } : {}),
    ...(session.autoCompaction !== undefined ? { autoCompaction: session.autoCompaction } : {}),
    ...(typeof session.metadata?.systemPrompt === 'string'
      ? { systemPrompt: session.metadata.systemPrompt }
      : {}),
  };
}

/** Resolve non-secret settings with one precedence order for API, agent and background policies. */
export function resolveEffectiveConfiguration(
  services: Pick<RuntimeServices, 'configurationStore'>,
  input: { projectId?: string; sessionId?: string; session?: Session } = {},
): EffectiveConfiguration {
  return services.configurationStore.effective({
    projectId: input.projectId,
    sessionId: input.sessionId ?? input.session?.id,
    defaults: { ...DEFAULT_SCOPED_CONFIGURATION },
    runtimeSession: runtimeSessionConfiguration(input.session),
    environment: environmentConfiguration(),
  });
}
