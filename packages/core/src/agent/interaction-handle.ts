import type {
  ExtensionInteractionHandle,
  ExtensionInteractionResponse,
  ExtensionInteractionUpdate,
} from '../extensions/extension-registry.js';
import type { ExtensionInteractionSnapshot } from './events.js';

export const MAX_RUN_INTERACTIONS = 16;
export const MAX_INTERACTION_BYTES = 128_000;
export const MAX_RUN_INTERACTION_BYTES = 512_000;

/** Bound individual journal payloads and aggregate reconnect state, including UTF-8 expansion. */
export function assertInteractionCapacity(
  requests: readonly ExtensionInteractionSnapshot[],
  request: ExtensionInteractionSnapshot,
  replaceId?: string,
): void {
  const others = requests.filter(item => item.id !== replaceId);
  const bytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
  if (bytes > MAX_INTERACTION_BYTES || others.length >= MAX_RUN_INTERACTIONS
    || others.reduce((total, item) => total + Buffer.byteLength(JSON.stringify(item), 'utf8'), bytes) > MAX_RUN_INTERACTION_BYTES) {
    throw Object.assign(new Error('Extension interaction queue is full or request is too large.'), {
      status: 409, code: 'EXTENSION_INTERACTION_QUEUE_FULL',
    });
  }
}

export function interactionTimeout(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647)) {
    throw Object.assign(new Error('Extension interaction timeout is invalid.'), {
      status: 400, code: 'INVALID_EXTENSION_INTERACTION_TIMEOUT',
    });
  }
  return timeoutMs;
}

/** The closures, not the visible ID, are the update/close authority. */
export function interactionHandle(
  id: string,
  response: Promise<ExtensionInteractionResponse>,
  update: (request: ExtensionInteractionUpdate) => boolean,
  close: () => boolean,
): ExtensionInteractionHandle {
  return Object.defineProperties(response, {
    id: { value: id, enumerable: true },
    update: { value: update },
    close: { value: close },
  }) as ExtensionInteractionHandle;
}
