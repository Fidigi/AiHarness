import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JsonlSessionStore, SessionManager } from '@ai-harness/core';
import { CommandHandler } from '../commands/handler.js';
import type { TerminalUI } from '../tui/terminal-ui.js';
import { DIAGNOSTIC_PRIVACY_WARNING, EXPORT_PRIVACY_WARNING, SHARE_PRIVACY_WARNING } from './privacy-warnings.js';

let root: string, manager: SessionManager, store: JsonlSessionStore;
const registered = 'disposable-registered-privacy-key';
const unknown = 'disposable-unregistered-private-text';
const warnings: string[] = [], output: string[] = [], errors: string[] = [];
function handler(writeWarning: ((message: string) => void) | undefined = message => { warnings.push(message); }) {
  const terminal = { writeOutput: (text: string) => { output.push(text); }, showError: (text: string) => { errors.push(text); } } as unknown as TerminalUI;
  const value = new CommandHandler(manager, store, terminal, undefined, undefined, {
    cwd: root, providers: new Map(), isProjectTrusted: () => true, writeWarning,
    redactText: text => text.replaceAll(registered, '[REDACTED]'),
  });
  value.getContext().currentSessionId = manager.list()[0]!.id;
  return value;
}
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'aih-privacy-notices-'));
  store = new JsonlSessionStore(undefined, false);
  manager = new SessionManager({ store });
  const session = await manager.create({ title: 'private fixture' });
  await manager.addMessage(session.id, { role: 'user', content: unknown });
  warnings.length = 0; output.length = 0; errors.length = 0;
});
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe('value-free privacy warning policy', () => {
  it.each([EXPORT_PRIVACY_WARNING, SHARE_PRIVACY_WARNING, DIAGNOSTIC_PRIVACY_WARNING])('is bounded, inert and honest about unknown secrets: %s', warning => {
    expect(Buffer.byteLength(warning)).toBeLessThanOrEqual(1024);
    expect(warning).not.toMatch(/[\x00-\x1f\x7f-\x9f]/u);
    expect(warning).toMatch(/^Privacy warning:/u);
    expect(warning).toContain('unrecognized secrets'); expect(warning).toContain('Review');
    expect(warning).not.toContain(registered); expect(warning).not.toContain(unknown); expect(warning).not.toContain(root);
  });

  it('warns before the authenticated share request, never including configuration or transcript values', async () => {
    vi.stubEnv('AI_HARNESS_SERVER_URL', 'https://share.example/private-base');
    vi.stubEnv('AI_HARNESS_AUTH_TOKEN', registered);
    const order: string[] = [];
    const fetch = vi.fn(async () => { order.push('request'); expect(warnings).toEqual([SHARE_PRIVACY_WARNING]); return new Response(JSON.stringify({ url: '/share/fixture', expiresInHours: 2 }), { status: 201 }); });
    vi.stubGlobal('fetch', fetch);
    await handler(message => { order.push('warning'); warnings.push(message); }).execute('/share 2');
    expect(order).toEqual(['warning', 'request']); expect(fetch).toHaveBeenCalledTimes(1);
    expect(output.join('')).toContain('/share/fixture'); expect(output.join('')).not.toContain(registered);
    expect(warnings.join('')).not.toContain('private-base'); expect(warnings.join('')).not.toContain(unknown);
  });

  it.each(['0', '-1', '169', '2x', '1 2'])('does not warn or request for a refused share lifetime %s', async ttl => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await handler().execute('/share '+ttl);
    expect(warnings).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });

  it('does not publish a share when the warning sink throws', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await handler(() => { throw new Error('disposable warning failure'); }).execute('/share 2');
    expect(fetch).not.toHaveBeenCalled(); expect(errors).toEqual(['Command failed.']);
  });

  it.each(['json', 'jsonl', 'html', 'markdown'])('warns before writing a private %s export without claiming arbitrary-secret removal', async format => {
    const destination = path.join(root, 'result.'+(format==='markdown'?'md':format));
    await handler(message => { expect(existsSync(destination)).toBe(false); warnings.push(message); }).execute('/export '+format+' '+JSON.stringify(destination));
    expect(warnings).toEqual([EXPORT_PRIVACY_WARNING]); expect(errors).toEqual([]);
    expect(await readFile(destination, 'utf8')).toContain(unknown);
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
    expect(output.join('')).toContain('Exported session');
  });

  it('does not emit a publication notice for an unsupported export format', async () => {
    await handler().execute('/export unsupported result');
    expect(warnings).toEqual([]); expect(output.join('')).toContain('Unsupported format'); expect(existsSync(path.join(root,'result'))).toBe(false);
  });

  it('does not write an export when the warning sink fails', async () => {
    await handler(() => { throw new Error('disposable warning failure'); }).execute('/export json result.json');
    expect(existsSync(path.join(root,'result.json'))).toBe(false); expect(errors).toEqual(['Command failed.']);
  });

  it('keeps a value-free diagnostic warning ahead of the report URL and preserves existing registered-key redaction', async () => {
    const order: string[] = [];
    const value = handler(message => { order.push('warning'); warnings.push(message); });
    await value.execute('/bug '+unknown+' '+registered);
    expect(order).toEqual(['warning']); expect(warnings).toEqual([DIAGNOSTIC_PRIVACY_WARNING]);
    expect(output.join('')).toContain(encodeURIComponent(unknown)); expect(output.join('')).not.toContain(registered);
    expect(output.join('')).toContain(encodeURIComponent('[REDACTED]'));
    expect(warnings.join('')).not.toContain(unknown);
  });

  it('uses the interactive terminal when no separate host warning sink is supplied', async () => {
    // Explicit undefined uses the helper default; clear the context to exercise the actual fallback.
    const value = handler(); value.getContext().writeWarning = undefined;
    await value.execute('/bug example');
    expect(warnings).toEqual([]); expect(output[0]).toContain(DIAGNOSTIC_PRIVACY_WARNING); expect(output[1]).toContain('issues/new');
  });
});
