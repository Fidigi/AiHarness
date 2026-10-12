import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../hooks/useI18n';
import WorkspacePanelBoundary from './WorkspacePanelBoundary';
import { workspacePanelMessages } from './workspace-panel-messages';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('workspace pane load boundary', () => {
  it('renders a labelled, cancellable local loading pane before importing', () => {
    const html = renderToStaticMarkup(createElement(I18nProvider, null,
      createElement(WorkspacePanelBoundary, { onRequestClose() {} })));
    expect(html).toContain('aria-label="Workspace explorer"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Loading the file pane…');
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('Cancel</button>');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('file-tree');
  });
  it('owns both actual imports and gates ready/failure on its mount lifetime', () => {
    const gate = source('./WorkspacePanelBoundary.tsx');
    expect(gate).toContain("Promise.all([import('./WorkspacePanel'), import('../workspace-panel.css')])");
    expect(gate).toContain('if (current) setPanel');
    expect(gate).toContain('if (current) setFailed');
    expect(gate).toContain('current = false');
    expect(gate).toContain('window.clearTimeout(timer)');
    expect(gate).toContain("window.removeEventListener('aih-open-file', supersede)");
    expect(gate).toContain('window.location.reload()');
    expect(gate).not.toMatch(/<Suspense|\.focus\(|document\.|session-store|useFocusTrap|autoFocus|AbortController/);
  });
  it('starts only at the existing open-pane call site and resets per workspace/session/navigation', () => {
    const app = source('../App.tsx');
    const entry = source('../index.tsx');
    expect(app).not.toContain("from './components/WorkspacePanel'");
    expect(app).toContain('filesOpen && <WorkspacePanelBoundary');
    expect(app).toContain('&& workspace && filesOpen');
    expect(app).toContain('workspace?.id, workspace?.cwd, activeSessionId, location.key');
    expect(entry).not.toContain('workspace-panel.css');
  });
  it('commits router identity urgently alongside the external workspace/session store', () => {
    const entry = source('../index.tsx');
    expect(entry).toContain('<BrowserRouter useTransitions={false}>');
  });
  it('retires real navigation even when browser history entries reuse a fallback key', () => {
    const app = source('../App.tsx');
    expect(app).toContain('location.key, location.pathname, location.search, location.hash');
  });
  it('keeps fallback styles local and avoids mutating global focus or DOM state', () => {
    const css = source('./workspace-panel-boundary.css');
    expect(css).toContain('.workspace-panel-loading');
    expect(css).not.toMatch(/\.app[\s{.]|body[\s{.]|\.workspace-panel[\s{.]|\.chat/);
  });
  it('warns about unsent text before explicit page-reload retry in both locales', () => {
    const gate = source('./WorkspacePanelBoundary.tsx');
    expect(gate).toContain('<p>{copy.reloadWarning}</p>');
    expect(workspacePanelMessages('en').reloadWarning).toContain('unsent text');
    expect(workspacePanelMessages('fr').reloadWarning).toContain('texte non envoyé');
    for (const locale of ['en', 'fr']) expect(workspacePanelMessages(locale).reloadWarning.length).toBeLessThan(150);
  });
  it('provides bounded bilingual loading and network failure copy without exposing errors', () => {
    for (const locale of ['en', 'fr']) {
      const copy = workspacePanelMessages(locale);
      expect(copy.retry.length).toBeGreaterThan(5);
      expect(copy.loading.length).toBeGreaterThan(10);
      expect(copy.failed.length).toBeLessThan(150);
    }
    expect(workspacePanelMessages('other')).toEqual(workspacePanelMessages('en'));
    expect(workspacePanelMessages('fr')).not.toEqual(workspacePanelMessages('en'));
  });
});
