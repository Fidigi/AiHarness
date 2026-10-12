import { describe, expect, it } from 'vitest';
import { quotaDelayMs } from '../e2e/fixtures/api-budget.js';
const observation = (remaining: string, reset: string, reserve = 200) => ({
  headers: { 'ratelimit-remaining': remaining, 'ratelimit-reset': reset }, reserve,
});
describe('real API quota scheduling between browser cases', () => {
  it('does not delay when quota covers the case, including the exact boundary', () => {
    expect(quotaDelayMs([observation('200', '60')], 1000)).toBe(0);
  });
  it('waits through the genuine reset with a small rounding margin, even after 429', () => {
    expect(quotaDelayMs([observation('0', '60')], 1000)).toBe(59_200);
  });
  it('waits once for the latest independent GET/auth window, rather than summing waits', () => {
    expect(quotaDelayMs([observation('20', '60'), observation('30', '65', 60)], 1000)).toBe(64_200);
  });
  it('does not delay for expired windows or hosts with no limiter headers', () => {
    expect(quotaDelayMs([observation('0', '1'), { headers: {}, reserve: 200 }], 2000)).toBe(0);
  });
  it('fails on malformed applicable headers instead of silently disabling scheduling', () => {
    expect(() => quotaDelayMs([observation('NaN', '60')], 1000)).toThrow('Invalid server quota headers');
    expect(() => quotaDelayMs([observation('0', '-1')], 1000)).toThrow('Invalid server quota headers');
  });
});
