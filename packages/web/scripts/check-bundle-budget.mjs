import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dist = resolve(process.cwd(), 'dist');
const assets = join(dist, 'assets');
const limits = {
  entryJsRaw: 500 * 1024,
  entryJsGzip: 150 * 1024,
  eagerGzip: 180 * 1024,
  asyncJsRaw: 1_600 * 1024,
  asyncJsGzip: 500 * 1024,
  cssRaw: 64 * 1024,
};

function size(file) {
  const source = readFileSync(file);
  return { raw: source.byteLength, gzip: gzipSync(source).byteLength };
}

function assertBudget(condition, message) {
  if (!condition) throw new Error(`Bundle budget exceeded: ${message}`);
}

const html = readFileSync(join(dist, 'index.html'), 'utf8');
const entryMatch = html.match(/<script[^>]+src="\/assets\/([^"?]+\.js)"/);
assertBudget(Boolean(entryMatch), 'production entry script was not found');
const entryName = entryMatch[1];
const jsFiles = readdirSync(assets).filter(file => file.endsWith('.js'));
const cssFiles = readdirSync(assets).filter(file => file.endsWith('.css'));
const entrySize = size(join(assets, entryName));
assertBudget(entrySize.raw <= limits.entryJsRaw, `${entryName} is ${entrySize.raw} B raw (limit ${limits.entryJsRaw} B)`);
assertBudget(entrySize.gzip <= limits.entryJsGzip, `${entryName} is ${entrySize.gzip} B gzip (limit ${limits.entryJsGzip} B)`);

for (const file of jsFiles) {
  const measured = size(join(assets, file));
  const rawLimit = file === entryName ? limits.entryJsRaw : limits.asyncJsRaw;
  const gzipLimit = file === entryName ? limits.entryJsGzip : limits.asyncJsGzip;
  assertBudget(measured.raw <= rawLimit, `${file} is ${measured.raw} B raw (limit ${rawLimit} B)`);
  assertBudget(measured.gzip <= gzipLimit, `${file} is ${measured.gzip} B gzip (limit ${gzipLimit} B)`);
}
for (const file of cssFiles) {
  const raw = statSync(join(assets, file)).size;
  assertBudget(raw <= limits.cssRaw, `${file} is ${raw} B raw (limit ${limits.cssRaw} B)`);
}

const eager = new Set([entryName]);
for (const match of html.matchAll(/(?:src|href)="\/assets\/([^"?]+\.(?:js|css))"/g)) eager.add(match[1]);
const pending = [entryName];
while (pending.length) {
  const current = pending.pop();
  const source = readFileSync(join(assets, current), 'utf8');
  for (const match of source.matchAll(/(?:from\s*|import\s*)["']\.\/([^"']+\.js)["']/g)) {
    if (!eager.has(match[1])) {
      eager.add(match[1]);
      pending.push(match[1]);
    }
  }
}
const eagerGzip = [...eager].reduce((total, file) => total + size(join(assets, file)).gzip, 0);
assertBudget(eagerGzip <= limits.eagerGzip, `eager assets are ${eagerGzip} B gzip (limit ${limits.eagerGzip} B)`);

console.log(`Bundle budgets OK: entry ${Math.round(entrySize.gzip / 1024)} KiB gzip; eager ${Math.round(eagerGzip / 1024)} KiB gzip; ${jsFiles.length} JS chunks.`);
