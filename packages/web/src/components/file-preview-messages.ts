const messages = {
  en: {
    reader: 'File reader', options: 'File options', destination: 'Destination (workspace root)', chooseFiles: 'Choose files',
    tabs: 'Open files', close: 'Close file', limit: 'At most 8 files can be open. Close a tab first.',
    loading: 'Loading file…', previewLoading: 'Loading document preview…',
    failed: 'Preview unavailable. The document may be invalid, encrypted or exceed preview limits. Reopen it or reload the page to retry.',
    tableInvalid: 'Malformed delimited data. Source and download remain available.',
    tableLimit: 'Table preview limit exceeded (500 rows, 64 columns, 20,000 cells, 16,384 characters per cell).',
    table: 'Delimited data', empty: 'Empty document', docx: 'DOCX text (styles, images, macros and external resources are not loaded)',
    previous: 'Previous page', next: 'Next page', page: 'Page', pageText: 'Page text',
    readFailed: 'The file could not be read. Select it again to retry.',
  },
  fr: {
    reader: 'Lecteur de fichiers', options: 'Options des fichiers', destination: 'Destination (racine du projet)', chooseFiles: 'Choisir des fichiers',
    tabs: 'Fichiers ouverts', close: 'Fermer le fichier', limit: 'Au maximum 8 fichiers ouverts. Fermez d’abord un onglet.',
    loading: 'Chargement du fichier…', previewLoading: 'Chargement de l’aperçu du document…',
    failed: 'Aperçu indisponible. Le document est peut-être invalide, chiffré ou dépasse les limites. Rouvrez-le ou rechargez la page pour réessayer.',
    tableInvalid: 'Données délimitées invalides. La source et le téléchargement restent disponibles.',
    tableLimit: 'Limites du tableau dépassées (500 lignes, 64 colonnes, 20 000 cellules, 16 384 caractères par cellule).',
    table: 'Données délimitées', empty: 'Document vide', docx: 'Texte DOCX (styles, images, macros et ressources externes non chargés)',
    previous: 'Page précédente', next: 'Page suivante', page: 'Page', pageText: 'Texte de la page',
    readFailed: 'Le fichier n’a pas pu être lu. Sélectionnez-le à nouveau pour réessayer.',
  },
};
export const filePreviewMessages = (locale: string) => messages[locale === 'fr' ? 'fr' : 'en'];
