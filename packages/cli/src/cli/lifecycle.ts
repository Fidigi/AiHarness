import { retainAgentWork } from '@ai-harness/core';

export interface CliCloseable {
  close(): void;
}

export interface CliDisposable {
  dispose(): void;
}

export interface CliExtensionShutdown {
  shutdown(): void | Promise<void>;
}

export interface CliJsonOutputLifecycle {
  flush(): void | Promise<void>;
  restore(): void;
}

export interface CliEarlyExitResources {
  input?: CliCloseable;
  filteredInput?: CliDisposable;
  themeProbe?: CliCloseable;
  extensions?: CliExtensionShutdown;
  jsonOutput?: CliJsonOutputLifecycle;
  closeNetwork?: () => void | Promise<void>;
  additional?: readonly (() => void | Promise<void>)[];
  timeoutMs?: number;
  /** Active run owners must join cleanup and surface failure, not time out into success. */
  requireSettlement?: boolean;
}

/** Run all post-initialization cleanup branches without letting one failure block the others. */
export async function cleanupCliEarlyExit(resources: CliEarlyExitResources): Promise<void> {
  const releaseWork = resources.requireSettlement ? retainAgentWork() : () => undefined;
  const failures: unknown[] = [];
  try { resources.input?.close(); } catch (error) { failures.push(error); }
  try { resources.filteredInput?.dispose(); } catch (error) { failures.push(error); }
  try { resources.themeProbe?.close(); } catch (error) { failures.push(error); }

  const settled = Promise.allSettled([
    Promise.resolve().then(() => resources.extensions?.shutdown()),
    Promise.resolve().then(() => resources.closeNetwork?.()),
    Promise.resolve().then(() => resources.jsonOutput?.flush()),
    ...(resources.additional ?? []).map(operation => Promise.resolve().then(operation)),
  ]);
  const requestedTimeout = resources.timeoutMs ?? 5_000;
  const timeoutMs = Number.isSafeInteger(requestedTimeout) && requestedTimeout >= 0
    ? Math.min(requestedTimeout, 30_000)
    : 5_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (resources.requireSettlement) {
      if (timeoutMs > 0) {
        timer = setTimeout(() => failures.push(new Error('CLI cleanup deadline exceeded.')), timeoutMs);
        timer.unref?.();
      }
      for (const result of await settled) if (result.status === 'rejected') failures.push(result.reason);
      if (failures.length) throw new AggregateError(failures, 'CLI owned cleanup failed.');
    } else if (timeoutMs === 0) await settled;
    else await Promise.race([
      settled,
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    try {
      try { resources.jsonOutput?.restore(); } catch (error) {
        if (resources.requireSettlement) throw new AggregateError([...failures, error], 'CLI owned cleanup failed.');
      }
    } finally { releaseWork(); }
  }
}
