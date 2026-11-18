import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import yaml from 'js-yaml';
import { validateBase, pagesBase } from '../scripts/base-path.mjs';
import { assertNoSecrets, validateArtifact } from '../scripts/artifact.mjs';

let directory, fixtures, state;
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'aih-demo-unit-'));
  for (const name of ['fixtures', 'state']) {
    const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    await writeFile(path.join(directory, `${name}.mjs`), output.replace("from './fixtures'", "from './fixtures.mjs'"));
  }
  fixtures = await import(pathToFileURL(path.join(directory, 'fixtures.mjs')));
  state = await import(pathToFileURL(path.join(directory, 'state.mjs')));
});
after(async () => { await rm(directory, { recursive: true, force: true }); });

test('base validation rejects URLs, traversal, ambiguous separators, encodings and shell-shaped input', () => {
  for (const value of ['/', '/AiHarness/', '/preview/nested_demo/']) assert.equal(validateBase(value), value);
  for (const value of ['', 'demo', '/demo', '//', '/a//b/', '/a/../b/', '/%2e%2e/', '/a?b/', '/a#b/', '/a.b/', '/a\\b/', 'https://example.invalid/', '/$(id)/', null]) assert.throws(() => validateBase(value));
  assert.equal(pagesBase('Fidigi/AiHarness'), '/AiHarness/');
  assert.equal(pagesBase('Example/example.github.io'), '/');
  assert.throws(() => pagesBase('owner/repo/extra'));
  assert.throws(() => pagesBase('owner/repo.with.dots'));
});

test('fixtures are authored, secret-free and never carry provider credential fields', () => {
  const data = { models: fixtures.models, tools: fixtures.tools, sessions: fixtures.freshSessions(), files: fixtures.initialFiles };
  assertNoSecrets(JSON.stringify(data));
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert(!/^(?:apiKey|access_token|refresh_token|client_secret|authorization|credentials)$/i.test(key));
      visit(child);
    }
  };
  visit(data);
  assert.equal(fixtures.models.every(model => model.provider === 'mock'), true);
  assert.equal(fixtures.freshSessions().length, 2);
  assert.notEqual(fixtures.freshSessions()[0], fixtures.freshSessions()[0]);
});

test('secret scanner fails closed on representative key/token/private-key shapes', () => {
  for (const sample of ['sk-' + 'x'.repeat(30), 'ghp_' + 'x'.repeat(30), 'AKIA' + 'A'.repeat(16), '-----BEGIN PRIVATE KEY-----', JSON.stringify({ apiKey: 'synthetic-forbidden-value' })]) assert.throws(() => assertNoSecrets(sample));
  assert.doesNotThrow(() => assertNoSecrets('No accounts or API credentials.'));
});

test('synthetic edit/diff/revert share state without mutating fixture files', () => {
  const original = { ...fixtures.initialFiles };
  const files = state.previewEdit(original);
  assert.equal(original['README.md'], fixtures.initialFiles['README.md']);
  assert.match(files['README.md'], /Welcome to your community garden!/);
  assert.match(state.gitDiff(files), /-Welcome, gardener!\n\+Welcome to your community garden!/);
  assert.match(state.terminalReply('git status', files), /modified: README.md/);
  assert.match(state.gitDiff(original), /clean/);
});

test('terminal accepts exact fixture commands only, refuses arbitrary paths, operators and processes', () => {
  const files = { ...fixtures.initialFiles };
  for (const command of ['help', 'pwd', 'ls', 'cat README.md', 'git status', 'git diff', 'npm test']) assert.doesNotMatch(state.terminalReply(command, files), /Not executed/);
  for (const command of ['cat /etc/passwd', 'ls; whoami', 'npm test && curl example.invalid', 'touch demo-pwned', '$(id)', 'env', 'git push', 'cat ../../README.md']) assert.match(state.terminalReply(command, files), /^Not executed\./);
  assert.deepEqual(files, fixtures.initialFiles);
});

test('turns are bounded, literal and affected by selected model/read toggle', () => {
  const session = fixtures.freshSessions()[0];
  const before = session.messages.length;
  const next = state.simulatedTurn('x'.repeat(3000), session, fixtures.initialFiles, ['read'], 'one');
  assert.equal(session.messages.length, before);
  assert.equal(next.messages.find(value => value.id === 'one-user').content.length, 2000);
  assert.equal(next.messages.find(value => value.id === 'one-read').role, 'tool');
  const shellReplay = state.simulatedTurn('Review', session, fixtures.initialFiles, ['bash'], 'shell');
  assert.equal(shellReplay.messages.at(-2).name, 'bash');
  assert.match(shellReplay.messages.at(-2).content, /no test runner started/);
  const disabled = state.simulatedTurn('Review', session, fixtures.initialFiles, [], 'two');
  assert.match(disabled.messages.at(-1).content, /read tool is disabled/);
  assert.equal(disabled.messages.length, before + 2);
  const writer = state.simulatedTurn('Review', fixtures.freshSessions()[1], fixtures.initialFiles, [], 'three');
  assert.match(writer.messages.at(-1).content, /Documentation walkthrough/);
  let bounded = session;
  for (let i = 0; i < 100; i++) bounded = state.simulatedTurn('fixture', bounded, fixtures.initialFiles, ['read'], `bound-${i}`);
  assert.equal(bounded.messages.length, 80);
});

test('real production builds validate root and deeply nested deployment assets with unchanged Web-size ceilings', async () => {
  for (const base of ['/', '/preview/AiHarness/']) {
    execFileSync(process.execPath, ['demo/scripts/build.mjs'], { cwd: process.cwd(), env: { ...process.env, DEMO_BASE: base }, stdio: 'inherit' });
    await validateArtifact(path.resolve('demo/dist'), base);
    const worker = await readFile('demo/dist/sw.js', 'utf8');
    assert(worker.includes(`const BASE = ${JSON.stringify(base)}`));
    assert(!worker.includes('/api/'));
    const manifest = JSON.parse(await readFile('demo/dist/demo-manifest.json', 'utf8'));
    assert(manifest.assets.every(asset => asset.startsWith(base)));
  }
});

test('Pages workflow isolates deployment authority and Docker validation from pull requests', async () => {
  const workflow = await readFile('.github/workflows/demo-pages.yml', 'utf8');
  // js-yaml is already installed/locked through the repository's ESLint toolchain.
  const policy = yaml.load(workflow);
  assert.deepEqual(policy.permissions, { contents: 'read' });
  assert.deepEqual(policy.on.push.branches, ['main']);
  const dependencies = ['demo/**', 'e2e/demo*.spec.ts', '.github/workflows/demo-pages.yml',
    '.docker/Dockerfile.test', '.docker/test-fonts.conf', '.docker/test-fonts.test.mjs', '.dockerignore', 'Makefile', '.npmrc',
    'package.json', 'package-lock.json', 'packages/web/src/components/MarkdownContent*',
    'packages/web/src/components/markdown-*.ts', 'packages/web/src/components/composer-submit.ts',
    'packages/web/src/hooks/useFocusTrap.ts', 'packages/web/src/hooks/useI18n.tsx', 'packages/web/src/i18n/**',
    'packages/web/src/store/preferences.ts', 'packages/web/src/services/keyboard.ts',
    'packages/core/**', 'packages/*/package.json', 'tsconfig.json'];
  assert.deepEqual(policy.on.push.paths, dependencies);
  assert.deepEqual(policy.on.pull_request.paths, dependencies);
  assert(policy.on.pull_request && !policy.on.pull_request_target);
  assert.equal(policy.on.workflow_dispatch.inputs.deploy.default, false);
  assert.equal(policy.concurrency['cancel-in-progress'], false);
  assert.equal(policy.jobs.build.permissions, undefined);
  assert.equal(policy.jobs.deploy.needs, 'build');
  assert.deepEqual(policy.jobs.deploy.permissions, { pages: 'write', 'id-token': 'write' });
  assert.equal(policy.jobs.deploy.environment.name, 'github-pages');
  assert.equal(policy.jobs.deploy.if, "${{ github.ref == 'refs/heads/main' && (github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.deploy)) }}");
  // Positive and negative truth table for the exact reviewed predicate above.
  const canDeploy = (ref, event, deploy) => ref === 'refs/heads/main' && (event === 'push' || (event === 'workflow_dispatch' && deploy));
  for (const [ref, event, deploy, expected] of [
    ['refs/heads/main', 'push', false, true], ['refs/heads/main', 'workflow_dispatch', true, true],
    ['refs/heads/main', 'workflow_dispatch', false, false], ['refs/pull/1/merge', 'pull_request', true, false],
    ['refs/heads/main', 'pull_request', true, false], ['refs/heads/topic', 'push', true, false],
    ['refs/heads/topic', 'workflow_dispatch', true, false],
  ]) assert.equal(canDeploy(ref, event, deploy), expected);
  assert.equal(policy.jobs.deploy.steps.length, 1);
  assert.equal(policy.jobs.deploy.steps[0].uses, 'actions/deploy-pages@v4');
  const upload = policy.jobs.build.steps.find(step => step.uses === 'actions/upload-pages-artifact@v3');
  assert.equal(upload.with.path, 'demo/dist');
  assert.equal(policy.jobs.build.steps.find(step => step.uses === 'actions/checkout@v5').with['persist-credentials'], false);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /needs: build/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /github\.event_name == 'push'/);
  assert.match(workflow, /pages: write\n      id-token: write/);
  assert.match(workflow, /actions\/upload-pages-artifact@v3/);
  assert.match(workflow, /actions\/deploy-pages@v4/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /bash demo\/run-docker\.sh/);
  assert(!workflow.includes('pull_request_target'));
  assert(!workflow.includes('enablement: true'));
});
