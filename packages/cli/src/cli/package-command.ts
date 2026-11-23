import path from 'node:path';
import {
  CredentialRedactor,
  loadAgentSettings,
  PluginService,
  ProjectTrustManager,
  resolvePreTrustAgentDirectory,
  resolveProjectTrust,
  WorkspaceManager,
} from '@ai-harness/core';
import type {
  PluginCatalog,
  PluginPackageInfo,
  PluginResourceFilters,
  PluginScope,
  PluginUpdateResult,
  PluginNpmCommandOptions,
  ResolvedAgentSettings,
} from '@ai-harness/core';

export type PackageCommandAction =
  | 'list'
  | 'install'
  | 'configure'
  | 'enable'
  | 'disable'
  | 'remove'
  | 'update'
  | 'check'
  | 'reload';

export interface PackageCommandArguments {
  action?: PackageCommandAction;
  help: boolean;
  json: boolean;
  scope?: PluginScope;
  selector?: string;
  projectTrust?: boolean;
  resetFilters: boolean;
  filters: PluginResourceFilters;
}

export class PackageCommandArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackageCommandArgumentError';
  }
}

const ACTIONS = new Set([
  'list', 'install', 'configure', 'config', 'enable', 'disable', 'remove', 'uninstall', 'update', 'check', 'reload',
]);
const FILTER_OPTIONS: Record<string, keyof PluginResourceFilters> = {
  '--extensions': 'extensions',
  '--skills': 'skills',
  '--prompts': 'prompts',
  '--themes': 'themes',
};

function actionName(value: string): PackageCommandAction {
  if (value === 'config') return 'configure';
  if (value === 'uninstall') return 'remove';
  return value as PackageCommandAction;
}

function filterValues(value: string): string[] {
  if (!value) return [];
  const entries = value.split(',').map(entry => entry.trim()).filter(Boolean);
  if (entries.some(entry => entry.length > 500)) {
    throw new PackageCommandArgumentError('Package resource selectors must be at most 500 characters.');
  }
  return [...new Set(entries)];
}

/** Strict parser for the standalone package administration surface. */
export function parsePackageCommandArguments(args: readonly string[]): PackageCommandArguments {
  const result: PackageCommandArguments = {
    help: false,
    json: false,
    resetFilters: false,
    filters: {},
  };
  const positional: string[] = [];
  let optionsEnded = false;

  for (let index = 0; index < args.length; index++) {
    const raw = args[index]!;
    if (!optionsEnded && raw === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && raw.startsWith('-')) {
      const equals = raw.startsWith('--') ? raw.indexOf('=') : -1;
      const option = equals > 0 ? raw.slice(0, equals) : raw;
      const inlineValue = equals > 0 ? raw.slice(equals + 1) : undefined;
      const value = (allowEmpty = false, allowExactExclusion = false): string => {
        const candidate = inlineValue ?? args[++index];
        const optionLike = inlineValue === undefined && candidate?.startsWith('-')
          && !(allowExactExclusion && /^-[^-]/.test(candidate));
        if (candidate === undefined || optionLike) {
          throw new PackageCommandArgumentError(`${option} requires a value.`);
        }
        if (!allowEmpty && !candidate) throw new PackageCommandArgumentError(`${option} requires a non-empty value.`);
        return candidate;
      };
      const booleanOption = (): void => {
        if (inlineValue !== undefined) throw new PackageCommandArgumentError(`${option} does not accept a value.`);
      };

      if (option === '--help' || option === '-h') {
        booleanOption(); result.help = true;
      } else if (option === '--json') {
        booleanOption(); result.json = true;
      } else if (option === '--scope') {
        const scope = value();
        if (scope !== 'global' && scope !== 'project') {
          throw new PackageCommandArgumentError('--scope must be global or project.');
        }
        if (result.scope && result.scope !== scope) throw new PackageCommandArgumentError('Package scope options conflict.');
        result.scope = scope;
      } else if (option === '--project' || option === '--local' || option === '-l') {
        booleanOption();
        if (result.scope === 'global') throw new PackageCommandArgumentError('Package scope options conflict.');
        result.scope = 'project';
      } else if (option === '--global') {
        booleanOption();
        if (result.scope === 'project') throw new PackageCommandArgumentError('Package scope options conflict.');
        result.scope = 'global';
      } else if (option === '--approve' || option === '-a') {
        booleanOption();
        if (result.projectTrust === false) throw new PackageCommandArgumentError('--approve conflicts with --no-approve.');
        result.projectTrust = true;
      } else if (option === '--no-approve' || option === '-na') {
        booleanOption();
        if (result.projectTrust === true) throw new PackageCommandArgumentError('--no-approve conflicts with --approve.');
        result.projectTrust = false;
      } else if (option === '--reset') {
        booleanOption(); result.resetFilters = true;
      } else if (FILTER_OPTIONS[option]) {
        const field = FILTER_OPTIONS[option]!;
        const entries = filterValues(value(true, true));
        Object.assign(result.filters, {
          [field]: entries.length === 0
            ? []
            : [...new Set([...(result.filters[field] ?? []), ...entries])],
        });
      } else {
        throw new PackageCommandArgumentError(`Unknown package option: ${option}.`);
      }
      continue;
    }
    positional.push(raw);
  }

  if (positional.length > 0) {
    const action = positional.shift()!.toLowerCase();
    if (!ACTIONS.has(action)) throw new PackageCommandArgumentError(`Unknown package action: ${action}.`);
    result.action = actionName(action);
  }
  if (positional.length > 1) throw new PackageCommandArgumentError('Package commands accept at most one source or selector.');
  result.selector = positional[0];

  if (result.help || !result.action) return result;
  if (result.action === 'install' && !result.selector) {
    throw new PackageCommandArgumentError('package install requires a source.');
  }
  if (['configure', 'enable', 'disable', 'remove'].includes(result.action) && !result.selector) {
    throw new PackageCommandArgumentError(`package ${result.action} requires a package selector.`);
  }
  if (result.action === 'configure' && result.resetFilters && Object.keys(result.filters).length > 0) {
    throw new PackageCommandArgumentError('--reset cannot be combined with resource filters.');
  }
  if (result.action === 'configure' && !result.resetFilters && Object.keys(result.filters).length === 0) {
    throw new PackageCommandArgumentError('package configure requires a resource filter or --reset.');
  }
  if (result.action !== 'configure' && (result.resetFilters || Object.keys(result.filters).length > 0)) {
    throw new PackageCommandArgumentError('Resource filters apply only to package configure.');
  }
  if (result.selector && ['list', 'reload'].includes(result.action)) {
    throw new PackageCommandArgumentError(`package ${result.action} does not accept a selector.`);
  }
  return result;
}

export function formatPackageCommandHelp(): string {
  return `AiHarness package administration\n\nUsage:\n  ai-harness package list [--scope global|project] [--json]\n  ai-harness package install <npm:|git:|path> [--global|--project]\n  ai-harness package configure <selector> [filters] [--scope ...]\n  ai-harness package enable|disable <selector> [--scope ...]\n  ai-harness package remove|uninstall <selector> [--scope ...]\n  ai-harness package check [selector] [--scope ...] [--json]\n  ai-harness package update [selector] [--scope ...]\n  ai-harness package reload [--json]\n\nFilters:\n  --extensions <selectors>       Narrow extension files; an empty value disables the kind\n  --skills <selectors>           Narrow skills\n  --prompts <selectors>          Narrow prompt templates\n  --themes <selectors>           Narrow themes\n  --reset                        Remove all package-level filters\n\nSelectors use comma-separated globs, !glob exclusions, +exact includes, and -exact\nexclusions. Filters only narrow resources already declared by the package manifest.\nInstalling, configuring, enabling, or updating project packages requires saved trust or
--approve; disabling and removal remain safe while blocked.\nListing and refresh never contact npm/Git; only check, install, and update can do so.\n`;
}

function packageCandidates(
  catalog: PluginCatalog,
  selector: string,
  scope?: PluginScope,
): PluginPackageInfo[] {
  const normalized = selector.trim();
  const absolute = normalized.startsWith('./') || normalized.startsWith('../')
    ? path.resolve(catalog.cwd, normalized)
    : normalized;
  return catalog.packages.filter(pkg => (!scope || pkg.scope === scope) && (
    pkg.key === normalized
    || pkg.source === normalized
    || pkg.source === absolute
    || pkg.packageName === normalized
  ));
}

function selectPackage(catalog: PluginCatalog, selector: string, scope?: PluginScope): PluginPackageInfo {
  const candidates = packageCandidates(catalog, selector, scope);
  if (candidates.length === 0) throw new Error(`Package not found: ${selector}`);
  if (candidates.length > 1) {
    throw new Error(`Package selector is ambiguous; add --scope: ${selector}`);
  }
  return candidates[0]!;
}

function formatCatalog(catalog: PluginCatalog, scope?: PluginScope): string {
  const packages = catalog.packages.filter(pkg => !scope || pkg.scope === scope);
  if (packages.length === 0) return 'No packages configured.';
  const lines = ['scope\tstate\tversion\tresources\tsource'];
  for (const pkg of packages) {
    const resources = `${pkg.counts.extensions}e/${pkg.counts.skills}s/${pkg.counts.prompts}p/${pkg.counts.themes}t`;
    lines.push(`${pkg.scope}\t${pkg.status}\t${pkg.version ?? '-'}\t${resources}\t${pkg.source}`);
  }
  return lines.join('\n');
}

function formatUpdates(updates: PluginUpdateResult[]): string {
  if (updates.length === 0) return 'No packages support update checks.';
  return updates.map(update => [
    update.scope,
    update.displayName,
    update.state,
    update.availableVersion ?? update.installedVersion ?? '-',
    update.message ?? '',
  ].filter(Boolean).join('\t')).join('\n');
}

/** Capture only explicit host process choices, with CLI flags before session-only prompts.
 * Resolved/default/saved project trust is selection policy, never an explicit override.
 */
export function resolvePackageNpmOptions(
  resolved: ResolvedAgentSettings,
  canonicalCwd: string,
  flag?: boolean,
  sessionChoice?: boolean,
): PluginNpmCommandOptions {
  const override = flag ?? sessionChoice;
  return PluginService.resolveNpmCommand(resolved, override === undefined ? undefined
    : Object.freeze({ cwd: canonicalCwd, trusted: override }));
}

/** Execute package administration without starting a session, provider, extension, or TUI. */
export async function runPackageCommand(args: readonly string[]): Promise<number> {
  const redactor = new CredentialRedactor();
  redactor.addEnvironment(process.env);
  for (const argument of args) {
    try {
      const candidate = new URL(argument);
      if (candidate.username || candidate.password) {
        redactor.add(argument);
        redactor.add(candidate.username ? decodeURIComponent(candidate.username) : undefined);
        redactor.add(candidate.password ? decodeURIComponent(candidate.password) : undefined);
      }
    } catch { /* Non-URL package selectors are not credentials. */ }
  }
  const safeText = (value: unknown): string => redactor.redact(value instanceof Error ? value.message : String(value));
  let parsed: PackageCommandArguments;
  try {
    parsed = parsePackageCommandArguments(args);
  } catch (error) {
    process.stderr.write(`Error: ${safeText(error)}\n`);
    return 2;
  }
  if (parsed.help || !parsed.action) {
    process.stdout.write(formatPackageCommandHelp());
    return 0;
  }

  try {
    const cwd = process.cwd();
    const workspaceManager = new WorkspaceManager({ allowedRoots: [cwd], defaultCwd: cwd });
    await workspaceManager.initialize();
    const canonicalCwd = await workspaceManager.getDefaultCwd();
    const trustManager = new ProjectTrustManager(
      path.join(resolvePreTrustAgentDirectory(canonicalCwd), 'trust.json'),
    );
    await trustManager.load();
    const bootstrapSettings = await loadAgentSettings({ cwd: canonicalCwd, projectTrusted: false });
    const trust = await resolveProjectTrust({
      cwd: canonicalCwd,
      trustManager,
      override: parsed.projectTrust,
      defaultProjectTrust: bootstrapSettings.settings.defaultProjectTrust,
      includeContextFiles: false,
    });
    const context = {
      cwd: canonicalCwd,
      projectTrusted: trust.resourceTrusted,
    };
    const resolvedSettings = await loadAgentSettings({
      cwd: canonicalCwd,
      projectTrusted: trust.resourceTrusted,
    });
    const agentDir = resolvedSettings.agentDir;
    if (!resolvedSettings.agentDirTrusted) {
      throw new Error('The agent data directory requires explicit project trust.');
    }
    const service = new PluginService(
      workspaceManager,
      trustManager,
      path.join(agentDir, 'plugins.json'),
      agentDir,
      undefined,
      // Keep rejected/uncertain trusted-source policy, not just the loader's
      // surviving merged array. Refusal is lazy so list/reload remain passive.
      resolvePackageNpmOptions(resolvedSettings, canonicalCwd, parsed.projectTrust),
    );
    await service.load();

    let output: PluginCatalog | PluginUpdateResult[];
    if (parsed.action === 'list') {
      output = await service.getCatalog(context);
    } else if (parsed.action === 'install') {
      output = await service.install({
        ...context,
        scope: parsed.scope ?? 'global',
        source: parsed.selector!,
      });
    } else if (parsed.action === 'check') {
      const catalog = await service.getCatalog(context);
      const pkg = parsed.selector ? selectPackage(catalog, parsed.selector, parsed.scope) : undefined;
      output = await service.checkUpdates({
        ...context,
        ...(pkg ? { key: pkg.key, scope: pkg.scope } : parsed.scope ? { scope: parsed.scope } : {}),
      });
    } else if (parsed.action === 'update' && !parsed.selector) {
      output = await service.updateAll({ ...context, ...(parsed.scope ? { scope: parsed.scope } : {}) });
    } else if (parsed.action === 'reload') {
      output = (await service.reload(context)).catalog;
    } else {
      const catalog = await service.getCatalog(context);
      const pkg = selectPackage(catalog, parsed.selector!, parsed.scope);
      if (parsed.action === 'configure') {
        const resourceFilters = parsed.resetFilters
          ? undefined
          : { ...(pkg.resourceFilters ?? {}), ...parsed.filters };
        output = await service.configure({ ...context, scope: pkg.scope, key: pkg.key, resourceFilters });
      } else if (parsed.action === 'enable' || parsed.action === 'disable') {
        output = await service.setEnabled({
          ...context, scope: pkg.scope, key: pkg.key, enabled: parsed.action === 'enable',
        });
      } else if (parsed.action === 'remove') {
        output = await service.remove({ ...context, scope: pkg.scope, key: pkg.key });
      } else {
        output = await service.update({ ...context, scope: pkg.scope, key: pkg.key });
      }
    }

    if (parsed.json) process.stdout.write(`${JSON.stringify(redactor.redactJson(output))}\n`);
    else if (Array.isArray(output)) process.stdout.write(`${redactor.redact(formatUpdates(output))}\n`);
    else process.stdout.write(`${redactor.redact(formatCatalog(output, parsed.scope))}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`Error: ${safeText(error)}\n`);
    return 1;
  }
}
