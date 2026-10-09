export interface ClipboardLink { label: string; href: string; occurrence?: number }

// Bounds apply ONLY to optional HTML metadata, never to the user's plain text.
export const clipboardMetadataLimits = { htmlLength: 65_536, nodes: 1_024, links: 32, labelLength: 1_024, hrefLength: 2_048 } as const;

function boundedLinks(links: ClipboardLink[]): boolean {
  return links.length <= clipboardMetadataLimits.links && links.every(({ label, href, occurrence = 0 }) =>
    label.length <= clipboardMetadataLimits.labelLength && href.length <= clipboardMetadataLimits.hrefLength
    && Number.isSafeInteger(occurrence) && occurrence >= 0 && occurrence <= clipboardMetadataLimits.nodes);
}

/** Preserve the authoritative text/plain byte-for-byte except safe, labelled links. */
export function replaceClipboardLinks(text: string, links: ClipboardLink[]): string {
  if (!boundedLinks(links)) return text;
  const edits: Array<{ start: number; end: number; value: string }> = [];
  for (const { label, href, occurrence = 0 } of links) {
    const url = href.trim();
    if (!label || label === url || !/^(?:https?:\/\/|file:)/i.test(url) || /[\u0000-\u0020\u007f]/.test(url)) continue;
    // A literal URL label should stay an autolink, and existing Markdown must not be wrapped twice.
    let start = -1;
    let searchFrom = 0;
    for (let index = 0; index <= occurrence; index++) {
      start = text.indexOf(label, searchFrom);
      if (start < 0) break;
      searchFrom = start + label.length;
    }
    if (start < 0 || text[start - 1] === '[' || edits.some(edit => start < edit.end && start + label.length > edit.start)) continue;
    const escapedLabel = label.replace(/[\\[\]]/g, '\\$&');
    const escapedUrl = url.replace(/\\/g, '%5C').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/</g, '%3C').replace(/>/g, '%3E');
    edits.push({ start, end: start + label.length, value: `[${escapedLabel}](${escapedUrl})` });
  }
  let result = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  return result;
}

/** HTML is used only for link metadata. Wrapper div/p/br never invent blank lines. */
export function clipboardTextToMarkdown(text: string, html: string): string {
  if (!text || !html || html.length > clipboardMetadataLimits.htmlLength) return text;
  try {
    // Template contents have an inert owner document: resources/custom elements never
    // activate, even before unwanted nodes are stripped. Never attach this fragment.
    const template = document.createElement('template');
    template.innerHTML = html;
    const fragment = template.content;
    const owner = fragment.ownerDocument;
    const walker = owner.createTreeWalker(fragment);
    let nodes = 0;
    while (walker.nextNode()) if (++nodes > clipboardMetadataLimits.nodes) return text;
    fragment.querySelectorAll('script,style,template,iframe,object,embed').forEach(node => node.remove());
    const anchors = fragment.querySelectorAll('a[href]');
    if (anchors.length > clipboardMetadataLimits.links) return text;
    const links: ClipboardLink[] = [];
    for (const link of anchors) {
      const label = link.textContent ?? '';
      const href = link.getAttribute('href') ?? '';
      if (label.length > clipboardMetadataLimits.labelLength || href.length > clipboardMetadataLimits.hrefLength) return text;
      // Both the Range and its endpoints must use the fragment's inert owner, not
      // the active document (template content has a different owner document).
      const preceding = owner.createRange();
      preceding.setStart(fragment, 0);
      preceding.setEndBefore(link);
      const occurrence = label ? preceding.toString().split(label).length - 1 : 0;
      links.push({ label, href, occurrence });
    }
    return replaceClipboardLinks(text, links);
  } catch {
    // Unsupported DOM/Trusted Types restrictions or malformed metadata must never
    // lose plaintext or prevent the native-layout paste.
    return text;
  }
}
