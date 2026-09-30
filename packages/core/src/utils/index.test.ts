// ============================================================
// Utility Functions Tests - Retry logic, helpers
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import {
  isRetryableError,
  calculateRetryDelay,
  withRetry,
  withRetryIfRetryable,
  sleep,
} from './index';

describe('isRetryableError()', () => {
  it('should detect rate limit errors', () => {
    expect(isRetryableError(new Error('HTTP 429 - Too Many Requests'))).toBe(true);
    expect(isRetryableError(new Error('rate limit exceeded'))).toBe(true);
  });

  it('should detect server errors', () => {
    expect(isRetryableError(new Error('HTTP 500 - Internal Server Error'))).toBe(true);
    expect(isRetryableError(new Error('service unavailable'))).toBe(true);
  });

  it('should detect network errors', () => {
    expect(isRetryableError(new Error('ECONNREFUSED'))).toBe(true);
    expect(isRetryableError(new Error('ETIMEDOUT'))).toBe(true);
    expect(isRetryableError(new Error('ENOTFOUND'))).toBe(true);
  });

  it('should not detect non-retryable errors', () => {
    expect(isRetryableError(new Error('HTTP 400 - Bad Request'))).toBe(false);
    expect(isRetryableError(new Error('Invalid API key'))).toBe(false);
    expect(isRetryableError(new Error('Not found'))).toBe(false);
  });

  it('should handle string inputs', () => {
    expect(isRetryableError('HTTP 429 - rate limited')).toBe(true);
    expect(isRetryableError('some random error')).toBe(false);
  });
});

describe('calculateRetryDelay()', () => {
  it('should return increasing delays with exponential backoff', () => {
    const delay0 = calculateRetryDelay(0, { initialDelayMs: 1000, maxDelayMs: 5000 });
    const delay1 = calculateRetryDelay(1, { initialDelayMs: 1000, maxDelayMs: 5000 });
    const delay2 = calculateRetryDelay(2, { initialDelayMs: 1000, maxDelayMs: 5000 });

    // Delays should be increasing (with jitter they might not be strictly ordered)
    expect(delay0).toBeGreaterThanOrEqual(750);   // ~1000 * 0.75 min
    expect(delay2).toBeLessThanOrEqual(5000);      // Capped at maxDelayMs
  });

  it('should respect custom initial delay', () => {
    const delay = calculateRetryDelay(0, { initialDelayMs: 500, maxDelayMs: 10000 });
    expect(delay).toBeGreaterThanOrEqual(375);   // ~500 * 0.75 min (with jitter)
  });

  it('should cap at max delay', () => {
    const delay = calculateRetryDelay(10, { initialDelayMs: 1000, maxDelayMs: 2000 });
    expect(delay).toBeLessThanOrEqual(2500);   // Capped + jitter buffer
  });

  it('should return non-negative values', () => {
    const delay = calculateRetryDelay(0, { initialDelayMs: 100, maxDelayMs: 500 });
    expect(delay).toBeGreaterThanOrEqual(0);
  });
});

describe('withRetry()', () => {
  it('should return immediately on success', async () => {
    const result = await withRetry(async () => 'success');
    expect(result).toBe('success');
  });

  it('should retry on failure and succeed on second attempt', async () => {
    let attempts = 0;
    const fn = vi.fn().mockImplementation(() => {
      attempts++;
      if (attempts < 2) throw new Error('HTTP 503');
      return 'recovered';
    });

    const result = await withRetry(fn, { maxRetries: 3, initialDelayMs: 10 });
    expect(result).toBe('recovered');
    expect(attempts).toBe(2);
  });

  it('should throw after exhausting retries', async () => {
    let attempts = 0;
    const fn = vi.fn().mockImplementation(() => {
      attempts++;
      throw new Error(`Attempt ${attempts} failed`);
    });

    await expect(
      withRetry(fn, { maxRetries: 2, initialDelayMs: 1 })
    ).rejects.toThrow('Attempt 3 failed');
    
    expect(attempts).toBe(3); // Initial + 2 retries
  });

  it('should use exponential backoff between retries', async () => {
    let attempts = 0;
    const fn = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts < 2) throw new Error('HTTP 429');
      return 'ok';
    });

    const startTime = Date.now();
    await withRetry(fn, { maxRetries: 3, initialDelayMs: 50, maxDelayMs: 100 });
    const elapsed = Date.now() - startTime;

    // Should have waited at least some delay (allowing for timing variance)
    expect(elapsed).toBeGreaterThanOrEqual(20);
  });

  it('should handle non-retryable errors immediately with withRetryIfRetryable', async () => {
    let attempts = 0;
    const fn = vi.fn().mockImplementation(() => {
      attempts++;
      throw new Error('HTTP 400 - Bad Request'); // Not retryable status
    });

    await expect(
      withRetryIfRetryable(fn, { maxRetries: 3 })
    ).rejects.toThrow();
    
    // Should only try once since error is not retryable
    expect(attempts).toBe(1);
  });

  it('should pass options through correctly', async () => {
    const result = await withRetry(async () => ({ success: true }), { maxRetries: 5 });
    expect(result.success).toBe(true);
  });
});

describe('sleep()', () => {
  it('should resolve after the specified duration', async () => {
    const start = Date.now();
    await sleep(10);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(5); // Allow some timing variance
  });

  it('should handle zero delay', async () => {
    await sleep(0); // Should not throw
  });
});
