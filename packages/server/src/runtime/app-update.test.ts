import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compareVersions,
  fetchAppUpdate,
  getAppUpdateStatus,
  resetAppUpdateCache,
} from './app-update';

afterEach(() => {
  resetAppUpdateCache();
  vi.unstubAllEnvs();
});

describe('application update status', () => {
  it('compares stable and prerelease semantic versions', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1);
    expect(compareVersions('v1.0.0', '1.0.0-beta.2')).toBe(1);
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBeLessThan(0);
    expect(compareVersions('invalid', '1.0.0')).toBe(0);
  });

  it('normalizes bounded release metadata and detects an available version', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      tag_name: 'v0.2.0',
      name: 'AiHarness 0.2',
      html_url: 'https://github.com/Fidigi/AiHarness/releases/tag/v0.2.0',
      published_at: '2026-10-01T00:00:00.000Z',
      body: 'Release notes',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await expect(fetchAppUpdate({
      endpoint: 'https://example.test/latest',
      webVersion: '0.1.0',
      agentVersion: '0.1.0',
      fetchImpl: fetchImpl as typeof fetch,
      now: new Date('2026-10-01T12:00:00.000Z'),
    })).resolves.toMatchObject({
      webVersion: '0.1.0', agentVersion: '0.1.0', checkedAt: '2026-10-01T12:00:00.000Z',
      available: true,
      release: { version: '0.2.0', name: 'AiHarness 0.2', notes: 'Release notes' },
    });
  });

  it('rejects unsafe release links and supports an inspectable disabled mode', async () => {
    const invalid = await fetchAppUpdate({
      endpoint: 'https://example.test/latest',
      webVersion: '0.1.0',
      agentVersion: '0.1.0',
      fetchImpl: async () => new Response(JSON.stringify({
        tag_name: 'v9.0.0', html_url: 'javascript:alert(1)',
      }), { status: 200 }),
    });
    expect(invalid).toMatchObject({ available: false, error: { code: 'invalid-response' } });

    vi.stubEnv('AI_HARNESS_DISABLE_UPDATE_CHECK', '1');
    await expect(getAppUpdateStatus()).resolves.toMatchObject({
      webVersion: '0.1.0', agentVersion: '0.1.0', available: false,
      error: { code: 'disabled' },
    });
  });
});
