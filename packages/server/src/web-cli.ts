#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start, stop } from './index.js';
import { parseWebCliArgs, webCliHelp } from './web-cli-options.js';

function browserUrl(hostname: string, port: number): string {
  const browserHost = hostname === '0.0.0.0' || hostname === '::' ? '127.0.0.1' : hostname;
  const formattedHost = browserHost.includes(':') && !browserHost.startsWith('[') ? `[${browserHost}]` : browserHost;
  return `http://${formattedHost}:${port}`;
}

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.once('error', error => {
    console.warn(`[Web] Ouverture automatique impossible : ${error.message}`);
  });
  child.unref();
}

async function runWebCli(): Promise<void> {
  const options = parseWebCliArgs(process.argv.slice(2), process.env);
  if (options.help) {
    process.stdout.write(webCliHelp());
    return;
  }

  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  const webRoot = path.resolve(currentDirectory, '../../web/dist');
  const result = await start({ port: options.port, host: options.hostname, webRoot });
  const url = browserUrl(options.hostname, result.port);
  console.log(`[Web] AiHarness Web disponible sur ${url}`);

  if (!options.noOpen) openBrowser(url);

  const shutdown = (signal: string): void => {
    console.log(`\n[Web] Arrêt (${signal})…`);
    void stop().finally(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

runWebCli().catch(error => {
  console.error(`[Web] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
