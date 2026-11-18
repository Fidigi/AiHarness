import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const ROWS_SHA256 = '40dec0dc4c26b846f5ee0d6958ce0fe3af0c12afd7d1c9fea06e14079e0e29c9';
export const sha256 = value => createHash('sha256').update(value).digest('hex');

/** Validate the frozen native metadata/admission selection, independently of live discovery. */
export function validateReference(reference) {
  assert.equal(reference.schema, 'native-provider-coverage-selection-v1');
  assert.equal(reference.sourceCommit, '06a466935536f8c9bcacb2d5efc0fc021be1bdff');
  assert.equal(sha256(JSON.stringify(reference.files)), '62df7f05b82bd09750af1a0b13a5e65c9281ae38e16f15b83e9fc9aec8b2c63c');
  assert.deepEqual(reference.fields, ['provider', 'model', 'api', 'type', 'declaredImageInput']);
  assert.equal(reference.rowsSha256, ROWS_SHA256);
  assert.equal(reference.rows.length, 1620);
  assert.equal(sha256(JSON.stringify(reference.rows)), reference.rowsSha256);
  const counts = { chat: 0, classifier: 0, image: 0 }, identities = new Set(), providers = new Set();
  for (const row of reference.rows) {
    assert.equal(row.length, 5);
    const [provider, model, api, type, images] = row;
    assert.equal(typeof provider, 'string'); assert.ok(Object.hasOwn(reference.files, provider));
    assert.equal(typeof model, 'string'); assert.equal(typeof api, 'string');
    assert.ok(Object.hasOwn(counts, type)); assert.equal(typeof images, 'boolean');
    const identity = JSON.stringify([provider, model, api, type]);
    assert.ok(!identities.has(identity), `Duplicate typed identity: ${identity}`);
    identities.add(identity); providers.add(provider); counts[type]++;
  }
  assert.equal(providers.size, 41);
  assert.deepEqual(counts, { chat: 1525, classifier: 34, image: 61 });
  return counts;
}
