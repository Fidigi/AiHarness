/** A link grant is filesystem access only, never project/code trust. */
export type LinkedDirectoryReason = 'directory' | 'unavailable' | 'unsafe-target' | 'not-directory' | 'store-unavailable' | 'unsupported-platform';
export interface LinkedDirectoryEntry {
  id: string;
  name: string;
  /** Exact readlink value, not an interpreted display string. */
  rawTarget?: string;
  canonicalTarget?: string;
  hiddenCharacters: boolean;
  reason: LinkedDirectoryReason;
  allowed: boolean;
}
export interface LinkedDirectoryInventory {
  cwd: string;
  directory: string;
  revision: string;
  entries: LinkedDirectoryEntry[];
  truncated: boolean;
  /** General root scanners and execution do not consume these scoped grants. */
  restriction: 'scoped-files-only';
}
export interface LinkedDirectorySelector {
  cwd: string;
  directory: string;
  id: string;
  revision: string;
}
export interface LinkedDirectoryAccess extends LinkedDirectorySelector { path: string }
export interface LinkedDirectoryListing {
  path: string;
  entries: Array<{ name: string; path: string; isDirectory: boolean; blocked: boolean }>;
  truncated: boolean;
}
export interface LinkedDirectoryContent { path: string; content: string; size: number }
export type LinkedDirectoryErrorCode = 'invalid-request' | 'stale-entry' | 'consent-required' | 'unsafe-target' | 'store-unavailable' | 'busy' | 'too-large' | 'unsupported-platform';
export class LinkedDirectoryError extends Error {
  constructor(readonly code: LinkedDirectoryErrorCode) {
    super('Linked-directory operation refused.');
    this.name = 'LinkedDirectoryError';
  }
}
