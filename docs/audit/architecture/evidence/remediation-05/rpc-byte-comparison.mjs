// Identical canonical payload on original/current frozen images; no latency/RSS claim.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
const root = await mkdtemp(path.join(os.tmpdir(), 'rpc-byte-comparison-'));
const originalCwd = process.cwd();
try {
  process.env.HOME = path.join(root, 'home'); process.env.AI_HARNESS_AGENT_DIR = path.join(root, 'agent');
  const cwd = path.join(root, 'work');
  await mkdir(process.env.HOME); await mkdir(process.env.AI_HARNESS_AGENT_DIR); await mkdir(cwd);
  process.chdir(cwd);
  const { runRpcMode } = await import('/app/packages/cli/dist/rpc/rpc-server.js');
  const request = { type: 'get_state', id: 'same-canonical-boundary', padding: '' };
  const desired = 32 * 1024 * 1024 + 1;
  request.padding = 'x'.repeat(desired - Buffer.byteLength(JSON.stringify(request)));
  const payload = JSON.stringify(request);
  assert.equal(Buffer.byteLength(payload), desired);
  let canonicalReply = false, echoedPadding = false, error;
  try {
    await runRpcMode({ cwd, offline: true, noSession: true, noContextFiles: true, noExtensions: true,
      noMcp: true, noSkills: true, noPromptTemplates: true, noTools: true, projectTrust: false,
      input: Readable.from([Buffer.from(payload + '\n')], { objectMode: false }),
      output: record => {
        if (record.id === request.id && record.type === 'response' && record.success === true) canonicalReply = true;
        if (JSON.stringify(record).includes('x'.repeat(128))) echoedPadding = true;
      } });
  } catch (failure) { assert.equal(failure.message, 'RPC_FRAME_TOO_LARGE'); error = failure.message; }
  assert.equal(echoedPadding, false);
  assert.equal(canonicalReply, !error);
  console.log(JSON.stringify({ payloadBytes: desired, command: request.type, canonicalReply, error: error ?? null, echoedPadding,
    limits: 'Framing admission comparison only. Embedded fatal rejection is distinct from the emitted/installed nonzero-exit and held-operation cleanup controls. No RSS/throughput or rollback claim.' }));
} finally { process.chdir(originalCwd); await rm(root, { recursive: true, force: true }); }
