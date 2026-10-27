import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE_COMMIT = '06a466935536f8c9bcacb2d5efc0fc021be1bdff';
export const MANIFEST_SHA256 = 'a4c0a81f2cc4323b81d4c5d3886b343dc226939168f33e8eb731c928a81cfce9';
export const ROWS_SHA256 = '458975f575e8c576c083fff689ce4b8dd3ade1af25745a1f2be14908359a6738';
const FACTORIES_SHA256 = '14f44123613804502d1338f87cd7232e2aed0f7125e9e9ae64d7faae1bb5156d';
export const sha256 = value => createHash('sha256').update(value).digest('hex');

/** Extract identities only. The package catalogue and source factories have separate provenance. */
export function captureReference(dataDirectory, factoryDirectory) {
  const bytes = readFileSync(path.join(dataDirectory, '.manifest.json'));
  assert.equal(sha256(bytes), MANIFEST_SHA256, 'Reference manifest differs from the approved pin');
  const manifest = JSON.parse(bytes);
  assert.equal(manifest.schemaVersion, 6);
  assert.equal(Object.keys(manifest.files).length, 42);
  const files = {}, rows = [], identities = new Set();
  for (const [file, expectedHash] of Object.entries(manifest.files).sort()) {
    assert.match(file, /^[a-z][a-z0-9-]*\.json$/);
    const provider = file.slice(0, -5), content = readFileSync(path.join(dataDirectory, file));
    assert.equal(sha256(content), expectedHash, file);
    const factoryHash = sha256(readFileSync(path.join(factoryDirectory, `${provider}.ts`)));
    files[provider] = { catalogue: expectedHash, factory: factoryHash };
    for (const [api, models] of Object.entries(JSON.parse(content))) {
      for (const [key, model] of Object.entries(models)) {
        assert.equal(model.provider, provider);
        assert.equal(model.api, api);
        assert.ok(['chat', 'classifier', 'image'].includes(model.type));
        assert.equal(key, `${model.type}:${model.id}`);
        const identity = JSON.stringify([provider, model.id, api, model.type]);
        assert.ok(!identities.has(identity), `Duplicate typed identity: ${identity}`);
        identities.add(identity);
        rows.push([provider, model.id, api, model.type, model.input?.includes('image') === true]);
      }
    }
  }
  rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
  const reference = { sourceCommit: SOURCE_COMMIT, cataloguePackage: '@earendil-works/pi-ai@1.2.0',
    manifestSha256: MANIFEST_SHA256, manifestJson: bytes.toString('utf8'), schemaVersion: 6, generatedAt: manifest.generatedAt,
    fields: ['provider', 'model', 'api', 'type', 'declaredImageInput'], files,
    rowsSha256: sha256(JSON.stringify(rows)), rows };
  validateReference(reference);
  return reference;
}

export function validateReference(reference) {
  assert.equal(reference.sourceCommit, SOURCE_COMMIT);
  assert.equal(reference.manifestSha256, MANIFEST_SHA256);
  assert.equal(sha256(reference.manifestJson), MANIFEST_SHA256);
  const manifest = JSON.parse(reference.manifestJson);
  assert.deepEqual(Object.fromEntries(Object.entries(reference.files).map(([id, file]) => [`${id}.json`, file.catalogue])),
    manifest.files);
  assert.equal(sha256(JSON.stringify(Object.fromEntries(Object.entries(reference.files).map(([id, file]) => [id, file.factory])))),
    FACTORIES_SHA256);
  assert.equal(reference.rowsSha256, ROWS_SHA256);
  assert.equal(reference.rows.length, 1649);
  assert.equal(Object.keys(reference.files).length, 42);
  assert.equal(sha256(JSON.stringify(reference.rows)), reference.rowsSha256);
  const counts = { chat: 0, classifier: 0, image: 0 }, identities = new Set();
  for (const [provider, model, api, type, images] of reference.rows) {
    assert.ok(Object.hasOwn(reference.files, provider));
    assert.equal(typeof model, 'string'); assert.equal(typeof api, 'string');
    assert.ok(Object.hasOwn(counts, type)); assert.equal(typeof images, 'boolean');
    const identity = JSON.stringify([provider, model, api, type]);
    assert.ok(!identities.has(identity), `Duplicate typed identity: ${identity}`);
    identities.add(identity); counts[type]++;
  }
  assert.deepEqual(counts, { chat: 1554, classifier: 34, image: 61 });
  return counts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 4, 'Usage: node provider-reference.mjs DATA_DIRECTORY FACTORY_DIRECTORY');
  const reference = captureReference(process.argv[2], process.argv[3]);
  // Keep the derived fixture reviewable: one typed tuple per line, never deduplicated by model ID.
  const { rows, ...header } = reference;
  process.stdout.write(JSON.stringify(header, null, 2).slice(0, -2) + ',\n  "rows": [\n'
    + rows.map(row => `    ${JSON.stringify(row)}`).join(',\n') + '\n  ]\n}\n');
}
