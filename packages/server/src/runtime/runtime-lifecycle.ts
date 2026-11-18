export interface RuntimeLifecycleDependencies {
  terminal: { shutdown(): void };
  subagents: { shutdown(): void | Promise<void> };
  mcp: { shutdown(): void | Promise<void> };
  extensions: { shutdown(): void | Promise<void> };
  agents: {
    listRunning(): Array<{ id: string }>;
    stop(id: string): void;
    wait(id: string): Promise<unknown>;
  };
}

/** Build one idempotent, bounded runtime shutdown operation. */
export function createRuntimeCloser(
  dependencies: RuntimeLifecycleDependencies,
  timeoutMs = 5_000,
): () => Promise<void> {
  const boundedTimeout = Number.isSafeInteger(timeoutMs) && timeoutMs >= 0
    ? Math.min(timeoutMs, 30_000)
    : 5_000;
  let closePromise: Promise<void> | undefined;
  return (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      try { dependencies.terminal.shutdown(); } catch { /* Continue shutdown. */ }
      const agentWaits: Promise<unknown>[] = [];
      let running: Array<{ id: string }> = [];
      try { running = dependencies.agents.listRunning().slice(0, 10_000); }
      catch { /* Continue shutdown. */ }
      for (const run of running) {
        try {
          dependencies.agents.stop(run.id);
          agentWaits.push(Promise.resolve().then(() => dependencies.agents.wait(run.id)));
        } catch { /* The run became terminal concurrently. */ }
      }
      const settled = Promise.allSettled([
        Promise.resolve().then(() => dependencies.subagents.shutdown()),
        Promise.resolve().then(() => dependencies.mcp.shutdown()),
        Promise.resolve().then(() => dependencies.extensions.shutdown()),
        ...agentWaits,
      ]).then(() => undefined);
      if (boundedTimeout === 0) {
        await settled;
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          settled,
          new Promise<void>(resolve => { timer = setTimeout(resolve, boundedTimeout); }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    return closePromise;
  };
}
