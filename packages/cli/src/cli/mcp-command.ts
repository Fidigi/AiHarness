import path from 'node:path';
import { runMcpOAuthCommand } from './mcp-oauth-command.js';
import {
  CredentialRedactor,
  importMcpServer,
  inspectMcpConfig,
  isMcpExposure,
  loadAgentSettings,
  McpServerTester,
  ProjectTrustManager,
  readMcpServerTestTarget,
  removeMcpServer,
  resolvePreTrustAgentDirectory,
  setMcpServerExposure,
  setMcpServersEnabled,
  WorkspaceManager,
  type McpConfigInventory,
  type McpConfigScope,
} from '@ai-harness/core';

interface McpCommandIo {
  cwd?: string;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
  signal?: AbortSignal;
}

interface ParsedOptions {
  scope: McpConfigScope;
  json: boolean;
  rest: string[];
}

const HELP = `Usage: ai-harness mcp <command> [options]

Commands:
  list | status                       List configured servers and local status
  test <name>                         Run one bounded connectivity test
  add <name> --url <url>              Add an HTTP server
  add <name> -- <command> [args...]   Add a stdio server
  enable <name> [...]                 Enable servers
  disable <name> [...]                Disable servers
  exposure <name> <mode> [--tool <remote-name>]
                                      Set direct, codemode, deferred, or hidden exposure
  login <name> [--no-open] [--timeout <1..300>]
                                      Authorize OAuth via loopback or terminal paste
  logout <name>                       Remove local OAuth credentials (no remote revocation)
  remove <name>                       Remove a server

Options:
  --scope <global|project>            Configuration scope (default: global)
  --project | --global                Scope aliases
  --json                              Emit JSON
  -h, --help                          Show this help
`;

function parseOptions(args: string[]): ParsedOptions {
  let scope: McpConfigScope = 'global';
  let json = false;
  const rest: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (value === '--') {
      rest.push(...args.slice(index));
      break;
    }
    if (value === '--json') json = true;
    else if (value === '--project') scope = 'project';
    else if (value === '--global') scope = 'global';
    else if (value === '--scope') {
      const selected = args[++index];
      if (selected !== 'global' && selected !== 'project') throw new Error('--scope must be global or project.');
      scope = selected;
    } else if (value.startsWith('--scope=')) {
      const selected = value.slice('--scope='.length);
      if (selected !== 'global' && selected !== 'project') throw new Error('--scope must be global or project.');
      scope = selected;
    } else {
      rest.push(value);
    }
  }
  return { scope, json, rest };
}

function fileRevision(inventory: McpConfigInventory, scope: McpConfigScope): string | null {
  return inventory.files.find(file => file.scope === scope)?.revision ?? null;
}

function formatInventory(inventory: McpConfigInventory): string {
  if (inventory.servers.length === 0) return 'No MCP servers configured.';
  return inventory.servers.map(server => {
    const configured = !server.valid ? 'invalid'
      : server.shadowedByProject ? 'shadowed'
        : !server.enabled ? 'disabled' : 'configured';
    const test = server.testStatus ? `; test=${server.testStatus.state}` : '';
    const runtime = server.runtimeStatus
      ? `; runtime=${server.runtimeStatus.state}${server.runtimeStatus.toolCount === undefined ? '' : `:${server.runtimeStatus.toolCount}`}`
      : '';
    return `${server.name}\t${server.scope}\t${server.transport ?? 'unknown'}\t${server.exposure}\t${configured}${test}${runtime}`;
  }).join('\n');
}

function commandConfig(args: string[]): { name: string; config: Record<string, unknown> } {
  const name = args[0]?.trim();
  if (!name) throw new Error('Usage: ai-harness mcp add <name> --url <url> | -- <command> [args...]');
  const urlIndex = args.indexOf('--url');
  const separator = args.indexOf('--');
  if (urlIndex >= 0) {
    const url = args[urlIndex + 1];
    if (!url || args.length !== 3 || urlIndex !== 1) {
      throw new Error('Usage: ai-harness mcp add <name> --url <url>');
    }
    return { name, config: { url } };
  }
  if (separator !== 1 || !args[separator + 1]) {
    throw new Error('Usage: ai-harness mcp add <name> -- <command> [args...]');
  }
  return {
    name,
    config: { command: args[separator + 1], args: args.slice(separator + 2) },
  };
}

/** Thin CLI adapter over the shared Core MCP inventory, mutation, and test policy. */
export async function runMcpCommand(args: string[], io: McpCommandIo = {}): Promise<number> {
  const write = io.stdout ?? (value => process.stdout.write(value));
  const writeError = io.stderr ?? (value => process.stderr.write(value));
  const redactor = new CredentialRedactor();
  redactor.addEnvironment(process.env);
  let tester: McpServerTester | undefined;
  try {
    if (args.length === 0 || args[0] === '-h' || args[0] === '--help' || args[0] === 'help') {
      write(HELP);
      return 0;
    }
    const command = args[0]!.toLowerCase();
    const parsed = parseOptions(args.slice(1));
    const requestedCwd = path.resolve(io.cwd ?? process.cwd());
    const workspaceManager = new WorkspaceManager({ allowedRoots: [requestedCwd], defaultCwd: requestedCwd });
    await workspaceManager.initialize();
    const cwd = await workspaceManager.getDefaultCwd();
    const trustManager = new ProjectTrustManager(path.join(resolvePreTrustAgentDirectory(cwd), 'trust.json'));
    await trustManager.load();
    const settings = await loadAgentSettings({ cwd, projectTrusted: await trustManager.isTrusted(cwd) });
    const inventoryOptions = { agentDir: settings.agentDir, cwd, trustManager };
    const inventory = await inspectMcpConfig(inventoryOptions);
    const mutationTarget = {
      agentDir: settings.agentDir,
      scope: parsed.scope,
      ...(parsed.scope === 'project' ? { cwd } : {}),
      trustManager,
      expectedRevision: fileRevision(inventory, parsed.scope),
    };

    if (command === 'list' || command === 'status') {
      if (parsed.rest.length) throw new Error(`Usage: ai-harness mcp ${command} [--scope <scope>] [--json]`);
      const scoped = {
        ...inventory,
        servers: inventory.servers.filter(server => server.scope === parsed.scope),
      };
      write(parsed.json ? `${JSON.stringify(scoped, null, 2)}\n` : `${formatInventory(scoped)}\n`);
      return 0;
    }

    if (command === 'login' || command === 'logout') {
      const name = parsed.rest[0];
      if (!name || name.startsWith('-')) throw new Error(`Usage: ai-harness mcp ${command} <name> [--scope <scope>]`);
      return await runMcpOAuthCommand(command, parsed.rest.slice(1), {
        agentDir: settings.agentDir, agentDirTrusted: settings.agentDirTrusted, redactor,
        json: parsed.json, write, writeError, signal: io.signal,
        readTarget: () => readMcpServerTestTarget({
          agentDir: settings.agentDir, scope: parsed.scope, name,
          ...(parsed.scope === 'project' ? { cwd } : {}), defaultCwd: cwd, trustManager,
          resolveWorkingDirectory: (configured, base) => workspaceManager.resolve(configured, { base, kind: 'directory' }),
        }),
      });
    }

    if (command === 'test') {
      const name = parsed.rest[0];
      if (!name || parsed.rest.length !== 1) throw new Error('Usage: ai-harness mcp test <name> [--scope <scope>] [--json]');
      const target = await readMcpServerTestTarget({
        agentDir: settings.agentDir,
        scope: parsed.scope,
        name,
        ...(parsed.scope === 'project' ? { cwd } : {}),
        defaultCwd: cwd,
        trustManager,
        resolveWorkingDirectory: (configured, base) => workspaceManager.resolve(configured, { base, kind: 'directory' }),
      });
      tester = new McpServerTester();
      const result = await tester.test(target);
      write(parsed.json
        ? `${JSON.stringify({ scope: target.scope, name: target.name, configKey: target.configKey, result }, null, 2)}\n`
        : `${target.name}: ${result.state}; ${result.toolCount} tools; ${result.durationMs} ms${result.error ? `; ${result.error}` : ''}\n`);
      return result.state === 'failed' ? 1 : 0;
    }

    if (command === 'add') {
      const { name, config } = commandConfig(parsed.rest);
      const result = await importMcpServer({
        ...mutationTarget,
        text: JSON.stringify({ mcpServers: { [name]: config } }),
        syntax: 'aiharness',
        entryIndex: 0,
        name,
        availableVariableNames: Object.keys(process.env),
      });
      write(parsed.json ? `${JSON.stringify(result)}\n` : `Added MCP server ${result.name} (${result.scope}).\n`);
      return 0;
    }

    if (command === 'enable' || command === 'disable') {
      if (parsed.rest.length === 0) throw new Error(`Usage: ai-harness mcp ${command} <name> [...] [--scope <scope>]`);
      const result = await setMcpServersEnabled({
        ...mutationTarget,
        names: parsed.rest,
        enabled: command === 'enable',
      });
      write(parsed.json ? `${JSON.stringify(result)}\n` : `${command === 'enable' ? 'Enabled' : 'Disabled'}: ${result.outcomes.map(item => `${item.name}=${item.status}`).join(', ')}\n`);
      return 0;
    }

    if (command === 'exposure') {
      const [name, mode, ...extra] = parsed.rest;
      const tool = extra.length === 2 && extra[0] === '--tool' ? extra[1] : undefined;
      if (!name || !isMcpExposure(mode) || (extra.length > 0 && !tool)) {
        throw new Error('Usage: ai-harness mcp exposure <name> <direct|codemode|deferred|hidden> [--tool <remote-name>] [--scope <scope>]');
      }
      const result = await setMcpServerExposure({ ...mutationTarget, name, exposure: mode, ...(tool ? { tool } : {}) });
      write(parsed.json ? `${JSON.stringify(result)}\n` : `Updated ${name}: exposure=${mode}.\n`);
      return 0;
    }

    if (command === 'remove') {
      const name = parsed.rest[0];
      if (!name || parsed.rest.length !== 1) throw new Error('Usage: ai-harness mcp remove <name> [--scope <scope>]');
      const result = await removeMcpServer({ ...mutationTarget, name });
      // The Core result contains server-only undo material; never serialize it here.
      const output = { revision: result.revision, name: result.removed.name, scope: result.removed.scope };
      write(parsed.json ? `${JSON.stringify(output)}\n` : `Removed MCP server ${name} (${parsed.scope}).\n`);
      return 0;
    }

    throw new Error(`Unknown MCP command: ${command}. Run "ai-harness mcp --help".`);
  } catch (error) {
    writeError(`Error: ${redactor.redact(error instanceof Error ? error.message : String(error))}\n`);
    return 1;
  } finally {
    await tester?.shutdown().catch(() => undefined);
  }
}
