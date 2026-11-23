import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('exports optional RPC UI declarations through the genuine emitted Core entry', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-rpc-ui-types-'));
  try {
    const core = fileURLToPath(new URL('../../../core/dist/index.js', import.meta.url));
    const fixture = path.join(root, 'consumer.mts');
    await writeFile(fixture, `
      import { ExtensionRegistry, type ExtensionRuntimeUI, type ExtensionRuntimeContext } from ${JSON.stringify(core)};
      const render = (context: ExtensionRuntimeContext) => {
        const ui: ExtensionRuntimeUI | undefined = context.ui;
        if (ui) {
          const mode: 'rpc' = ui.mode;
          const custom: false = ui.capabilities.custom;
          ui.setStatus('job', 'running');
          ui.setStatus('job');
          ui.setWidget('job', ['plain text']);
          ui.setTitle('Title');
          ui.setEditorText('draft');
          // @ts-expect-error capabilities are immutable
          ui.capabilities.custom = true;
          // @ts-expect-error widget lines must be strings
          ui.setWidget('job', [123]);
          // @ts-expect-error no custom HTML/component API is declared
          ui.mountHtml('<script/>');
          void mode; void custom;
        }
        const request = context.requestInteraction?.({ kind: 'input', title: 'Input' });
        request?.update?.({ kind: 'editor', title: 'Editor', output: 'draft' });
        request?.close?.();
        // @ts-expect-error update cannot replace host timeout authority
        request?.update?.({ kind: 'input', title: 'Input', timeoutMs: 100 });
        return request;
      };
      const registry = new ExtensionRegistry();
      await registry.load('ui', api => {
        api.registerCommand('ui', { description: 'UI', handler: async (_args, context) => { await render(context); } });
        api.registerTool({ name: 'ui_tool', description: 'UI', execute: async (_input, context) => {
          await render(context); return { content: 'done' };
        } });
      });
    `);
    const { stderr } = await promisify(execFile)(process.execPath, [path.resolve('node_modules/typescript/bin/tsc'),
      '--noEmit', '--strict', '--skipLibCheck', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
      '--target', 'ES2022', '--typeRoots', path.resolve('node_modules/@types'), fixture], { timeout: 30_000 });
    expect(stderr).toBe('');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 40_000);
