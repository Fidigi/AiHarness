import { mkdtemp, rm, writeFile, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeyBindingManager } from './keybinding-manager.js';
import { KeyBindingConfigError, MAX_KEYBINDING_CONFIG_BYTES, MAX_KEYBINDING_CONFIG_ENTRIES,
  parseKeyBindingConfig, type KeyBindingConfigProblem } from './keybinding-config.js';

const binding = { id: 'help', keys: ['CTRL+H'], action: 'app.help', description: 'Aide é', preventDefault: false };
const invalid: Array<[KeyBindingConfigProblem, unknown]> = [
  ['shape', {}], ['shape', null], ['shape', 17],
  ['entry', [null]], ['entry', [[]]], ['entry', [17]],
  ['properties', [{ ...binding, command: 'PRIVATE_SENTINEL' }]],
  ['id', [{ keys: ['ctrl+h'] }]], ['id', [{ ...binding, id: '' }]],
  ['id', [{ ...binding, id: ' hidden ' }]], ['id', [{ ...binding, id: 'bad\u202ename' }]],
  ['keys', [{ ...binding, keys: [] }]], ['keys', [{ ...binding, keys: [17] }]],
  ['keys', [{ ...binding, keys: ['ctrl+'] }]], ['keys', [{ ...binding, keys: ['ctrl+ctrl+h'] }]],
  ['keys', [{ ...binding, keys: ['ctrl'] }]], ['keys', [{ ...binding, keys: ['h+x'] }]],
  ['keys', [{ ...binding, keys: ['ctrl+\u001bh'] }]],
  ['description', [{ ...binding, description: 17 }]],
  ['description', [{ ...binding, description: 'bad\nPRIVATE_SENTINEL' }]],
  ['description', [{ ...binding, description: 'é'.repeat(257) }]],
  ['action', [{ ...binding, action: '' }]], ['action', [{ ...binding, action: {} }]],
  ['prevent-default', [{ ...binding, preventDefault: 'false' }]],
  ['duplicate-id', [binding, { ...binding, keys: ['ctrl+j'] }]],
  ['duplicate-keys', [binding, { ...binding, id: 'other', keys: ['h', 'control'] }]],
  ['reserved', [{ ...binding, keys: ['ctrl+c'] }]], ['reserved', [{ ...binding, keys: ['ctrl+d'] }]],
  ['reserved', [{ ...binding, keys: ['escape'] }]], ['reserved', [{ ...binding, keys: ['alt+escape'] }]],
];

afterEach(() => vi.restoreAllMocks());
describe('owned bounded keybinding data grammar', () => {
  it.each(invalid)('refuses %s without exposing contents', (reason, value) => {
    try { parseKeyBindingConfig(JSON.stringify(value)); throw new Error('accepted'); }
    catch (error) {
      expect(error).toBeInstanceOf(KeyBindingConfigError);
      expect((error as KeyBindingConfigError).reason).toBe(reason);
      expect((error as Error).message).toBe('Invalid keybinding configuration.');
      expect((error as Error).message).not.toContain('PRIVATE_SENTINEL');
    }
  });
  it.each(['{PRIVATE_SENTINEL', '[,]', ''])('refuses malformed JSON without parser excerpts', content => {
    expect(() => parseKeyBindingConfig(content)).toThrowError('Invalid keybinding configuration.');
  });
  it('normalizes chord aliases, preserves Unicode/boolean intent and owns returned records', () => {
    expect(parseKeyBindingConfig('\ufeff' + JSON.stringify([binding]))).toEqual([{ ...binding, keys: ['ctrl', 'h'] }]);
    expect(parseKeyBindingConfig(JSON.stringify([{ id: 'escape', action: 'app.escape', keys: ['Esc'] }, { id: 'send', keys: ['Control+Return'] }]))
      .map(entry => entry.keys)).toEqual([['escape'], ['ctrl', 'enter']]);
    const first = parseKeyBindingConfig(JSON.stringify([binding])); first[0]!.keys.push('x');
    expect(parseKeyBindingConfig(JSON.stringify([binding]))[0]!.keys).toEqual(['ctrl', 'h']);
  });
  it('conserves empty descriptions, unbound/unknown action IDs, literal plus IDs and empty layers', () => {
    expect(parseKeyBindingConfig(JSON.stringify([{ id: 'binding-ctrl+x', keys: ['ctrl+x'], description: '' }])))
      .toEqual([{ id: 'binding-ctrl+x', keys: ['ctrl', 'x'], description: '' }]);
    expect(parseKeyBindingConfig(JSON.stringify([{ ...binding, action: 'constructor' }]))[0]!.action).toBe('constructor');
    expect(parseKeyBindingConfig('[]')).toEqual([]);
  });
  it('refuses prototype properties rather than copying diagnostic/action authority', () => {
    expect(() => parseKeyBindingConfig('[{"id":"x","keys":["x"],"__proto__":{"action":"app.help"}}]'))
      .toThrowError(KeyBindingConfigError);
    expect(parseKeyBindingConfig('[{"id":"constructor","keys":["constructor"]}]')[0]!.keys).toEqual(['constructor']);
  });
  it('bounds original UTF8 and collection counts independently', () => {
    expect(() => parseKeyBindingConfig(' '.repeat(MAX_KEYBINDING_CONFIG_BYTES + 1))).toThrowError(KeyBindingConfigError);
    try { parseKeyBindingConfig(JSON.stringify(Array.from({ length: MAX_KEYBINDING_CONFIG_ENTRIES + 1 }, (_, i) => ({ id: String(i), keys: ['key' + i] })))); }
    catch (error) { expect((error as KeyBindingConfigError).reason).toBe('count'); return; }
    throw new Error('accepted');
  });
  it('admits the native Escape decoder alias only for its existing safety action', () => {
    expect(parseKeyBindingConfig(JSON.stringify([{ id: 'escape-wire-alias', action: 'app.escape', keys: ['alt+escape'] }]))[0]!.action).toBe('app.escape');
  });
  it('retains the six exact legacy saved-default IDs without inventing action authority', () => {
    const keys = [['c', 'ctrl'], ['ctrl', 'd'], ['alt', 'up'], ['alt', 'down'], ['ctrl', 'l'], ['alt', 'h']];
    const previous = keys.map(parts => ({ id: `binding-${parts.join('+')}`, keys: parts }));
    const parsed = parseKeyBindingConfig(JSON.stringify(previous));
    expect(parsed).toEqual(previous); expect(parsed.every(entry => !Object.hasOwn(entry, 'action'))).toBe(true);
  });
  it('does not coerce foreign input objects', () => {
    let reads = 0;
    const foreign = { get toString() { reads++; throw new Error('must stay unread'); } };
    expect(() => parseKeyBindingConfig(foreign as unknown as string)).toThrowError(KeyBindingConfigError);
    expect(reads).toBe(0);
  });
});

async function fixture(run: (directory: string, manager: KeyBindingManager) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'keybinding-config-owned-'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const manager = new KeyBindingManager();
  manager.registerAction('terminal.clear', { handler: () => undefined });
  try { await run(directory, manager); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

describe('actual configuration layer and dispatch', () => {
  it('overrides a default through the registered action and owns presentation copies', async () => fixture(async (dir, manager) => {
    const action = vi.fn(); manager.registerAction('app.help', { handler: action });
    const file = join(dir, 'keys.json'); await writeFile(file, JSON.stringify([{ ...binding, keys: ['ctrl+l'] }]));
    await manager.loadFromFile(file); await expect(manager.processKey(['ctrl+l'])).resolves.toBe(true);
    expect(action).toHaveBeenCalledOnce();
    const displayed = manager.getBindings().find(entry => entry.id === binding.id)!;
    displayed.keys.push('mutated'); displayed.description = 'mutated';
    expect(manager.getBindings().find(entry => entry.id === binding.id)?.description).toBe(binding.description);
  }));
  it('replaces loaded layers without retaining stale handlers and empty reload restores defaults', async () => fixture(async (dir, manager) => {
    const action = vi.fn(); manager.registerAction('app.help', { handler: action }); const file = join(dir, 'keys.json');
    await writeFile(file, JSON.stringify([binding])); await manager.loadFromFile(file);
    await writeFile(file, JSON.stringify([{ ...binding, keys: ['ctrl+j'] }])); await manager.loadFromFile(file);
    await expect(manager.processKey(['ctrl+h'])).resolves.toBe(false);
    await expect(manager.processKey(['ctrl+j'])).resolves.toBe(true); expect(action).toHaveBeenCalledOnce();
    await writeFile(file, '[]'); await manager.loadFromFile(file);
    await expect(manager.processKey(['ctrl+j'])).resolves.toBe(false); expect(manager.matchKey(['ctrl+l'])).not.toBeNull();
  }));
  it('retains previous active data after invalid schema/read and logs no private excerpts/paths', async () => fixture(async (dir, manager) => {
    const action = vi.fn(); manager.registerAction('app.help', { handler: action }); const file = join(dir, 'PRIVATE_SENTINEL.json');
    await writeFile(file, JSON.stringify([binding])); await manager.loadFromFile(file);
    await writeFile(file, '[{"id":"PRIVATE_SENTINEL","keys":[]}]'); await manager.loadFromFile(file);
    await manager.loadFromFile(join(dir, 'PRIVATE_SENTINEL-missing'));
    await expect(manager.processKey(['ctrl+h'])).resolves.toBe(true); expect(action).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('PRIVATE_SENTINEL');
  }));
  it('keeps unknown action metadata inert and resolves explicit later registration without reload', async () => fixture(async (dir, manager) => {
    const file = join(dir, 'keys.json'); await writeFile(file, JSON.stringify([binding])); await manager.loadFromFile(file);
    await expect(manager.processKey(['ctrl+h'])).resolves.toBe(false);
    const action = vi.fn(); manager.registerAction('app.help', { handler: action });
    await expect(manager.processKey(['ctrl+h'])).resolves.toBe(true); expect(action).toHaveBeenCalledOnce();
  }));
  it('captures one predicate decision and honors explicit native-event propagation', async () => fixture(async (dir, manager) => {
    let decisions = 0; const action = vi.fn();
    manager.registerAction('app.help', { handler: action, when: () => ++decisions === 1 });
    const file = join(dir, 'keys.json'); await writeFile(file, JSON.stringify([binding])); await manager.loadFromFile(file);
    expect(manager.handleKeypress({ ctrl: true, name: 'h' })).toBe(false);
    expect(decisions).toBe(1); expect(action).toHaveBeenCalledOnce();
  }));
  it('clear invalidates a pending loader without acquiring a new layer', async () => fixture(async (dir, manager) => {
    const file = join(dir, 'keys.json'); await writeFile(file, JSON.stringify([binding]));
    const pending = manager.loadFromFile(file); manager.clearAll(); await pending;
    expect(manager.getBindings()).toEqual([]);
  }));
  it('last requested reload alone publishes even if another valid read is pending', async () => fixture(async (dir, manager) => {
    const first = join(dir, 'first.json'), second = join(dir, 'second.json');
    await writeFile(first, JSON.stringify([binding])); await writeFile(second, JSON.stringify([{ ...binding, id: 'latest', keys: ['ctrl+j'] }]));
    await Promise.all([manager.loadFromFile(first), manager.loadFromFile(second)]);
    expect(manager.getBindings().some(entry => entry.id === 'help')).toBe(false);
    expect(manager.getBindings().some(entry => entry.id === 'latest')).toBe(true);
  }));
  it('later refused intent preserves only already active data, not an unpublished earlier read', async () => fixture(async (dir, manager) => {
    const file = join(dir, 'keys.json'); await writeFile(file, JSON.stringify([binding]));
    await Promise.all([manager.loadFromFile(file), manager.loadFromFile(join(dir, 'missing'))]);
    expect(manager.getBindings().some(entry => entry.id === 'help')).toBe(false);
  }));
  it.each(['symlink', 'hardlink'] as const)('refuses unsafe %s files without execution', async kind => fixture(async (dir, manager) => {
    const file = join(dir, 'keys.json'), alias = join(dir, 'alias.json'); await writeFile(file, JSON.stringify([binding]));
    if (kind === 'symlink') await symlink(file, alias); else await link(file, alias);
    await manager.loadFromFile(alias); expect(manager.getBindings().some(entry => entry.id === 'help')).toBe(false);
  }));
});
