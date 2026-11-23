import { readFile } from 'node:fs/promises';
import { getAgentSettingsEditorSchema, getCustomModelEditorSchema } from '@ai-harness/core';
import { describe, expect, it } from 'vitest';

describe('normal CLI build settings editor assets', () => {
  it.each([['settings.schema.json', 'global'], ['project-settings.schema.json', 'project']] as const)('emits %s from the authoritative Core owner', async (name, scope) => {
    const bytes = await readFile(new URL(`../../dist/schemas/${name}`, import.meta.url), 'utf8');
    expect(bytes).toBe(JSON.stringify(getAgentSettingsEditorSchema(scope), null, 2) + '\n');
    expect(JSON.parse(bytes).$id).toBe(`urn:ai-harness:schemas:settings:${scope}:1`);
  });
  it('emits the native public metadata schema, not a CLI models.json loader/private registry format', async () => {
    const bytes = await readFile(new URL('../../dist/schemas/models.schema.json', import.meta.url), 'utf8');
    expect(bytes).toBe(JSON.stringify(getCustomModelEditorSchema(), null, 2) + '\n');
    expect(JSON.parse(bytes).$id).toBe('urn:ai-harness:schemas:custom-model:1');
  });
  it.each(['keybindings.schema.json', 'theme.schema.json'])('preserves original %s byte-exactly', async name => {
    const original = await readFile(new URL(`../../schemas/${name}`, import.meta.url));
    const emitted = await readFile(new URL(`../../dist/schemas/${name}`, import.meta.url));
    expect(emitted).toEqual(original);
  });
});
