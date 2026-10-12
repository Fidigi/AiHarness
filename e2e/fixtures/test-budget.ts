import { test as base, type APIRequestContext } from '@playwright/test';
import { quotaDelayMs } from './api-budget';
export * from '@playwright/test';

/** Reserve genuine server quota between cases. Keep the production limiter,
 * original assertions/timeouts and zero retries; never mask a 429 within a case.
 * Static hosts and authenticated deployments without anonymous protected reads
 * have no applicable protected-read quota header. */
async function reserveReadBudget(request: APIRequestContext): Promise<void> {
  const observations: Array<{ headers: Record<string, string>; reserve: number }> = [];
  for (const [endpoint, reserve] of [['/api/agent/running', 200], ['/api/auth/status', 60]] as const) {
    const response = await request.get(endpoint);
    observations.push({ headers: response.headers(), reserve });
  }
  const delay = quotaDelayMs(observations, Date.now());
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
}

export const test = base.extend<{ serverReadBudget: void }>({
  serverReadBudget: [async ({ request }, use) => {
    await reserveReadBudget(request);
    await use();
  }, { auto: true, timeout: 70_000 }],
});
