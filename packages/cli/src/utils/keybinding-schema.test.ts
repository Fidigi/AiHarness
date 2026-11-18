import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { defaultTerminalBindings } from './terminal-actions.js';
import { MAX_KEYBINDING_CONFIG_BYTES, MAX_KEYBINDING_CONFIG_ENTRIES, parseKeyBindingConfig } from './keybinding-config.js';

describe('packaged editor schema and authoritative runtime grammar', () => {
  it('ships every supported field, bounds and explicit runtime-only constraints', async () => {
    const schema = JSON.parse(await readFile(new URL('../../schemas/keybindings.schema.json', import.meta.url), 'utf8'));
    expect(schema.type).toBe('array'); expect(schema.maxItems).toBe(MAX_KEYBINDING_CONFIG_ENTRIES);
    expect(schema['x-maxUtf8Bytes']).toBe(MAX_KEYBINDING_CONFIG_BYTES);
    expect(schema.items.required).toEqual(['id', 'keys']); expect(schema.items.additionalProperties).toBe(false);
    expect(Object.keys(schema.items.properties).sort()).toEqual(['action', 'description', 'id', 'keys', 'preventDefault']);
    expect(schema.items.properties.preventDefault.type).toBe('boolean'); expect(schema.items.properties.preventDefault.default).toBe(true);
    expect(schema.items.properties.keys.maxItems).toBe(5); expect(schema.$defs.identifier['x-maxUtf8Bytes']).toBe(256);
    expect(schema.items.properties.description['x-maxUtf8Bytes']).toBe(512);
    for (const entry of defaultTerminalBindings()) {
      expect(new RegExp(schema.$defs.identifier.allOf[0].pattern, 'u').test(entry.id)).toBe(true);
      expect(new RegExp(schema.$defs.identifier.allOf[1].pattern, 'u').test(entry.id)).toBe(true);
    }
    expect(parseKeyBindingConfig(JSON.stringify(defaultTerminalBindings()))).toEqual(defaultTerminalBindings());
  });
  it('copies the exact schema into emitted CLI assets without reading configuration bodies', async () => {
    const original = await readFile(new URL('../../schemas/keybindings.schema.json', import.meta.url));
    const emitted = await readFile(new URL('../../dist/schemas/keybindings.schema.json', import.meta.url));
    expect(emitted.equals(original)).toBe(true);
  });
});
