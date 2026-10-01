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

const SECRET_CONFIG_KEYS = /^(?:api[-_]?key|secret(?:access)?key|access[-_]?token|session[-_]?token|authorization|password)$/i;

export function redactProviderConfig(config: Session['providerConfig']): Session['providerConfig'] {
  if (!config) return undefined;
  return Object.fromEntries(Object.entries(config).filter(([key]) => !SECRET_CONFIG_KEYS.test(key))) as Session['providerConfig'];
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
