import type { Message } from '@ai-harness/core';

/** Count only loaded entries after the last observed tail. Older pages increase
 * its index, not the unread count; a missing/retired tail grants no new evidence. */
export function unseenMessagesAfter(messages: readonly Pick<Message, 'id'>[], tailId: string | undefined): number {
  const index = tailId === undefined ? -1 : messages.findIndex(message => message.id === tailId);
  return index < 0 ? 0 : messages.length - index - 1;
}
