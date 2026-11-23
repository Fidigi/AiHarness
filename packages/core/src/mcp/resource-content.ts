import { createHash, randomUUID } from 'node:crypto';
import type { ExtensionToolResult } from '../extensions/extension-registry.js';
import { copySessionCustomValue } from '../sessions/session-custom-data.js';
import { validateGeneratedImages } from '../providers/specialized-models.js';
import { safeText } from './server-test.js';

export const MCP_CONTENT_LIMITS = Object.freeze({ resultBytes: 4 * 1024 * 1024, binaryBytes: 2 * 1024 * 1024,
  retainedBytes: 16 * 1024 * 1024, retainedItems: 64, ttlMs: 10 * 60 * 1000, items: 64, textChars: 64 * 1024 });
export interface McpRetainedContent { data: Buffer; mediaType: string; size: number; sha256: string }
interface Retained extends McpRetainedContent { owner: string; expires: number }

/** Process-local, bounded and owner-scoped. References convey no filesystem authority. */
export class McpContentStore {
  private readonly entries = new Map<string, Retained>();
  constructor(private readonly now: () => number = Date.now) {}
  private prune(): void {
    for (const [id, entry] of this.entries) if (entry.expires <= this.now()) this.entries.delete(id);
  }
  put(owner: string, data: Buffer, mediaType: string): string {
    this.prune();
    if (data.length > MCP_CONTENT_LIMITS.binaryBytes) throw new Error('MCP binary content exceeds its limit.');
    let bytes = [...this.entries.values()].reduce((sum, entry) => sum + entry.size, 0);
    while (this.entries.size >= MCP_CONTENT_LIMITS.retainedItems || bytes + data.length > MCP_CONTENT_LIMITS.retainedBytes) {
      const first = this.entries.keys().next().value!;
      bytes -= this.entries.get(first)!.size; this.entries.delete(first);
    }
    const id = randomUUID();
    this.entries.set(id, { owner, data: Buffer.from(data), mediaType, size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'), expires: this.now() + MCP_CONTENT_LIMITS.ttlMs });
    return id;
  }
  get(owner: string, id: string): McpRetainedContent | undefined {
    this.prune(); const entry = this.entries.get(id);
    return entry?.owner === owner ? { data: Buffer.from(entry.data), mediaType: entry.mediaType, size: entry.size, sha256: entry.sha256 } : undefined;
  }
  removeOwner(owner: string): void { for (const [id, entry] of this.entries) if (entry.owner === owner) this.entries.delete(id); }
}

export function resourceUri(value: unknown, template = false): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 4096 || /[\u0000-\u0020\u007f]/u.test(value)) throw new Error('Invalid MCP resource URI.');
  // Templates are inert metadata, including a variable-expanded base URI. Only
  // a concrete URI supplied to readResource can authorize a peer request.
  const literal = template ? value.replace(/\{[^{}]+\}/gu, 'x') : value;
  if (template && /[{}]/u.test(literal)) throw new Error('Invalid MCP resource template.');
  let url: URL; try { url = template ? new URL(literal, 'https://mcp-template.invalid') : new URL(literal); } catch { throw new Error('Invalid MCP resource URI.'); }
  if (['ui:', 'javascript:', 'data:', 'blob:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported MCP resource URI.');
  return value;
}
export function resourceMime(value: unknown): string {
  const mime = value === undefined ? 'application/octet-stream' : value;
  if (typeof mime !== 'string' || mime.length > 200 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;[\x20-\x7e]*)?$/iu.test(mime)
    || /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/iu.test(mime)) throw new Error('Unsupported MCP resource media type.');
  return mime.split(';', 1)[0]!.toLowerCase();
}

/** Keep protocol metadata inert; never interpret MCP Apps, remote links or HTML. */
export function formatMcpResult(value: unknown, redact: (text: string) => string,
  retain: (data: Buffer, mediaType: string) => string): ExtensionToolResult {
  const result = copySessionCustomValue(value, MCP_CONTENT_LIMITS.resultBytes) as Record<string, unknown>;
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || (result.isError !== undefined && typeof result.isError !== 'boolean')) throw new Error('Invalid MCP result.');
  const raw = result.content;
  if (!Array.isArray(raw) || raw.length > MCP_CONTENT_LIMITS.items) throw new Error('Invalid MCP result content.');
  const output: string[] = [], blocks: NonNullable<ExtensionToolResult['blocks']> = [];
  const binaries: Array<{ data: Buffer; mime: string }> = [];
  let binaryBytes = 0;
  for (const item of raw as Array<Record<string, unknown>>) {
    if (!item || typeof item !== 'object') throw new Error('Invalid MCP result content.');
    if (item.type === 'text' && typeof item.text === 'string') { output.push(item.text); continue; }
    if (item.type === 'resource_link') {
      const uri = resourceUri(item.uri); output.push(`[Resource link: ${uri}]`); continue;
    }
    if (!['resource', 'image', 'audio'].includes(String(item.type))) throw new Error('Unsupported MCP result content.');
    const resource = item.type === 'resource' ? item.resource as Record<string, unknown> : undefined;
    if (resource) resourceUri(resource.uri);
    const mime = resourceMime(resource?.mimeType ?? item.mimeType);
    if (redact(mime) !== mime) throw new Error('Unsafe MCP resource media type.');
    if (resource && typeof resource.text === 'string') { output.push(resource.text); continue; }
    const data = resource?.blob ?? item.data;
    if (typeof data !== 'string' || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(data)) throw new Error('Invalid MCP binary content.');
    const binary = Buffer.from(data, 'base64'); binaryBytes += binary.length;
    if (binary.toString('base64') !== data || binaryBytes > MCP_CONTENT_LIMITS.binaryBytes
      || redact(data) !== data || redact(binary.toString('utf8')) !== binary.toString('utf8')) throw new Error('Invalid or unsafe MCP binary content.');
    if (['image/png', 'image/jpeg', 'image/webp'].includes(mime)) {
      const image = validateGeneratedImages([{ mediaType: mime, data }], 1)[0]!;
      blocks.push({ type: 'image', mediaType: image.mediaType, url: `data:${mime};base64,${image.data}`, size: binary.length });
    } else {
      binaries.push({ data: binary, mime });
    }
  }
  let structuredContent: unknown;
  if (result.structuredContent !== undefined) {
    const scrub = (value: unknown): unknown => typeof value === 'string' ? redact(value) : Array.isArray(value) ? value.map(scrub)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), scrub(item)])) : redact(String(value)) === String(value) ? value : '•••';
    structuredContent = copySessionCustomValue(scrub(copySessionCustomValue(result.structuredContent, 128 * 1024)), 128 * 1024);
  }
  // Validate the whole result before retaining any binary.
  const references = binaries.map(binary => `[Retained ${binary.mime}, ${binary.data.length} bytes: mcp-content:${retain(binary.data, binary.mime)}]`).join('\n');
  const text = safeText(output.join('\n'), redact, MCP_CONTENT_LIMITS.textChars - references.length - 1);
  return { content: [text, references].filter(Boolean).join('\n') || '(MCP returned no text)',
    ...(structuredContent !== undefined ? { structuredContent } : {}), ...(blocks.length ? { blocks } : {}), isError: result.isError === true, details: { mcp: true, contentItems: raw.length } };
}
