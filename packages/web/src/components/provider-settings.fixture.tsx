// Browser-test entry only; not imported by the application bundle.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider, useI18n } from '../hooks/useI18n';
import { OAuthPastePanel } from './OAuthPastePanel';
import { ProviderRenamePanel } from './ProviderRenamePanel';

function Fixture() {
  const { setLocale } = useI18n();
  const [active, setActive] = useState(false);
  const [operationId, setOperationId] = useState('flow-one');
  const [pastes, setPastes] = useState(0);
  const [cancels, setCancels] = useState(0);
  const [reloads, setReloads] = useState(0);
  return <main>
    <button type="button" onClick={() => setLocale('fr')}>Français</button>
    <button type="button" onClick={() => setLocale('en')}>English</button>
    <section role="dialog" aria-label="Existing dialog" aria-modal="true">
      <label>Existing dialog input<input aria-label="Existing dialog input" /></label>
      <button type="button" onClick={() => setActive(true)}>Start explicit operation</button>
      <button type="button" onClick={() => setOperationId('flow-two')}>Replace operation</button>
    </section>
    <OAuthPastePanel active={active} operationId={operationId} authorizationUrl="https://issuer.example/authorize"
      onPaste={() => setPastes(count => count + 1)} onCancel={() => { setCancels(count => count + 1); setActive(false); }} />
    <output aria-label="Pastes">{pastes}</output><output aria-label="Cancels">{cancels}</output>
    <ProviderRenamePanel provider={{ id: 'acme', name: 'Acme', baseUrl: 'https://provider.invalid/v1', dialect: 'openai-completions',
      headerNames: ['X-Private'], configured: true, modelCount: 1, createdAt: '', updatedAt: '', revision: 'a'.repeat(64) }}
      capability={{ supported: true, mode: 'exclusive-host-single-writer', reason: 'restricted-single-writer' }}
      reconcile={async () => { setReloads(count => count + 1); }} />
    <output aria-label="Canonical reloads">{reloads}</output>
  </main>;
}
createRoot(document.getElementById('root')!).render(<I18nProvider><Fixture /></I18nProvider>);
