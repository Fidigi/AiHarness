import { Session } from '../types';

/** In-memory session manager (can be extended with persistence) */
export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private onSessionUpdate?: (sessionId: string) => void;

  setListener(listener: (sessionId: string) => void): void {
    this.onSessionUpdate = listener;
  }

  /** Create a new session */
  create(options?: { id?: string; title?: string }): Session {
    const session: Session = {
      id: options?.id ?? crypto.randomUUID(),
      title: options?.title,
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.sessions.set(session.id, session);
    this.onSessionUpdate?.(session.id);
    return session;
  }

  /** Get a session by ID */
  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** List all sessions */
  list(): Session[] {
    return Array.from(this.sessions.values()).sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
    );
  }

  /** Add a message to a session */
  addMessage(sessionId: string, message: { role: 'user' | 'assistant'; content: string }): Session | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const fullMessage = {
      id: crypto.randomUUID(),
      ...message,
      timestamp: new Date(),
    };

    session.messages.push(fullMessage);
    session.updatedAt = new Date();

    // Auto-generate title from first user message
    if (!session.title && message.role === 'user') {
      session.title = message.content.slice(0, 50) + (message.content.length > 50 ? '...' : '');
    }

    this.onSessionUpdate?.(sessionId);
    return session;
  }

  /** Delete a session */
  delete(id: string): boolean {
    const deleted = this.sessions.delete(id);
    if (deleted) {
      this.onSessionUpdate?.(id);
    }
    return deleted;
  }

  /** Clear all sessions */
  clear(): void {
    this.sessions.clear();
  }
}
