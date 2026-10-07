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
  WorkspaceManager,
  WorkspacePathError,
} from './workspace-manager.js';
export type {
  WorkspaceDescriptor,
  DirectoryEntry,
  GitWorktree,
  WorkspacePathKind,
} from './workspace-manager.js';
