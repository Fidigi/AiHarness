import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const run = promisify(execFile);

it('compiles exported v1 option API declarations and rejects unsupported public types', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-options-types-'));
  const core = fileURLToPath(new URL('../../../core/dist/index.js', import.meta.url));
  try {
    const fixture = path.join(root, 'consumer.mts');
    await writeFile(fixture, `
      import { AI_HARNESS_EXTENSION_API_VERSION, ExtensionRegistry,
        type ExtensionAPI, type ExtensionOption, type ExtensionOptionDescriptor,
        type ExtensionOptionValue } from ${JSON.stringify(core)};
      const option: ExtensionOption = { type: 'string', description: 'Style', completions: ['full'] };
      const descriptor: ExtensionOptionDescriptor = { ...option, name: 'style', extensionId: 'review' };
      const registry = new ExtensionRegistry();
      await registry.load('review', (api: ExtensionAPI) => {
        const version: typeof AI_HARNESS_EXTENSION_API_VERSION = api.version;
        const dispose: () => void = api.registerOption(descriptor.name, option);
        const value: ExtensionOptionValue | undefined = api.getOption('style');
        void version; void dispose; void value;
        // @ts-expect-error only boolean/string are supported
        api.registerOption('count', { type: 'number', description: 'Count' });
        // @ts-expect-error defaults must agree with option type
        api.registerOption('check', { type: 'boolean', description: 'Check', default: 'yes' });
        // @ts-expect-error completion is literal metadata, not executable code
        api.registerOption('style', { type: 'string', description: 'Style', completions: () => ['full'] });
      });
    `);
    const { stderr } = await run(process.execPath, [
      path.resolve('node_modules/typescript/bin/tsc'), '--noEmit', '--strict',
      '--skipLibCheck', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
      '--target', 'ES2022', '--typeRoots', path.resolve('node_modules/@types'), fixture,
    ], { timeout: 30_000 });
    expect(stderr).toBe('');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 40_000);
