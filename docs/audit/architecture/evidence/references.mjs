// Static lexical screening, not a semantic unused-export or external-usage proof.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const files = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim().split('\n');
const code = files.filter(f => /\.(ts|tsx|mjs|cjs|js)$/.test(f));
const counts = new Map();
for (const file of code) for (const match of fs.readFileSync(file, 'utf8').matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
  counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
}
const candidates = [];
for (const file of code.filter(f => f.startsWith('packages/') && f.includes('/src/') && !/\.(test|spec)\./.test(f) && !f.includes('/fixtures/'))) {
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(/export\s+(?:async\s+)?(?:function|class|const)\s+([A-Za-z_$][\w$]*)/g)) {
    if (counts.get(match[1]) === 1) candidates.push({ file, line: text.slice(0, match.index).split('\n').length, name: match[1] });
  }
}
const sources = files.filter(f => /^packages\/(core|cli|server|web)\/src\//.test(f) && /\.(ts|tsx)$/.test(f)
  && !f.includes('/fixtures/') && !/\.(test|spec|d)\.(ts|tsx)$/.test(f)).sort();
const digest = createHash('sha256');
for (const file of sources) digest.update(file + '\0' + fs.readFileSync(file, 'utf8') + '\0');
console.log(JSON.stringify({ scope: 'Tracked code identifiers including tests/scripts; comments/strings also count. Public wildcard exports and external/dynamic consumers require separate review.',
  trackedCodeFiles: code.length, sourceFiles: sources.length, sourceDigest: digest.digest('hex'), lexicallySingleExportCandidates: candidates }, null, 2));
