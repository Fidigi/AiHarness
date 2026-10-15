# AiHarness TypeScript session SDK

Import the high-level facade from the genuine built `@ai-harness/core` root entry (Core API major 1). The [complete bilingual SDK reference and mock example](../../../packages/core/src/sdk/README.md) describes all supported options/methods; [agent ownership guide](../../ai/topics/session-sdk.md) identifies implementation and validation.

Compose an explicit built-in config or borrowed `AiProvider`, canonical workspace roots and an independently owned fresh trust policy. Omit `store` for actual memory; supply `JsonlSessionStore` or the structural six-operation `SessionStore` for persistence/resume. The factory performs no discovery, executable/MCP loading, credential command or provider request. Cloud credentials may be used by an explicit prompt, not at factory time.

`prompt` starts detached work; `promptAndWait` waits for that run. `stop` acknowledges abort: await `wait` for durable interrupted results/accounting. Wait must not block stop. Busy starts/history/settings mutations are refused. Version-1 sequenced events retain unknown payloads and bounded replay/reset semantics. Read methods return detached redacted copies of active context or raw abandoned/pre-compaction history.

`fork` copies durable user ancestry; `branchBefore` changes the active path; `clone` creates an independent root with remapped active IDs. Manual compaction uses a supplied summary; automatic compaction uses an explicit callback. Resource discovery/expansion is opt-in and returns text to send yourself. No extra agent/persistence/retry loop belongs in this facade.

Capture options and borrowed identities before the first await, method arguments at admission, and detach/redact callbacks/store/public data. Mutating usage/policy observers must not change durable tokens/history. Supply explicit secrets or a shared Core redactor, especially for shared backends. Custom stores must validate/bound their backend, preserve v2 raw parent graphs and Date projections, enforce atomic requireAbsent/locking, and await durability.

Inspect `capabilities` and `ownership`; dispose every fork/clone handle. Last-handle cleanup closes only owned scopes/registry, never caller stores/providers/registries or global transports. Non-cooperative host integrations can delay settlement and are not sandboxed. OAuth/discovery, implicit instructions/settings, executable/MCP loading, provider switching, shell/HTML export, shared-process admission and full custom-entry semantics are not implied.

## Scoped Markdown resources

`ResourceManager` and `createAgentResourceLoader` accept additive `globalSkillSelectors`, `projectSkillSelectors`, `globalPromptSelectors` and `projectPromptSelectors`. Each readonly `ResourceFileSelector` keeps `{ pattern, baseDir }` separate; `baseDir` must be absolute and stays literal, while `pattern` supports ordered plain/glob, exact `+`, subtree `-` and `!glob` operations. For previously loaded settings, use `resolveAgentResourceSelectors(settings, 'prompts', homeDir, 'global')` (or `'skills'`/`'project'`). Project selectors remain trust-gated.

```ts
import { createAgentResourceLoader, type ResourceFileSelector } from '@ai-harness/core';
const selectors: readonly ResourceFileSelector[] = Object.freeze([
  Object.freeze({ pattern: '*.md', baseDir: '/srv/operator/prompts[literal]' }),
]);
const loader = createAgentResourceLoader({ globalPromptSelectors: selectors });
// Still passive: explicit loader.load(context) performs discovery.
```

`ResourceManager` snapshots scoped arrays/fields at construction without invoking array-entry or selector-field getters; the built-in loader constructs it on explicit `load`. Limits are 512 requests per combined legacy/scoped layer and 32KiB per pattern/base pair. Legacy mutable `*Paths: string[]` options and `resolveAgentResourcePaths` retain their string ABI. They cannot recover a literal directory already flattened into an absolute glob: use scoped records or exact `+` paths in that case. If both forms are supplied, legacy paths precede scoped selectors in the same layer. No implicit settings, executable loading or trust is added to the SDK.

`discoverSkills: false` / `discoverPrompts: false` on `ResourceManager` or `createAgentResourceLoader` skip automatic roots and the corresponding supplied settings/package selector layers, retaining explicit `skillPaths` / `promptPaths`. Both default to true. Legacy `disableSkills` / `disablePrompts` still disable **all** loading, including explicit paths; they were not repurposed. These are host options, not saved agent settings, and never override project trust or stable-file checks. The SDK factory remains passive.

## Validation

Build Core and run its SDK tests/typechecks **inside Docker**, with one worker. `public-consumer.test.ts` uses a real external temporary installation of the manifest and emitted dist; Node imports only `@ai-harness/core`, and real TypeScript NodeNext compiles positive/negative calls against emitted declarations. Do not replace the public entry with source aliases or a private SDK module to manufacture proof.

Related: [public contract policy](./public-contract-policy.md), [architecture](./architecture-overview.md), [user guide](../../users/en/user-guide.md#typescript-session-sdk).
