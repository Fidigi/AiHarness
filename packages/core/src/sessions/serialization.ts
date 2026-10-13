import type { Message, Session, ShellCommandRecord } from '../types/index.js';

export type SerializedMessage = Omit<Message, 'timestamp'> & { timestamp: string };
export type SerializedShellCommand = Omit<ShellCommandRecord, 'timestamp'> & { timestamp: string };
export type SerializedSession = Omit<Session, 'messages' | 'commands' | 'createdAt' | 'updatedAt' | 'providerConfig'> & {
  messages: SerializedMessage[];
  commands?: SerializedShellCommand[];
  createdAt: string;
  updatedAt: string;
  /** Provider identity and non-secret runtime options only. */
  providerConfig?: Session['providerConfig'];
};

const SECRET_CONFIG_KEYS = /(?:api[-_]?key|secret|private[-_]?key|(?:access|refresh|session|auth|bearer)[-_]?token|authorization|password|cookie|credential|^token$)/i;

/** Shared JSON/JSONL metadata policy; never evaluates getters or retains executable values. */
export function redactProviderConfig(config: Session['providerConfig']): Session['providerConfig'] {
  if (!config || typeof config !== 'object') return undefined;
  try { if (Array.isArray(config)) return undefined; }
  catch { return undefined; }
  const seen = new WeakSet<object>();
  const encoder = new TextEncoder();
  let nodes = 0;
  const sanitize = (value: unknown, depth = 0): unknown => {
    if (++nodes > 10_000 || depth > 32) return undefined;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value !== 'object') return undefined;
    if (seen.has(value)) return undefined;
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > 1_024) return undefined;
        const result: unknown[] = [];
        for (let index = 0; index < value.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || !('value' in descriptor)) return undefined;
          const item = sanitize(descriptor.value, depth + 1);
          if (item !== undefined) result.push(item);
        }
        return result;
      }
      const keys = Object.keys(value);
      if (keys.length > 256) return undefined;
      const result: Record<string, unknown> = {};
      for (const key of keys) {
        if (SECRET_CONFIG_KEYS.test(key) || key.length > 256 || encoder.encode(key).byteLength > 256) continue;
        let descriptor: PropertyDescriptor | undefined;
        try { descriptor = Object.getOwnPropertyDescriptor(value, key); }
        catch { continue; }
        if (!descriptor || !('value' in descriptor)) continue;
        const item = sanitize(descriptor.value, depth + 1);
        if (item === undefined) continue;
        Object.defineProperty(result, key, {
          value: item, enumerable: true, configurable: true, writable: true,
        });
      }
      return result;
    } catch {
      return undefined;
    } finally {
      seen.delete(value);
    }
  };
  return sanitize(config) as Session['providerConfig'];
}

/** Convert the runtime Date-based contract to its JSON wire representation. */
export function serializeSession(session: Session): SerializedSession {
  const { messages, commands, createdAt, updatedAt, providerConfig, ...rest } = session;
  return {
    ...rest,
    providerConfig: redactProviderConfig(providerConfig),
    messages: messages.map(message => ({
      ...message,
      timestamp: message.timestamp.toISOString(),
    })),
    ...(commands ? {
      commands: commands.map(command => ({
        ...command,
        timestamp: command.timestamp.toISOString(),
      })),
    } : {}),
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
}

/** Hydrate a JSON session while retaining unknown additive fields. */
export function deserializeSession(session: SerializedSession): Session {
  const { messages, commands, createdAt, updatedAt, providerConfig, ...rest } = session;
  return {
    ...rest,
    providerConfig: redactProviderConfig(providerConfig),
    messages: messages.map(message => ({
      ...message,
      timestamp: new Date(message.timestamp),
    })),
    ...(commands ? {
      commands: commands.map(command => ({
        ...command,
        timestamp: new Date(command.timestamp),
      })),
    } : {}),
    createdAt: new Date(createdAt),
    updatedAt: new Date(updatedAt),
  };
}
