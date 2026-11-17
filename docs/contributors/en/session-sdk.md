# AiHarness TypeScript session SDK

Import the high-level facade from the genuine built `@ai-harness/core` root entry (Core API major 1). The [complete bilingual SDK reference and mock example](../../../packages/core/src/sdk/README.md) describes all supported options/methods; [agent ownership guide](../../ai/topics/session-sdk.md) identifies implementation and validation.

Compose an explicit built-in config or borrowed `AiProvider`, canonical workspace roots and an independently owned fresh trust policy. Omit `store` for actual memory; supply `JsonlSessionStore` or the structural six-operation `SessionStore` for persistence/resume. The factory performs no discovery, executable/MCP loading, credential command or provider request. Cloud credentials may be used by an explicit prompt, not at factory time.

`prompt` starts detached work; `promptAndWait` waits for that run. `stop` acknowledges abort: await `wait` for durable interrupted results/accounting. Wait must not block stop. Busy starts/history/settings mutations are refused. Version-1 sequenced events retain unknown payloads and bounded replay/reset semantics. Read methods return detached redacted copies of active context or raw abandoned/pre-compaction history.

`fork` copies durable user ancestry; `branchBefore` changes the active path; `clone` creates an independent root with remapped active IDs. Manual compaction uses a supplied summary; automatic compaction uses an explicit callback. Resource discovery/expansion is opt-in and returns text to send yourself. No extra agent/persistence/retry loop belongs in this facade.

Capture options and borrowed identities before the first await, method arguments at admission, and detach/redact callbacks/store/public data. Mutating usage/policy observers must not change durable tokens/history. Supply explicit secrets or a shared Core redactor, especially for shared backends. Custom stores must validate/bound their backend, preserve v2 raw parent graphs and Date projections, enforce atomic requireAbsent/locking, and await durability.

Inspect `capabilities` and `ownership`; dispose every fork/clone handle. Last-handle cleanup closes only owned scopes/registry, never caller stores/providers/registries or global transports. Non-cooperative host integrations can delay settlement and are not sandboxed. OAuth/discovery, implicit instructions/settings, executable/MCP loading, provider switching, shell/HTML export, shared-process admission and arbitrary custom-data reference rewriting are not implied.

Lower-level `SessionManager.getActiveBranchEntries(id)` supplies an owned parent-first private-state path, distinct from raw history/model context, with last append projections and incomplete/stale-read refusal. Related forks now preserve selected stable IDs and custom/private ancestry through Core's bounded copy path; independent clones remap internal IDs. This adds no facade read/mutation method, cross-process CAS or arbitrary custom-payload ID rewriting. See the [extension state contract](./extensions-cli.md#session-state-context-and-generations).

Native `JsonlSessionStore.getSessionSnapshot(id)` and the manager's fourth `forkSession` options `{sourceStore?,id?,cwd?,workspaceId?,signal?}` are lower-level APIs, not facade methods or new structural store requirements. One stable bounded read preserves the raw journal without rewriting a foreign source; shared rich copies retain selected private/custom/summary/compaction ancestry. Own options are captured before awaits and a changed target store withdraws unpublished work; existing no-session startup precedence and API1/schema2 remain. CLI startup ID/prefix/file selection uses this same engine, not a second message-only copier.

Existing facade fork/branchBefore/clone now use Core ordered cancellation through an independent borrowed registry lease. Dispose publishes its one promise before synchronous abort dispatch and withdraws unpublished work before waiting the handle tail, including ignored hooks. Reentry cannot release live sibling ownership twice; admitted writes finish and returned child handles stay live. Final cleanup/factory failure releases only its lease, preserving another host's lifecycle/summary binding and borrowed resources. Lower-level `onBeforeBranch` and explicit `onBeforeBranchSummary`/registry overrides add no facade or structural-store requirements. See [ordered extension contracts](./extensions-cli.md#ordered-branch-and-summary-hooks), including privacy, budgets, last-override/veto ordering and original legacy caller-signal identity.

## Native embedding adaptation

Use the [host/SDK adaptation map](../../ai/topics/native-extension-contract.md), not foreign method aliases. The explicit registry can provide bounded output/turn/settlement hooks; `prompt(text,{trigger:{kind:'custom',type:'automation:review'}})` persists custom model-visible context instead of a user message. Continuations share the existing round budget and durable stop/ownership rules. Constructor/reads remain passive; provider switching, executable/auth/MCP discovery and custom renderers are not silently added. The genuine public declaration/runtime consumer covers these additions alongside existing queue/copy/compaction/borrowed-resource controls.

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

`ResourceManager` snapshots scoped arrays/fields at construction without invoking array-entry or selector-field getters; the built-in loader constructs it on explicit `load`. Limits are 512 requests per combined legacy/scoped layer and 32KiB per pattern/base pair. Legacy mutable `*Paths: string[]` options and `resolveAgentResourcePaths` retain their string ABI. For absolute strings inside the manager's configured cwd, agent directory or home, the longest matching known root now stays literal. Supply the same roots used to resolve settings; no filesystem probing guesses an arbitrary declaring directory. Scoped absolute patterns likewise preserve their own `baseDir`. Outside-base and nested patterns retain glob syntax; use scoped records or exact `+` for any additional literal identity. If both forms are supplied, legacy paths precede scoped selectors in the same layer. No implicit settings, executable loading or trust is added to the SDK.

`discoverSkills: false` / `discoverPrompts: false` on `ResourceManager` or `createAgentResourceLoader` skip automatic roots and the corresponding supplied settings/package selector layers, retaining explicit `skillPaths` / `promptPaths`. Both default to true. Legacy `disableSkills` / `disablePrompts` still disable **all** loading, including explicit paths; they were not repurposed. These are host options, not saved agent settings, and never override project trust or stable-file checks. The SDK factory remains passive.

## Lower-level compaction limits

`SessionManager.setCompactionContextWindow(tokens?)` accepts a positive safe integer or `undefined`; its getter returns a manager-scoped, non-persisted host limit. With a limit, automatic admission requires `estimateContextTokens(id) > window - reserveTokens`, then the existing keep/cut checks; the window is rechecked across asynchronous admission. Clearing it preserves the legacy trigger. The passive root `resolveAgentCompactionContextWindow(provider?, model?)` uses published metadata or a 128,000-token non-mock fallback; missing/mock identities preserve legacy policy. This is not exact system/tool wire tokenization or authoritative metadata for unknown models. Manual targets and the high-level facade do not acquire a window setter or implicit model discovery.

## Lower-level navigation and custom context

The root also exports `SessionManager.navigateTree(sessionId, entryId, options?)`, `BranchNavigationOptions`/`BranchNavigationResult` and `createProviderBranchSummarizer(provider, model?)`. Only explicit `summarize: true` authorizes generation; a callback alone does not. Results distinguish `navigated`, `not-found`, `cancelled` and `stale`. Generation is bounded and outside the mutation queue; publication rechecks the exact source. A cancellation cannot roll back an admitted write. These methods do not become methods of the high-level session facade; its host still owns foreground admission and callback cooperation.

`appendCustomEntry` stores bounded own JSON outside model context. `appendCustomMessage` contributes content even with `display: false`, never `details`; this is not a secret vault/sandbox. Context follows parents, compaction and destination summaries, never summary `fromEntryId` provenance, and drops incomplete tool groups. Active clones remap required custom/summary/compaction ancestry and legacy prefix anchors, not arbitrary IDs inside payloads. The journal stays at schema major 2 and Core API major 1; caller stores must preserve these entries without requiring a local file path.

## Journal accounting

Use the public Core `getSessionAccounting(readonlyEntries, activeLeafId?)` for active ancestors versus full history. On an idle SDK handle, supply `await session.history()` and `session.snapshot().activeLeafId`; context size is a separate estimate. Persisted cost wins; published pricing requires the entry's own provider/model. Unknown/partial costs and authenticated outer nested usage must survive projection, without summing progress or nested detail payloads. `requests` counts accountable entries, not internal network calls. Optional copied `BranchSummaryAccounting` on the lower-level manager/store summary methods survives v2 reload/clone; it is neither automatic generation nor a new facade method. See the complete reference for bounds and unknown-measurement behavior.

## Validation

Build Core and run its SDK tests/typechecks **inside Docker**, with one worker. `public-consumer.test.ts` uses a real external temporary installation of the manifest and emitted dist; Node imports only `@ai-harness/core`, and real TypeScript NodeNext compiles positive/negative calls against emitted declarations. Do not replace the public entry with source aliases or a private SDK module to manufacture proof.

Related: [public contract policy](./public-contract-policy.md), [architecture](./architecture-overview.md), [user guide](../../users/en/user-guide.md#typescript-session-sdk).
