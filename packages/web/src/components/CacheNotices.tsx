import type { CacheTranscriptNotice, Message, TokenUsage } from '@ai-harness/core';
import { cacheNoticeText } from './cache-notice-messages';

export function MessageUsage({ message }: { message: Message }) {
  return <>
    <time dateTime={message.timestamp.toISOString()}>{message.timestamp.toLocaleTimeString()}</time>
    {message.model && <span>{message.model}</span>}
    {message.usage && <span title={messageUsageDetails(message.usage)}>{messageUsageSummary(message.usage)}</span>}
  </>;
}

function messageUsageSummary(usage: TokenUsage): string {
  const hasTokens = usage.totalTokens !== undefined || usage.inputTokens !== undefined || usage.outputTokens !== undefined;
  const tokens = usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  return [hasTokens ? `${tokens.toLocaleString()} tokens` : '', usage.costUsd !== undefined ? `$${usage.costUsd.toFixed(4)}` : '']
    .filter(Boolean).join(' · ');
}

function messageUsageDetails(usage: TokenUsage): string {
  return [
    usage.inputTokens !== undefined ? `${usage.inputTokens.toLocaleString()} input` : '',
    usage.outputTokens !== undefined ? `${usage.outputTokens.toLocaleString()} output` : '',
    usage.cacheReadTokens !== undefined ? `${usage.cacheReadTokens.toLocaleString()} cache read` : '',
    usage.cacheWriteTokens !== undefined ? `${usage.cacheWriteTokens.toLocaleString()} cache write` : '',
  ].filter(Boolean).join(' · ');
}

export default function CacheNotices({ notices, messageId, locale }: {
  notices: CacheTranscriptNotice[]; messageId: string; locale: string;
}) {
  return <>{notices.filter(notice => notice.afterEntryId === messageId).map(notice =>
    <aside key={notice.id} className="notice cache-notice" style={{ color: '#eef2fa' }} role="note" data-cache-notice={notice.id}>
      {cacheNoticeText(notice, locale)}
    </aside>)}</>;
}
