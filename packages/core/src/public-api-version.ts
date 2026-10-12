/**
 * Major version of the supported `@ai-harness/core` entry-point contract.
 *
 * This is independent from the package release version. It changes only when
 * an intentional breaking change cannot be represented additively or through
 * a documented migration.
 */
export const AI_HARNESS_CORE_API_VERSION = 1 as const;

/** Major version supplied to every loaded AiHarness extension factory. */
export const AI_HARNESS_EXTENSION_API_VERSION = 1 as const;
