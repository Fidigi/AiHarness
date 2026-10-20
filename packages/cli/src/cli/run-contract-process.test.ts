import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import os from 'node:os';
import { expect, it } from 'vitest';

const probe = fileURLToPath(new URL('./fixtures/run-contract-probe.mjs', import.meta.url));
const check = async (args: string[]) => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [probe, ...args], {
    cwd: os.tmpdir(), timeout: 25_000, maxBuffer: 2_000_000,
  });
  expect(stderr).toBe(''); expect(stdout.trim()).toBe('RUN_CONTRACT_OK');
};
for (const mode of ['print', 'json', 'rpc', 'sdk']) for (const scenario of ['tools', 'overflow', 'length']) {
  it(`${mode} executes the real ${scenario} contract with durable readback`, () => check([mode, scenario]), 28_000);
}
for (const mode of ['rpc', 'sdk', 'regular', 'fullscreen']) for (const steering of ['all', 'one-at-a-time']) for (const followUp of ['all', 'one-at-a-time']) {
  it(`${mode} delivers steering=${steering}, follow-up=${followUp} through the actual host`, () => check([mode, 'queues', steering, followUp]), 28_000);
}
