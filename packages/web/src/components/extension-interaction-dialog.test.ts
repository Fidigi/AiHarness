import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionInteractionSnapshot } from '@ai-harness/core';
import ExtensionInteractionDialog from './ExtensionInteractionDialog';
import type { TranslationFunction } from '../i18n/types';

const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
afterEach(() => vi.unstubAllGlobals());
function render(request: ExtensionInteractionSnapshot) {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  return renderToStaticMarkup(createElement(ExtensionInteractionDialog, {
    request, waitingCount: 2, restoreFocusRef: { current: null }, onResolve: async () => {},
    renderOutput: content => createElement('pre', null, content), t: ((key: string) => key) as TranslationFunction,
  }));
}
const request: ExtensionInteractionSnapshot = { id: 'a', kind: 'input', title: 'Approval', createdAt: '2026-01-01' };

describe('lazy interaction renderer', () => {
  it('keeps native required/autofocus controls and inert plain-text output', () => {
    const html = render({ ...request, message: '<script>unsafe()</script>', output: '<b>plain</b>' });
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('data-autofocus="true"');
    expect(html).toContain('required=""');
    expect(html).toContain('&lt;script&gt;unsafe()&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;plain&lt;/b&gt;');
    expect(html).not.toContain('<script>');
  });
  it('renders only declarative supported schema fields with initial defaults', () => {
    const html = render({ ...request, kind: 'custom', fields: [
      { name: 'text', label: 'Text', type: 'text', required: true },
      { name: 'area', label: 'Area', type: 'textarea' },
      { name: 'check', label: 'Check', type: 'checkbox' },
      { name: 'pick', label: 'Pick', type: 'select', required: true, options: [{ value: 'one', label: 'One' }] },
    ] });
    expect(html).toContain('extension-fields');
    expect(html).toContain('<textarea');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('value="one" selected=""');
  });
  it('owns CSS and focus trapping exclusively inside the mounted lazy renderer', () => {
    const boundary = source('./ExtensionInteractionBoundary.tsx');
    const chat = source('./ChatView.tsx');
    const renderer = source('./ExtensionInteractionDialog.tsx');
    expect(boundary).toContain("import('./ExtensionInteractionDialog')");
    expect(boundary).not.toContain("import './extension-interaction-dialog.css'");
    expect(boundary).toContain('if (mounted) setRenderer');
    expect(boundary).toContain('mounted = false');
    expect(renderer).toContain("import './extension-interaction-dialog.css'");
    expect(renderer).toContain('useFocusTrap(true, dialogRef');
    expect(chat).not.toContain('useFocusTrap');
    expect(chat).not.toContain('function ExtensionInteractionDialog');
    expect(source('../agent.css')).not.toContain('.extension-interaction {');
  });
});

describe('singular accepted-base lifetime policy', () => {
  it('retains every shared dictionary and keeps abort confined to the existing transport', () => {
    expect(source('./ExtensionInteractionBoundary.tsx')).toContain('controller.abort()');
    expect(source('../services/api.ts')).toContain('signal?: AbortSignal');
    expect(source('./ChatView.tsx')).toContain('if (signal.aborted) return');
    expect(source('./ChatView.tsx')).not.toContain('extensionRequests');
    expect(source('./ExtensionInteractionDialog.tsx')).not.toContain("from '../services/api'");
    expect(source('./ExtensionInteractionDialog.tsx')).toContain('pendingSubmit.current');
  });
  it('has truthful bilingual cached-import reload copy', async () => {
    const { interactionLoadingMessages } = await import('./ExtensionInteractionBoundary');
    expect(interactionLoadingMessages('en').warning).toContain('unsent text');
    expect(interactionLoadingMessages('fr').warning).toContain('texte non envoyé');
    expect(source('./ExtensionInteractionBoundary.tsx')).toContain('window.location.reload()');
    expect(source('./ExtensionInteractionBoundary.tsx')).not.toContain('pending = undefined');
  });
  it('retains typed same-ID drafts and resets removed/changed controls', async () => {
    const { interactionDraft } = await import('./ExtensionInteractionDialog');
    const previous: ExtensionInteractionSnapshot = { ...request, kind: 'custom', fields: [
      { name: 'keep', label: 'Keep', type: 'text' },
      { name: 'change', label: 'Change', type: 'text' },
      { name: 'removed', label: 'Removed', type: 'text' },
    ] };
    expect(interactionDraft({ ...previous, fields: [
      { name: 'keep', label: 'Keep', type: 'text' },
      { name: 'change', label: 'Change', type: 'checkbox' },
      { name: 'pick', label: 'Pick', type: 'select', required: true, options: [{ value: 'one', label: 'One' }] },
    ] }, previous, { keep: 'verbatim', change: 'not a boolean', removed: 'private' }))
      .toEqual({ keep: 'verbatim', change: false, pick: 'one' });
  });
});
