import os from 'node:os';
import path from 'node:path';
import {
  discoverThemeSources, type ResolvedAgentSettings, type ThemeSource, type ThemeSourceSelector,
} from '@ai-harness/core';
import type { CliArguments } from './args.js';

export function configuredThemeSelection(
  settings: ResolvedAgentSettings,
  options: Pick<CliArguments, 'theme'>,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return options.theme ?? (environment.AI_HARNESS_THEME || settings.settings.theme || 'auto');
}

/** Compose sources, not palettes. Suppression never grants project authority. */
export async function configuredThemeSources(
  settings: ResolvedAgentSettings,
  cwd: string,
  packages: { readonly global: readonly string[]; readonly project: readonly string[] },
  options: Pick<CliArguments, 'themeSources' | 'noThemes'>,
): Promise<ThemeSource[]> {
  const selectors: ThemeSourceSelector[] = [];
  const add = (
    entries: readonly string[] | undefined, baseDir: string,
    scope: ThemeSourceSelector['scope'], source: ThemeSourceSelector['source'], literal = false,
  ): void => {
    for (const entry of entries ?? []) {
      const marker = literal ? '+' : /^[+!-]/u.test(entry) ? entry[0]! : '';
      const value = literal ? entry : marker ? entry.slice(1) : entry;
      const home = value === '~' || value.startsWith('~/') || value.startsWith('~\\');
      selectors.push({
        pattern: `${marker}${home ? value === '~' ? '.' : value.slice(2) : value}`,
        baseDir: home ? os.homedir() : baseDir,
        scope, source, trusted: true,
      });
    }
  };
  if (!options.noThemes) {
    if (settings.agentDirTrusted) {
      add([path.join(settings.agentDir, 'themes') + path.sep], cwd, 'user', 'auto', true);
      add(packages.global, cwd, 'user', 'package', true);
      add(settings.globalSettings.themes, settings.agentDir, 'user', 'settings');
    }
    if (settings.projectTrusted) {
      const baseDir = path.dirname(settings.paths.project);
      add([path.join(baseDir, 'themes') + path.sep], cwd, 'project', 'auto', true);
      add(packages.project, cwd, 'project', 'package', true);
      add(settings.projectSettings.themes, baseDir, 'project', 'settings');
    }
  }
  add(options.themeSources, cwd, 'temporary', 'cli', true);
  return discoverThemeSources(selectors, { cwd, projectTrusted: settings.projectTrusted });
}
