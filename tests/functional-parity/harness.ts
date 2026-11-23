import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  JsonlSessionStore,
  serializeSession,
  type SerializedSession,
  type SessionEntry,
} from '@ai-harness/core';

export const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
export const fixtureRoot = path.join(repositoryRoot, 'tests', 'functional-parity', 'fixtures');
const cliEntry = path.join(repositoryRoot, 'packages', 'cli', 'src', 'index.ts');
const tsxImport = createRequire(import.meta.url).resolve('tsx');
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const ISO_TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

export interface GoldenFileExpectation {
  path: string;
  fixture: string;
}

export interface ProcessScenario {
  id: string;
  description: string;
  criteria: string[];
  args: string[];
  stdin?: string;
  stdinFixture?: string;
  workspaceFiles?: Array<{ source: string; destination: string }>;
  environment?: Record<string, string>;
  interaction?: {
    method: 'confirm' | 'input' | 'select' | 'editor';
    commandId: string;
    response: Record<string, unknown>;
  };
  expected: {
    exitCode: number;
    stdout: string;
    stderr: string;
    files?: GoldenFileExpectation[];
  };
}

export interface SessionScenario {
  id: string;
  description: string;
  criteria: string[];
  sessionId: string;
  input: string;
  rewrite: boolean;
  expected: string;
}

export interface SdkScenario {
  id: string;
  description: string;
  criteria: string[];
  kind: 'runtime' | 'types';
  input: string;
  expected: string;
  expectSuccess?: boolean;
}

export interface ParityManifest {
  version: number;
  processScenarios: ProcessScenario[];
  sessionScenarios: SessionScenario[];
  sdkScenarios: SdkScenario[];
}

export interface ProcessScenarioResult {
  code: number | null;
  stdout: string;
  stderr: string;
  workspace: string;
  cleanup(): Promise<void>;
}

export async function loadManifest(): Promise<ParityManifest> {
  return JSON.parse(await readFile(path.join(fixtureRoot, 'manifest.json'), 'utf8')) as ParityManifest;
}

function substitute(value: string, workspace: string): string {
  return value
    .replaceAll('<WORKSPACE>', workspace)
    .replaceAll('<FIXTURES>', fixtureRoot)
    .replaceAll('<REPOSITORY>', repositoryRoot);
}

async function prepareWorkspace(scenario: ProcessScenario): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'aih-parity-'));
  for (const file of scenario.workspaceFiles ?? []) {
    const destination = path.join(workspace, file.destination);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(fixtureRoot, file.source), destination);
  }
  for (const file of scenario.expected.files ?? []) {
    await mkdir(path.dirname(path.join(workspace, file.path)), { recursive: true });
  }
  return workspace;
}

export async function runProcessScenario(scenario: ProcessScenario): Promise<ProcessScenarioResult> {
  const workspace = await prepareWorkspace(scenario);
  const args = scenario.args.map(argument => substitute(argument, workspace));
  const environment = Object.fromEntries(
    Object.entries(scenario.environment ?? {}).map(([key, value]) => [key, substitute(value, workspace)]),
  );
  const child = spawn(process.execPath, ['--import', tsxImport, cliEntry, ...args], {
    cwd: workspace,
    env: {
      ...process.env,
      HOME: path.join(workspace, 'home'),
      AI_HARNESS_AGENT_DIR: path.join(workspace, 'agent'),
      AI_HARNESS_DEFAULT_PROVIDER: '',
      AI_HARNESS_EXTENSIONS: '',
      NO_COLOR: '1',
      NODE_NO_WARNINGS: '1',
      ...environment,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let lineBuffer = '';
  let interactionAnswered = false;
  let stdinEnded = false;
  const endInput = (): void => {
    if (stdinEnded) return;
    stdinEnded = true;
    child.stdin.end();
  };
  const inspectLine = (line: string): void => {
    if (!scenario.interaction || !line.trim()) return;
    let record: Record<string, unknown>;
    try { record = JSON.parse(line) as Record<string, unknown>; }
    catch { return; }
    if (!interactionAnswered
      && record.type === 'extension_ui_request'
      && record.method === scenario.interaction.method
      && typeof record.id === 'string') {
      interactionAnswered = true;
      child.stdin.write(`${JSON.stringify({
        type: 'extension_ui_response',
        id: record.id,
        ...scenario.interaction.response,
      })}\n`);
    }
    if (record.type === 'response' && record.id === scenario.interaction.commandId) endInput();
  };

  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
    lineBuffer += chunk;
    while (true) {
      const newline = lineBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = lineBuffer.slice(0, newline);
      lineBuffer = lineBuffer.slice(newline + 1);
      inspectLine(line);
    }
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });

  if (scenario.interaction) {
    const input = scenario.stdinFixture
      ? await readFile(path.join(fixtureRoot, scenario.stdinFixture), 'utf8')
      : scenario.stdin ?? '';
    child.stdin.write(input);
  } else {
    const input = scenario.stdinFixture
      ? await readFile(path.join(fixtureRoot, scenario.stdinFixture), 'utf8')
      : scenario.stdin;
    child.stdin.end(input);
    stdinEnded = true;
  }

  const code = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Parity scenario timed out: ${scenario.id}`));
    }, 20_000);
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', value => {
      clearTimeout(timeout);
      resolve(value);
    });
  }).catch(async error => {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  });

  if (scenario.interaction && !interactionAnswered) {
    await rm(workspace, { recursive: true, force: true });
    throw new Error(`Scenario did not receive its ${scenario.interaction.method} interaction: ${scenario.id}`);
  }
  return {
    code,
    stdout,
    stderr,
    workspace,
    cleanup: () => rm(workspace, { recursive: true, force: true }),
  };
}

function replaceVolatileText(value: string, workspace?: string): string {
  let result = value.replaceAll('\r\n', '\n');
  if (workspace) result = result.replaceAll(workspace, '<WORKSPACE>');
  result = result
    .replaceAll(fixtureRoot, '<FIXTURES>')
    .replaceAll(repositoryRoot, '<REPOSITORY>')
    .replace(UUID_PATTERN, '<UUID>')
    .replace(ISO_TIMESTAMP_PATTERN, '<TIMESTAMP>');
  return result;
}

function canonicalJson(value: unknown, key?: string, workspace?: string): unknown {
  if (Array.isArray(value)) return value.map(item => canonicalJson(item, undefined, workspace));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([childKey, child]) => [childKey, canonicalJson(child, childKey, workspace)]),
    );
  }
  if (typeof value === 'string') {
    if (key === 'workspaceId' && /^[0-9a-f]{24}$/i.test(value)) return '<WORKSPACE_ID>';
    return replaceVolatileText(value, workspace);
  }
  if (typeof value === 'number' && key && /(?:timestamp|createdAt|updatedAt)$/i.test(key)) {
    return '<TIMESTAMP>';
  }
  if (typeof value === 'number' && key === 'durationMs') return '<DURATION_MS>';
  return value;
}

export function normalizeFixture(value: string, fixturePath: string, workspace?: string): string {
  const replaced = replaceVolatileText(value, workspace);
  if (fixturePath.endsWith('.jsonl')) {
    const records = replaced.split('\n').filter(line => line.trim()).map(line => canonicalJson(JSON.parse(line), undefined, workspace));
    return records.length ? `${records.map(record => JSON.stringify(record)).join('\n')}\n` : '';
  }
  if (fixturePath.endsWith('.json')) {
    return `${JSON.stringify(canonicalJson(JSON.parse(replaced), undefined, workspace), null, 2)}\n`;
  }
  return replaced;
}

export async function readExpected(relativePath: string): Promise<string> {
  return readFile(path.join(fixtureRoot, relativePath), 'utf8');
}

export async function assertProcessScenario(
  scenario: ProcessScenario,
  result: ProcessScenarioResult,
): Promise<{ actual: Record<string, string>; expected: Record<string, string> }> {
  const actual: Record<string, string> = {
    stdout: normalizeFixture(result.stdout, scenario.expected.stdout, result.workspace),
    stderr: normalizeFixture(result.stderr, scenario.expected.stderr, result.workspace),
  };
  const expected: Record<string, string> = {
    stdout: normalizeFixture(await readExpected(scenario.expected.stdout), scenario.expected.stdout),
    stderr: normalizeFixture(await readExpected(scenario.expected.stderr), scenario.expected.stderr),
  };
  for (const file of scenario.expected.files ?? []) {
    const key = `file:${file.path}`;
    actual[key] = normalizeFixture(
      await readFile(path.join(result.workspace, file.path), 'utf8'),
      file.fixture,
      result.workspace,
    );
    expected[key] = normalizeFixture(await readExpected(file.fixture), file.fixture);
  }
  return { actual, expected };
}

export async function runSessionScenario(scenario: SessionScenario): Promise<unknown> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aih-parity-session-'));
  try {
    await copyFile(path.join(fixtureRoot, scenario.input), path.join(directory, `${scenario.sessionId}.jsonl`));
    const store = new JsonlSessionStore(directory);
    let session = await store.loadSession(scenario.sessionId);
    if (scenario.rewrite && session) {
      await store.saveSession(session);
      session = await store.loadSession(scenario.sessionId);
    }
    const rawEntries = await store.getRawEntries(scenario.sessionId);
    let diskEntries: unknown[] | undefined;
    if (scenario.rewrite) {
      diskEntries = (await readFile(path.join(directory, `${scenario.sessionId}.jsonl`), 'utf8'))
        .split('\n').filter(Boolean).map(line => JSON.parse(line) as unknown);
    }
    return JSON.parse(JSON.stringify({
      session: session ? serializeSession(session) as SerializedSession : null,
      rawEntries: rawEntries as SessionEntry[],
      ...(diskEntries ? { diskEntries } : {}),
    })) as unknown;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function runTypeProbe(relativePath: string): Record<string, unknown> {
  const input = path.join(fixtureRoot, relativePath);
  const program = ts.createProgram([input], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
    types: ['node'],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program)
    .filter(diagnostic => !diagnostic.file || path.resolve(diagnostic.file.fileName) === path.resolve(input))
    .map(diagnostic => {
      const position = diagnostic.file && diagnostic.start !== undefined
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
        : undefined;
      return {
        code: diagnostic.code,
        category: ts.DiagnosticCategory[diagnostic.category].toLowerCase(),
        ...(position ? { line: position.line + 1, column: position.character + 1 } : {}),
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      };
    });
  return { success: diagnostics.length === 0, diagnostics };
}

export async function runRuntimeProbe(relativePath: string): Promise<Record<string, unknown>> {
  const child = spawn(process.execPath, [path.join(fixtureRoot, relativePath)], {
    cwd: repositoryRoot,
    env: { ...process.env, NO_COLOR: '1', NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Runtime SDK probe timed out: ${relativePath}`));
    }, 10_000);
    child.once('error', reject);
    child.once('close', value => {
      clearTimeout(timeout);
      resolve(value);
    });
  });
  return {
    code,
    stdout: stdout.trim() ? JSON.parse(stdout) as unknown : null,
    stderr,
  };
}

export async function assertFixtureImportsAreAiHarnessOwned(): Promise<void> {
  const files = [
    'extensions/contract-extension.mjs',
    'extensions/invalid-extension.mjs',
    'extensions/noisy-extension.mjs',
    'sdk/runtime-probe.mjs',
    'sdk/types-positive.ts',
    'sdk/types-negative.ts',
  ];
  const allowed = new Set(['@ai-harness/core']);
  for (const relativePath of files) {
    const source = await readFile(path.join(fixtureRoot, relativePath), 'utf8');
    const imports = [...source.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)].map(match => match[2]!);
    for (const specifier of imports) {
      if (specifier.startsWith('.') || specifier.startsWith('node:') || allowed.has(specifier)) continue;
      throw new Error(`Parity fixture ${relativePath} imports a non-AiHarness public package: ${specifier}`);
    }
  }
}
