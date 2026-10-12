import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../hooks/useI18n';
import { ProviderRenamePanel, type ProviderRenamePanelProps } from './ProviderRenamePanel';

const provider: ProviderRenamePanelProps['provider'] = {
  id: 'acme', name: 'Acme endpoint', baseUrl: 'https://endpoint.invalid/v1', dialect: 'openai-completions',
  headerNames: [], configured: true, modelCount: 1, createdAt: '', updatedAt: '', revision: 'a'.repeat(64),
};
function markup(props: Partial<ProviderRenamePanelProps> = {}) {
  const reconcile = vi.fn();
  const value = renderToStaticMarkup(createElement(I18nProvider, null,
    createElement(ProviderRenamePanel, { provider, reconcile, ...props })));
  expect(reconcile).not.toHaveBeenCalled();
  return value;
}
describe('explicit exclusive-host rename presentation', () => {
  it('is off without actual capability, even with a revision and configured provider', () => {
    expect(markup()).toContain('disabled=""');
    expect(markup()).toContain('server did not provide an active exclusive-host capability');
  });
  it('requires the exact restricted composition metadata', () => {
    expect(markup({ capability: { supported: true, mode: 'disabled', reason: 'unavailable' } })).toContain('disabled=""');
    expect(markup({ capability: { supported: true, mode: 'exclusive-host-single-writer', reason: 'restricted-single-writer' } })).not.toContain('disabled=""');
  });
  it('keeps built-in identities immutable even with active capability metadata', () => {
    expect(markup({ provider: { ...provider, id: 'openai' }, capability: {
      supported: true, mode: 'exclusive-host-single-writer', reason: 'restricted-single-writer',
    } })).toContain('disabled=""');
  });
});
