import { registerFeatureLocaleMessages } from '../i18n/registry';

/** New Settings-only feature copy; do not enlarge the eager locale catalogues
 * or rewrite the historical 228-message Settings relocation inventory. */
export const skillContentMessages = {
  en: {
    'settings.skills.instructions': 'Instructions: {skill}',
    'settings.skills.openInstructions': 'Read instructions for {skill}',
    'settings.skills.mainInstructions': 'Main instructions',
    'settings.skills.contentUnavailable': 'Skill content is unavailable or not permitted.',
  },
  fr: {
    'settings.skills.instructions': 'Instructions : {skill}',
    'settings.skills.openInstructions': 'Lire les instructions de {skill}',
    'settings.skills.mainInstructions': 'Instructions principales',
    'settings.skills.contentUnavailable': 'Le contenu du skill est indisponible ou non autorisé.',
  },
} as const;

registerFeatureLocaleMessages(skillContentMessages);
