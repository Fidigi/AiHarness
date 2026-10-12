import type { CodemodeCall, CodemodeDetails } from '@ai-harness/core';
import { useI18n } from '../hooks/useI18n';
import './codemode-card.css';

function cost(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `$${value.toFixed(6)}` : undefined;
}
/** Plain text only, bounded visible call list; binary model results never become markup. */
export function CodemodeCard({ code, output, calls = [], details, running = false }: {
  code?: string; output?: string; calls?: CodemodeCall[]; details?: CodemodeDetails; running?: boolean;
}) {
  const { t } = useI18n();
  const visible = calls.slice(0, 12);
  return <section className={`codemode-card${running ? ' codemode-card-running' : ''}`} tabIndex={running ? 0 : undefined} aria-label={t('chat.codemode.title')}>
    <header><strong>{t('chat.codemode.title')}</strong>
      <span>{running ? t('chat.codemode.running') : details ? `${details.durationMs} ms` : ''}</span>
      {details && <span>{t('session.cost')}: {details.costComplete ? cost(details.usage?.costUsd) ?? t('chat.codemode.unknownCost')
        : `${cost(details.usage?.costUsd) ? `${cost(details.usage?.costUsd)} + ` : ''}${t('chat.codemode.unknownCost')}`}</span>}
    </header>
    {code && <details><summary>{t('chat.codemode.script')}</summary><pre>{code.slice(0, 65_536)}</pre></details>}
    {visible.length > 0 && <ol tabIndex={0} aria-label={t('chat.codemode.calls')}>
      {visible.map(call => <li key={call.id} data-call-id={call.id}>
        <span className="codemode-call-name">{call.name}</span><span>{t(`chat.codemode.${call.state}`)}</span>
        {call.durationMs !== undefined && <small>{call.durationMs} ms</small>}
        {cost(call.usage?.costUsd) && <small>{cost(call.usage?.costUsd)}</small>}
      </li>)}
    </ol>}
    {calls.length > visible.length && <p>{t('chat.codemode.omitted', { count: calls.length - visible.length })}</p>}
    {output !== undefined && <details open><summary>{t('chat.codemode.output')}</summary>
      <pre>{output.slice(0, 8_000)}</pre>
      {output.length > 8_000 && <details><summary>{t('chat.codemode.fullOutput')}</summary><pre>{output.slice(0, 100_000)}</pre></details>}
    </details>}
  </section>;
}
