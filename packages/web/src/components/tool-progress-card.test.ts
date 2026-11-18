import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup as renderMarkup } from 'react-dom/server';
import { I18nProvider } from '../hooks/useI18n';
import { toolProgressMessages } from './tool-progress-messages';

const renderToStaticMarkup = (node: ReactNode) => renderMarkup(createElement(I18nProvider, null, node));
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ToolProgressCard from './ToolProgressCard';
import ToolProgressBoundary from './ToolProgressBoundary';
import { normalizeToolProgress } from './tool-progress-state';

const value = { version: 1, toolCallId: 'host', toolName: 'arbitrary_custom', sequence: 3, status: 'running',
  durationMs: 1250, truncated: false, omittedUpdates: 0, content: '<img src=x onerror=alert(1)> **not Markdown**',
  details: { usage: { costUsd: 999 }, toolCallId: 'nested', activatedTools: ['hidden'] } };

describe('generic tool progress leaf', () => {
  it('provides feature-local EN/FR copy for every status, disclosure and loading/error state', () => {
    const en = toolProgressMessages('en');
    const fr = toolProgressMessages('fr');
    expect(toolProgressMessages('unknown')).toEqual(en);
    expect(Object.keys(fr)).toEqual(Object.keys(en));
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(fr[key]).not.toEqual(en[key]);
    }
    expect(fr.status).toEqual({ running: 'en cours', completed: 'terminé', failed: 'échec', cancelled: 'annulé' });
    expect(fr.disclaimer).toContain('non vérifiés');
  });
  it('shows real host context/duration and labels inert details without markup or authenticated cost', () => {
    const progress = normalizeToolProgress(value, 'host', 'arbitrary_custom')!;
    const html = renderToStaticMarkup(createElement(ToolProgressCard, { progress }));
    expect(html).toContain('Host duration: 1.25s');
    expect(html).toContain('Tool phase · update 3');
    expect(html).toContain('Tool-reported details (self-reported)');
    expect(html).toContain('not verified usage, cost or permissions');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; **not Markdown**');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<strong>not Markdown');
    expect(html).not.toContain('$999');
    expect(html).not.toContain('autofocus');
    expect(html).toContain('<summary>'); // Native, focusable keyboard disclosure, not a textbox.
    expect(html).not.toContain('contenteditable');
  });
  it('has explicit empty/loading states and rejects old/malformed/unknown metadata before loading', () => {
    const props = { toolCallId: 'host', toolName: 'arbitrary_custom' };
    for (const invalid of [undefined, {}, { ...value, version: 2 }, { ...value, durationMs: Infinity }]) {
      expect(renderToStaticMarkup(createElement(ToolProgressBoundary, { ...props, value: invalid }))).toBe('');
    }
    expect(renderToStaticMarkup(createElement(ToolProgressBoundary, { ...props, value })))
      .toContain('Loading tool progress');
    expect(renderToStaticMarkup(createElement(ToolProgressBoundary, { ...props, value, terminal: true }))).toBe('');
    const progress = normalizeToolProgress({ ...value, content: '', details: null }, 'host', 'arbitrary_custom')!;
    expect(renderToStaticMarkup(createElement(ToolProgressCard, { progress }))).toContain('Waiting for tool progress');
    expect(renderToStaticMarkup(createElement(ToolProgressCard, { progress: { ...progress, status: 'failed' } })))
      .toContain('No progress text reported.');
  });
  it('loads leaf and scoped styles lazily without Core runtime, renderer, store or focus side effects', () => {
    const gate = readFileSync(new URL('./ToolProgressBoundary.tsx', import.meta.url), 'utf8');
    const leaf = readFileSync(new URL('./ToolProgressCard.tsx', import.meta.url), 'utf8');
    const helper = readFileSync(new URL('./tool-progress-state.ts', import.meta.url), 'utf8');
    expect(gate).toContain("lazy(() => import('./ToolProgressCard'))");
    expect(gate).not.toContain('.css');
    expect(leaf).toContain("import './tool-progress-card.css'");
    expect(toolProgressMessages('en').failedLoad).toBe('Progress display could not load. Tool execution is unaffected.');
    for (const source of [gate, leaf, helper]) {
      expect(source).not.toMatch(/dangerouslySetInnerHTML|MarkdownContent|session-store|\.focus\(|autoFocus|Buffer\./u);
      expect(source).not.toMatch(/import \{[^\n]*\} from '@ai-harness\/core'/u);
    }
  });
});
