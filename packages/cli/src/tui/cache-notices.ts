import { getCacheTranscriptNotices, type SessionManager } from '@ai-harness/core';

/** Inert optional presentation; unavailable ancestry omits notices, never guesses or changes warming. */
export async function cliCacheNotices(manager: SessionManager, sessionId: string, enabled = true) {
  if (!enabled) return [];
  return getCacheTranscriptNotices(await manager.getActiveBranchEntries(sessionId).catch(() => [])).slice(-500).map(notice => ({
    ...notice,
    content: [notice.kind === 'cache_warm' ? 'Cache warmed' : 'Cache miss',
      notice.missedTokens === undefined ? '' : `${notice.missedTokens} tokens`,
      notice.costUsd === undefined ? '' : `$${notice.costUsd.toFixed(5)}`,
      notice.modelChanged ? 'model changed' : '',
      notice.idleMinutes === undefined ? '' : `${notice.idleMinutes} idle minutes`,
    ].filter(Boolean).join(' · '),
  }));
}
