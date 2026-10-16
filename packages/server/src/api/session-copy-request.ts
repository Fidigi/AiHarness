import type { Request, Response } from 'express';

/** Request-owned cancellation: never stops the source run or rolls back an admitted write. */
export function sessionCopyRequest(req: Request, res: Response): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = (): void => { controller.abort(); };
  const closed = (): void => { if (!res.writableEnded) abort(); };
  req.once('aborted', abort);
  res.once('close', closed);
  if (req.aborted || res.destroyed) abort();
  return {
    signal: controller.signal,
    dispose: () => { req.off('aborted', abort); res.off('close', closed); },
  };
}
