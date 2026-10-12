import type { AgentRunSnapshot } from '@ai-harness/core';
import { orderedExtensionRequests } from './api.js';

/** Recent same-ID replay suppression; older transports remain sequence/epoch gated. */
class RecentClosedIds extends Set<string> {
  override add(id: string): this {
    super.add(id);
    if (this.size > 256) this.delete(this.values().next().value!);
    return this;
  }
}

export interface InteractionPresentation {
  closed: Set<string>;
  known: Set<string>;
  sounded: Set<string>;
  restored: boolean;
}

/** View-local presentation only: never run, request, or response authority. */
export class InteractionPresentationLedger {
  private readonly runs = new Map<string, InteractionPresentation>();
  get size(): number { return this.runs.size; }
  clear(): void { this.runs.clear(); }
  forRun(runId: string): InteractionPresentation {
    let ledger = this.runs.get(runId);
    if (!ledger) {
      ledger = { closed: new RecentClosedIds(), known: new Set(), sounded: new Set(), restored: false };
      this.runs.set(runId, ledger);
      // Match the store's bounded retired-run horizon, without retaining old views.
      if (this.runs.size > 16) this.runs.delete(this.runs.keys().next().value!);
    }
    return ledger;
  }
  observe(run: AgentRunSnapshot): void {
    const ledger = this.forRun(run.id);
    const requests = orderedExtensionRequests(run);
    const active = new Set(requests.map(request => request.id));
    for (const known of ledger.known) if (!active.has(known)) ledger.closed.add(known);
    for (const sounded of ledger.sounded) if (!active.has(sounded)) ledger.sounded.delete(sounded);
    // Only the first projection is cold restoration, including legacy primary.
    // An empty baseline must count as observation before later App polling.
    for (const request of requests) if (!ledger.restored) ledger.sounded.add(request.id);
    ledger.known = active;
    ledger.restored = true;
  }
}
