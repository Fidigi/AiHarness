const en = { truncated: 'Output limit reached. Ask to continue.', compact: 'Compact context' } as const;
const fr = { truncated: 'Limite de sortie. Demandez la suite.', compact: 'Compacter le contexte' } as const;
/** Feature-owned copy: do not alter the conserved Settings dictionary inventory. */
export function replyMessages(locale: string): typeof en | typeof fr { return locale === 'fr' ? fr : en; }
