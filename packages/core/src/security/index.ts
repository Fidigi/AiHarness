export {
  CredentialStoreError,
  EncryptedCredentialStore,
  credentialValuesEqual,
} from './credential-store.js';
export type { EncryptedCredentialStoreOptions } from './credential-store.js';
export {
  atomicWriteStableFile,
  StableFileError,
} from './stable-file.js';
export type {
  AtomicStableFileOptions,
  StableFileErrorCode,
} from './stable-file.js';
export {
  openStableDirectoryHandle,
  readStableDirectoryEntries,
  readStableDirectorySnapshot,
} from './stable-directory.js';
export type {
  StableDirectoryListing,
  StableDirectorySnapshot,
  StableDirectorySnapshotEntry,
} from './stable-directory.js';
export {
  FRESH_PROJECT_SCAN_DEPTH,
  FRESH_PROJECT_SCAN_MAX_DIRECTORIES,
  inspectProjectTrustResources,
  ProjectTrustManager,
  resolveProjectTrust,
} from './project-trust.js';
export type {
  FreshProjectTrustBlockReason,
  FreshProjectTrustBreadth,
  FreshProjectTrustBreadthKind,
  FreshProjectTrustOptions,
  FreshProjectTrustStatus,
  FreshProjectTrustWriteResult,
  ProjectTrustDecision,
  ProjectTrustDecisionEntry,
  ProjectTrustDefault,
  ProjectTrustInspection,
  ProjectTrustInspectionOptions,
  ProjectTrustPromptChoice,
  ProjectTrustPromptRequest,
  ProjectTrustResource,
  ProjectTrustStatus,
  ProjectTrustUpdate,
  ResolvedProjectTrust,
  ResolveProjectTrustOptions,
} from './project-trust.js';
export {
  WORKSPACE_BROWSE_ENTRY_LIMIT,
  WorkspaceManager,
  WorkspacePathError,
} from './workspace-manager.js';
export type {
  WorkspaceDescriptor,
  DirectoryEntry,
  GitWorktree,
  WorkspacePathKind,
} from './workspace-manager.js';
