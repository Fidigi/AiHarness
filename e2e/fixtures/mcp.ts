import type {
  McpConfigInventory,
  McpConfigProblemReason,
  McpImportPreview,
  McpServerInventoryEntry,
} from '@ai-harness/core';

const GLOBAL_PATH = '/agent/mcp.json';
const PROJECT_PATH = '/workspace/.ai-harness/mcp.json';

export const MCP_FILE_PROBLEM_MESSAGES: Readonly<Record<McpConfigProblemReason, string>> = {
  'invalid-shape': 'The configuration does not match the supported schema.',
  'invalid-syntax': 'The file is not valid JSON or JSONC.',
  'not-regular': 'The path is not a regular file or directory.',
  'too-deep': 'The configuration is nested too deeply.',
  'too-large': 'The configuration file exceeds the size limit.',
  'too-many-servers': 'The configuration declares too many servers.',
  'trust-required': 'Project trust is required before reading this file.',
  'trust-unavailable': 'Project trust could not be read safely.',
  'unsafe-link': 'A symbolic link was refused.',
  unreadable: 'The file could not be read safely.',
};

export const MCP_FILE_PROBLEM_REASONS = Object.keys(MCP_FILE_PROBLEM_MESSAGES) as McpConfigProblemReason[];

function server(overrides: Partial<McpServerInventoryEntry> & Pick<McpServerInventoryEntry, 'name' | 'scope'>): McpServerInventoryEntry {
  return {
    sourcePath: overrides.scope === 'global' ? GLOBAL_PATH : PROJECT_PATH,
    valid: true,
    enabled: true,
    exposure: 'direct',
    envNames: [],
    headerNames: [],
    commandFields: [],
    variableReferences: [],
    masked: false,
    shadowedByProject: false,
    replacesGlobal: false,
    problems: [],
    ...overrides,
  };
}

/** A value-free inventory containing every row state rendered by Settings. */
export function mcpStateInventory(): McpConfigInventory {
  return {
    files: [
      {
        scope: 'global', path: GLOBAL_PATH, exists: true, contentRead: true,
        problems: [{ reason: 'invalid-shape', message: 'The configuration contains unsupported root properties.' }],
      },
      { scope: 'project', path: PROJECT_PATH, exists: true, contentRead: true, problems: [] },
    ],
    project: {
      cwd: '/workspace', contentTrusted: true, requiresTrust: true, decision: true,
      inherited: false, trustError: false,
    },
    servers: [
      server({
        name: 'remote-docs', scope: 'global', transport: 'http', exposure: 'deferred',
        url: 'https://docs.example.test/•••?•••', headerNames: ['Authorization', 'X-Workspace'],
        commandFields: ['headers.X-Command'],
        variableReferences: [{ field: 'headers.X-Token', names: ['DOCS_TOKEN'] }],
        masked: true,
      }),
      server({
        name: 'local-tools', scope: 'global', transport: 'stdio', command: 'npx',
        args: ['-y', '•••', '--api-key=•••'], enabled: false, exposure: 'codemode',
        envNames: ['CACHE_DIR', 'TOKEN'], commandFields: ['env.TOKEN'],
        variableReferences: [{ field: 'env.CACHE_DIR', names: ['CACHE_DIR'] }],
        masked: true,
      }),
      server({
        name: 'shared', scope: 'global', transport: 'http', url: 'https://global.example.test',
        shadowedByProject: true,
      }),
      server({
        name: 'bad\\u202ename', scope: 'global', valid: false, url: '[invalid URL]',
        headerNames: ['Authorization'], masked: true,
        problems: [
          'The server name is empty, too long, or contains hidden characters.',
          'The URL must be a bounded HTTP or HTTPS URL.',
        ],
      }),
      server({
        name: 'shared', scope: 'project', transport: 'stdio', command: 'node', args: ['•••'],
        replacesGlobal: true, masked: true,
      }),
    ],
  };
}

/** A value-free import preview covering fields, references, secrets, and scope policy. */
export function mcpImportPreviewFixture(): McpImportPreview {
  return {
    ok: true,
    entries: [{
      name: 'docs-import',
      source: 'mcp-json',
      complete: false,
      persisted: {
        valid: true,
        enabled: true,
        exposure: 'direct',
        transport: 'http',
        url: 'https://docs.example.test/•••?•••',
        envNames: [],
        headerNames: ['Authorization', 'X-Tenant'],
        oauthFields: [],
        commandFields: [],
        variableReferences: [{ field: 'headers.Authorization', names: ['DOCS_TOKEN'] }],
        masked: true,
      },
      fields: [{
        id: 'headers.X-Tenant', field: 'headers.X-Tenant', kind: 'text', required: true, canReference: true,
      }],
      variables: [{
        field: 'headers.Authorization', name: 'DOCS_TOKEN', availability: 'available',
        remote: true, confirmationRequired: true,
      }],
      literalSecretFields: ['url'],
      referenceableLiteralSecretFields: [],
      scopes: {
        global: { allowed: true, reasons: [], confirmations: ['literal-secret', 'remote-host-variable'] },
        project: { allowed: false, reasons: ['literal-secret'], confirmations: ['remote-host-variable'] },
      },
      notes: [{ code: 'missing-value', severity: 'warning', field: 'headers.X-Tenant' }],
    }],
    notes: [],
  };
}

/** A semantically shaped response for one exhaustive, localized file-problem browser case. */
export function mcpFileProblemInventory(reason: McpConfigProblemReason): McpConfigInventory {
  const trustProblem = reason === 'trust-required' || reason === 'trust-unavailable';
  const bodyWasRead = reason === 'invalid-shape'
    || reason === 'invalid-syntax'
    || reason === 'too-deep'
    || reason === 'too-many-servers';
  const diagnostic = { reason, message: `SOURCE-DIAGNOSTIC-MUST-NOT-RENDER:${reason}` };
  return {
    files: [
      {
        scope: 'global', path: GLOBAL_PATH, exists: true,
        contentRead: trustProblem ? true : bodyWasRead,
        problems: trustProblem ? [] : [diagnostic],
      },
      {
        scope: 'project', path: PROJECT_PATH, exists: trustProblem,
        contentRead: false,
        problems: trustProblem ? [diagnostic] : [],
      },
    ],
    project: {
      cwd: '/workspace', contentTrusted: !trustProblem, requiresTrust: trustProblem,
      decision: trustProblem ? null : true, inherited: false,
      trustError: reason === 'trust-unavailable',
    },
    servers: [],
  };
}
