import { describe, expect, it } from 'vitest';
import {
  MCP_IMPORT_MAX_BYTES,
  previewMcpImport,
  type McpImportNoteCode,
} from './config-import.js';
import { splitMcpShellWords } from './import-shell.js';

function codes(result: ReturnType<typeof previewMcpImport>): McpImportNoteCode[] {
  return [...result.notes, ...result.entries.flatMap(entry => entry.notes)].map(item => item.code);
}

describe('previewMcpImport', () => {
  it('previews a URL without returning credentials, path, query values, or fragments', () => {
    const result = previewMcpImport('http://aliceidentity:pw-value-9382@example.test/private/token?api_key=TOP_SECRET#fragment');

    expect(result.ok).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      source: 'url',
      persisted: {
        transport: 'http',
        url: 'http://example.test/•••?•••#•••',
        headerNames: ['Authorization'],
        masked: true,
      },
      literalSecretFields: ['headers.Authorization', 'url'],
      scopes: {
        global: { allowed: true },
        project: { allowed: false, reasons: ['no-project', 'literal-secret'] },
      },
    });
    expect(codes(result)).toEqual(expect.arrayContaining(['insecure-http', 'userinfo-moved', 'literal-secret']));
    const serialized = JSON.stringify(result);
    for (const secret of ['aliceidentity', 'pw-value-9382', 'private', 'TOP_SECRET', 'fragment']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('escapes foreign literals in resolved fields and only preserves explicit foreign references', () => {
    const result = previewMcpImport(JSON.stringify({
      mcpServers: {
        docs: {
          url: 'https://docs.example.test/mcp',
          headers: {
            Authorization: 'Bearer ${DOCS_TOKEN}',
            'X-Literal': '$NOT_A_REFERENCE',
            'X-Command': '!printf secret',
          },
        },
      },
    }), { availableVariableNames: ['DOCS_TOKEN'] });

    const entry = result.entries[0]!;
    expect(entry.variables).toEqual([{
      field: 'headers.Authorization',
      name: 'DOCS_TOKEN',
      availability: 'available',
      remote: true,
      confirmationRequired: true,
    }]);
    expect(entry.persisted.commandFields).toEqual([]);
    expect(entry.persisted.variableReferences).toEqual([{
      field: 'headers.Authorization',
      names: ['DOCS_TOKEN'],
    }]);
    expect(entry.scopes.global.confirmations).toEqual(['remote-host-variable']);
    expect(entry.scopes.project.confirmations).toEqual(['remote-host-variable']);
    expect(codes(result)).toEqual(expect.arrayContaining(['literal-escaped', 'host-variable-confirmation']));
    expect(JSON.stringify(result)).not.toContain('printf secret');
  });

  it('does not reinterpret already escaped foreign literals as references', () => {
    const result = previewMcpImport(JSON.stringify({
      command: 'server',
      env: { LITERAL: '$$NOT_A_REFERENCE', COMMAND: '$!not-a-command' },
    }), { availableVariableNames: ['NOT_A_REFERENCE'] });

    expect(result.entries[0]!.variables).toEqual([]);
    expect(result.entries[0]!.persisted.variableReferences).toEqual([]);
    expect(result.entries[0]!.persisted.commandFields).toEqual([]);
  });

  it('honors AiHarness references and command-backed values only when explicitly requested', () => {
    const paste = JSON.stringify({
      mcpServers: {
        docs: {
          url: 'https://docs.example.test',
          headers: { Authorization: '!credential-helper', 'X-Token': '$DOCS_TOKEN' },
        },
      },
    });
    const foreign = previewMcpImport(paste, { availableVariableNames: ['DOCS_TOKEN'] });
    const native = previewMcpImport(paste, {
      syntax: 'aiharness',
      availableVariableNames: ['DOCS_TOKEN'],
    });

    expect(foreign.entries[0]!.variables).toEqual([]);
    expect(foreign.entries[0]!.persisted.commandFields).toEqual([]);
    expect(native.entries[0]!.variables).toEqual([expect.objectContaining({
      field: 'headers.X-Token', name: 'DOCS_TOKEN', availability: 'available',
    })]);
    expect(native.entries[0]!.persisted.commandFields).toEqual(['headers.Authorization']);
    expect(codes(native)).toContain('command-value');

    const foreignCommand = previewMcpImport('TOKEN=!credential-helper npx docs-mcp');
    const nativeCommand = previewMcpImport('TOKEN=!credential-helper npx docs-mcp', { syntax: 'aiharness' });
    expect(foreignCommand.entries[0]!.persisted.commandFields).toEqual([]);
    expect(nativeCommand.entries[0]!.persisted.commandFields).toEqual(['env.TOKEN']);
  });

  it('reports placeholders and references in unresolved fields without resolving them', () => {
    const result = previewMcpImport(JSON.stringify({
      command: '<binary>',
      args: ['--token', '${ARG_TOKEN}', '--tenant=YOUR_TENANT'],
      env: { API_TOKEN: 'YOUR_API_TOKEN' },
    }), { availableVariableNames: ['ARG_TOKEN'] });

    expect(result.ok).toBe(true);
    expect(result.entries[0]!.complete).toBe(false);
    expect(result.entries[0]!.fields.map(field => field.field)).toEqual(expect.arrayContaining([
      'command', 'args[1]', 'args[2]', 'env.API_TOKEN',
    ]));
    expect(result.entries[0]!.fields.find(field => field.field === 'args[1]')).toMatchObject({
      kind: 'secret', canReference: false,
    });
    expect(result.entries[0]!.variables).toEqual([]);
    expect(codes(result)).toEqual(expect.arrayContaining(['unsupported-reference', 'missing-value']));
    expect(JSON.stringify(result)).not.toContain('YOUR_API_TOKEN');
  });

  it('marks absent variables and blocks reserved AiHarness authentication variables in every scope', () => {
    const result = previewMcpImport(JSON.stringify({
      mcpServers: {
        remote: {
          url: 'https://example.test',
          headers: {
            Authorization: 'Bearer ${AI_HARNESS_AUTH_TOKEN}',
            'X-Optional': '${UNSET_TOKEN}',
          },
        },
      },
    }));
    const entry = result.entries[0]!;

    expect(entry.variables).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'AI_HARNESS_AUTH_TOKEN', availability: 'reserved' }),
      expect.objectContaining({ name: 'UNSET_TOKEN', availability: 'missing' }),
    ]));
    expect(entry.scopes.global).toEqual({ allowed: false, reasons: ['reserved-variable'], confirmations: [] });
    expect(entry.scopes.project).toEqual({
      allowed: false,
      reasons: ['no-project', 'reserved-variable'],
      confirmations: [],
    });
    expect(codes(result)).toEqual(expect.arrayContaining(['reserved-variable', 'missing-variable']));

    const unsupportedLocation = previewMcpImport(JSON.stringify({
      url: 'https://example.test/${AI_HARNESS_MASTER_KEY}',
    }));
    expect(unsupportedLocation.entries[0]!.variables).toEqual([]);
    expect(unsupportedLocation.entries[0]!.scopes.global.reasons).toContain('reserved-variable');
    expect(unsupportedLocation.entries[0]!.scopes.project.reasons).toContain('reserved-variable');

    const commandBacked = previewMcpImport(JSON.stringify({
      url: 'https://example.test/mcp',
      headers: { Authorization: '!helper $AI_HARNESS_ADMIN_TOKEN' },
    }), { syntax: 'aiharness' });
    expect(commandBacked.entries[0]!.persisted.commandFields).toEqual(['headers.Authorization']);
    expect(commandBacked.entries[0]!.scopes.global.reasons).toContain('reserved-variable');
    expect(commandBacked.entries[0]!.scopes.project.reasons).toContain('reserved-variable');
  });

  it('does not offer an invalid normalized entry to either scope', () => {
    const result = previewMcpImport(JSON.stringify({ mcpServers: { invalid: { url: 'ftp://example.test/mcp' } } }));
    expect(result.entries[0]!.persisted.valid).toBe(false);
    expect(result.entries[0]!.scopes.global.reasons).toContain('invalid-entry');
    expect(result.entries[0]!.scopes.project.reasons).toEqual(expect.arrayContaining(['no-project', 'invalid-entry']));
  });

  it('applies scope availability, trust, name collision, and literal-secret policies independently', () => {
    const result = previewMcpImport('API_TOKEN=literal-secret npx @example/mcp-server', {
      scopes: {
        global: { available: true, names: ['example'] },
        project: { available: false, unavailableReason: 'trust-required', names: [] },
      },
    });
    const entry = result.entries[0]!;

    expect(entry.name).toBe('example');
    expect(entry.scopes.global).toEqual({
      allowed: false,
      reasons: ['name-taken'],
      confirmations: ['literal-secret'],
    });
    expect(entry.scopes.project).toEqual({
      allowed: false,
      reasons: ['trust-required', 'literal-secret'],
      confirmations: [],
    });
    expect(codes(result)).toEqual(expect.arrayContaining(['literal-secret', 'name-taken']));
  });

  it.each([
    'https://example.test/sse',
    'wss://example.test/mcp',
    JSON.stringify({ mcpServers: { old: { type: 'sse', url: 'https://example.test/events' } } }),
    JSON.stringify({ mcpServers: { old: { transportType: 'sse', url: 'https://example.test/events' } } }),
    JSON.stringify({ mcpServers: { old: { tcp: { host: 'example.test', port: 9000 } } } }),
  ])('refuses unsupported SSE and WebSocket transports: %s', paste => {
    const result = previewMcpImport(paste);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('unsupported-transport');
  });

  it.each([
    'npx server; touch /tmp/pwned',
    'npx server | sh',
    'npx $(touch /tmp/pwned)',
    'npx `touch /tmp/pwned`',
    'npx server\nrm -rf /',
    'sh -c "server | touch /tmp/pwned"',
    'cmd.exe /c "server & echo pwned"',
    'cmd.exe /k server',
    'pwsh -Command "server; Write-Output pwned"',
    'npx safe\u202espoofed',
    'npx safe\u200bspoofed',
  ])('refuses shell operators, substitutions, hidden text, and multiple commands: %s', paste => {
    const result = previewMcpImport(paste);
    expect(result).toEqual({
      ok: false,
      entries: [],
      notes: [{ code: 'unsafe-shell', severity: 'error' }],
    });
  });

  it.each([
    JSON.stringify({ command: 'sh', args: ['-c', 'run-server'] }),
    JSON.stringify({ command: 'env', args: ['TOKEN=value', 'pwsh', '-Command', 'run-server'] }),
    JSON.stringify({ command: 'env', args: ['-S', 'sh -c "run-server"'] }),
    JSON.stringify({ command: 'pwsh', args: ['-enc', 'cgB3AG4AZQBkAA=='] }),
    'ai-harness mcp add docs -- cmd.exe /k run-server',
    'codex mcp add docs -- bash -lc run-server',
  ])('refuses shell evaluators in every supported import form: %s', paste => {
    expect(previewMcpImport(paste)).toEqual({
      ok: false,
      entries: [],
      notes: [{ code: 'unsafe-shell', severity: 'error' }],
    });
  });

  it('marks unsafe native command-backed values invalid without executing them', () => {
    const result = previewMcpImport(JSON.stringify({
      command: 'server',
      env: { TOKEN: '!sh -c "printf pwned"' },
    }), { syntax: 'aiharness' });

    expect(result.entries[0]!.persisted.valid).toBe(false);
    expect(result.entries[0]!.scopes.global.reasons).toContain('invalid-entry');
    expect(result.entries[0]!.scopes.project.reasons).toContain('invalid-entry');
    expect(codes(result)).toEqual(expect.arrayContaining(['command-value', 'unsafe-shell', 'invalid-entry']));

    const management = previewMcpImport(JSON.stringify({
      command: 'server',
      env: { TOKEN: '!claude mcp login prod' },
    }), { syntax: 'aiharness' });
    expect(management.entries[0]!.persisted.valid).toBe(false);
    expect(codes(management)).toEqual(expect.arrayContaining(['command-value', 'management-command', 'invalid-entry']));
  });

  it.each([
    'claude mcp remove prod',
    'codex mcp list',
    'gemini mcp reset',
    'ai-harness mcp test prod',
    'TOKEN=value env claude mcp remove prod',
    'npx -y @anthropic-ai/claude-code mcp remove prod',
    JSON.stringify({ command: 'claude', args: ['mcp', 'remove', 'prod'] }),
  ])('refuses pasted MCP management commands: %s', paste => {
    expect(previewMcpImport(paste).notes).toEqual([
      { code: 'management-command', severity: 'error' },
    ]);
  });

  it('parses AiHarness, Claude, Codex, Gemini, and VS Code add commands as data', () => {
    const samples = [
      ['ai-harness mcp add --scope project --env TOKEN=$TOKEN docs -- npx -y docs-mcp', 'aiharness-command'],
      ['claude mcp add --transport http --header "Authorization: Bearer $TOKEN" docs https://docs.example.test', 'claude-command'],
      ['codex mcp add --env TOKEN=${TOKEN} docs -- npx -y docs-mcp', 'codex-command'],
      ['gemini mcp add --transport http docs https://docs.example.test', 'gemini-command'],
      ['npx -y @openai/codex mcp add docs -- npx -y docs-mcp', 'codex-command'],
      ['code --add-mcp \'{"name":"docs","command":"npx","args":["docs-mcp"]}\'', 'vscode-command'],
    ] as const;

    for (const [paste, source] of samples) {
      const result = previewMcpImport(paste, { availableVariableNames: ['TOKEN'] });
      expect(result.ok, paste).toBe(true);
      expect(result.entries[0]!.source, paste).toBe(source);
      expect(result.entries[0]!.name, paste).toBe('docs');
      if (source === 'claude-command') {
        expect(result.entries[0]!.variables).toEqual([
          expect.objectContaining({ name: 'TOKEN', availability: 'available' }),
        ]);
      }
    }
  });

  it('parses supported JSON container formats and drops unrecognized properties', () => {
    const samples = [
      [{ mcpServers: { docs: { command: 'npx', args: ['docs-mcp'] } } }, 'mcp-json'],
      [{ servers: { docs: { type: 'stdio', command: 'npx', args: ['docs-mcp'] } } }, 'vscode-json'],
      [{ context_servers: { docs: { command: { path: 'npx', args: ['docs-mcp'], ignored: true } } } }, 'zed-json'],
      [{ mcp: { docs: { type: 'local', command: ['npx', 'docs-mcp'], ignored: true } } }, 'opencode-json'],
    ] as const;

    for (const [value, source] of samples) {
      const result = previewMcpImport(JSON.stringify(value));
      expect(result.entries[0]!.source).toBe(source);
      expect(result.entries[0]!.persisted).toMatchObject({
        valid: true,
        transport: 'stdio',
      });
    }
    expect(codes(previewMcpImport(JSON.stringify(samples[2]![0])))).toContain('dropped-properties');
  });

  it('decodes Cursor and VS Code install links without including encoded source in the result', () => {
    const config = JSON.stringify({ command: 'npx', args: ['-y', 'docs-mcp', '--token', 'SECRET_VALUE'] });
    const cursor = `cursor://anysphere.cursor-deeplink/mcp/install?name=docs&config=${Buffer.from(config).toString('base64url')}`;
    const vscode = `vscode:mcp/install?${encodeURIComponent(config)}`;
    const wrapped = encodeURIComponent(JSON.stringify({ name: 'docs', config: JSON.parse(config) }));
    const visualStudio = `vsweb+mcp:install?${wrapped}`;
    const copilot = `ghapp://mcp/install?${wrapped}`;

    for (const [paste, source] of [
      [cursor, 'cursor-install-link'],
      [vscode, 'vscode-install-link'],
      [visualStudio, 'visual-studio-install-link'],
      [copilot, 'copilot-app-install-link'],
    ] as const) {
      const result = previewMcpImport(paste);
      expect(result.ok).toBe(true);
      expect(result.entries[0]).toMatchObject({ source, name: 'docs' });
      expect(JSON.stringify(result)).not.toContain('SECRET_VALUE');
      expect(JSON.stringify(result)).not.toContain('base64');
    }
  });

  it('bounds bytes, nesting, entry count, field count, and malformed JSON', () => {
    expect(previewMcpImport('x'.repeat(MCP_IMPORT_MAX_BYTES + 1)).notes[0]!.code).toBe('input-too-large');
    expect(previewMcpImport(`${'['.repeat(65)}0${']'.repeat(65)}`).notes[0]!.code).toBe('too-deep');
    expect(previewMcpImport(JSON.stringify({
      mcpServers: Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`s${index}`, { command: 'x' }])),
    })).notes[0]!.code).toBe('too-many-servers');
    expect(previewMcpImport(JSON.stringify({
      command: 'server',
      env: Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`FIELD_${index}`, 'value'])),
    })).notes[0]!.code).toBe('too-many-fields');
    expect(previewMcpImport(JSON.stringify({
      command: 'server',
      ignored: Array.from({ length: 129 }, () => null),
    })).notes[0]!.code).toBe('too-many-fields');
    expect(previewMcpImport(JSON.stringify({ command: 'x'.repeat(16 * 1024 + 1) })).notes[0]!.code)
      .toBe('invalid-entry');
    expect(previewMcpImport(`https://example.test/${'x'.repeat(16 * 1024)}`).notes[0]!.code)
      .toBe('invalid-entry');
    expect(previewMcpImport('{ broken').notes[0]!.code).toBe('invalid-json');
  });

  it('never returns source snippets or resolved environment values', () => {
    process.env.IMPORT_PREVIEW_SECRET = 'HOST_VALUE_THAT_MUST_NOT_APPEAR';
    try {
      const sourceSecret = 'SOURCE_VALUE_THAT_MUST_NOT_APPEAR';
      const result = previewMcpImport(JSON.stringify({
        command: 'npx',
        args: ['server', '--verbose', '--password', sourceSecret],
        env: { TOKEN: '${IMPORT_PREVIEW_SECRET}' },
      }), { availableVariableNames: Object.keys(process.env) });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(sourceSecret);
      expect(serialized).not.toContain('--verbose');
      expect(result.entries[0]!.persisted.args).toEqual(['•••', '•••', '•••', '•••']);
      expect(result.entries[0]!.persisted.masked).toBe(true);
      expect(serialized).not.toContain(process.env.IMPORT_PREVIEW_SECRET);
      expect(serialized).not.toContain('"sourceText"');
      expect(result.entries[0]!.variables[0]).toMatchObject({
        name: 'IMPORT_PREVIEW_SECRET', availability: 'available', remote: false,
      });
    } finally {
      delete process.env.IMPORT_PREVIEW_SECRET;
    }
  });

  it('refuses unsupported native reference forms instead of silently resolving them', () => {
    const result = previewMcpImport(JSON.stringify({
      url: 'https://example.test/mcp',
      headers: {
        'X-Fallback': '${OPTIONAL_TOKEN:-fallback}',
        'X-Reserved': '${AI_HARNESS_AUTH_TOKEN:-fallback}',
      },
    }), { syntax: 'aiharness' });

    expect(result.entries[0]!.fields.map(field => field.field)).toEqual(expect.arrayContaining([
      'headers.X-Fallback', 'headers.X-Reserved',
    ]));
    expect(result.entries[0]!.variables).toEqual([]);
    expect(result.entries[0]!.scopes.global.reasons).toContain('reserved-variable');
    expect(codes(result)).toEqual(expect.arrayContaining(['unsupported-reference', 'reserved-variable']));
  });

  it('treats references outside resolved fields as values that must be replaced', () => {
    const result = previewMcpImport(JSON.stringify({
      url: 'https://example.test/mcp',
      description: '${DESCRIPTION}',
      oauth: { clientId: '$CLIENT_ID', scopes: ['read:${TENANT}'] },
    }));

    expect(result.entries[0]!.fields.map(field => field.field)).toEqual(expect.arrayContaining([
      'description', 'oauth.clientId', 'oauth.scopes[0]',
    ]));
    expect(result.entries[0]!.variables).toEqual([]);
    expect(codes(result)).toContain('unsupported-reference');
  });
});

describe('splitMcpShellWords', () => {
  it('reads quoting and Windows paths without executing or expanding anything', () => {
    expect(splitMcpShellWords('env TOKEN="$TOKEN" npx "my package" C:\\tools\\server.exe')).toEqual({
      ok: true,
      words: ['env', 'TOKEN=$TOKEN', 'npx', 'my package', 'C:\\tools\\server.exe'],
    });
    expect(previewMcpImport('C:\\tools\\mcp-server.exe').entries[0]).toMatchObject({
      source: 'command-line',
      name: 'server',
      persisted: { transport: 'stdio' },
    });
  });

  it('allows an operator only when it is quoted data', () => {
    expect(splitMcpShellWords('npx server "a|b&c"')).toEqual({
      ok: true,
      words: ['npx', 'server', 'a|b&c'],
    });
  });
});
