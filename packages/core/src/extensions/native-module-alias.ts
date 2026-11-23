import Module, { createRequire, registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExtensionFactory } from './extension-registry.js';

const CORE_URL = new URL('../index.js', import.meta.url).href;
const HOST_DIRECTORY = new URL('../', import.meta.url).href;
const contexts = new Map<string, Set<ModuleScope>>();
let associations = 0;
// Native modules survive loader retirement in Node's cache. Retain only bounded
// URL edges so a later owner also covers cached transitive/late dependencies.
const dependencies = new Map<string, Set<string>>();
let dependencyEdges = 0;
let dependencyBytes = 0;
let hooks: ReturnType<typeof registerHooks> | undefined;
let restoreRequire: (() => void) | undefined;
let hostNamespace: object;
class NativeModuleResolutionLimitError extends Error {
  constructor() { super('Extension module resolution exceeds its limits.'); }
}
const exceeded = () => new NativeModuleResolutionLimitError();

interface ModuleScope { urls: Set<string>; references: number }
function link(scope: ModuleScope, url: string): void {
  const owners = contexts.get(url);
  if (owners?.has(scope)) return;
  if (associations >= 20_000 || (!owners && contexts.size >= 10_000)) throw exceeded();
  if (owners) owners.add(scope); else contexts.set(url, new Set([scope]));
  associations++;
}
function unlink(scope: ModuleScope): void {
  for (const url of scope.urls) {
    const owners = contexts.get(url);
    if (!owners?.delete(scope)) continue;
    associations--;
    if (!owners.size) contexts.delete(url);
  }
  if (!contexts.size) {
    hooks?.deregister(); hooks = undefined;
    restoreRequire?.(); restoreRequire = undefined;
  }
}
function add(scope: ModuleScope, url: string): void {
  const pending = [url];
  for (let index = 0; index < pending.length; index++) {
    const next = pending[index]!;
    if (scope.urls.has(next)) continue;
    if (scope.urls.size >= 1_000 || Buffer.byteLength(next) > 32_768) throw exceeded();
    if (scope.references) link(scope, next);
    scope.urls.add(next);
    for (const dependency of dependencies.get(next) ?? []) pending.push(dependency);
  }
}
function remember(parent: string, child: string): void {
  const children = dependencies.get(parent);
  if (children?.has(child)) return;
  const bytes = Buffer.byteLength(parent) + Buffer.byteLength(child);
  if (Buffer.byteLength(child) > 32_768 || dependencyEdges >= 20_000
    || (!children && dependencies.size >= 10_000) || dependencyBytes + bytes > 16 * 1024 * 1024) throw exceeded();
  if (children) children.add(child); else dependencies.set(parent, new Set([child]));
  dependencyEdges++; dependencyBytes += bytes;
}
function ownDependency(parent: string, child: string, owners: Set<ModuleScope>): void {
  if (!child.startsWith('file:') || child.startsWith(HOST_DIRECTORY)) return;
  remember(parent, child);
  for (const owner of owners) add(owner, child);
}
function installRequire(): () => void {
  const original = Module.prototype.require;
  // CJS has a same-directory fast cache *before* resolve hooks. Intercept only
  // owned callers before that cache; never delete/replace any native cache entry.
  const wrapped = function(this: NodeJS.Module, id: string): unknown {
    const parent = typeof this.filename === 'string' && path.isAbsolute(this.filename) ? pathToFileURL(this.filename).href : '';
    const owners = contexts.get(parent);
    if (owners) {
      if (id === '@ai-harness/core') return hostNamespace;
      const require = createRequire(this.filename);
      let resolved: string;
      try { resolved = require.resolve(id); }
      catch (error) {
        if (error instanceof NativeModuleResolutionLimitError) throw error;
        // A preexisting require adapter may implement non-Node specifiers.
        return original.call(this, id);
      }
      const resolvedUrl = path.isAbsolute(resolved) ? pathToFileURL(resolved).href : undefined;
      if (resolvedUrl && !resolvedUrl.startsWith(HOST_DIRECTORY)) {
        ownDependency(parent, resolvedUrl, owners);
        // A cached CJS subtree need not call resolve hooks again. Adopt its real
        // existing children without evaluating or modifying their Module objects.
        const cached = require.cache[resolved];
        const pending = cached ? [cached] : [];
        const seen = new Set<string>([resolved]);
        for (let index = 0; index < pending.length; index++) {
          const current = pending[index]!;
          if (!Array.isArray(current.children) || current.children.length > 1_000) throw exceeded();
          for (const child of current.children) {
            if (typeof child.filename !== 'string' || !path.isAbsolute(child.filename)) continue;
            const url = pathToFileURL(child.filename).href;
            if (url.startsWith(HOST_DIRECTORY)) continue;
            ownDependency(pathToFileURL(current.filename).href, url, owners);
            if (!seen.has(child.filename)) {
              if (seen.size >= 1_000) throw exceeded();
              seen.add(child.filename); pending.push(child);
            }
          }
        }
      }
    }
    return original.call(this, id);
  };
  Module.prototype.require = wrapped;
  return () => {
    // Another library may have installed a newer wrapper. Never clobber it;
    // a retained delegate becomes inert when no owned contexts remain.
    if (Module.prototype.require === wrapped) Module.prototype.require = original;
  };
}
function activate(scope: ModuleScope): () => void {
  if (!scope.references) {
    try {
      for (const url of scope.urls) {
        for (const child of dependencies.get(url) ?? []) add(scope, child);
      }
      for (const url of scope.urls) link(scope, url);
      hooks ??= registerHooks({
        resolve(specifier, context, nextResolve) {
          const owners = contexts.get(context.parentURL ?? '');
          if (!owners) return nextResolve(specifier, context);
          if (specifier === '@ai-harness/core') return { url: CORE_URL, shortCircuit: true };
          const resolved = nextResolve(specifier, context);
          // Never intercept the host's own dependency graph or Node built-ins.
          ownDependency(context.parentURL!, resolved.url, owners);
          return resolved;
        },
      });
      restoreRequire ??= installRequire();
    } catch (error) { unlink(scope); throw error; }
  }
  scope.references++;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (--scope.references === 0) unlink(scope);
  };
}

/** Alias only the exact public root for admitted native entry/dependency URLs.
 * This owns resolver bookkeeping, not a sandbox or revocation of Node caches. */
export async function acquireNativeModuleAlias(entry: string, identity: string): Promise<{
  release(): void;
  wrap(factory: ExtensionFactory): ExtensionFactory;
}> {
  hostNamespace ??= await import('../index.js');
  const scope: ModuleScope = { urls: new Set(), references: 0 };
  add(scope, entry); add(scope, identity);
  const release = activate(scope);
  return {
    release,
    wrap: factory => async api => {
      const retire = activate(scope);
      try {
        const cleanup = await factory(api);
        return async () => { try { if (cleanup) await cleanup(); } finally { retire(); } };
      } catch (error) { retire(); throw error; }
    },
  };
}
