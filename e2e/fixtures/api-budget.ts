export function quotaDelayMs(observations: Array<{ headers: Record<string, string>; reserve: number }>, now: number): number {
  let readyAt = now;
  for (const { headers, reserve } of observations) {
    if (headers['ratelimit-remaining'] === undefined || headers['ratelimit-reset'] === undefined) continue;
    const remaining = Number(headers['ratelimit-remaining']);
    const reset = Number(headers['ratelimit-reset']);
    if (!Number.isFinite(remaining) || !Number.isFinite(reset) || remaining < 0 || reset < 0) {
      throw new Error('Invalid server quota headers');
    }
    if (remaining < reserve) readyAt = Math.max(readyAt, reset * 1000 + 200);
  }
  return Math.max(0, readyAt - now);
}
