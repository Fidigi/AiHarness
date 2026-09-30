// ============================================================
// Utility Functions
// ============================================================

/** Retry configuration interface */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial delay in milliseconds (default: 1000) */
  initialDelayMs?: number;
  /** Maximum delay between retries in milliseconds (default: 10000) */
  maxDelayMs?: number;
  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier?: number;
  /** List of HTTP status codes that should trigger a retry (default: [429, 500, 502, 503, 504]) */
  retryableStatuses?: number[];
}

/** Default retry configuration */
const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
  retryableStatuses: [429, 500, 502, 503, 504],
};

/** Check if an error indicates a retryable condition */
export function isRetryableError(error: Error | unknown): boolean {
  const err = error instanceof Error ? error.message : String(error);
  
  // Network errors are typically retryable
  if (err.includes('ECONNREFUSED') || err.includes('ETIMEDOUT') || 
      err.includes('ENOTFOUND') || err.includes('fetch failed')) {
    return true;
  }
  
  // Rate limiting and server errors
  const statusMatch = err.match(/(?:HTTP|status)\s*(\d{3})/);
  if (statusMatch) {
    const status = parseInt(statusMatch[1]);
    return [429, 500, 502, 503, 504].includes(status);
  }
  
  // Generic retryable error messages
  if (err.includes('rate limit') || err.includes('too many requests') ||
      err.includes('service unavailable') || err.includes('internal server error')) {
    return true;
  }
  
  return false;
}

/** Calculate delay for exponential backoff with jitter */
export function calculateRetryDelay(
  attempt: number,
  options: Partial<RetryOptions> = {},
): number {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options } as Required<RetryOptions>;
  
  // Exponential backoff: initialDelay * multiplier^attempt
  let delay = opts.initialDelayMs * Math.pow(opts.backoffMultiplier, attempt);
  
  // Cap at maxDelay
  delay = Math.min(delay, opts.maxDelayMs);
  
  // Add jitter (±25%) to prevent thundering herd
  const jitter = delay * 0.25 * (Math.random() * 2 - 1);
  delay += jitter;
  
  return Math.max(0, delay);
}

/** Execute a function with retry logic and exponential backoff */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options } as Required<RetryOptions>;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      // Don't retry if we've exhausted all attempts
      if (attempt >= opts.maxRetries) break;
      
      // Check if this error is retryable - only retry on retryable errors
      const delay = calculateRetryDelay(attempt, options);
      console.warn(
        `[withRetry] Attempt ${attempt + 1}/${opts.maxRetries + 1} failed:`,
        lastError.message,
        `\n[withRetry] Retrying in ${(delay / 1000).toFixed(1)}s...`
      );
      
      await sleep(delay);
    }
  }

  throw lastError;
}

/** Execute a function with retry logic, but only on retryable errors */
export async function withRetryIfRetryable<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options } as Required<RetryOptions>;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      lastError = err;
      
      // Don't retry if we've exhausted all attempts
      if (attempt >= opts.maxRetries) break;
      
      // Only retry on retryable errors - otherwise fail immediately
      if (!isRetryableError(err)) {
        console.warn(
          `[withRetryIfRetryable] Non-retryable error:`,
          err.message,
          `\n[withRetryIfRetryable] Failing immediately...`
        );
        throw err;
      }
      
      const delay = calculateRetryDelay(attempt, options);
      console.warn(
        `[withRetryIfRetryable] Attempt ${attempt + 1}/${opts.maxRetries + 1} failed:`,
        err.message,
        `\n[withRetryIfRetryable] Retrying in ${(delay / 1000).toFixed(1)}s...`
      );
      
      await sleep(delay);
    }
  }

  throw lastError;
}

/** Wrap a fetch call with retry logic */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit & {
    retryOptions?: RetryOptions;
  },
  extraOptions?: { retryOptions?: RetryOptions },
): Promise<Response> {
  // Merge retry options from both possible sources (init.retryOptions or extraOptions)
  const retryOptions = init?.retryOptions ?? extraOptions?.retryOptions;
  const fetchOptions: RequestInit = {};

  if (init) {
    for (const key in init) {
      if (key !== 'retryOptions') {
        (fetchOptions as Record<string, unknown>)[key] = (init as Record<string, unknown>)[key];
      }
    }
  }

  return withRetryIfRetryable(async () => {
    let response: Response;
    try {
      response = await fetch(url, fetchOptions);
    } catch (error) {
      // Network errors are always retryable
      throw new Error(`Network error: ${error instanceof Error ? error.message : String(error)}`);
    }
    
    if (!response.ok && retryOptions?.retryableStatuses) {
      const shouldRetry = retryOptions.retryableStatuses.includes(response.status);
      if (shouldRetry) {
        let errorText: string;
        try {
          errorText = await response.text();
        } catch {
          errorText = 'No body';
        }
        throw new Error(`HTTP ${response.status} - ${errorText}`);
      }
    }
    
    return response;
  }, retryOptions);
}

/** Generate a unique ID */
export function generateId(): string {
  return crypto.randomUUID();
}

/** Format a date to readable string */
export function formatDate(date: Date): string {
  return date.toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Truncate text to max length */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

/** Sleep for a given duration */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Deep clone an object */
export function deepClone<T>(obj: T): T {
  return structuredClone(obj);
}

// Re-export event emitter for lifecycle hooks and extensions
export { EventEmitter } from './event-emitter.js';
export type { EventHandler, EventMap } from './event-emitter.js';
