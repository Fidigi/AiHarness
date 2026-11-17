// Read-only, bounded repository inventory. Run in the test image; see AUDIT-1.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const ts = createRequire('/app/package.json')('typescript');
const root = path.resolve(process.argv[2] ?? '/app');
const packages = ['core', 'cli', 'server', 'web'];
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'fixtures') walk(target); }
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec|d)\.(ts|tsx)$/.test(entry.name)) files.push(target);
  }
}
for (const pkg of packages) walk(path.join(root, 'packages', pkg, 'src'));
files.sort();
const relative = f => path.relative(root, f).replaceAll(path.sep, '/');
const sources = new Map(files.map(f => [f, fs.readFileSync(f, 'utf8')]));
const graph = new Map(files.map(f => [f, []]));
const options = { moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true, resolveJsonModule: true,
  baseUrl: root, paths: { '@ai-harness/core': ['packages/core/src/index.ts'], '@ai-harness/core/shell-input': ['packages/core/src/tools/shell-input.ts'] } };
const cache = ts.createModuleResolutionCache(root, f => f, options);
const imports = [], unresolved = [];
for (const [file, text] of sources) {
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  function visit(node) {
    let specifier, typeOnly = false, dynamic = false;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      specifier = node.moduleSpecifier;
      typeOnly = Boolean(node.isTypeOnly || node.importClause?.isTypeOnly);
      const bindings = node.importClause?.namedBindings ?? node.exportClause;
      if (!typeOnly && !node.importClause?.name && bindings?.elements?.length) typeOnly = bindings.elements.every(e => e.isTypeOnly);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(ast) === 'require') && node.arguments.length === 1) {
      specifier = node.arguments[0]; dynamic = true;
    }
    if (specifier && ts.isStringLiteralLike(specifier)) {
      const spec = specifier.text;
      if (spec.startsWith('.') || spec.startsWith('@ai-harness/')) {
        const resolved = ts.resolveModuleName(spec, file, options, ts.sys, cache).resolvedModule?.resolvedFileName;
        const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
        if (resolved && graph.has(resolved)) {
          const edge = { from: relative(file), to: relative(resolved), line, typeOnly, dynamic };
          graph.get(file).push(edge); imports.push(edge);
        } else if (!resolved) unresolved.push({ file: relative(file), line, spec });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}
const byRelative = new Map(files.map(f => [relative(f), f]));
const roots = ['packages/core/src/index.ts', 'packages/core/src/tools/shell-input.ts', 'packages/cli/src/index.ts',
  'packages/server/src/index.ts', 'packages/server/src/web-cli.ts', 'packages/web/src/index.tsx'];
const reached = new Set();
function reach(file) {
  if (!file || reached.has(file)) return;
  reached.add(file);
  for (const edge of graph.get(file) ?? []) reach(byRelative.get(edge.to));
}
roots.forEach(r => reach(byRelative.get(r)));
// Tarjan SCCs on value edges. Type-only cycles are deliberately excluded.
let next = 0;
const indexes = new Map(), low = new Map(), stack = [], active = new Set(), cycles = [];
function connect(file) {
  indexes.set(file, next); low.set(file, next++); stack.push(file); active.add(file);
  for (const edge of graph.get(file)) {
    if (edge.typeOnly) continue;
    const target = byRelative.get(edge.to);
    if (!indexes.has(target)) { connect(target); low.set(file, Math.min(low.get(file), low.get(target))); }
    else if (active.has(target)) low.set(file, Math.min(low.get(file), indexes.get(target)));
  }
  if (low.get(file) === indexes.get(file)) {
    const component = []; let current;
    do { current = stack.pop(); active.delete(current); component.push(relative(current)); } while (current !== file);
    if (component.length > 1) cycles.push(component.sort());
  }
}
files.forEach(f => { if (!indexes.has(f)) connect(f); });
const digest = createHash('sha256');
for (const [file, text] of sources) digest.update(relative(file) + '\0' + text + '\0');
const packageOf = f => f.split('/')[1];
const crossPackage = imports.filter(e => packageOf(e.from) !== packageOf(e.to));
const result = {
  scope: 'src TS/TSX excluding tests, declarations and fixture directories; literal imports/re-exports/require only; no proof of external SDK usage or computed worker/assets',
  sourceDigest: digest.digest('hex'),
  packages: Object.fromEntries(packages.map(pkg => [pkg, { files: files.filter(f => relative(f).startsWith(`packages/${pkg}/`)).length,
    lines: files.filter(f => relative(f).startsWith(`packages/${pkg}/`)).reduce((sum, f) => sum + sources.get(f).trimEnd().split('\n').length, 0) }])),
  moduleCount: files.length, edgeCount: imports.length,
  largest: files.map(f => ({ file: relative(f), lines: sources.get(f).trimEnd().split('\n').length })).sort((a, b) => b.lines - a.lines).slice(0, 15),
  crossPackageCounts: Object.fromEntries([...new Set(crossPackage.map(e => `${packageOf(e.from)} -> ${packageOf(e.to)}`))].sort().map(key => [key, crossPackage.filter(e => `${packageOf(e.from)} -> ${packageOf(e.to)}` === key).length])),
  forbiddenCoreEdges: crossPackage.filter(e => packageOf(e.from) === 'core'),
  webCoreValueEdges: crossPackage.filter(e => packageOf(e.from) === 'web' && !e.typeOnly),
  cycles: cycles.sort((a, b) => b.length - a.length),
  cycleEdges: cycles.map(component => imports.filter(edge => !edge.typeOnly && component.includes(edge.from) && component.includes(edge.to))),
  unreachableFromDeclaredRoots: files.filter(f => !reached.has(f)).map(relative),
  unresolved,
};
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
