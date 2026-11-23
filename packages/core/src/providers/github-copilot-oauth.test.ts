import { describe, expect, it, vi } from 'vitest';
import { exchangeGitHubCopilotToken, getGitHubCopilotBaseUrl, getGitHubCopilotOAuthConfig } from './github-copilot-oauth.js';

const githubToken = 'disposable-github-grant';
const accessToken = 'tid=disposable;proxy-ep=proxy.individual.githubcopilot.com';
const now = 1_000_000, expiresAt = 2_000_000;
const json = (value: unknown, init?: ResponseInit) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' }, ...init });
const model = (id: string, picker: boolean, state?: string, tools = true) => ({ id, model_picker_enabled: picker, policy: { state }, capabilities: { supports: { tool_calls: tools } } });
function transport(data: unknown, token = accessToken) {
  return vi.fn<typeof fetch>().mockResolvedValueOnce(json({ token, expires_at: expiresAt / 1000 }))
    .mockResolvedValueOnce(json({ data }));
}

describe('GitHub Copilot subscription token exchange', () => {
  it('separates the GitHub device grant, inference exchange and account catalogue', async () => {
    expect(getGitHubCopilotOAuthConfig()).toEqual({ clientId: 'Iv1.b507a08c87ecfe98', scope: 'read:user', responseProfile: 'github-copilot',
      deviceAuthorizationUrl: 'https://github.com/login/device/code', tokenUrl: 'https://github.com/login/oauth/access_token',
      exchangeUrl: 'https://api.github.com/copilot_internal/v2/token' });
    const fetcher = transport([model('allowed', true, 'enabled'), model('disabled', true, 'disabled'), model('hidden', false, 'enabled'), model('no-tools', true, 'enabled', false), model('allowed', true)]);
    expect(await exchangeGitHubCopilotToken(githubToken, { fetcher, now })).toEqual({ accessToken, refreshToken: githubToken,
      expiresAt: expiresAt - 300_000, baseUrl: 'https://api.individual.githubcopilot.com', availableModelIds: ['allowed'] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const headers = { Accept: 'application/json', 'User-Agent': 'GitHubCopilotChat/0.35.0', 'Editor-Version': 'vscode/1.107.0',
      'Editor-Plugin-Version': 'copilot-chat/0.35.0', 'Copilot-Integration-Id': 'vscode-chat' };
    expect(fetcher.mock.calls[0]).toEqual(['https://api.github.com/copilot_internal/v2/token', {
      method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { ...headers, Authorization: `Bearer ${githubToken}` } }]);
    expect(fetcher.mock.calls[1]).toEqual(['https://api.individual.githubcopilot.com/models', {
      method: 'GET', redirect: 'manual', signal: fetcher.mock.calls[0][1]!.signal,
      headers: { ...headers, Authorization: `Bearer ${accessToken}`, 'X-GitHub-Api-Version': '2026-06-01' } }]);
  });

  it.each(['individual', 'business', 'enterprise'])('limits the empty-picker policy fallback to Individual (%s)', async tier => {
    const token = `tid=disposable;proxy-ep=proxy.${tier}.githubcopilot.com`, fetcher = transport([model('enabled', false, 'enabled'), model('unconfigured', false, 'unconfigured'), model('no-tools', false, 'enabled', false)], token);
    const result = await exchangeGitHubCopilotToken(githubToken, { fetcher, now });
    expect(result.availableModelIds).toEqual(tier === 'individual' ? ['enabled'] : []);
    expect(result.baseUrl).toBe(`https://api.${tier}.githubcopilot.com`);
  });

  it('retains picker-visible policy state without implicitly enabling an account model', async () => {
    const fetcher = transport([model('needs-policy', true, 'unconfigured'), model('enabled', false, 'enabled')]);
    expect((await exchangeGitHubCopilotToken(githubToken, { fetcher, now })).availableModelIds).toEqual(['needs-policy']);
    expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });

  it('uses only an explicitly configured enterprise domain when the token has no proxy', async () => {
    const fetcher = transport([model('enterprise-model', true, 'enabled')], 'tid=enterprise');
    const result = await exchangeGitHubCopilotToken(githubToken, { enterpriseDomain: 'Company.GHE.com', fetcher, now });
    expect(result).toMatchObject({ enterpriseDomain: 'company.ghe.com', baseUrl: 'https://copilot-api.company.ghe.com' });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['https://api.company.ghe.com/copilot_internal/v2/token', 'https://copilot-api.company.ghe.com/models']);
  });

  it.each(['https://company.ghe.com', 'user@company.ghe.com', 'localhost', '127.0.0.1', 'company.ghe.com/path', 'company.ghe.com:443'])('rejects invalid explicit enterprise authority: %s', async enterpriseDomain => {
    const fetcher = transport([]);
    await expect(exchangeGitHubCopilotToken(githubToken, { enterpriseDomain, fetcher, now })).rejects.toThrow('Invalid GitHub Copilot enterprise domain.');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['proxy-ep=evil.example', 'proxy-ep=proxy.individual.githubcopilot.com.evil.example', 'proxy-ep=proxy.individual.githubcopilot.com:443',
    'proxy-ep=proxy.individual.githubcopilot.com/path', 'proxy-ep=proxy.individual.githubcopilot.com;proxy-ep=proxy.business.githubcopilot.com'])('refuses token-controlled outbound targets: %s', async token => {
    expect(() => getGitHubCopilotBaseUrl(token)).toThrow('Invalid GitHub Copilot token endpoint.');
    const fetcher = transport([], token);
    await expect(exchangeGitHubCopilotToken(githubToken, { fetcher, now })).rejects.toThrow('GitHub Copilot authentication failed.');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { token: 'secret' }, { token: 'secret', expires_at: 1 }, { token: 'secret', expires_at: Number.MAX_SAFE_INTEGER },
    { token: 'secret\nheader', expires_at: 2000 }])('rejects unusable token responses without disclosing fields (%j)', async body => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(body));
    await expect(exchangeGitHubCopilotToken(githubToken, { fetcher, now })).rejects.toThrow('GitHub Copilot authentication failed.');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([302, 401, 403, 429, 500])('does not follow redirects, retry or expose error bodies (%s)', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('private-access-token', { status }));
    await expect(exchangeGitHubCopilotToken(githubToken, { fetcher, now })).rejects.toThrow('GitHub Copilot authentication failed.');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid catalogue instead of publishing a partial credential', async () => {
    const fetcher = transport(null);
    await expect(exchangeGitHubCopilotToken(githubToken, { fetcher, now })).rejects.toThrow('GitHub Copilot authentication failed.');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('bounds streamed response bytes without trusting Content-Length', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(256 * 1024 + 1)));
    await expect(exchangeGitHubCopilotToken(githubToken, { fetcher, now })).rejects.toThrow('GitHub Copilot authentication failed.');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('cancels even a fetcher which ignores the supplied signal', async () => {
    const controller = new AbortController(), fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const pending = exchangeGitHubCopilotToken(githubToken, { fetcher, signal: controller.signal, now });
    controller.abort('private-abort-reason');
    await expect(pending).rejects.toThrow('GitHub Copilot authentication cancelled.');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refuses an already cancelled operation without network access', async () => {
    const fetcher = transport([]);
    await expect(exchangeGitHubCopilotToken(githubToken, { fetcher, signal: AbortSignal.abort(), now })).rejects.toThrow('GitHub Copilot authentication cancelled.');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
