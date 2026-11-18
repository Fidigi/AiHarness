import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as core from '@ai-harness/core';

const require = createRequire(import.meta.url);
const sdkRequire = createRequire(require.resolve('@modelcontextprotocol/sdk/client/index.js'));
const Ajv2020 = sdkRequire('ajv/dist/2020.js').default;
assert.equal(sdkRequire('ajv/package.json').version, '8.20.0');
const ajv = new Ajv2020({ strict: true, allErrors: true });
for (const keyword of ['x-maxUtf8Bytes', 'x-maxUtf16CodeUnits']) ajv.addKeyword({ keyword, schemaType: 'number', valid: true });
const cli = path.dirname(require.resolve('@ai-harness/cli/package.json'));
const documents = {};
for (const name of ['settings', 'project-settings', 'models', 'keybindings', 'theme']) {
  documents[name] = JSON.parse(await readFile(path.join(cli, 'dist/schemas', name + '.schema.json'), 'utf8'));
  assert.equal(documents[name].$schema, 'https://json-schema.org/draft/2020-12/schema');
}
assert.deepEqual(documents.settings, core.getAgentSettingsEditorSchema());
assert.deepEqual(documents['project-settings'], core.getAgentSettingsEditorSchema('project'));
assert.deepEqual(documents.models, core.getCustomModelEditorSchema());
const validators = Object.fromEntries(Object.entries(documents).map(([name, document]) => [name, ajv.compile(document)]));
const inputs = {
  settings: { theme: 'dark', defaultModel: 'mock-model', quietStartup: 'header', compaction: { reserveTokens: 100 }, providerApiKeyCommands: { mock: 'DO_NOT_EXECUTE' } },
  'project-settings': { theme: 'light', defaultTools: ['+grep'], skills: ['./literal-skill.md'] },
  models: { provider: 'mock', id: 'native-metadata', capabilities: { reasoning: true, imageInput: false, toolCalls: true }, contextWindow: 128000, pricing: { inputPerMillion: 0 } },
  keybindings: [{ id: 'editor.previous', keys: ['alt', 'up'], preventDefault: false }],
  theme: { name: 'Native schema', appearance: 'dark', vars: { Base: '#123456' }, colors: { accent: 'Base' }, export: { pageBg: '#abc' } },
};
for (const [name, input] of Object.entries(inputs)) assert.equal(validators[name](input), true, name);
assert.equal(validators.settings({ defaultModel: ' ' }), false);
assert.equal(validators['project-settings']({ defaultProjectTrust: 'always' }), false);
assert.equal(validators.models({ provider: 'mock', id: 'native', apiKey: 'NOT_MODEL_DATA' }), false);
assert.equal(validators.models({ provider: 'mock', id: 'native', contextWindow: 0 }), false);
assert.equal(validators.keybindings([{ id: 'bad', keys: [] }]), false);
assert.equal(validators.theme({ name: 'Bad', appearance: 'dark', colors: { unknown: '#abc' } }), false);
assert.equal(documents.theme.properties.colors.propertyNames.enum.length, 58);
for (const token of documents.theme.properties.colors.propertyNames.enum) assert.equal(validators.theme({ name: 'Token', appearance: 'dark', colors: { [token]: '#123456' } }), true);
const root = await mkdtemp(path.join(os.tmpdir(), 'aih-editor-public-'));
try {
  const cwd = path.join(root, 'work'), agentDir = path.join(root, 'agent');
  await mkdir(path.join(cwd, '.ai-harness'), { recursive: true }); await mkdir(agentDir);
  const globalPath = path.join(agentDir, 'settings.json'), projectPath = path.join(cwd, '.ai-harness/settings.json');
  const globalBytes = JSON.stringify(inputs.settings), projectBytes = JSON.stringify(inputs['project-settings']);
  await writeFile(globalPath, globalBytes); await writeFile(projectPath, projectBytes);
  const options = { cwd, agentDir };
  const refused = await core.loadAgentSettings({ ...options, projectTrusted: false });
  assert.deepEqual(refused.settings, inputs.settings); assert.deepEqual(refused.projectSettings, {}); assert.deepEqual(refused.diagnostics, []);
  const trusted = await core.loadAgentSettings({ ...options, projectTrusted: true });
  assert.deepEqual(trusted.diagnostics, []); assert.equal(trusted.settings.theme, 'light');
  assert.deepEqual(trusted.settings.defaultTools, ['+grep']); assert.deepEqual(trusted.settings.skills, ['./literal-skill.md']);
  assert.equal(await readFile(globalPath, 'utf8'), globalBytes); assert.equal(await readFile(projectPath, 'utf8'), projectBytes);
  const target = path.join(agentDir, 'palette.json'); await writeFile(target, JSON.stringify(inputs.theme));
  const loaded = await core.ThemeManager.load(target, [], {}, { cwd, projectTrusted: false });
  assert.equal(loaded.colors.accent, '#123456'); assert.equal(loaded.export.pageBg, '#aabbcc');
  const cycle = { ...inputs.theme, vars: { Base: 'Alias', Alias: 'Base' } }; assert.equal(validators.theme(cycle), true);
  await writeFile(target, JSON.stringify(cycle)); await assert.rejects(core.ThemeManager.load(target, [], {}, { cwd, projectTrusted: false }), /cycle/);
  const malformed = { ...inputs.theme, export: { unknown: '#abc' } }; assert.equal(validators.theme(malformed), false);
  await writeFile(target, JSON.stringify(malformed)); await assert.rejects(core.ThemeManager.load(target, [], {}, { cwd, projectTrusted: false }), /Unknown theme export token/);
} finally { await rm(root, { recursive: true, force: true }); }
assert.equal(core.AI_HARNESS_CORE_API_VERSION, 2);
process.stdout.write('native editor schemas OK\n');
