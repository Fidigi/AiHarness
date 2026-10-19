import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as core from '../index.js';
import type { AgentSettings } from './agent-settings.js';

// Existing pinned SDK-owned Ajv8, not the root Ajv6 or a hand-written validator.
const sdkRequire = createRequire(import.meta.resolve('@modelcontextprotocol/sdk/client/index.js'));
const Ajv2020 = sdkRequire('ajv/dist/2020.js').default;
const ajv = new Ajv2020({ strict: true, allErrors: true });
// Optional annotations document bounds enforced by native loading; they do not
// pretend that standard JSON Schema counts UTF-16 units or UTF-8 file bytes.
for (const keyword of ['x-maxUtf8Bytes', 'x-maxUtf16CodeUnits']) ajv.addKeyword({ keyword, schemaType: 'number', valid: true });
const compiled = new Map<string, (value: unknown) => boolean>();
const compile = (scope: 'global' | 'project' = 'global') => {
  if (!compiled.has(scope)) compiled.set(scope, ajv.compile(core.getAgentSettingsEditorSchema(scope)));
  return compiled.get(scope)!;
};
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function source(global: unknown, project?: unknown, trusted = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-settings-editor-')); dirs.push(root);
  const cwd = path.join(root, 'work'), agentDir = path.join(root, 'agent');
  await mkdir(path.join(cwd, '.ai-harness'), { recursive: true }); await mkdir(agentDir);
  await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify(global));
  if (project !== undefined) await writeFile(path.join(cwd, '.ai-harness/settings.json'), JSON.stringify(project));
  return { root, cwd, agentDir, result: await core.loadAgentSettings({ cwd, agentDir, projectTrusted: trusted }) };
}

// Compile-time exhaustive canonical top-level inventory, with executable native
// samples (not invented schema-only fields or host default values).
const samples = {
  lastChangelogVersion: '0.1.0', defaultProvider: 'mock', defaultModel: 'mock-model', defaultThinkingLevel: 'high',
  modelThinkingLevels: { 'mock/mock-model': 'low' }, thinkingBudgets: { minimal: 0, low: 1, medium: 2, high: 3 },
  enabledModels: ['mock/mock-model:low'], hideThinkingBlock: true, showCacheMissNotices: false, cacheWarming: 'idle',
  steeringMode: 'all', followUpMode: 'one-at-a-time', externalEditor: 'literal-editor --wait', doubleEscapeAction: 'fork',
  treeFilterMode: 'labeled-only', defaultProjectTrust: 'ask', defaultTools: ['read', '+grep'], codemode: { mode: 'only', inlineBudget: 3000 },
  sessionDir: './sessions', compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 200,
    modelOverrides: { 'mock/mock-model': { reserveTokens: 0, keepRecentTokens: 1 } } }, branchSummary: { reserveTokens: 100, skipPrompt: true },
  theme: 'dark', quietStartup: 'header', tuiMode: 'regular', fullscreenExitOutput: 'resume-hint', fullscreenScrollbar: 'hidden',
  fullscreenCopyOnSelect: true, fullscreenWheelScrollLines: 100, editorPaddingX: 3, outputPad: 1, autocompleteMaxVisible: 20,
  showHardwareCursor: true, terminal: { showImages: true, imageWidthCells: 1000, clearOnShrink: false, showTerminalProgress: true,
    hyperlinks: 'auto', images: 'kitty', trueColor: 'auto' }, images: { autoResize: false, blockImages: true },
  markdown: { codeBlockIndent: '', mermaid: 'streaming' }, transport: 'websocket-cached', httpProxy: 'http://127.0.0.1:3128/',
  httpIdleTimeoutMs: 0, websocketConnectTimeoutMs: 3600000, retry: { enabled: false, maxRetries: 10, baseDelayMs: 0,
    maxAgentDelayMs: 3600000, provider: { timeoutMs: 0, maxRetries: 10, maxRetryDelayMs: 3600000 } },
  shellPath: '/bin/sh', shellCommandPrefix: '', npmCommand: ['literal-npm', '--offline'],
  providerApiKeyCommands: { mock: 'printf DO_NOT_EXECUTE' }, packages: ['npm:example', { source: './literal-kit', autoload: false,
    extensions: ['./entry.mjs'], skills: ['./SKILL.md'], prompts: ['./prompt.md'], themes: ['./theme.json'] }],
  extensions: ['./literal.mjs'], skills: ['./SKILL.md'], prompts: ['./prompt.md'], themes: ['./theme.json'], enableSkillCommands: false,
  collapseChangelog: true, enableInstallTelemetry: false, enableAnalytics: false, trackingId: 'example', deviceId: 'example-device',
  warnings: { anthropicExtraUsage: false },
} satisfies Required<AgentSettings>;

describe('owned native agent settings editor schema', () => {
  it('publishes versioned global/project shapes from the canonical exhaustive inventory', () => {
    expect(sdkRequire('ajv/package.json').version).toBe('8.20.0');
    const global = core.getAgentSettingsEditorSchema(), project = core.getAgentSettingsEditorSchema('project');
    expect(global.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(global.$id).toBe('urn:ai-harness:schemas:settings:global:1');
    expect(project.$id).toBe('urn:ai-harness:schemas:settings:project:1');
    expect(Object.keys(global.properties as object).sort()).toEqual([...Object.keys(samples), 'queueMode', 'websockets'].sort());
    expect(global['x-maxUtf8Bytes']).toBe(262144); expect(global.additionalProperties).toBe(false);
    expect(compile()({})).toBe(true); expect(compile('project')({})).toBe(true);
    expect(compile()(samples)).toBe(true);
    expect(() => core.getAgentSettingsEditorSchema('other' as 'global')).toThrow('Settings editor schema scope is invalid.');
  });
  it.each(Object.entries(samples))('round-trips native field %s, without applying defaults or execution', async (key, value) => {
    const document = { [key]: value };
    expect(compile()(document)).toBe(true);
    const { result } = await source(document);
    expect(result.diagnostics).toEqual([]); expect(result.settings).toEqual(document);
  });
  it('owns nested arrays/objects across calls and leaves native validation unmodified', async () => {
    const document = core.getAgentSettingsEditorSchema();
    const properties = document.properties as Record<string, any>;
    properties.defaultThinkingLevel.enum.push('invented'); properties.terminal.properties.images.anyOf.length = 0;
    properties.defaultProvider.maxLength = 999999; properties.retry.properties.provider.properties.maxRetries.maximum = 999;
    const validate = compile(); expect(validate({ defaultThinkingLevel: 'invented' })).toBe(false);
    expect(validate({ terminal: { images: 'kitty' } })).toBe(true); expect(validate({ retry: { provider: { maxRetries: 11 } } })).toBe(false);
    const { result } = await source({ defaultThinkingLevel: 'invented', theme: 'dark' });
    expect(result.settings).toEqual({ theme: 'dark' }); expect(result.diagnostics.map(item => item.setting)).toEqual(['defaultThinkingLevel']);
  });
  it.each([
    { queueMode: 'all', websockets: true, skills: { enableSkillCommands: false, customDirectories: ['./legacy'] }, retry: { maxDelayMs: 1234 } },
    { steeringMode: 'one-at-a-time', queueMode: { ignored: true }, transport: 'auto', websockets: 'ignored', enableSkillCommands: true,
      skills: { customDirectories: [], enableSkillCommands: { ignored: true }, inert: true }, retry: { maxDelayMs: -1.5, provider: { maxRetryDelayMs: 2 } } },
  ])('admits actual legacy migration and modern precedence %#', async document => {
    expect(compile()(document)).toBe(true); const { result } = await source(document); expect(result.diagnostics).toEqual([]);
    expect(result.settings).not.toHaveProperty('queueMode'); expect(result.settings).not.toHaveProperty('websockets');
    expect(result.settings.retry).not.toHaveProperty('maxDelayMs'); expect(Array.isArray(result.settings.skills)).toBe(true);
  });
  it.each([
    { defaultModel: '  ' }, { defaultThinkingLevel: 'unknown' }, { thinkingBudgets: { high: -1 } }, { enabledModels: [''] },
    { defaultTools: Array(257).fill('read') }, { codemode: { inlineBudget: 3001 } }, { compaction: { reserveTokens: 1.5 } },
    { compaction: { modelOverrides: { fixture: { keepRecentTokens: -1 } } } }, { branchSummary: { skipPrompt: 1 } },
    { quietStartup: 'full' }, { fullscreenWheelScrollLines: 101 }, { editorPaddingX: 4 }, { outputPad: 2 }, { autocompleteMaxVisible: 2 },
    { terminal: { images: true } }, { terminal: { imageWidthCells: 0 } }, { markdown: { mermaid: 'yes' } },
    { transport: 'http' }, { httpIdleTimeoutMs: 3600001 }, { retry: { maxRetries: 11 } }, { retry: { provider: { timeoutMs: -1 } } },
    { npmCommand: [] }, { npmCommand: Array(65).fill('npm') }, { providerApiKeyCommands: { 'bad/id': 'printf inert' } },
    { packages: [{ autoload: true }] }, { extensions: [''] }, { skills: { customDirectories: [], enableSkillCommands: 1 } },
    { queueMode: 'invalid' }, { retry: { maxDelayMs: -1 } }, { warnings: { anthropicExtraUsage: 'yes' } },
    { unknownSetting: true }, { terminal: { unknownSetting: true } },
  ])('rejects malformed editor values and native loading diagnoses while salvaging theme %#', async document => {
    expect(compile()(document)).toBe(false);
    const { result } = await source({ ...document, theme: 'dark' });
    expect(result.settings.theme).toBe('dark'); expect(result.diagnostics.length).toBeGreaterThan(0);
  });
  it('keeps project scope/trust independent of schema validity', async () => {
    const global = compile(), project = compile('project');
    for (const key of ['cacheWarming', 'defaultProjectTrust', 'httpProxy', 'deviceId'] as const) {
      const input = { [key]: samples[key] }; expect(global(input)).toBe(true); expect(project(input)).toBe(false);
      const { result } = await source({}, input, true); expect(result.settings).toEqual({});
      expect(result.diagnostics.map(item => item.setting)).toEqual([key]);
    }
    const input = { extensions: ['./DO_NOT_LOAD.mjs'], providerApiKeyCommands: { mock: 'touch MUST_NOT_EXECUTE' }, theme: 'light' };
    expect(project(input)).toBe(true); const { result } = await source({ theme: 'dark' }, input, false);
    expect(result.projectSettings).toEqual({}); expect(result.settings).toEqual({ theme: 'dark' }); expect(result.diagnostics).toEqual([]);
  });
  it('discloses standard character/annotation limits while native UTF-16, bytes and URL rules remain binding', async () => {
    const validate = compile();
    const unicode = { lastChangelogVersion: '😀'.repeat(65) }; expect(validate(unicode)).toBe(true);
    expect((await source(unicode)).result.diagnostics.map(item => item.setting)).toEqual(['lastChangelogVersion']);
    const bytes = { shellCommandPrefix: 'é'.repeat(99999), markdown: { codeBlockIndent: 'x'.repeat(128) },
      providerApiKeyCommands: { mock: 'x'.repeat(16384), local: 'y'.repeat(16384), openai: 'z'.repeat(16384), google: 'w'.repeat(16384) } };
    expect(validate(bytes)).toBe(true); expect(Buffer.byteLength(JSON.stringify(bytes))).toBeGreaterThan(262144);
    expect((await source(bytes)).result.diagnostics[0]?.message).toBe('Settings source exceeds the 262144 byte limit.');
    const proxy = { httpProxy: 'file:///not-an-http-proxy' }; expect(validate(proxy)).toBe(true);
    expect((await source(proxy)).result.diagnostics.map(item => item.setting)).toEqual(['httpProxy']);
    const legacy = { retry: { maxDelayMs: 2, provider: null } }; expect(validate(legacy)).toBe(false);
    const migrated = (await source(legacy)).result; expect(migrated.diagnostics).toEqual([]);
    expect(migrated.settings).toEqual({ retry: { provider: { maxRetryDelayMs: 2 } } });
    const { agentDir } = await source({}); expect(await readFile(path.join(agentDir, 'settings.json'), 'utf8')).toBe('{}');
  });
});
