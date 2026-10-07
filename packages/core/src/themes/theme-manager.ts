import os from 'node:os';
import path from 'node:path';
import {
  readBoundedResourceText,
  type ResourceProvenance,
  type ResourceScope,
  type ResourceSource,
} from '../resources/resource-manager.js';

export type ThemeMode = 'dark' | 'light';
export type ThemeColorValue = string | number;

export interface TerminalThemeColors {
  accent: string;
  user: string;
  assistant: string;
  warning: string;
  error: string;
  muted: string;
  [token: string]: string;
}

export interface TerminalTheme {
  name: string;
  mode: ThemeMode;
  appearance: ThemeMode;
  vars: Readonly<Record<string, string>>;
  colors: TerminalThemeColors;
  export?: Readonly<Record<string, string>>;
  provenance: ResourceProvenance;
}

export interface ThemeSource {
  path: string;
  scope?: ResourceScope;
  source?: ResourceSource;
  trusted?: boolean;
}

export interface ThemeLoadContext {
  /** Canonical workspace root used to classify explicit paths. */
  cwd: string;
  projectTrusted: boolean;
}

export interface TerminalRgbColor { r: number; g: number; b: number }

export interface ReportedTerminalColors {
  foreground?: TerminalRgbColor;
  background?: TerminalRgbColor;
  /** Present only after all ANSI slots 0–15 were reported. */
  palette?: readonly TerminalRgbColor[];
  appearanceHint?: ThemeMode;
}

export interface TerminalThemeProbeInput {
  isTTY?: boolean;
  on(event: 'data', listener: (chunk: unknown) => void): unknown;
  off?(event: 'data', listener: (chunk: unknown) => void): unknown;
  removeListener?(event: 'data', listener: (chunk: unknown) => void): unknown;
}

export interface TerminalThemeProbeOutput {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

export interface SystemThemeProbeOptions {
  input: TerminalThemeProbeInput;
  output: TerminalThemeProbeOutput;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Receive bounded late replies and terminal light/dark notifications. */
  onTheme?: (theme: TerminalTheme) => void;
  force?: boolean;
}

export interface SystemThemeProbe {
  initial: Promise<TerminalTheme>;
  refresh(): void;
  close(): void;
}

interface TerminalThemeReportInspection {
  state: 'complete' | 'incomplete' | 'invalid';
  bytes?: number;
}

const MAX_TERMINAL_THEME_REPORT_BYTES = 1_024;
const TERMINAL_THEME_COLOR_BODY = /^(?:rgba?:)?[0-9a-f]{1,4}\/[0-9a-f]{1,4}\/[0-9a-f]{1,4}(?:\/[0-9a-f]{1,4})?$|^#[0-9a-f]{6}(?:[0-9a-f]{6})?$/i;

function inspectTerminalThemeReport(candidate: Buffer): TerminalThemeReportInspection {
  if (candidate.length === 0 || candidate[0] !== 0x1b) return { state: 'invalid' };
  if (candidate.length === 1) return { state: 'incomplete' };

  if (candidate[1] === 0x5d) { // OSC
    const source = candidate.toString('ascii');
    const command = source.match(/^\u001b\](?:10;|11;|4;\d{1,3};)/)?.[0];
    if (!command) {
      const possible = ['\u001b]10;', '\u001b]11;', '\u001b]4;']
        .some(prefix => prefix.startsWith(source));
      if (possible || /^\u001b\]4;\d{0,3}$/.test(source)) return { state: 'incomplete' };
      return { state: 'invalid' };
    }
    if (candidate.length > MAX_TERMINAL_THEME_REPORT_BYTES) return { state: 'invalid' };
    const bodyStart = Buffer.byteLength(command, 'ascii');
    let end = -1;
    let terminatorBytes = 0;
    for (let index = bodyStart; index < candidate.length; index++) {
      if (candidate[index] === 0x07) {
        end = index;
        terminatorBytes = 1;
        break;
      }
      if (candidate[index] === 0x1b && candidate[index + 1] === 0x5c) {
        end = index;
        terminatorBytes = 2;
        break;
      }
    }
    if (end < 0) return { state: 'incomplete' };
    const body = candidate.subarray(bodyStart, end).toString('ascii');
    return TERMINAL_THEME_COLOR_BODY.test(body)
      ? { state: 'complete', bytes: end + terminatorBytes }
      : { state: 'invalid' };
  }

  if (candidate[1] === 0x5b) { // CSI
    if (candidate.length === 2) return { state: 'incomplete' };
    if (candidate[2] !== 0x3f) return { state: 'invalid' };
    const source = candidate.subarray(3, Math.min(candidate.length, 80)).toString('ascii');
    const scheme = source.match(/^997;[12]n/);
    if (scheme) return { state: 'complete', bytes: 3 + scheme[0].length };
    const attributes = source.match(/^[0-9;]{0,64}c/);
    if (attributes) return { state: 'complete', bytes: 3 + attributes[0].length };
    if (source.length <= 64 && (/^[0-9;]*$/.test(source) || ['997;1n', '997;2n'].some(value => value.startsWith(source)))) {
      return { state: 'incomplete' };
    }
  }
  return { state: 'invalid' };
}

type TerminalReportKind = 'osc' | 'csi';

function terminalReportKind(candidate: Buffer): TerminalReportKind | undefined {
  const source = candidate.subarray(0, Math.min(candidate.length, 80)).toString('ascii');
  if (candidate.length >= 2 && candidate[0] === 0x1b && candidate[1] === 0x5d) {
    if (/^\u001b\](?:10;|11;|4;\d{1,3};)/u.test(source)
      || ['\u001b]10;', '\u001b]11;', '\u001b]4;'].some(prefix => prefix.startsWith(source))
      || /^\u001b\]4;\d{0,3}$/u.test(source)) return 'osc';
  }
  if (candidate.length >= 3 && candidate[0] === 0x1b && candidate[1] === 0x5b && candidate[2] === 0x3f) {
    const body = source.slice(3);
    if (/^[0-9;]*$/u.test(body) || /^997;[12]n/u.test(body) || /^[0-9;]{0,64}c/u.test(body)) return 'csi';
  }
  return undefined;
}

function discardedReportBytes(candidate: Buffer, kind: TerminalReportKind): number | undefined {
  if (kind === 'osc') {
    for (let index = 0; index < candidate.length; index++) {
      if (candidate[index] === 0x07) return index + 1;
      if (candidate[index] === 0x1b && candidate[index + 1] === 0x5c) return index + 2;
    }
    return undefined;
  }
  for (let index = 0; index < candidate.length; index++) {
    if (candidate[index] === 0x6e || candidate[index] === 0x63) return index + 1;
  }
  return undefined;
}

/** Strip only validated OSC/CSI replies emitted by the adaptive-theme probe. */
export class TerminalThemeResponseFilter {
  private pending = Buffer.alloc(0);
  private discarding?: TerminalReportKind;

  push(chunk: string | Uint8Array): Buffer {
    const incoming = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    let source = this.pending.length ? Buffer.concat([this.pending, incoming]) : incoming;
    this.pending = Buffer.alloc(0);
    if (this.discarding) {
      const consumed = discardedReportBytes(source, this.discarding);
      if (consumed === undefined) return Buffer.alloc(0);
      this.discarding = undefined;
      source = source.subarray(consumed);
    }
    const output: Buffer[] = [];
    while (source.length) {
      const escape = source.indexOf(0x1b);
      if (escape < 0) {
        output.push(source);
        break;
      }
      if (escape > 0) {
        output.push(source.subarray(0, escape));
        source = source.subarray(escape);
      }
      const report = inspectTerminalThemeReport(source);
      if (report.state === 'complete') {
        source = source.subarray(report.bytes!);
        continue;
      }
      if (report.state === 'incomplete' && source.length <= MAX_TERMINAL_THEME_REPORT_BYTES) {
        this.pending = Buffer.from(source);
        break;
      }
      const kind = terminalReportKind(source);
      if (kind && source.length > MAX_TERMINAL_THEME_REPORT_BYTES) {
        this.discarding = kind;
        break;
      }
      output.push(source.subarray(0, 1));
      source = source.subarray(1);
    }
    return output.length === 0 ? Buffer.alloc(0) : Buffer.concat(output);
  }

  hasPending(): boolean {
    return this.pending.length > 0 || this.discarding !== undefined;
  }

  /** A lone Escape remains responsive; fragmented reports get one bounded discard window. */
  pendingTimeoutMs(): number {
    if (this.discarding) return 2_000;
    return this.pending.length <= 1 ? 30 : 250;
  }

  flush(): Buffer {
    if (this.discarding) {
      this.discarding = undefined;
      return Buffer.alloc(0);
    }
    const output = this.pending;
    this.pending = Buffer.alloc(0);
    if (output.length > 1 && terminalReportKind(output)
      && inspectTerminalThemeReport(output).state === 'incomplete') {
      this.discarding = terminalReportKind(output);
      return Buffer.alloc(0);
    }
    return output;
  }
}

export interface ThemeInventoryItem {
  name: string;
  mode?: ThemeMode;
  active: boolean;
  valid: boolean;
  provenance: ResourceProvenance;
  error?: string;
}

interface ThemeDocument {
  name?: unknown;
  mode?: unknown;
  appearance?: unknown;
  vars?: unknown;
  colors?: unknown;
  export?: unknown;
}

const MAX_THEME_BYTES = 256 * 1024;
const MAX_THEME_VARS = 256;
const MAX_THEME_TOKENS = 128;
const TOKEN_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const REQUIRED_RICH_TOKENS = [
  'accent', 'border', 'borderAccent', 'borderMuted', 'success', 'error', 'warning', 'muted', 'dim', 'text',
  'thinkingText', 'selectedBg', 'userMessageBg', 'userMessageText', 'customMessageBg', 'customMessageText',
  'customMessageLabel', 'toolPendingBg', 'toolSuccessBg', 'toolErrorBg', 'toolTitle', 'toolOutput', 'mdHeading',
  'mdLink', 'mdLinkUrl', 'mdCode', 'mdCodeBlock', 'mdCodeBlockBorder', 'mdQuote', 'mdQuoteBorder', 'mdHr',
  'mdListBullet', 'toolDiffAdded', 'toolDiffRemoved', 'toolDiffContext', 'syntaxComment', 'syntaxKeyword',
  'syntaxFunction', 'syntaxVariable', 'syntaxString', 'syntaxNumber', 'syntaxType', 'syntaxOperator',
  'syntaxPunctuation', 'thinkingOff', 'thinkingMinimal', 'thinkingLow', 'thinkingMedium', 'thinkingHigh',
  'thinkingXhigh', 'bashMode',
] as const;
const OPTIONAL_TOKENS = [
  'scrollbarTrack', 'scrollbarThumb', 'searchMatchBg', 'searchMatchText', 'thinkingMax', 'user', 'assistant',
] as const;
const ALLOWED_TOKENS = new Set<string>([...REQUIRED_RICH_TOKENS, ...OPTIONAL_TOKENS]);
const EXPORT_TOKENS = new Set(['pageBg', 'cardBg', 'infoBg']);

const NAMED_COLORS: Readonly<Record<string, string>> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00',
  cyan: '#00ffff', magenta: '#ff00ff', gray: '#808080', grey: '#808080', transparent: '#000000',
};
const ANSI_BASE = [
  '#000000', '#800000', '#008000', '#808000', '#000080', '#800080', '#008080', '#c0c0c0',
  '#808080', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff',
];

function ansiColor(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 255) throw new Error('Theme color indexes must be between 0 and 255.');
  if (index < 16) return ANSI_BASE[index]!;
  if (index >= 232) {
    const value = 8 + (index - 232) * 10;
    return `#${value.toString(16).padStart(2, '0').repeat(3)}`;
  }
  const value = index - 16;
  const red = Math.floor(value / 36);
  const green = Math.floor((value % 36) / 6);
  const blue = value % 6;
  const channel = (item: number): number => item === 0 ? 0 : 55 + item * 40;
  return `#${[red, green, blue].map(item => channel(item).toString(16).padStart(2, '0')).join('')}`;
}

function literalColor(value: ThemeColorValue): string {
  if (typeof value === 'number') return ansiColor(value);
  const normalized = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(normalized)) {
    return `#${[...normalized.slice(1)].map(character => character.repeat(2)).join('')}`;
  }
  if (/^#[0-9a-f]{6}$/i.test(normalized)) return normalized;
  if (/^#[0-9a-f]{8}$/i.test(normalized)) return normalized.slice(0, 7);
  const named = NAMED_COLORS[normalized];
  if (named) return named;
  throw new Error('Theme colors must use a variable, a named color, a hex color, or a 0–255 index.');
}

function record(value: unknown, label: string, maxEntries: number): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > maxEntries) {
    throw new Error(`${label} must be a bounded object.`);
  }
  return value as Record<string, unknown>;
}

function colorValue(value: unknown): ThemeColorValue {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255) return value;
  if (typeof value === 'string' && value.length <= 256 && !value.includes('\0')) return value;
  throw new Error('Theme color value is invalid.');
}

function resolvePalette(
  rawVariables: Record<string, unknown>,
  rawColors: Record<string, unknown>,
  fallback: TerminalTheme,
): { vars: Record<string, string>; colors: TerminalThemeColors } {
  const variables = new Map<string, ThemeColorValue>();
  for (const [name, value] of Object.entries(rawVariables)) {
    if (!TOKEN_PATTERN.test(name)) throw new Error('Theme variable name is invalid.');
    variables.set(name, colorValue(value));
  }
  const resolving = new Set<string>();
  const resolvedVariables: Record<string, string> = {};
  const resolve = (value: ThemeColorValue): string => {
    if (typeof value === 'string' && variables.has(value)) {
      if (resolving.has(value)) throw new Error('Theme variables contain a cycle.');
      if (resolvedVariables[value]) return resolvedVariables[value]!;
      resolving.add(value);
      const result = resolve(variables.get(value)!);
      resolving.delete(value);
      resolvedVariables[value] = result;
      return result;
    }
    return literalColor(value);
  };
  for (const [name, value] of variables) resolvedVariables[name] = resolve(value);

  const colors: TerminalThemeColors = { ...fallback.colors };
  for (const [name, value] of Object.entries(rawColors)) {
    if (!ALLOWED_TOKENS.has(name)) throw new Error(`Unknown theme color token: ${name}.`);
    colors[name] = resolve(colorValue(value));
  }
  // Compatibility aliases and rich tokens always converge on the same final palette.
  colors.user = colors.user ?? colors.userMessageText ?? colors.success;
  colors.assistant = colors.assistant ?? colors.text;
  colors.userMessageText = colors.userMessageText ?? colors.user;
  colors.text = colors.text ?? colors.assistant;
  return { vars: resolvedVariables, colors };
}

async function readThemeFile(filePath: string): Promise<string> {
  return readBoundedResourceText(filePath, MAX_THEME_BYTES);
}

function builtinProvenance(name: string): ResourceProvenance {
  return {
    scope: 'user', source: 'auto', origin: 'top-level', path: `builtin:${name}`,
    selector: `builtin:${name}`, trusted: true,
  };
}

function richColors(mode: ThemeMode): TerminalThemeColors {
  const dark = mode === 'dark';
  const accent = dark ? '#22d3ee' : '#0369a1';
  const text = dark ? '#f8fafc' : '#0f172a';
  const muted = dark ? '#94a3b8' : '#64748b';
  const success = dark ? '#4ade80' : '#15803d';
  const warning = dark ? '#facc15' : '#a16207';
  const error = dark ? '#f87171' : '#b91c1c';
  const background = dark ? '#111827' : '#f1f5f9';
  const colors = Object.fromEntries(REQUIRED_RICH_TOKENS.map(token => [token, text])) as TerminalThemeColors;
  Object.assign(colors, {
    accent, user: success, assistant: text, warning, error, muted, success, text,
    dim: muted, thinkingText: muted, border: muted, borderAccent: accent, borderMuted: muted,
    selectedBg: background, userMessageBg: background, userMessageText: success,
    customMessageBg: background, customMessageText: text, customMessageLabel: accent,
    toolPendingBg: background, toolSuccessBg: background, toolErrorBg: background,
    toolTitle: accent, toolOutput: text, mdHeading: accent, mdLink: accent, mdLinkUrl: muted,
    mdCode: warning, mdCodeBlock: text, mdCodeBlockBorder: muted, mdQuote: muted, mdQuoteBorder: muted,
    mdHr: muted, mdListBullet: accent, toolDiffAdded: success, toolDiffRemoved: error, toolDiffContext: muted,
    syntaxComment: muted, syntaxKeyword: accent, syntaxFunction: success, syntaxVariable: text,
    syntaxString: warning, syntaxNumber: warning, syntaxType: accent, syntaxOperator: text,
    syntaxPunctuation: muted, thinkingOff: muted, thinkingMinimal: muted, thinkingLow: accent,
    thinkingMedium: warning, thinkingHigh: error, thinkingXhigh: error, thinkingMax: error, bashMode: success,
  });
  return colors;
}

const BUILTIN_THEMES: Readonly<Record<ThemeMode, TerminalTheme>> = Object.freeze({
  dark: Object.freeze({
    name: 'dark', mode: 'dark', appearance: 'dark', vars: Object.freeze({}),
    colors: Object.freeze(richColors('dark')), provenance: builtinProvenance('dark'),
  }),
  light: Object.freeze({
    name: 'light', mode: 'light', appearance: 'light', vars: Object.freeze({}),
    colors: Object.freeze(richColors('light')), provenance: builtinProvenance('light'),
  }),
});

const SYSTEM_TOKEN_SLOTS: Readonly<Record<string, number>> = {
  accent: 5, borderAccent: 5, customMessageLabel: 5, mdCode: 5, syntaxType: 5,
  border: 4, mdLink: 4, syntaxKeyword: 4, thinkingLow: 4,
  success: 2, user: 2, userMessageText: 2, mdCodeBlock: 2, toolDiffAdded: 2, bashMode: 2,
  error: 1, toolDiffRemoved: 1, thinkingHigh: 1, thinkingXhigh: 13, thinkingMax: 1,
  warning: 3, mdHeading: 3, syntaxFunction: 3, syntaxString: 3,
  syntaxVariable: 6, thinkingMedium: 6,
  muted: 8, dim: 8, thinkingText: 8, mdLinkUrl: 8, mdQuote: 8, syntaxComment: 8,
};
const SYSTEM_BACKGROUND_TOKENS = new Set([
  'selectedBg', 'userMessageBg', 'customMessageBg', 'toolPendingBg', 'toolSuccessBg', 'toolErrorBg',
  'scrollbarTrack', 'searchMatchBg',
]);

function rgbHex(color: TerminalRgbColor): string {
  return `#${[color.r, color.g, color.b]
    .map(channel => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0')).join('')}`;
}

function hexRgb(value: string): TerminalRgbColor {
  return {
    r: Number.parseInt(value.slice(1, 3), 16),
    g: Number.parseInt(value.slice(3, 5), 16),
    b: Number.parseInt(value.slice(5, 7), 16),
  };
}

function terminalLuminance(color: TerminalRgbColor): number {
  const linear = (channel: number): number => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

function terminalContrast(left: TerminalRgbColor, right: TerminalRgbColor): number {
  const a = terminalLuminance(left);
  const b = terminalLuminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function readableTerminalColor(
  candidate: TerminalRgbColor,
  background: TerminalRgbColor,
  fallback: string,
  minimum = 4.5,
): string {
  if (terminalContrast(candidate, background) >= minimum) return rgbHex(candidate);
  const fallbackRgb = hexRgb(fallback);
  if (terminalContrast(fallbackRgb, background) >= minimum) return fallback;
  const black = { r: 0, g: 0, b: 0 };
  const white = { r: 255, g: 255, b: 255 };
  return rgbHex(terminalContrast(black, background) >= terminalContrast(white, background) ? black : white);
}

function mixTerminalColor(background: TerminalRgbColor, foreground: TerminalRgbColor, weight: number): string {
  return rgbHex({
    r: background.r * (1 - weight) + foreground.r * weight,
    g: background.g * (1 - weight) + foreground.g * weight,
    b: background.b * (1 - weight) + foreground.b * weight,
  });
}

/** Build an adaptive palette from bounded terminal color metadata. */
export function createSystemTerminalTheme(
  reported: ReportedTerminalColors = {},
  environment: NodeJS.ProcessEnv = process.env,
): TerminalTheme {
  const background = reported.background;
  const mode: ThemeMode = background
    ? terminalLuminance(background) > 0.45 ? 'light' : 'dark'
    : reported.appearanceHint ?? ThemeManager.detectMode(environment);
  const colors = { ...richColors(mode) };
  if (background) {
    const foreground = reported.foreground;
    if (foreground) {
      colors.text = readableTerminalColor(foreground, background, colors.text);
      colors.assistant = colors.text;
      colors.toolTitle = colors.text;
    }
    const palette = reported.palette?.length === 16 ? reported.palette : undefined;
    if (palette) {
      for (const [token, slot] of Object.entries(SYSTEM_TOKEN_SLOTS)) {
        const candidate = palette[slot];
        if (candidate) colors[token] = readableTerminalColor(candidate, background, colors[token] ?? colors.text, token === 'dim' ? 3 : 4.5);
      }
      for (const token of SYSTEM_BACKGROUND_TOKENS) {
        const slot = token.includes('Error') ? 1 : token.includes('Success') ? 2 : token.includes('Pending') ? 8 : 4;
        colors[token] = mixTerminalColor(background, palette[slot]!, mode === 'dark' ? 0.22 : 0.13);
      }
    }
  }
  colors.user = colors.userMessageText;
  return {
    name: 'system', mode, appearance: mode, vars: {}, colors,
    ...(background ? { export: { pageBg: rgbHex(background) } } : {}),
    provenance: builtinProvenance('system'),
  };
}

function parseTerminalChannel(value: string): number | undefined {
  if (!/^[0-9a-f]{1,4}$/i.test(value)) return undefined;
  const maximum = 16 ** value.length - 1;
  return Math.round((Number.parseInt(value, 16) / maximum) * 255);
}

function parseTerminalColor(value: string): TerminalRgbColor | undefined {
  const normalized = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(normalized)) return hexRgb(normalized.toLowerCase());
  if (/^#[0-9a-f]{12}$/i.test(normalized)) {
    const channels = [normalized.slice(1, 5), normalized.slice(5, 9), normalized.slice(9, 13)].map(parseTerminalChannel);
    return channels.every(channel => channel !== undefined)
      ? { r: channels[0]!, g: channels[1]!, b: channels[2]! }
      : undefined;
  }
  const channels = normalized.replace(/^rgba?:/i, '').split('/').slice(0, 3).map(parseTerminalChannel);
  return channels.length === 3 && channels.every(channel => channel !== undefined)
    ? { r: channels[0]!, g: channels[1]!, b: channels[2]! }
    : undefined;
}

/**
 * Query OSC 10/11/4 colors with a 100 ms default deadline. The listener remains active for terminal
 * color-scheme notifications, so valid replies arriving after the deadline can still replace the fallback.
 */
export function startSystemThemeProbe(options: SystemThemeProbeOptions): SystemThemeProbe {
  const timeoutMs = Math.max(1, Math.min(1_000, options.timeoutMs ?? 100));
  const environment = options.environment ?? process.env;
  let foreground: TerminalRgbColor | undefined;
  let background: TerminalRgbColor | undefined;
  let appearanceHint: ThemeMode | undefined;
  const palette = new Map<number, TerminalRgbColor>();
  let buffer = '';
  let closed = false;
  let initialSettled = false;
  let lastSignature = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveInitial!: (theme: TerminalTheme) => void;
  const initial = new Promise<TerminalTheme>(resolve => { resolveInitial = resolve; });

  const snapshot = (): TerminalTheme => createSystemTerminalTheme({
    ...(foreground ? { foreground } : {}),
    ...(background ? { background } : {}),
    ...(palette.size === 16 ? { palette: Array.from({ length: 16 }, (_, index) => palette.get(index)!) } : {}),
    ...(appearanceHint ? { appearanceHint } : {}),
  }, environment);
  const publish = (initial = false): void => {
    const theme = snapshot();
    const signature = JSON.stringify([theme.mode, theme.colors, theme.export]);
    if (initial) {
      initialSettled = true;
      if (timer) clearTimeout(timer);
      resolveInitial(theme);
    } else if (initialSettled && signature !== lastSignature) {
      options.onTheme?.(theme);
    }
    lastSignature = signature;
  };
  const query = (): void => {
    if (closed) return;
    foreground = undefined;
    background = undefined;
    palette.clear();
    const osc = ['\u001b]10;?\u0007', '\u001b]11;?\u0007'];
    for (let index = 0; index < 16; index++) osc.push(`\u001b]4;${index};?\u0007`);
    try { options.output.write(`${osc.join('')}\u001b[c`); }
    catch {
      if (!initialSettled) publish(true);
    }
  };
  const onData = (chunk: unknown): void => {
    if (closed) return;
    const text = typeof chunk === 'string'
      ? chunk
      : Buffer.isBuffer(chunk) || chunk instanceof Uint8Array
        ? Buffer.from(chunk).toString('utf8')
        : '';
    if (!text) return;
    buffer = (buffer + text).slice(-64 * 1024);
    let changed = false;
    const colorPattern = /\u001b\](10|11|4;(\d{1,3}));([^\u0007\u001b]*)(?:\u0007|\u001b\\)/gi;
    for (const match of buffer.matchAll(colorPattern)) {
      const color = parseTerminalColor(match[3] ?? '');
      if (!color) continue;
      if (match[1] === '10') foreground = color;
      else if (match[1] === '11') background = color;
      else {
        const index = Number(match[2]);
        if (Number.isInteger(index) && index >= 0 && index < 16) palette.set(index, color);
      }
      changed = true;
    }
    const schemes = [...buffer.matchAll(/\u001b\[\?997;(1|2)n/g)];
    const scheme = schemes.at(-1)?.[1];
    if (scheme) {
      appearanceHint = scheme === '2' ? 'light' : 'dark';
      changed = true;
      query();
    }
    const complete = /\u001b\[\?[0-9;]*c/.test(buffer);
    // Consume complete reports so later user keystrokes cannot replay a stale
    // scheme notification or repeatedly trigger terminal queries.
    buffer = buffer
      .replace(/\u001b\](?:10|11|4;\d{1,3});[^\u0007\u001b]*(?:\u0007|\u001b\\)/gi, '')
      .replace(/\u001b\[\?997;[12]n/g, '')
      .replace(/\u001b\[\?[0-9;]*c/g, '')
      .slice(-1_024);
    if (!initialSettled && complete) publish(true);
    else if (changed && initialSettled) queueMicrotask(() => { if (!closed) publish(); });
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    if (options.input.off) options.input.off('data', onData);
    else options.input.removeListener?.('data', onData);
    try { options.output.write('\u001b[?2031l'); } catch { /* Best-effort notification cleanup. */ }
    if (!initialSettled) publish(true);
  };

  if (!options.force && (!options.input.isTTY || !options.output.isTTY)) {
    publish(true);
    return { initial, refresh: () => undefined, close: () => undefined };
  }
  options.input.on('data', onData);
  try { options.output.write('\u001b[?2031h'); } catch { /* The query below resolves to the fallback. */ }
  query();
  timer = setTimeout(() => { if (!initialSettled) publish(true); }, timeoutMs);
  timer.unref?.();
  return { initial, refresh: query, close };
}

function sourceDescriptor(value: string | ThemeSource): Required<ThemeSource> {
  if (typeof value === 'string') {
    return { path: value, scope: 'user', source: 'package', trusted: true };
  }
  return {
    path: value.path,
    scope: value.scope ?? 'user',
    source: value.source ?? 'package',
    trusted: value.trusted ?? value.scope !== 'project',
  };
}

function provenance(source: Required<ThemeSource>, filePath: string): ResourceProvenance {
  return {
    scope: source.scope,
    source: source.source,
    origin: 'top-level',
    path: filePath,
    selector: source.path,
    trusted: source.trusted,
  };
}

function classifyThemeSource(
  value: string | ThemeSource,
  context?: ThemeLoadContext,
): Required<ThemeSource> {
  const source = sourceDescriptor(value);
  if (!context) return source;
  const relative = path.relative(path.resolve(context.cwd), path.resolve(source.path));
  const insideProject = relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  return insideProject
    ? { ...source, scope: 'project', trusted: context.projectTrusted }
    : source;
}

export class ThemeManager {
  static detectMode(environment: NodeJS.ProcessEnv = process.env): ThemeMode {
    const configured = environment.AI_HARNESS_THEME;
    if (configured === 'light' || configured === 'dark') return configured;
    const background = environment.COLORFGBG?.split(';').pop();
    if (background !== undefined && Number(background) >= 7) return 'light';
    return 'dark';
  }

  static builtins(environment: NodeJS.ProcessEnv = process.env): TerminalTheme[] {
    return [
      structuredClone(BUILTIN_THEMES.dark),
      structuredClone(BUILTIN_THEMES.light),
      createSystemTerminalTheme({}, environment),
    ];
  }

  static async load(
    value?: string,
    sources: readonly (string | ThemeSource)[] = [],
    environment: NodeJS.ProcessEnv = process.env,
    context?: ThemeLoadContext,
  ): Promise<TerminalTheme> {
    const selected = value || environment.AI_HARNESS_THEME || 'auto';
    if (selected === 'auto') return structuredClone(BUILTIN_THEMES[this.detectMode(environment)]);
    if (selected === 'system') return createSystemTerminalTheme({}, environment);
    if (selected === 'dark' || selected === 'light') return structuredClone(BUILTIN_THEMES[selected]);
    const available = sources
      .map(source => classifyThemeSource(source, context))
      .filter(source => source.scope !== 'project' || source.trusted);
    const packageTheme = available.find(candidate => (
      path.basename(candidate.path, path.extname(candidate.path)).toLocaleLowerCase() === selected.toLocaleLowerCase()
    ));
    const explicitPath = path.resolve(selected.replace(/^~(?=$|\/)/, os.homedir()));
    const relativeToProject = context ? path.relative(path.resolve(context.cwd), explicitPath) : undefined;
    const explicitProjectPath = relativeToProject !== undefined
      && relativeToProject !== '..'
      && !relativeToProject.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relativeToProject);
    const source = packageTheme ?? sourceDescriptor({
      path: explicitPath,
      scope: explicitProjectPath ? 'project' : 'temporary',
      source: 'cli',
      trusted: !explicitProjectPath || context?.projectTrusted === true,
    });
    if (source.scope === 'project' && !source.trusted) {
      throw new Error('Project themes require explicit trust before loading.');
    }
    const filePath = path.resolve(source.path);
    let parsed: ThemeDocument;
    try {
      const document = JSON.parse(await readThemeFile(filePath)) as unknown;
      if (!document || typeof document !== 'object' || Array.isArray(document)) {
        throw new SyntaxError('Theme document must be an object.');
      }
      parsed = document as ThemeDocument;
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('The theme file is not valid JSON.');
      throw error;
    }
    if (typeof parsed.name !== 'string' || !parsed.name.trim() || parsed.name.length > 128 || parsed.name.includes('/')) {
      throw new Error('The theme name is invalid.');
    }
    const mode = parsed.appearance ?? parsed.mode;
    if (mode !== 'dark' && mode !== 'light') throw new Error('The theme appearance must be dark or light.');
    const rawVariables = parsed.vars === undefined ? {} : record(parsed.vars, 'Theme vars', MAX_THEME_VARS);
    const rawColors = record(parsed.colors, 'Theme colors', MAX_THEME_TOKENS);
    const palette = resolvePalette(rawVariables, rawColors, BUILTIN_THEMES[mode]);
    let exportColors: Record<string, string> | undefined;
    if (parsed.export !== undefined) {
      exportColors = {};
      for (const [name, raw] of Object.entries(record(parsed.export, 'Theme export colors', EXPORT_TOKENS.size))) {
        if (!EXPORT_TOKENS.has(name)) throw new Error(`Unknown theme export token: ${name}.`);
        exportColors[name] = literalColor(colorValue(raw));
      }
    }
    return {
      name: parsed.name.trim(), mode, appearance: mode,
      vars: palette.vars,
      colors: palette.colors,
      ...(exportColors ? { export: exportColors } : {}),
      provenance: provenance(source, filePath),
    };
  }

  static async inventory(
    sources: readonly (string | ThemeSource)[] = [],
    selected?: string,
    context?: ThemeLoadContext,
  ): Promise<ThemeInventoryItem[]> {
    const items: ThemeInventoryItem[] = this.builtins().map(theme => ({
      name: theme.name, mode: theme.mode, active: selected === theme.name,
      valid: true, provenance: theme.provenance,
    }));
    for (const rawSource of sources.slice(0, 512)) {
      const source = classifyThemeSource(rawSource, context);
      if (source.scope === 'project' && !source.trusted) continue;
      const fallbackName = path.basename(source.path, path.extname(source.path));
      try {
        const theme = await this.load(fallbackName, [source], process.env, context);
        items.push({
          name: theme.name, mode: theme.mode, active: selected === theme.name || selected === source.path,
          valid: true, provenance: theme.provenance,
        });
      } catch (error) {
        items.push({
          name: fallbackName, active: selected === fallbackName || selected === source.path,
          valid: false, provenance: provenance(source, path.resolve(source.path)),
          error: error instanceof Error ? error.message : 'The theme is invalid.',
        });
      }
    }
    return items.sort((left, right) => left.name.localeCompare(right.name)
      || left.provenance.path.localeCompare(right.provenance.path));
  }
}
