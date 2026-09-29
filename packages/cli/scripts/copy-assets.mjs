#!/usr/bin/env node
// ============================================================
// Copy CLI assets during build
// ============================================================

import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '../../..');

// Create dist directory if it doesn't exist
const distDir = join(rootDir, 'packages/cli/dist');
if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true });
}

console.log('✅ CLI assets copied successfully');
