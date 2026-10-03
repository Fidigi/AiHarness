import type { SerializedSession, Session } from '@ai-harness/core';
import { serializeSession } from '@ai-harness/core';

export const DEFAULT_MESSAGE_PAGE_SIZE = 80;
export const MAX_MESSAGE_PAGE_SIZE = 250;

export interface SessionMessagePageInfo {
  start: number;
  end: number;
  total: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  nextBefore?: string;
  nextAfter?: string;
  revision: number;
  targetIndex?: number;
}

export interface PaginatedSerializedSession extends SerializedSession {
  messagePage: SessionMessagePageInfo;
}

export interface SessionPageOptions {
  limit?: number;
  before?: string;
  around?: string;
  includeCommands?: boolean;
}

export function boundedMessageLimit(value: unknown, fallback = DEFAULT_MESSAGE_PAGE_SIZE, allowZero = false): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (!Number.isSafeInteger(parsed)) return fallback;
  const minimum = allowZero ? 0 : 1;
  return Math.max(minimum, Math.min(MAX_MESSAGE_PAGE_SIZE, parsed as number));
}

/**
 * Select a stable message window without serializing the rest of a potentially
 * large session. Cursors are message IDs so appends do not invalidate them.
 */
export function getSessionMessagePage(
  session: Session,
  options: SessionPageOptions = {},
): { messages: Session['messages']; page: SessionMessagePageInfo } {
  const total = session.messages.length;
  const limit = boundedMessageLimit(options.limit, DEFAULT_MESSAGE_PAGE_SIZE, true);
  let start = total;
  let end = total;
  let targetIndex: number | undefined;

  if (limit > 0 && options.around) {
    targetIndex = session.messages.findIndex(message => message.id === options.around);
    if (targetIndex < 0) {
      throw Object.assign(new Error('Message target not found'), {
        status: 404,
        code: 'MESSAGE_TARGET_NOT_FOUND',
      });
    }
    const desiredBefore = Math.floor(limit / 3);
    start = Math.max(0, Math.min(targetIndex - desiredBefore, Math.max(0, total - limit)));
    end = Math.min(total, start + limit);
  } else if (limit > 0) {
    if (options.before) {
      const beforeIndex = session.messages.findIndex(message => message.id === options.before);
      if (beforeIndex < 0) {
        throw Object.assign(new Error('Message cursor not found'), {
          status: 400,
          code: 'MESSAGE_CURSOR_NOT_FOUND',
        });
      }
      end = beforeIndex;
    }
    start = Math.max(0, end - limit);
  }

  const page: SessionMessagePageInfo = {
    start,
    end,
    total,
    hasMoreBefore: start > 0,
    hasMoreAfter: end < total,
    ...(start > 0 && session.messages[start] ? { nextBefore: session.messages[start].id } : {}),
    ...(end < total && end > 0 && session.messages[end - 1] ? { nextAfter: session.messages[end - 1].id } : {}),
    revision: session.updatedAt.getTime(),
    ...(targetIndex === undefined ? {} : { targetIndex }),
  };
  return { messages: session.messages.slice(start, end), page };
}

export function serializeSessionPage(
  session: Session,
  options: SessionPageOptions = {},
): PaginatedSerializedSession {
  const { messages, page } = getSessionMessagePage(session, options);
  const pagedSession: Session = {
    ...session,
    messages,
    ...(options.includeCommands === false ? { commands: undefined } : {}),
  };
  return { ...serializeSession(pagedSession), messagePage: page };
}
