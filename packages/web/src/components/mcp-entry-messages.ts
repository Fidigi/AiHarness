import type { McpEntryProblemReason } from '@ai-harness/core';

const en: Record<McpEntryProblemReason, string> = {
  'entry-shape': 'The server entry must be an object.',
  'server-name': 'The server name is empty, too long, or contains hidden characters.',
  'unsupported-properties': 'The server entry contains unsupported properties.',
  target: 'The server entry must define exactly one command or URL.',
  command: 'The command must be a non-empty bounded string.',
  url: 'The URL must be a bounded HTTP or HTTPS URL.',
  transport: 'The transport type is unsupported.',
  'stdio-transport': 'The transport type does not match the command transport.',
  'http-transport': 'The transport type does not match the URL transport.',
  args: 'Arguments must be a bounded array of strings.',
  cwd: 'The working directory must be a bounded string.',
  description: 'The description must be a bounded string.',
  env: 'Environment entries must be a bounded string map.',
  headers: 'Header entries must be a bounded string map.',
  'stdio-fields': 'Standard-input servers cannot declare HTTP headers or OAuth settings.',
  'http-fields': 'HTTP servers cannot declare command arguments, a working directory, or process environment.',
  enabled: 'Enabled must be a boolean.',
  exposure: 'Exposure must be direct, codemode, deferred, or hidden.',
  'tool-exposure': 'Per-tool exposure must be a bounded map of tool names or * patterns and exposure modes.',
  oauth: 'OAuth settings do not match the supported schema.',
  'override-fields': 'A targetless project override may only set enabled, exposure, and toolExposure.',
  'orphan-override': 'A targetless project override requires a valid readable global server with the same name.',
};

const fr: Record<McpEntryProblemReason, string> = {
  'entry-shape': 'L’entrée du serveur doit être un objet.',
  'server-name': 'Le nom du serveur est vide, trop long ou contient des caractères masqués.',
  'unsupported-properties': 'L’entrée du serveur contient des propriétés non prises en charge.',
  target: 'L’entrée du serveur doit définir exactement une commande ou une URL.',
  command: 'La commande doit être une chaîne bornée non vide.',
  url: 'L’URL doit être une URL HTTP ou HTTPS de longueur bornée.',
  transport: 'Ce type de transport n’est pas pris en charge.',
  'stdio-transport': 'Le type de transport ne correspond pas au transport par commande.',
  'http-transport': 'Le type de transport ne correspond pas au transport par URL.',
  args: 'Les arguments doivent être un tableau borné de chaînes.',
  cwd: 'Le dossier de travail doit être une chaîne bornée.',
  description: 'La description doit être une chaîne bornée.',
  env: 'Les variables d’environnement doivent former une table bornée de chaînes.',
  headers: 'Les en-têtes doivent former une table bornée de chaînes.',
  'stdio-fields': 'Un serveur d’entrée-sortie standard ne peut pas déclarer d’en-têtes HTTP ni de paramètres OAuth.',
  'http-fields': 'Un serveur HTTP ne peut pas déclarer d’arguments de commande, de dossier de travail ni d’environnement de processus.',
  enabled: 'L’état d’activation doit être un booléen.',
  exposure: 'L’exposition doit être direct, codemode, deferred ou hidden.',
  'tool-exposure': 'L’exposition par outil doit être une table bornée de noms d’outils ou de motifs * et de modes d’exposition.',
  oauth: 'Les paramètres OAuth ne respectent pas le schéma pris en charge.',
  'override-fields': 'Une surcharge de projet sans cible ne peut définir que enabled, exposure et toolExposure.',
  'orphan-override': 'Une surcharge de projet sans cible nécessite un serveur global valide et lisible de même nom.',
};

/** Settings-lazy app copy keyed only by typed codes, never by source English.
 * Legacy/remote technical details stay verbatim in their existing channel. */
export function mcpEntryProblemMessage(locale: string, reason: unknown): string {
  const copy = locale === 'fr' ? fr : en;
  return typeof reason === 'string' && Object.hasOwn(copy, reason)
    ? copy[reason as McpEntryProblemReason]
    : locale === 'fr' ? 'L’entrée du serveur ne respecte pas le schéma MCP pris en charge.'
      : 'The server entry does not match the supported MCP schema.';
}
