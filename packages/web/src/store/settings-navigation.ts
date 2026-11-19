/** Optional presentation metadata. Never a configuration, descriptor or trust source. */
export const settingsSections = [
  'authentication', 'providers', 'provider-lifecycle', 'model', 'defaults',
  'custom-models', 'skills', 'tools', 'plugins', 'subagents', 'appearance', 'shortcuts',
  'sessions', 'mcp', 'about',
] as const;
export type SettingsSection = typeof settingsSections[number];
export const settingsCategoryIds = ['general', 'models', 'skills', 'tools', 'plugins', 'subagents', 'mcp'] as const;
export type SettingsCategory = typeof settingsCategoryIds[number];
export const settingsSectionCategory: Record<SettingsSection, SettingsCategory> = {
  authentication: 'general', appearance: 'general', shortcuts: 'general',
  defaults: 'general', sessions: 'general', about: 'general',
  providers: 'models', 'provider-lifecycle': 'models', model: 'models', 'custom-models': 'models',
  skills: 'skills', tools: 'tools', plugins: 'plugins', subagents: 'subagents', mcp: 'mcp',
};
export type SettingsScope = 'global' | 'project';
export const settingsScopeControls = ['tools', 'defaults', 'plugins', 'subagents', 'registry'] as const;
export type SettingsScopeControl = typeof settingsScopeControls[number];
export interface SettingsPosition { group?: string; selection?: string }
export interface SettingsNavigation {
  section: SettingsSection;
  categories?: Partial<Record<SettingsCategory, SettingsSection>>;
  positions: Partial<Record<SettingsSection, SettingsPosition>>;
  scopes: Partial<Record<SettingsScopeControl, SettingsScope>>;
}
interface Entry extends SettingsNavigation { cwd: string | null }
export interface NavigationStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
const KEY = 'ai-harness-settings-navigation-v1';
const MAX_TEXT = 65_536;
const MAX_CONTEXTS = 24;
const MAX_ID = 4_096;

export function isSettingsSection(value: unknown): value is SettingsSection {
  return typeof value === 'string' && settingsSections.some(section => section === value);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID;
}
function validCwd(value: unknown): value is string | null {
  return value === null || typeof value === 'string' && value.length > 0 && value.length <= 8_192;
}
function browserStorage(): NavigationStorage | undefined {
  try { return window.localStorage; } catch { return undefined; }
}
function navigation(value: unknown, fallback: SettingsSection): SettingsNavigation {
  const result: SettingsNavigation = { section: fallback, positions: {}, scopes: {} };
  if (!object(value)) return result;
  const section = own(value, 'section');
  if (isSettingsSection(section)) result.section = section;
  const categories = own(value, 'categories');
  if (object(categories)) for (const category of settingsCategoryIds) {
    const target = own(categories, category);
    if (isSettingsSection(target) && settingsSectionCategory[target] === category) {
      (result.categories ??= {})[category] = target;
    }
  }
  const positions = own(value, 'positions');
  if (object(positions)) for (const section of settingsSections) {
    const position = own(positions, section);
    if (!object(position)) continue;
    const group = own(position, 'group'), selection = own(position, 'selection');
    result.positions[section] = {
      ...(identifier(group) ? { group } : {}), ...(identifier(selection) ? { selection } : {}),
    };
  }
  const scopes = own(value, 'scopes');
  if (object(scopes)) for (const control of settingsScopeControls) {
    const scope = own(scopes, control);
    if (scope === 'global' || scope === 'project') result.scopes[control] = scope;
  }
  return result;
}
function entries(storage?: NavigationStorage): Entry[] {
  try {
    const text = storage?.getItem(KEY);
    if (!text || text.length > MAX_TEXT) return [];
    const parsed: unknown = JSON.parse(text);
    if (!object(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length > MAX_CONTEXTS) return [];
    return parsed.entries.flatMap((entry: unknown) => object(entry) && validCwd(entry.cwd)
      ? [{ ...navigation(entry, 'appearance'), cwd: entry.cwd }] : []);
  } catch { return []; }
}

/** All current AiHarness sections include a global/read-only surface without a project. */
export function settingsSectionForContext(section: unknown, _cwd?: string): SettingsSection {
  return isSettingsSection(section) ? section : 'appearance';
}
export function readSettingsNavigation(
  cwd?: string, legacySection: unknown = 'appearance', storage = browserStorage(),
): SettingsNavigation {
  const fallback = settingsSectionForContext(legacySection, cwd);
  if (!validCwd(cwd ?? null)) return navigation(undefined, fallback);
  const entry = entries(storage).filter(entry => entry.cwd === (cwd ?? null)).at(-1);
  return navigation(entry, fallback);
}
export function writeSettingsNavigation(
  cwd: string | undefined, value: SettingsNavigation, storage = browserStorage(),
): void {
  if (!validCwd(cwd ?? null)) return;
  const list = entries(storage).filter(entry => entry.cwd !== (cwd ?? null));
  list.push({ ...navigation(value, 'appearance'), cwd: cwd ?? null });
  while (list.length > MAX_CONTEXTS) list.shift();
  let text = JSON.stringify({ version: 1, entries: list });
  while (text.length > MAX_TEXT) {
    list.shift(); text = JSON.stringify({ version: 1, entries: list });
  }
  try { storage?.setItem(KEY, text); } catch { /* Optional storage; mounted intent stays local. */ }
}
export function settingsScopeForContext(scope: unknown, cwd?: string, fallback: SettingsScope = 'global'): SettingsScope {
  const selected = scope === 'global' || scope === 'project' ? scope : fallback;
  return selected === 'project' && !cwd ? 'global' : selected;
}
