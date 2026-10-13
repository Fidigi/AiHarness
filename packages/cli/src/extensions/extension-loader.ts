import os from 'node:os';
import path from 'node:path';
import {
  ExtensionModuleLoader,
  resolveBuiltinExtensionPolicy,
  type BuiltinExtensionPolicy,
  type ExtensionModuleSelector,
  type ResolvedAgentSettings,
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

/** Keep selectors ordered until Core has discovered actual files. Built-in
 * capability switches are not executable paths and remain host-owned. */
export function configuredBuiltinExtensions(settings: ResolvedAgentSettings, options: {
  extensions?: readonly string[]; noExtensions?: boolean;
}): BuiltinExtensionPolicy {
  return resolveBuiltinExtensionPolicy({
    global: settings.globalSettings.extensions,
    project: settings.projectSettings.extensions,
    projectTrusted: settings.projectTrusted,
    noExtensions: options.noExtensions,
    explicit: options.extensions,
  });
}

export function explicitExtensionFiles(entries: readonly string[] = []): string[] {
  return entries.filter(entry => !entry.startsWith('builtin:'));
}

export function configuredExtensionSelectors(settings: ResolvedAgentSettings, noExtensions = false): ExtensionModuleSelector[] {
  if (noExtensions) return [];
  const layer = (entries: readonly string[] | undefined, baseDir: string): ExtensionModuleSelector[] => (
    (entries ?? []).filter(entry => !/^[+!-]?builtin:/u.test(entry)).map(entry => {
      const marker = /^[+!-]/u.test(entry) ? entry[0]! : '';
      const value = marker ? entry.slice(1) : entry;
      if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
        return { pattern: `${marker}${value === '~' ? '.' : value.slice(2)}`, baseDir: os.homedir() };
      }
      return { pattern: entry, baseDir };
    })
  );
  return [
    ...layer(settings.globalSettings.extensions, settings.agentDir),
    ...(settings.projectTrusted ? layer(settings.projectSettings.extensions, path.dirname(settings.paths.project)) : []),
  ];
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
