import type { LinkedDirectoryAccess, LinkedDirectoryContent, LinkedDirectoryInventory, LinkedDirectoryListing, LinkedDirectorySelector } from '@ai-harness/core';
import { apiFetch } from './api';

export class LinkedDirectoriesApiError extends Error {
  constructor(readonly code: string) { super('Linked-directory request failed.'); }
}
const BASE = '/api/workspaces/linked-directories';
const MAX_BYTES = 4 * 1024 * 1024;
const fields = (selector: LinkedDirectorySelector) => ({ cwd: selector.cwd, directory: selector.directory, id: selector.id, revision: selector.revision });
async function request<T>(url: string, init: RequestInit, valid: (value: unknown) => boolean): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  init.signal?.addEventListener('abort', abort, { once: true });
  if (init.signal?.aborted) controller.abort();
  const timer = globalThis.setTimeout(abort, 15_000);
  try {
    const response = await apiFetch(url, { ...init, signal: controller.signal, cache: 'no-store' });
    if (!response.body) throw new LinkedDirectoriesApiError('invalid-response');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        bytes += next.value.length;
        if (bytes > MAX_BYTES) { await reader.cancel(); throw new LinkedDirectoriesApiError('invalid-response'); }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    const buffer = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) as unknown;
    if (!response.ok) {
      const code = value && typeof value === 'object' && 'code' in value && typeof value.code === 'string' ? value.code : `http-${response.status}`;
      throw new LinkedDirectoriesApiError(code);
    }
    if (!valid(value)) throw new LinkedDirectoriesApiError('invalid-response');
    return value as T;
  } catch (error) {
    if (error instanceof LinkedDirectoriesApiError) throw error;
    throw new LinkedDirectoriesApiError(controller.signal.aborted ? 'timeout' : 'request-unavailable');
  } finally { globalThis.clearTimeout(timer); init.signal?.removeEventListener('abort', abort); }
}
function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === 'string' && value.length <= 4096; }
function inventory(value: unknown): boolean {
  return object(value) && text(value.cwd) && text(value.directory) && typeof value.revision === 'string' && /^[a-f0-9]{64}$/u.test(value.revision)
    && value.restriction === 'scoped-files-only' && typeof value.truncated === 'boolean'
    && Array.isArray(value.entries) && value.entries.length <= 500
    && value.entries.every(entry => object(entry) && text(entry.name) && typeof entry.id === 'string' && /^[a-f0-9]{64}$/u.test(entry.id)
      && (entry.rawTarget === undefined || text(entry.rawTarget)) && (entry.canonicalTarget === undefined || text(entry.canonicalTarget))
      && typeof entry.allowed === 'boolean' && typeof entry.hiddenCharacters === 'boolean'
      && ['directory', 'unavailable', 'unsafe-target', 'not-directory', 'store-unavailable', 'unsupported-platform'].includes(String(entry.reason)));
}
export function listLinkedDirectories(cwd: string, directory = '.', signal?: AbortSignal): Promise<LinkedDirectoryInventory> {
  return request(`${BASE}?${new URLSearchParams({ cwd, directory })}`, { signal }, inventory);
}
export function setLinkedDirectoryConsent(selector: LinkedDirectorySelector, allowed: boolean, signal?: AbortSignal): Promise<LinkedDirectoryInventory> {
  return request(`${BASE}/consent`, {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...fields(selector), allowed, confirm: true }),
  }, inventory);
}
export function browseLinkedDirectory(selector: LinkedDirectoryAccess, signal?: AbortSignal): Promise<LinkedDirectoryListing> {
  return request(`${BASE}/browse?${new URLSearchParams({ ...fields(selector), path: selector.path })}`, { signal }, value =>
    object(value) && text(value.path) && typeof value.truncated === 'boolean' && Array.isArray(value.entries) && value.entries.length <= 500
      && value.entries.every(entry => object(entry) && text(entry.name) && text(entry.path) && typeof entry.isDirectory === 'boolean' && typeof entry.blocked === 'boolean'));
}
export function readLinkedDirectoryFile(selector: LinkedDirectoryAccess, signal?: AbortSignal): Promise<LinkedDirectoryContent> {
  return request(`${BASE}/content?${new URLSearchParams({ ...fields(selector), path: selector.path })}`, { signal }, value =>
    object(value) && text(value.path) && typeof value.content === 'string' && value.content.length <= 2 * 1024 * 1024
      && typeof value.size === 'number' && value.size >= 0 && value.size <= 2 * 1024 * 1024);
}
