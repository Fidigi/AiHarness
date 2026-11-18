/** Stable error used by the CLI and detached Web runtime. */
export class AgentAbortError extends Error {
  constructor() {
    super("Exécution de l'agent interrompue.");
    this.name = 'AbortError';
  }
}
