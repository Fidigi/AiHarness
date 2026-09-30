#!/usr/bin/env node

import { chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const entryPoint = path.resolve(scriptDirectory, '../dist/web-cli.js');

if (!existsSync(entryPoint)) {
  throw new Error(`Entrée ai-harness-web introuvable : ${entryPoint}`);
}

chmodSync(entryPoint, 0o755);
console.log('✅ ai-harness-web executable prepared');
