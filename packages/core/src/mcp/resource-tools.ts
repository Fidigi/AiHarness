import { copySessionCustomValue } from '../sessions/session-custom-data.js';
import { resourceMime, resourceUri } from './resource-content.js';

export type McpResourceOperation = 'resources/list' | 'resources/templates/list' | 'resources/read';
export interface McpResourceConnection {
  listResources(cursor: string | undefined, signal: AbortSignal): Promise<unknown>;
  listTemplates(cursor: string | undefined, signal: AbortSignal): Promise<unknown>;
  readResource(uri: string, signal: AbortSignal): Promise<unknown>;
}
export const MCP_RESOURCE_TOOLS = (['resources/list', 'resources/templates/list', 'resources/read'] as const).map((operation, index) => ({
  name: ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'][index]!,
  remoteName: operation, resourceOperation: operation, readOnly: true,
  description: index === 2 ? 'Read one resource URI from this MCP server. No local file or remote URL is opened by the host.'
    : `List one bounded page of MCP ${index === 1 ? 'resource templates' : 'resources'} from this server. Follow nextCursor explicitly. MCP Apps are excluded.`,
  parameters: { type: 'object', properties: index === 2 ? { uri: { type: 'string', maxLength: 4096 } }
    : { cursor: { type: 'string', maxLength: 4096 } }, ...(index === 2 ? { required: ['uri'] } : {}), additionalProperties: false } as Record<string, unknown>,
}));
function cursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('Invalid MCP resource cursor.');
  return value;
}
export async function callMcpResource(connection: McpResourceConnection, operation: McpResourceOperation,
  input: Record<string, unknown>, signal: AbortSignal, redact: (text: string) => string): Promise<unknown> {
  const reading = operation === 'resources/read';
  if (Object.keys(input).some(key => key !== (reading ? 'uri' : 'cursor'))) throw new Error('Invalid MCP resource input.');
  if (reading) {
    const result = copySessionCustomValue(await connection.readResource(resourceUri(input.uri), signal), 4 * 1024 * 1024) as Record<string, unknown>;
    if (!Array.isArray(result.contents) || result.contents.length > 64) throw new Error('Invalid MCP resource contents.');
    return { content: result.contents.map(resource => ({ type: 'resource', resource })) };
  }
  const requested = cursor(input.cursor);
  const raw = await (operation === 'resources/list' ? connection.listResources(requested, signal) : connection.listTemplates(requested, signal));
  const result = copySessionCustomValue(raw, 256 * 1024) as Record<string, unknown>;
  const key = operation === 'resources/list' ? 'resources' : 'resourceTemplates', items = result[key];
  if (!Array.isArray(items) || items.length > 1000) throw new Error('MCP resource page exceeds its limit.');
  let omitted = 0;
  const projected = items.flatMap((item: Record<string, unknown>) => {
    try {
      if (!item || typeof item !== 'object') throw new Error();
      const uriKey = key === 'resources' ? 'uri' : 'uriTemplate', uri = resourceUri(item[uriKey], key === 'resourceTemplates');
      if (redact(uri) !== uri) throw new Error();
      if (item.mimeType !== undefined) resourceMime(item.mimeType);
      if (typeof item.name !== 'string' || item.name.length > 500) throw new Error();
      const entry: Record<string, unknown> = { [uriKey]: uri, name: redact(item.name) };
      for (const field of ['description', 'title', 'mimeType'] as const) if (item[field] !== undefined) {
        if (typeof item[field] !== 'string' || item[field].length > 4096) throw new Error();
        entry[field] = redact(item[field]);
      }
      return [entry];
    } catch { omitted++; return []; }
  });
  const nextCursor = cursor(result.nextCursor);
  if (nextCursor && (nextCursor === requested || redact(nextCursor) !== nextCursor)) throw new Error('Invalid MCP resource pagination.');
  return { content: [{ type: 'text', text: `${projected.length} MCP ${key}; ${omitted} omitted.` }],
    structuredContent: { [key]: projected, ...(nextCursor ? { nextCursor } : {}), ...(omitted ? { omitted } : {}) } };
}
