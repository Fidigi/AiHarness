import { JsonlSessionStore, type SessionEntry } from '../sessions/session-manager.js';
import type { Session } from '../types/index.js';

/**
 * Storage boundary consumed by SessionManager (not a second persistence format).
 * Implementations must preserve the v2 raw journal, including abandoned and
 * compacted entries; atomically honor requireAbsent; and resolve writes only
 * after their durability guarantee. loadSession returns the active projection
 * with Date timestamps. See JsonlSessionStore for the reference implementation.
 * The SDK borrows stores and never deletes sessions or closes them on dispose.
 */
export type SessionStore = Pick<JsonlSessionStore,
  'setRedaction' | 'listSessionIds' | 'loadSession' | 'saveSession' | 'getRawEntries' | 'deleteSession'>;

/** Bridge the existing nominal store type without replacing any domain logic. */
export class SessionStoreAdapter extends JsonlSessionStore {
  private scrub: <T>(value: T) => T = value => structuredClone(value);

  constructor(private readonly delegate: SessionStore) {
    super(undefined, false);
  }

  override setRedaction(...args: Parameters<SessionStore['setRedaction']>): void {
    this.scrub = value => args[1](structuredClone(value));
    try { this.delegate.setRedaction(...args); }
    catch (error) {
      // This runs during manager construction, before the factory's load/create
      // error boundary. Never reflect a backend diagnostic containing secrets.
      throw new Error(args[0](error instanceof Error ? error.message : 'Session store initialization failed.'));
    }
  }

  override listSessionIds(): Promise<string[]> {
    return this.delegate.listSessionIds();
  }

  override async loadSession(id: string): Promise<Session | null> {
    return this.scrub(await this.delegate.loadSession(id));
  }

  override saveSession(session: Session, entries: SessionEntry[] = [], options: { requireAbsent?: boolean } = {}): Promise<void> {
    return this.delegate.saveSession(this.scrub(session), this.scrub(entries), { ...options });
  }

  override async getRawEntries(id: string): Promise<SessionEntry[]> {
    return this.scrub(await this.delegate.getRawEntries(id));
  }

  override deleteSession(id: string): Promise<boolean> {
    return this.delegate.deleteSession(id);
  }
}
