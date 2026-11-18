import type { Locale, TranslationParams } from '../i18n/types';

const en = {
  'settings.mcp.test.action': 'Test',
  'settings.mcp.test.testing': 'Testing…',
  'settings.mcp.test.named': 'Test {name}',
  'settings.mcp.test.reportNamed': 'Last connection test for {name}',
  'settings.mcp.test.state.connected': 'Connected',
  'settings.mcp.test.state.needs-auth': 'Authentication required',
  'settings.mcp.test.state.failed': 'Connection failed',
  'settings.mcp.test.timing': 'Tested {testedAt} · {duration} ms',
  'settings.mcp.test.serverInfo': 'Server: {name} {version}',
  'settings.mcp.test.cwd': 'Working directory:',
  'settings.mcp.test.capabilities': '{tools} tools · {resources} resources · {templates} templates · {prompts} prompts',
  'settings.mcp.test.truncated': 'The capability list reached its safety limit and was truncated.',
  'settings.mcp.test.timedOut': 'The bounded connection test timed out.',
  'settings.mcp.test.queueTimedOut': 'The test timed out while waiting to resolve a command-backed value.',
  'settings.mcp.test.needsAuth': 'This server needs authentication. Sign-in is a separate explicit action.',
  'settings.mcp.test.readOnly': 'read-only hint',
  'settings.mcp.test.mayWrite': 'may write',
  'settings.mcp.test.failed': 'The MCP test failed.',
  'settings.mcp.test.error': 'Connection error',
  'settings.mcp.test.stderr': 'Redacted server stderr',
} as const;

export type McpTestMessageKey = keyof typeof en;

const fr: Record<McpTestMessageKey, string> = {
  'settings.mcp.test.action': 'Tester',
  'settings.mcp.test.testing': 'Test…',
  'settings.mcp.test.named': 'Tester {name}',
  'settings.mcp.test.reportNamed': 'Dernier test de connexion de {name}',
  'settings.mcp.test.state.connected': 'Connecté',
  'settings.mcp.test.state.needs-auth': 'Authentification requise',
  'settings.mcp.test.state.failed': 'Échec de connexion',
  'settings.mcp.test.timing': 'Testé le {testedAt} · {duration} ms',
  'settings.mcp.test.serverInfo': 'Serveur : {name} {version}',
  'settings.mcp.test.cwd': 'Dossier de travail :',
  'settings.mcp.test.capabilities': '{tools} outils · {resources} ressources · {templates} modèles · {prompts} prompts',
  'settings.mcp.test.truncated': 'La liste des capacités a atteint sa limite de sécurité et a été tronquée.',
  'settings.mcp.test.timedOut': 'Le test de connexion borné a expiré.',
  'settings.mcp.test.queueTimedOut': 'Le test a expiré dans l’attente de la résolution d’une valeur adossée à une commande.',
  'settings.mcp.test.needsAuth': 'Ce serveur exige une authentification. La connexion est une action explicite distincte.',
  'settings.mcp.test.readOnly': 'indication lecture seule',
  'settings.mcp.test.mayWrite': 'peut écrire',
  'settings.mcp.test.failed': 'Le test MCP a échoué.',
  'settings.mcp.test.error': 'Erreur de connexion',
  'settings.mcp.test.stderr': 'Sortie d’erreur expurgée du serveur',
};

const messages: Record<Locale, Record<McpTestMessageKey, string>> = { en, fr };

/** Localized with the lazy MCP panel so Test copy stays outside the eager entry bundle. */
export function mcpTestMessage(
  locale: Locale,
  key: McpTestMessageKey,
  params: TranslationParams = {},
): string {
  const template = messages[locale][key] ?? en[key];
  return template.replace(/\{([A-Za-z0-9_]+)\}/gu, (placeholder, name: string) => {
    const value = params[name];
    return value === undefined ? placeholder : String(value);
  });
}
