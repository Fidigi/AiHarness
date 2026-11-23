/** Internal protocol failure: never turn malformed final JSON into tool input. */
export class ProviderToolArgumentsError extends Error {
  constructor() {
    super('The provider tool arguments were invalid JSON.');
    this.name = 'ProviderToolArgumentsError';
  }
}

/** Keep the legacy empty/absent no-argument form, but do not repair partial JSON. */
export function parseProviderToolArguments(value: unknown): unknown {
  if (value === undefined || value === '') return {};
  if (typeof value !== 'string') throw new ProviderToolArgumentsError();
  try { return JSON.parse(value) as unknown; }
  catch { throw new ProviderToolArgumentsError(); }
}
