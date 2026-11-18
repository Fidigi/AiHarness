/** Latest-only prompt-boundary work. Invalidation suppresses completion, not the
 * underlying I/O. Owners must invalidate BEFORE input starts (including shell)
 * and close BEFORE shutdown; isCurrent must check live session/run/stream state.
 * display is synchronous so its status/prompt writes share one guarded boundary. */
export class PromptBoundaryRefresh {
  private generation: object = {};
  private closed = false;

  invalidate(): void { this.generation = {}; }
  close(): void { this.closed = true; this.invalidate(); }

  async refresh<T>(
    sessionId: string,
    prepare: () => Promise<T>,
    isCurrent: (sessionId: string) => boolean,
    display: (value: T) => void,
    onError: (error: unknown) => void,
  ): Promise<void> {
    const generation = this.generation = {};
    const current = (): boolean => !this.closed && generation === this.generation && isCurrent(sessionId);
    if (!current()) return;
    let value: T;
    try { value = await prepare(); }
    catch (error) {
      // Stale failures must not inject diagnostics into a new stream either.
      if (current()) onError(error);
      return;
    }
    if (current()) display(value);
  }
}
