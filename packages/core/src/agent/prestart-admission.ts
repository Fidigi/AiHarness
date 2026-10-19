import { AgentAbortError } from './tool-loop.js';

/** Withdraw unpublished startup work without claiming to terminate privileged callbacks. */
export function awaitAgentAdmission<T>(work: () => T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new AgentAbortError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (done: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      done();
    };
    const abort = (): void => finish(() => reject(new AgentAbortError()));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try {
      // Invoke only after installing cancellation; still observe a late rejection.
      Promise.resolve(work()).then(
        value => signal.aborted ? abort() : finish(() => resolve(value)),
        error => signal.aborted ? abort() : finish(() => reject(error)),
      );
    } catch (error) {
      if (signal.aborted) abort();
      else finish(() => reject(error));
    }
  });
}
