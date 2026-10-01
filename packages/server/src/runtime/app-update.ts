import { readFileSync } from 'node:fs';

const DEFAULT_RELEASE_API = 'https://api.github.com/repos/Fidigi/AiHarness/releases/latest';
const CACHE_TTL_MS = 6 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 4_000;

export interface AppRelease {
  version: string;
  name: string;
  url: string;
  publishedAt?: string;
  notes?: string;
}

export interface AppUpdateStatus {
  webVersion: string;
  agentVersion: string;
  checkedAt: string;
  available: boolean;
  release?: AppRelease;
  error?: { code: 'disabled' | 'unavailable' | 'invalid-response'; message: string };
}

interface ReleaseApiResponse {
  tag_name?: unknown;
  name?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  body?: unknown;
}

function packageVersion(url: URL): string {
  try {
    const parsed = JSON.parse(readFileSync(url, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function installedVersions(): Pick<AppUpdateStatus, 'webVersion' | 'agentVersion'> {
  return {
    webVersion: packageVersion(new URL('../../../web/package.json', import.meta.url)),
    agentVersion: packageVersion(new URL('../../../core/package.json', import.meta.url)),
  };
}

function parsedVersion(value: string): { parts: [number, number, number]; prerelease?: string } | undefined {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return undefined;
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    ...(match[4] ? { prerelease: match[4] } : {}),
  };
}

/** Compare semantic versions without accepting arbitrary package-manager ranges. */
export function compareVersions(left: string, right: string): number {
  const a = parsedVersion(left);
  const b = parsedVersion(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index++) {
    if (a.parts[index] !== b.parts[index]) return a.parts[index]! > b.parts[index]! ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, 'en', { numeric: true });
}

function releaseUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2_000) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchAppUpdate(input: {
  endpoint: string;
  webVersion: string;
  agentVersion: string;
  fetchImpl?: typeof fetch;
  now?: Date;
  signal?: AbortSignal;
}): Promise<AppUpdateStatus> {
  const checkedAt = (input.now ?? new Date()).toISOString();
  const response = await (input.fetchImpl ?? fetch)(input.endpoint, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `AiHarness/${input.webVersion}`,
    },
    signal: input.signal,
  });
  if (!response.ok) throw new Error(`Release service returned HTTP ${response.status}`);
  const payload = await response.json() as ReleaseApiResponse;
  const version = typeof payload.tag_name === 'string' ? payload.tag_name.replace(/^v/, '') : '';
  const url = releaseUrl(payload.html_url);
  if (!parsedVersion(version) || !url) {
    return {
      webVersion: input.webVersion,
      agentVersion: input.agentVersion,
      checkedAt,
      available: false,
      error: { code: 'invalid-response', message: 'Release metadata is invalid.' },
    };
  }
  return {
    webVersion: input.webVersion,
    agentVersion: input.agentVersion,
    checkedAt,
    available: compareVersions(version, input.webVersion) > 0,
    release: {
      version,
      name: typeof payload.name === 'string' && payload.name.trim()
        ? payload.name.trim().slice(0, 500)
        : `AiHarness ${version}`,
      url,
      ...(typeof payload.published_at === 'string' ? { publishedAt: payload.published_at.slice(0, 100) } : {}),
      ...(typeof payload.body === 'string' && payload.body.trim()
        ? { notes: payload.body.trim().slice(0, 20_000) }
        : {}),
    },
  };
}

let cached: { expiresAt: number; status: AppUpdateStatus } | undefined;
let pending: Promise<AppUpdateStatus> | undefined;

export async function getAppUpdateStatus(force = false): Promise<AppUpdateStatus> {
  const versions = installedVersions();
  const now = Date.now();
  if (process.env.AI_HARNESS_DISABLE_UPDATE_CHECK === '1') {
    return {
      ...versions,
      checkedAt: new Date(now).toISOString(),
      available: false,
      error: { code: 'disabled', message: 'Remote update checks are disabled.' },
    };
  }
  if (!force && cached && cached.expiresAt > now) return cached.status;
  if (!force && pending) return pending;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  pending = fetchAppUpdate({
    endpoint: process.env.AI_HARNESS_UPDATE_CHECK_URL || DEFAULT_RELEASE_API,
    ...versions,
    signal: controller.signal,
  }).catch((error: unknown): AppUpdateStatus => ({
    ...versions,
    checkedAt: new Date().toISOString(),
    available: false,
    error: {
      code: 'unavailable',
      message: error instanceof Error && error.name === 'AbortError'
        ? 'Release check timed out.'
        : 'Release service is temporarily unavailable.',
    },
  })).finally(() => {
    clearTimeout(timer);
    pending = undefined;
  });
  const status = await pending;
  cached = { expiresAt: now + CACHE_TTL_MS, status };
  return status;
}

export function resetAppUpdateCache(): void {
  cached = undefined;
  pending = undefined;
}
