import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SessionManager } from '@ai-harness/core';
import {
  resolveStartupSession,
  resolveStartupSessionDirectory,
  type StartupSessionArguments,
} from './startup-session.js';

function args(overrides: Partial<StartupSessionArguments> = {}): StartupSessionArguments {
  return {
    continueSession: false,
    resume: false,
    noSession: false,
    ...overrides,
  };
}

describe('startup session resolution', () => {
  it('creates a new session by default instead of implicitly resuming history', async () => {
    const manager = new SessionManager();
    const existing = await manager.create({ id: 'existing', cwd: '/workspace', title: 'Existing' });

    const selected = await resolveStartupSession({
      sessionManager: manager,
      args: args(),
      cwd: '/workspace',
      workspaceId: 'workspace-1',
      interactive: false,
    });

    expect(selected.id).not.toBe(existing.id);
    expect(selected).toMatchObject({ cwd: '/workspace', workspaceId: 'workspace-1' });
  });

  it('continues the newest session for the current workspace and applies a startup name', async () => {
    const manager = new SessionManager();
    await manager.create({
      id: 'older', cwd: '/workspace', title: 'Older', updatedAt: new Date('2026-01-01T00:00:00Z'),
    });
    await manager.create({
      id: 'other', cwd: '/other', title: 'Other', updatedAt: new Date('2026-01-03T00:00:00Z'),
    });
    await manager.create({
      id: 'newer', cwd: '/workspace', title: 'Newer', updatedAt: new Date('2026-01-02T00:00:00Z'),
    });

    const selected = await resolveStartupSession({
      sessionManager: manager,
      args: args({ continueSession: true, name: 'Renamed' }),
      cwd: '/workspace',
      interactive: false,
    });

    expect(selected).toMatchObject({ id: 'newer', title: 'Renamed' });
  });

  it('opens ID prefixes, creates exact IDs, and delegates interactive resume selection', async () => {
    const manager = new SessionManager();
    const first = await manager.create({ id: 'alpha-session', title: 'Alpha' });
    const second = await manager.create({ id: 'beta-session', title: 'Beta' });

    await expect(resolveStartupSession({
      sessionManager: manager,
      args: args({ session: 'alpha' }),
      cwd: '/workspace',
      interactive: false,
    })).resolves.toMatchObject({ id: first.id });

    await expect(resolveStartupSession({
      sessionManager: manager,
      args: args({ sessionId: 'exact.id-1' }),
      cwd: '/workspace',
      interactive: false,
    })).resolves.toMatchObject({ id: 'exact.id-1' });

    const chooseSession = vi.fn(async () => second);
    await expect(resolveStartupSession({
      sessionManager: manager,
      args: args({ resume: true }),
      cwd: '/workspace',
      interactive: true,
      chooseSession,
    })).resolves.toMatchObject({ id: second.id });
    expect(chooseSession).toHaveBeenCalledOnce();
  });

  it('forks messages and settings without mutating the source session', async () => {
    const manager = new SessionManager();
    const source = await manager.create({
      id: 'source',
      title: 'Source',
      cwd: '/old',
      model: 'model-a',
      thinking: 'high',
    });
    await manager.addMessage(source.id, { role: 'user', content: 'Original' });

    const fork = await resolveStartupSession({
      sessionManager: manager,
      args: args({ fork: source.id, sessionId: 'forked', name: 'Fork name' }),
      cwd: '/workspace',
      workspaceId: 'workspace-1',
      interactive: false,
    });

    expect(fork).toMatchObject({
      id: 'forked',
      title: 'Fork name',
      parentId: source.id,
      cwd: '/workspace',
      model: 'model-a',
      thinking: 'high',
    });
    expect(fork.messages.map(message => message.content)).toEqual(['Original']);
    expect(manager.get(source.id)?.title).toBe('Source');
  });

  it('resolves explicit directories, environment fallback, tilde, and session-file parents', () => {
    expect(resolveStartupSessionDirectory(
      args({ sessionDir: './sessions' }),
      '/workspace',
      {},
      '/home/test',
    )).toBe(path.resolve('/workspace/sessions'));
    expect(resolveStartupSessionDirectory(
      args(),
      '/workspace',
      { AI_HARNESS_SESSIONS_DIR: '~/stored' },
      '/home/test',
    )).toBe(path.resolve('/home/test/stored'));
    expect(resolveStartupSessionDirectory(
      args(),
      '/workspace',
      { PI_CODING_AGENT_SESSION_DIR: '~/pi-sessions', AI_HARNESS_SESSIONS_DIR: '~/legacy' },
      '/home/test',
      './settings-sessions',
    )).toBe(path.resolve('/home/test/pi-sessions'));
    expect(resolveStartupSessionDirectory(
      args(),
      '/workspace',
      {},
      '/home/test',
      './settings-sessions',
    )).toBe(path.resolve('/workspace/settings-sessions'));
    expect(resolveStartupSessionDirectory(
      args({ session: './fixtures/example.jsonl', sessionDir: '/ignored' }),
      '/workspace',
      {},
      '/home/test',
    )).toBe(path.resolve('/workspace/fixtures'));
  });
});
