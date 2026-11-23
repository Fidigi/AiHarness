import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonlSessionStore, SessionManager } from './session-manager.js';
import type { Session, ShellCommandRecord } from '../types/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function seed(durable: boolean, status: ShellCommandRecord['status'] = 'completed') {
  const root = durable ? await mkdtemp(path.join(os.tmpdir(), 'aih-clone-prefix-')) : undefined;
  if (root) roots.push(root);
  const store = root ? new JsonlSessionStore(root) : undefined;
  const manager = new SessionManager({ store });
  const session = await manager.create({
    title: 'Source', cwd: '/workspace', autoCompaction: false,
    messages: [
      { id: 'question', role: 'user', content: 'Inspect', timestamp: new Date(1_000) },
      { id: 'answer', role: 'assistant', content: 'Result', timestamp: new Date(2_000), parentMessageId: 'command-second' },
      { id: 'later', role: 'user', content: 'Not in the prefix', timestamp: new Date(3_000), parentMessageId: 'answer' },
    ],
    commands: [
      { id: 'command-first', command: 'private-inspection', cwd: '/workspace', status,
        timestamp: new Date(10_000), parentEntryId: 'question', output: 'Excluded output', excludedFromContext: true },
      { id: 'command-second', command: 'pwd', cwd: '/workspace', status: 'completed',
        timestamp: new Date(11_000), parentEntryId: 'command-first', output: '/workspace', exitCode: 0 },
      { id: 'command-later', command: 'later-operation', cwd: '/workspace', status: 'completed',
        timestamp: new Date(500), parentEntryId: 'later', output: 'Later output' },
      { id: 'command-unlinked', command: 'unlinked-operation', cwd: '/workspace', status: 'completed',
        timestamp: new Date(400), output: 'Unlinked output' },
    ],
    activeLeafId: 'command-later', metadata: { custom: { nested: 'source' } },
  });
  const bytes = () => root ? readFile(path.join(root, `${session.id}.jsonl`)) : undefined;
  return { manager, store, session, bytes };
}

function expectPrefix(copy: Session, source: Session) {
  expect(copy.parentId).toBeUndefined();
  expect(copy.branchId).toBeUndefined();
  expect(copy.metadata?.clonedFromSessionId).toBe(source.id);
  expect(copy.messages.map(message => message.content)).toEqual(['Inspect', 'Result']);
  expect(copy.commands?.map(command => command.command)).toEqual(['private-inspection', 'pwd']);
  const [first, second] = copy.commands!;
  expect(first!.parentEntryId).toBe(copy.messages[0]!.id);
  expect(second!.parentEntryId).toBe(first!.id);
  expect(copy.messages[1]!.parentMessageId).toBe(second!.id);
  expect(copy.activeLeafId).toBe(copy.messages[1]!.id);
  expect(first).toMatchObject({ excludedFromContext: true, output: 'Excluded output' });
  const sourceIds = new Set([...source.messages, ...source.commands ?? []].map(entry => entry.id));
  expect([...copy.messages, ...copy.commands!].every(entry => !sourceIds.has(entry.id))).toBe(true);
}

describe.each([false, true])('clone prefix (durable=%s)', durable => {
  it.each([1, 'answer'])('remaps required command ancestry for target %s without copying later or unlinked commands', async target => {
    const fixture = await seed(durable);
    const source = structuredClone(fixture.session);
    const before = await fixture.bytes();
    const copy = await fixture.manager.cloneSession(source.id, 'Prefix', target);
    expect(copy).not.toBeNull();
    expectPrefix(copy!, source);
    const context = fixture.manager.getEffectiveContext(copy!.id);
    expect(context.map(entry => entry.type === 'message' ? entry.content : '')).toEqual([
      'Inspect', '[Shell command]\n$ pwd\n/workspace\n[exit 0]', 'Result',
    ]);
    expect(fixture.session).toEqual(source);
    expect(await fixture.bytes()).toEqual(before);
    if (fixture.store) expectPrefix((await fixture.store.loadSession(copy!.id))!, source);
    else expect((await fixture.manager.getRawEntries(copy!.id)).filter(entry => entry.type === 'command')).toHaveLength(2);
    await fixture.manager.addMessage(copy!.id, { role: 'user', content: 'Clone only' });
    copy!.commands![0]!.output = 'Clone edit';
    expect(fixture.session).toEqual(source);
    expect(await fixture.bytes()).toEqual(before);
  });

  it('refuses a running required ancestor even when its timestamp is ahead of the selected message', async () => {
    const fixture = await seed(durable, 'running');
    const before = await fixture.bytes();
    const count = fixture.manager.list().length;
    expect(await fixture.manager.cloneSession(fixture.session.id, undefined, 'answer')).toBeNull();
    expect(fixture.manager.list()).toHaveLength(count);
    expect(await fixture.bytes()).toEqual(before);
    if (fixture.store) expect(await fixture.store.listSessionIds()).toEqual([fixture.session.id]);
  });

  it('retains full-clone command copying, remapping and source independence', async () => {
    const fixture = await seed(durable);
    const source = structuredClone(fixture.session);
    const copy = await fixture.manager.cloneSession(source.id);
    expect(copy!.commands?.map(command => command.command)).toEqual(source.commands?.map(command => command.command));
    expect(copy!.commands![2]!.parentEntryId).toBe(copy!.messages[2]!.id);
    expect(copy!.activeLeafId).toBe(copy!.commands![2]!.id);
    expect(copy!.commands![3]!.parentEntryId).toBeUndefined();
    expect(fixture.session).toEqual(source);
  });

  it('retains the existing conservative timestamp-based running-command refusal', async () => {
    const fixture = await seed(durable);
    await fixture.manager.addCommand(fixture.session.id, {
      command: 'backdated pending', cwd: '/workspace', status: 'running', timestamp: new Date(1_500),
    });
    const count = fixture.manager.list().length;
    expect(await fixture.manager.cloneSession(fixture.session.id, undefined, 'answer')).toBeNull();
    expect(fixture.manager.list()).toHaveLength(count);
  });
});
