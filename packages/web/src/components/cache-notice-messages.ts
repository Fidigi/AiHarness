import type { CacheTranscriptNotice } from '@ai-harness/core';

export function cacheNoticeMessages(locale: string) {
  return locale.startsWith('fr') ? {
    title: 'Cache des prompts', label: 'Afficher les notices de cache (global)',
    help: 'Présentation uniquement. Masquer les notices ne désactive pas le réchauffement potentiellement facturable.',
    warm: 'Cache réchauffé', miss: 'Cache manqué', tokens: 'tokens', changed: 'modèle changé', idle: 'min d’inactivité',
  } : {
    title: 'Prompt cache', label: 'Show cache notices (global)',
    help: 'Presentation only. Hiding notices does not disable potentially billable cache warming.',
    warm: 'Cache warmed', miss: 'Cache miss', tokens: 'tokens', changed: 'model changed', idle: 'idle minutes',
  };
}

export function cacheNoticeText(notice: CacheTranscriptNotice, locale: string): string {
  const text = cacheNoticeMessages(locale);
  return [notice.kind === 'cache_warm' ? text.warm : text.miss,
    notice.missedTokens === undefined ? '' : `${notice.missedTokens.toLocaleString(locale)} ${text.tokens}`,
    notice.costUsd === undefined ? '' : `$${notice.costUsd.toFixed(5)}`,
    notice.modelChanged ? text.changed : '',
    notice.idleMinutes === undefined ? '' : `${notice.idleMinutes} ${text.idle}`,
  ].filter(Boolean).join(' · ');
}
