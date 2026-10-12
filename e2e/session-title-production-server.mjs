import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os'; import path from 'node:path';
import { start, stop } from '../packages/server/dist/index.js';
import { createRuntimeServices } from '../packages/server/dist/runtime/services.js';
const root = await mkdtemp(path.join(os.tmpdir(), 'aih-title-production-'));
const cwd = path.join(root, 'workspace'); await mkdir(cwd);
let services;
const server = await start({ port: 3099, host: '127.0.0.1', dataDir: path.join(root, 'data'),
  webRoot: path.resolve('packages/web/dist'), allowedRoots: [cwd], defaultCwd: cwd,
  runtimeServicesFactory: async (proxy, options) => (services = await createRuntimeServices(proxy, options)),
});
await services.trustManager.trust(cwd);
// Real registered command context, session metadata writer and session-event producer.
await services.extensionRegistry.load('metadata-retitle', api => {
  api.registerCommand('metadata_retitle', { description: 'Canonical metadata refresh', handler: async (_, context) => {
    await context.sessionManager.update(context.currentSessionId, { title: 'Real canonical metadata title' });
    services.agentRuntime.publishSessionEvent(context.currentSessionId, 'compaction.completed', { automatic: false });
    context.notify('REAL METADATA PRODUCER NOTICE');
    return '';
  } });
});
await writeFile('.session-title-production.json', JSON.stringify({ cwd }));
process.once('SIGTERM', async () => { await stop(); await rm(root, { recursive: true, force: true }); process.exit(0); });
