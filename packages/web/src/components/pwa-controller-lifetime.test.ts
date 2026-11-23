import { afterEach, describe, expect, it, vi } from 'vitest';

const { effects } = vi.hoisted(() => ({ effects: [] as Array<() => (() => void)> }));
vi.mock('react', () => ({
  useEffect: (effect: () => (() => void)) => effects.push(effect),
  useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, vi.fn()],
}));
vi.mock('../hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
import PwaStatus from './PwaStatus';

afterEach(() => { effects.length = 0; vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

// Existing services/pwa.test.ts covers shell caching and explicit skip-waiting,
// not the component effect's controllerchange callback that reloaded the first claim.
function mount(controlled: boolean) {
  vi.useFakeTimers(); vi.stubEnv('PROD', true);
  const worker = Object.assign(new EventTarget(), { controller: controlled ? {} : null,
    register: vi.fn().mockResolvedValue(Object.assign(new EventTarget(), { waiting: null, update: vi.fn() })) });
  const reload = vi.fn();
  vi.stubGlobal('navigator', { onLine: true, serviceWorker: worker });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { reload }, setInterval, clearInterval }));
  expect(PwaStatus()).toBeNull();
  const dispose = effects[0]!();
  return { worker, reload, dispose };
}

describe('production service worker reading lifetime', () => {
  it('keeps the first installation in place, then reloads once for a genuine replacement', async () => {
    const { worker, reload, dispose } = mount(false);
    await Promise.resolve();
    worker.controller = {}; worker.dispatchEvent(new Event('controllerchange'));
    expect(reload).not.toHaveBeenCalled();
    worker.controller = {}; worker.dispatchEvent(new Event('controllerchange'));
    worker.dispatchEvent(new Event('controllerchange'));
    expect(reload).toHaveBeenCalledTimes(1);
    dispose(); expect(vi.getTimerCount()).toBe(0);
  });
  it('retains update reload for an already controlled page and withdraws its listener on disposal', async () => {
    const { worker, reload, dispose } = mount(true);
    await Promise.resolve();
    worker.dispatchEvent(new Event('controllerchange')); expect(reload).toHaveBeenCalledTimes(1);
    dispose(); worker.dispatchEvent(new Event('controllerchange'));
    expect(reload).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
});
