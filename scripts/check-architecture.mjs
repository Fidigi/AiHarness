// Scoped source policy, not a whole-runtime call graph or proof of external SDK non-use.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';
import ts from 'typescript';

const packages = ['core', 'cli', 'server', 'web'];
const publicEntries = ['packages/core/src/index.ts', 'packages/core/src/tools/shell-input.ts',
  'packages/cli/src/index.ts', 'packages/server/src/index.ts', 'packages/server/src/web-cli.ts'];
const hostTestEntries = ['packages/web/src/test-support/native-frontend-relay.ts'];
const dynamicEntries = ['packages/core/src/media/image-worker.ts',
  'packages/web/src/components/provider-settings.fixture.tsx', ...hostTestEntries];
const packageOf = file => /^packages\/([^/]+)\//.exec(file)?.[1];
export const edgeKey = edge => `${edge.from} -> ${edge.to} (${edge.dynamic ? 'deferred' : 'eager'})`;

function walk(directory, files = []) {
  if (!fs.existsSync(directory)) return files;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || ['node_modules', 'dist'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file, files);
    else if (/\.(ts|tsx)$/.test(file) && !/\.d\.ts$/.test(file)) files.push(file);
  }
  return files;
}

export function inspectArchitecture(directory) {
  const root = path.resolve(directory), relative = file => path.relative(root, file).replaceAll(path.sep, '/');
  const files = [...walk(path.join(root, 'packages')), ...walk(path.join(root, 'e2e')), ...walk(path.join(root, 'tests'))];
  const production = new Set(files.filter(file => /^packages\/[^/]+\/src\//.test(relative(file))
    && !/\/(?:fixtures)\//.test(relative(file)) && !/\.(test|spec)\.(ts|tsx)$/.test(file)));
  const options = { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.Latest, noResolve: true, noLib: true, baseUrl: root,
    paths: Object.fromEntries(packages.map(pkg => [`@ai-harness/${pkg}`, [`packages/${pkg}/src/index.${pkg === 'web' ? 'tsx' : 'ts'}`]])) };
  options.paths['@ai-harness/core/shell-input'] = ['packages/core/src/tools/shell-input.ts'];
  const program = ts.createProgram(files, options), checker = program.getTypeChecker();
  const resolve = symbol => symbol?.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const exports = file => {
    const ast = program.getSourceFile(file), symbol = ast && checker.getSymbolAtLocation(ast);
    return symbol ? checker.getExportsOfModule(symbol).map(resolve) : [];
  };
  const publicSymbols = new Set([...publicEntries, ...dynamicEntries].flatMap(file => exports(path.join(root, file))));
  const used = new Set(), edges = [], forbidden = [];
  const graph = new Map([...production].map(file => [relative(file), []]));
  const cache = ts.createModuleResolutionCache(root, file => file, options);
  for (const file of files) {
    const ast = program.getSourceFile(file);
    const from = relative(file), sourcePackage = packageOf(from);
    function visit(node) {
      // Namespace/computed access is conservatively a consumer, never deletion evidence.
      if (ts.isNamespaceImport(node)) {
        const symbol = resolve(checker.getSymbolAtLocation(node.name));
        if (symbol) for (const value of checker.getExportsOfModule(symbol)) used.add(resolve(value));
      }
      if (ts.isIdentifier(node)) {
        const symbol = resolve(checker.getSymbolAtLocation(node));
        if (symbol?.declarations?.some(declaration => declaration.getSourceFile().fileName !== file)) used.add(symbol);
      }
      let literal, typeOnly = false, dynamic = false;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        literal = node.moduleSpecifier;
        typeOnly = Boolean(node.isTypeOnly || node.importClause?.isTypeOnly);
        const bindings = node.importClause?.namedBindings ?? node.exportClause;
        if (!typeOnly && !node.importClause?.name && bindings?.elements?.length) typeOnly = bindings.elements.every(value => value.isTypeOnly);
      } else if (ts.isImportTypeNode(node)) {
        literal = node.argument.literal; typeOnly = true;
      } else if (ts.isCallExpression(node) && node.arguments.length === 1
        && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(ast) === 'require')) {
        literal = node.arguments[0]; dynamic = true;
      }
      if (literal && ts.isStringLiteralLike(literal)) {
        const specifier = literal.text;
        if (production.has(file)) {
          if (sourcePackage === 'core' && /^(?:react|react-dom|zustand)(?:\/|$)/.test(specifier)) {
            forbidden.push(`${from}: Core UI dependency (${specifier})`);
          }
          if (sourcePackage === 'web' && !hostTestEntries.includes(from) && !typeOnly && (specifier.startsWith('node:') || builtinModules.includes(specifier))) {
            forbidden.push(`${from}: browser Node dependency (${specifier})`);
          }
          if (from === 'packages/core/src/tools/shell-input.ts' && !typeOnly) {
            forbidden.push(`${from}: browser-safe Core entry must remain a reviewed standalone value leaf (${specifier})`);
          }
        }
        if (specifier.startsWith('.') || specifier.startsWith('@ai-harness/')) {
          const resolved = ts.resolveModuleName(specifier, file, options, ts.sys, cache).resolvedModule?.resolvedFileName;
          if (production.has(file) && resolved && hostTestEntries.includes(relative(resolved)) && !hostTestEntries.includes(from)) {
            forbidden.push(`${from}: production import of host-only test entry (${specifier})`);
          }
          const targetPackage = specifier.startsWith('@ai-harness/') ? specifier.slice(12).split('/')[0]
            : packageOf(relative(resolved ?? path.resolve(path.dirname(file), specifier)));
          if (production.has(file) && sourcePackage && targetPackage && sourcePackage !== targetPackage) {
            if (targetPackage !== 'core' || sourcePackage === 'core'
              || sourcePackage === 'web' && !typeOnly && specifier !== '@ai-harness/core/shell-input') {
              forbidden.push(`${from}: forbidden ${sourcePackage} -> ${targetPackage} (${specifier})`);
            }
          }
          if (production.has(file) && production.has(resolved)) {
            const edge = { from, to: relative(resolved), typeOnly, dynamic };
            edges.push(edge); graph.get(from).push(edge);
            // Dynamic module namespaces may be consumed through arbitrary keys.
            if (dynamic) for (const symbol of exports(resolved)) used.add(symbol);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    if (ast) visit(ast);
  }
  let next = 0;
  const indexes = new Map(), low = new Map(), stack = [], active = new Set(), cycles = [];
  function connect(file) {
    indexes.set(file, next); low.set(file, next++); stack.push(file); active.add(file);
    for (const edge of graph.get(file)) {
      if (edge.typeOnly) continue;
      if (!indexes.has(edge.to)) { connect(edge.to); low.set(file, Math.min(low.get(file), low.get(edge.to))); }
      else if (active.has(edge.to)) low.set(file, Math.min(low.get(file), indexes.get(edge.to)));
    }
    if (low.get(file) === indexes.get(file)) {
      const members = []; let current;
      do { current = stack.pop(); active.delete(current); members.push(current); } while (current !== file);
      if (members.length > 1 || graph.get(file).some(edge => !edge.typeOnly && edge.to === file)) {
        cycles.push(edges.filter(edge => !edge.typeOnly && members.includes(edge.from) && members.includes(edge.to)).map(edgeKey).sort());
      }
    }
  }
  for (const file of graph.keys()) if (!indexes.has(file)) connect(file);
  const unused = [];
  for (const file of production) for (const symbol of exports(file)) {
    if (!(symbol.flags & ts.SymbolFlags.Value) || publicSymbols.has(symbol) || used.has(symbol)) continue;
    // Re-export aliases are checked at their declaring owner, not twice at barrels.
    if (symbol.declarations?.some(declaration => declaration.getSourceFile().fileName === file)) unused.push(`${relative(file)}:${symbol.name}`);
  }
  return { modules: production.size, edges: edges.length, forbidden, cycles, unused: unused.sort(),
    exclusions: { publicEntries, dynamicEntries, browserNodeHostEntries: hostTestEntries },
    scope: 'Literal src TS/TSX dependencies; types excluded from SCCs. Named value exports only; public entry points, reviewed dynamic entries and namespace/computed consumers excluded. Tests/E2E/fixtures are consumers, not layer/cycle subjects. No claim about arbitrary computed imports, external SDK consumers or class members.' };
}

export function architectureErrors(inventory, policy) {
  const errors = [...inventory.forbidden];
  const observed = new Set(inventory.cycles.map(edges => JSON.stringify(edges)));
  for (const cycle of policy.cycles) {
    if (!cycle.reason || !observed.delete(JSON.stringify([...cycle.edges].sort()))) errors.push(`Stale/unreviewed cycle exception: ${cycle.reason}`);
  }
  for (const cycle of observed) errors.push(`Unreviewed value cycle: ${cycle}`);
  const allowedUnused = new Map(policy.unused.map(entry => [entry.export, entry.reason]));
  for (const value of inventory.unused) {
    if (!allowedUnused.get(value)) errors.push(`Unused internal export: ${value}`);
    else allowedUnused.delete(value);
  }
  for (const value of allowedUnused.keys()) errors.push(`Stale unused-export exception: ${value}`);
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const policy = JSON.parse(fs.readFileSync(new URL('./architecture-policy.json', import.meta.url), 'utf8'));
  const inventory = inspectArchitecture(process.cwd()), errors = architectureErrors(inventory, policy);
  console.log(JSON.stringify({ ...inventory, errors }, null, 2));
  if (errors.length) process.exitCode = 1;
}
