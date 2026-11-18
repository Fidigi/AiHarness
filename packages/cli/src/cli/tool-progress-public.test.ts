import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('exports versioned arbitrary progress declarations with negative consumer checks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-progress-types-'));
  try {
    const core = fileURLToPath(new URL('../../../core/dist/index.js', import.meta.url));
    const fixture = path.join(root, 'consumer.mts');
    await writeFile(fixture, `
      import { TOOL_PROGRESS_VERSION, TOOL_PROGRESS_LIMITS, ExtensionRegistry,
        type ToolProgressInput, type ToolProgressSnapshot, type ExtensionRuntimeContext } from ${JSON.stringify(core)};
      const version: 1 = TOOL_PROGRESS_VERSION;
      const input: ToolProgressInput = { version, content: 'progress', details: { step: 1 } };
      const registry = new ExtensionRegistry();
      await registry.load('worker', api => api.registerTool({ name: 'work', description: 'Work',
        execute: async (_input, context) => {
          const sink: ((input: ToolProgressInput) => Promise<void>) | undefined = context.onProgress;
          await sink?.(input);
          return { content: 'done' };
        } }));
      const display = (snapshot: ToolProgressSnapshot) => snapshot.toolCallId + snapshot.toolName + snapshot.status + snapshot.sequence;
      const report = async (context: ExtensionRuntimeContext) => {
        // @ts-expect-error only the declared progress version is accepted
        await context.onProgress?.({ version: 2, content: 'bad' });
        // @ts-expect-error producer cannot claim outer correlation or terminal authority
        await context.onProgress?.({ version: 1, toolCallId: 'spoof', status: 'completed' });
        // @ts-expect-error detail values must be JSON data, not callbacks
        await context.onProgress?.({ version: 1, details: { execute: () => 'bad' } });
      };
      void display; void report; void TOOL_PROGRESS_LIMITS;
    `);
    const { stderr } = await promisify(execFile)(process.execPath, [path.resolve('node_modules/typescript/bin/tsc'),
      '--noEmit', '--strict', '--skipLibCheck', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
      '--target', 'ES2022', '--typeRoots', path.resolve('node_modules/@types'), fixture], { timeout: 30_000 });
    expect(stderr).toBe('');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 40_000);
