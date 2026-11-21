import assert from 'node:assert/strict';
import test from 'node:test';
import { commandStatus, moduleSpoke } from './evidence.mjs';

const delivered = 'Command sent to output module: |<speak><mark name="0"/>Keep editing</speak>|';
test('reader evidence requires the actual utterance and subsequent module acceptance', () => {
  assert.equal(moduleSpoke(`${delivered}\n200 OK SPEAKING`, 'Keep editing'), true);
  for (const log of ['Queueing message |<speak>Keep editing</speak> 200 OK SPEAKING',
    delivered, `200 OK SPEAKING\n${delivered}`,
    `${delivered}\nCommand sent to output module: |<speak>Other</speak>\n200 OK SPEAKING`]) {
    assert.equal(moduleSpoke(log, 'Keep editing'), false);
  }
});
test('a native termination is never success even if a reporter already printed passes', () => {
  assert.equal(commandStatus({ code: 0, signal: null }), 0);
  assert.equal(commandStatus({ code: 139, signal: null }), 139);
  assert.equal(commandStatus({ code: null, signal: 'SIGSEGV' }), 1);
});
