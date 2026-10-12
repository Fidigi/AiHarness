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
}

/** Run all post-initialization cleanup branches without letting one failure block the others. */
export async function cleanupCliEarlyExit(resources: CliEarlyExitResources): Promise<void> {
  try { resources.input?.close(); } catch { /* Continue cleanup. */ }
  try { resources.filteredInput?.dispose(); } catch { /* Continue cleanup. */ }
  try { resources.themeProbe?.close(); } catch { /* Continue cleanup. */ }

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
    if (timeoutMs === 0) await settled;
    else await Promise.race([
      settled,
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    try { resources.jsonOutput?.restore(); } catch { /* Process teardown must continue. */ }
  }
}
