import assert from 'node:assert/strict';
import { readdir, lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { validateBase } from './base-path.mjs';

export async function readArtifact(file, encoding) {
  const before = await lstat(file);
  assert(before.isFile() && before.nlink === 1 && before.size <= 16 * 1024 * 1024, 'Invalid artifact file identity/size');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    assert.equal(opened.dev, before.dev); assert.equal(opened.ino, before.ino);
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    const after = await handle.stat();
    assert(after.nlink === 1 && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs && bytes.length === before.size, 'Artifact changed during read');
    const current = await lstat(file);
    assert.equal(current.dev, before.dev); assert.equal(current.ino, before.ino);
    return encoding ? bytes.toString(encoding) : bytes;
  } finally { await handle.close(); }
}

export async function filesUnder(root) {
  assert.equal(await realpath(root), path.resolve(root), 'Linked artifact root/ancestor');
  const result = [];
  let visited = 0, total = 0;
  async function walk(relative = '', depth = 0) {
    assert(depth <= 24, 'Artifact depth exceeded');
    const directory = path.join(root, relative);
    assert((await lstat(directory)).isDirectory(), 'Artifact directory identity changed');
    assert.equal(await realpath(directory), path.resolve(directory), 'Linked artifact directory');
    for (const name of await readdir(directory)) {
      assert(++visited <= 10000, 'Artifact inventory exceeded');
      const file = path.posix.join(relative, name);
      const stat = await lstat(path.join(root, file));
      assert(!stat.isSymbolicLink(), `Artifact must not contain links: ${file}`);
      if (stat.isDirectory()) await walk(file, depth + 1);
      else {
        assert(stat.isFile() && stat.nlink === 1, `Artifact must contain only singly linked regular files: ${file}`);
        total += stat.size;
        assert(stat.size <= 16 * 1024 * 1024 && total <= 10 * 1024 * 1024, 'Artifact size exceeded');
        result.push(file);
      }
    }
  }
  await walk();
  return result.sort();
}

// Supplemental known-shape check only, NOT complete detection of arbitrary secrets.
// Primary isolation is authored fixtures, no credential inputs, and static-only dependencies.
export function assertNoSecrets(text) {
  for (const pattern of [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/, /\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{20,}/,
    /\bAKIA[A-Z0-9]{16}\b/, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /["'](?:apiKey|access_token|refresh_token|client_secret)["']\s*:\s*["'][^"']{8,}["']/]) {
    assert(!pattern.test(text), 'Credential-shaped value detected in demo artifact.');
  }
}

export async function validateArtifact(root, base) {
  validateBase(base);
  const files = await filesUnder(root);
  assert(files.includes('index.html') && files.includes('sw.js') && files.includes('.nojekyll'));
  const manifest = JSON.parse(await readArtifact(path.join(root, 'demo-manifest.json'), 'utf8'));
  assert.equal(manifest.base, base);
  assert.equal(manifest.synthetic, true);
  assert.deepEqual(manifest.assets, files.filter(file => !['sw.js', '.nojekyll', 'demo-manifest.json'].includes(file)).map(file => base + file));
  const html = await readArtifact(path.join(root, 'index.html'), 'utf8');
  const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]);
  assert(references.length >= 3);
  for (const reference of references) {
    assert(reference.startsWith(base) && files.includes(reference.slice(base.length)), `Unresolved or off-base asset ${reference}`);
  }
  const jsFiles = files.filter(file => file.endsWith('.js') && file !== 'sw.js');
  const entry = references.find(file => file.endsWith('.js')).slice(base.length);
  const eager = new Set(references.filter(file => /\.(?:js|css)$/.test(file)).map(file => file.slice(base.length)));
  const pending = [entry];
  while (pending.length) {
    const source = await readArtifact(path.join(root, pending.pop()), 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*)["']\.\/([^"']+\.js)["']/g)) {
      const file = `assets/${match[1]}`;
      assert(files.includes(file), `Unresolved or escaping import ${file}`);
      if (!eager.has(file)) { eager.add(file); pending.push(file); }
    }
  }
  let total = 0;
  let eagerGzip = 0;
  let entryGzip = 0;
  for (const file of files) {
    assert(!/(?:^|\/)(?:\.env.*|credentials.*|sessions.*\.jsonl)$/.test(file), `Private filename ${file}`);
    const data = await readArtifact(path.join(root, file));
    total += data.length;
    if (/\.(?:js|css|html|json|svg)$/.test(file)) assertNoSecrets(data.toString('utf8'));
    const gz = gzipSync(data).length;
    if (file === entry) { entryGzip = gz; assert(data.length <= 504 * 1024 && gz <= 150 * 1024, 'Entry exceeds existing Web limits'); }
    else if (jsFiles.includes(file)) assert(data.length <= 1600 * 1024 && gz <= 500 * 1024, `Async JS exceeds existing Web limits: ${file}`);
    if (file.endsWith('.css')) assert(data.length <= 64 * 1024, `CSS exceeds existing Web limit: ${file}`);
    if (eager.has(file)) eagerGzip += gz;
  }
  assert(eagerGzip <= 180 * 1024, 'Eager assets exceed existing Web limit');
  assert(total <= 10 * 1024 * 1024, 'Offline artifact exceeds 10 MiB');
  assert(!html.includes('src="/assets/') || base === '/', 'Root-relative entry is not nested-base safe');
  console.log(`Demo artifact OK: ${base}, ${files.length} files, entry ${Math.round(entryGzip / 1024)} KiB / eager ${Math.round(eagerGzip / 1024)} KiB gzip, ${Math.round(total / 1024)} KiB offline.`);
  return manifest;
}
