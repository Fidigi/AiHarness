const en = {
  label: 'Reasoning budgets (JSON)',
  help: 'Optional minimal/low/medium/high token counts. Numeric dialects clamp these values; effort-only models ignore them. A higher scope replaces the whole map. Empty text inherits; {} uses provider defaults.',
  invalid: 'Reasoning budgets must be valid JSON.',
};
const fr: typeof en = {
  label: 'Budgets de réflexion (JSON)',
  help: 'Comptages de tokens minimal/low/medium/high facultatifs. Les dialectes numériques bornent ces valeurs ; les modèles à effort les ignorent. Une portée supérieure remplace toute la table. Un texte vide hérite ; {} utilise les valeurs du fournisseur.',
  invalid: 'Les budgets de réflexion doivent être un JSON valide.',
};
export function reasoningSettingsMessage(locale: string, key: keyof typeof en): string {
  return (locale.toLowerCase().startsWith('fr') ? fr : en)[key];
}
