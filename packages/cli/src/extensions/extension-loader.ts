import {
  ExtensionModuleLoader,
  type ExtensionModuleLoaderOptions,
  type ExtensionModuleLoadResult,
  type ExtensionRegistry,
} from '@ai-harness/core';

export type ExtensionLoaderOptions = ExtensionModuleLoaderOptions;
export type ExtensionLoadResult = ExtensionModuleLoadResult;

/** CLI facade over the shared, transactional Node extension loader. */
export class ExtensionLoader extends ExtensionModuleLoader {
  constructor(registry: ExtensionRegistry, options: ExtensionLoaderOptions = {}) {
    super(registry, options);
  }
}

/** Parse repeatable `--extension <path>` and `--extension=<path>` arguments. */
export function getExtensionPaths(args: string[]): string[] {
  const paths: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--extension' && args[index + 1]) paths.push(args[++index]);
    else if (argument.startsWith('--extension=')) paths.push(argument.slice('--extension='.length));
  }
  return paths;
}
