import { getAgentSettingsEditorSchema, getCustomModelEditorSchema } from '@ai-harness/core';

// Build-time projection from the native Core owner, not a second settings
// parser or a new configuration loader. No environment, files or trust reads.
export function nativeEditorDocuments() {
  return {
    'settings.schema.json': getAgentSettingsEditorSchema('global'),
    'project-settings.schema.json': getAgentSettingsEditorSchema('project'),
    'models.schema.json': getCustomModelEditorSchema(),
  };
}
