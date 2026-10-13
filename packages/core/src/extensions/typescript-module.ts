import type { ExtensionFactory } from './extension-registry.js';

/** Evaluate the already admitted entry bytes, never reopen its pathname through
 * the transpiler. Dependency imports remain privileged Node code, not a sandbox. */
export async function evaluateTypeScriptExtension(source: string, filename: string, identity: string): Promise<ExtensionFactory> {
  let exported: unknown;
  try {
    const { createJiti } = await import('jiti');
    const loader = createJiti(filename, {
      fsCache: false,
      moduleCache: false,
      tryNative: false,
      debug: false,
      sourceMaps: false,
      interopDefault: false,
      extensions: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.mtsx', '.ctsx', '.json'],
      alias: {},
      nativeModules: [],
      transformModules: [],
      tsconfigPaths: false,
      jsx: { runtime: 'classic' },
      esmEvalTempFile: false,
      virtualModules: { '@ai-harness/core': await import('../index.js') },
    });
    exported = await loader.evalModule(source, {
      filename, id: identity, async: true, forceTranspile: true, cache: Object.create(null),
    });
  } catch {
    // Parser/code-frame messages can include the complete operator-owned source.
    throw new Error('TypeScript extension evaluation failed.');
  }
  const factory: unknown = typeof exported === 'function' ? exported
    : exported && typeof exported === 'object' ? Reflect.get(exported, 'default') : undefined;
  if (typeof factory !== 'function') throw new Error('Extension module must export a default factory function');
  return factory as ExtensionFactory;
}
