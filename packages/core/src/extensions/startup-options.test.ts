import { describe, expect, it } from 'vitest';
import { AI_HARNESS_EXTENSION_API_VERSION, ExtensionRegistry, type ExtensionAPI, type ExtensionOption } from '../index.js';

describe('owned extension startup options (public API v1)', () => {
  it('exports typed metadata, defaults, owned values and idempotent disposers', async () => {
    const registry = new ExtensionRegistry();
    let first!: ExtensionAPI;
    let second!: ExtensionAPI;
    let dispose!: () => void;
    const option: ExtensionOption = { type: 'string', description: 'Review style', default: 'brief', completions: ['brief', 'full'] };
    await registry.load('one', api => {
      first = api;
      expect(api.version).toBe(AI_HARNESS_EXTENSION_API_VERSION);
      dispose = api.registerOption('review-style', option);
      api.registerOption('review-check', { type: 'boolean', description: 'Check', default: false });
      api.registerOption('constructor', { type: 'string', description: 'Prototype-safe', default: 'safe' });
    });
    await registry.load('two', api => { second = api; });
    expect(first.getOption('review-style')).toBe('brief');
    expect(first.getOption('constructor')).toBe('safe');
    expect(second.getOption('review-style')).toBeUndefined();
    registry.setOptionValues({ 'review-style': 'full', 'review-check': true });
    expect(first.getOption('review-style')).toBe('full');
    expect(first.getOption('review-check')).toBe(true);
    expect(() => registry.setOptionValues({ 'review-check': 'false' })).toThrow(/Invalid/);
    expect(first.getOption('review-style')).toBe('full');
    dispose(); dispose();
    expect(first.getOption('review-style')).toBeUndefined();
    await registry.unload('one');
    expect(registry.getOptions()).toEqual([]);
    expect(() => first.registerOption('stale', { type: 'boolean', description: 'Stale' })).toThrow(/unloaded/);
  });

  it('rejects reserved, malformed, conflicting and oversized metadata atomically', async () => {
    for (const [name, metadata] of [
      ['help', { type: 'boolean', description: 'Hijack' }],
      ['--bad', { type: 'boolean', description: 'Bad' }],
      ['Bad', { type: 'boolean', description: 'Bad' }],
      ['bad', null],
      ['bad', { type: 'number', description: 'Bad' }],
      ['bad', { type: 'boolean', description: '\u001b[2J' }],
      ['bad', { type: 'boolean', description: 'Bad', default: 'false' }],
      ['bad', { type: 'string', description: 'Bad', default: 'x'.repeat(4097) }],
      ['bad', { type: 'string', description: 'x'.repeat(513) }],
      ['bad', { type: 'string', description: 'Bad', completions: Array(65).fill('x') }],
      ['bad', { type: 'boolean', description: 'Bad', completions: ['x'] }],
      ['bad', { type: 'string', description: 'Bad', extra: true }],
    ] as Array<[string, unknown]>) {
      const registry = new ExtensionRegistry();
      await expect(registry.load('bad', api => { api.registerOption(name, metadata as ExtensionOption); })).rejects.toThrow(/Invalid/);
      expect(registry.getOptions()).toEqual([]);
      expect(registry.list()).toEqual([]);
    }
    const registry = new ExtensionRegistry();
    await registry.load('one', api => { api.registerOption('check', { type: 'boolean', description: 'Check' }); });
    await expect(registry.load('two', api => {
      api.registerOption('fresh', { type: 'boolean', description: 'Fresh' });
      api.registerOption('check', { type: 'boolean', description: 'Conflict' });
    })).rejects.toThrow(/already registered/);
    expect(registry.getOptions().map(option => option.name)).toEqual(['check']);
    await expect(registry.load('many', api => {
      for (let n = 0; n < 33; n++) api.registerOption(`flag-${n}`, { type: 'boolean', description: 'Bound' });
    })).rejects.toThrow(/limit/);
    expect(registry.getOptions()).toHaveLength(1);
    const full = new ExtensionRegistry();
    for (let owner = 0; owner < 8; owner++) await full.load(`owner-${owner}`, api => {
      for (let n = 0; n < 32; n++) api.registerOption(`flag-${owner}-${n}`, { type: 'boolean', description: 'Bound' });
    });
    await expect(full.load('overflow', api => {
      api.registerOption('overflow', { type: 'boolean', description: 'Bound' });
    })).rejects.toThrow(/limit/);
    expect(full.getOptions()).toHaveLength(256);
  });

  it('removes values on replacement and restores metadata after a failed generation', async () => {
    const registry = new ExtensionRegistry();
    let api!: ExtensionAPI;
    const factory = (value: ExtensionAPI): void => {
      api = value;
      value.registerOption('owned', { type: 'string', description: 'Owned', default: 'default' });
    };
    await registry.load('one', factory);
    registry.setOptionValues({ owned: 'explicit' });
    await expect(registry.replaceManaged(['one'], [{ id: 'two', factory: candidate => {
      candidate.registerOption('other', { type: 'boolean', description: 'Other' });
      throw new Error('bad');
    } }])).rejects.toThrow('bad');
    expect(registry.getOptions().map(option => option.name)).toEqual(['owned']);
    expect(api.getOption('owned')).toBe('explicit');
    await registry.replaceManaged(['one'], []);
    expect(registry.getOptions()).toEqual([]);
  });
});
