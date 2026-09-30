import type { Session } from '@ai-harness/core';

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function sanitizeFilename(value: string): string {
  const sanitized = value
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
  return sanitized || 'conversation';
}

/** Render a portable, dependency-free and escaped conversation document. */
export function renderSessionHtml(session: Session): string {
  const title = escapeHtml(session.title || 'Conversation');
  const createdAt = new Date(session.createdAt).toISOString();
  const messages = session.messages.map(message => {
    const role = message.role === 'user'
      ? 'user'
      : message.role === 'assistant'
        ? 'assistant'
        : message.role === 'tool'
          ? 'tool'
          : 'system';
    const label = role === 'user'
      ? 'Vous'
      : role === 'assistant'
        ? 'Assistant'
        : role === 'tool'
          ? `Outil${message.name ? ` · ${message.name}` : ''}`
          : 'Système';
    const timestamp = new Date(message.timestamp).toISOString();
    return `      <article class="message ${role}">
        <header><strong>${label}</strong><time datetime="${timestamp}">${escapeHtml(new Date(message.timestamp).toLocaleString('fr-FR'))}</time></header>
        <pre>${escapeHtml(message.content)}</pre>
      </article>`;
  }).join('\n');

  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — AiHarness</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { max-width: 900px; margin: 0 auto; padding: 2rem 1rem; line-height: 1.5; background: Canvas; color: CanvasText; }
    h1 { margin-bottom: .25rem; }
    .meta { color: GrayText; margin-top: 0; }
    .message { margin: 1rem 0; padding: 1rem; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: .75rem; }
    .message.user { border-left: .3rem solid #16a34a; }
    .message.assistant { border-left: .3rem solid #2563eb; }
    .message.system { border-left: .3rem solid #ca8a04; }
    .message.tool { border-left: .3rem solid #9333ea; }
    header { display: flex; justify-content: space-between; gap: 1rem; }
    time { color: GrayText; font-size: .85rem; }
    pre { margin: .75rem 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p class="meta">Export AiHarness · <time datetime="${createdAt}">${escapeHtml(new Date(session.createdAt).toLocaleString('fr-FR'))}</time> · ${session.messages.length} message(s)</p>
${messages || '    <p>Cette conversation ne contient aucun message.</p>'}
  </main>
</body>
</html>
`;
}
