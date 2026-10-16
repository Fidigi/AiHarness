# Session SDK

## Scope and ownership

The Core API-major-1 root entry exports `createAgentSession`, `createAgentResourceLoader`, session/provider/auth/model types, structural `SessionStore`, and existing Date/wire conversions. The complete bilingual API and lifecycle reference is [Core SDK README](../../../packages/core/src/sdk/README.md); contributor guides are [EN](../../contributors/en/session-sdk.md) and [FR](../../contributors/fr/session-sdk.md).

| Source | Responsibility |
|---|---|
| `packages/core/src/sdk/agent-session.ts` | Additive facade over existing runtime, manager, trust, redaction and scoped network lifecycle |
| `sdk/types.ts` | Explicit supported factory/method/capability/ownership contracts |
| `sdk/session-store.ts` | Six-operation nominal bridge for borrowed structural stores; detached/redacted data, not a new persistence engine |
| `sdk/resource-loader.ts` | Explicit bounded Markdown discovery/expansion using existing ResourceManager |
| `sdk/{agent-session,public-review,public-consumer}.test.ts` | Lifecycle/regression tests and genuine external installed-package runtime/declaration consumers |

## Invariants

- Factory/read operations do not discover models/resources, construct providers, load executables/MCP, execute credential commands or open an encrypted store. Explicit prompts lazily construct named built-ins; custom providers are borrowed instances, not global dynamic registrations.
- Execution defaults to denied. Canonical allowed roots and the host's independently owned fresh decision gate prompts/resource loads. No SDK trust write or project-controlled approval marker.
- Omitted store means true memory. Caller stores must preserve raw v2 parent graphs, Date projections, atomic requireAbsent, bounded locking/redaction and promised durability. Share a redactor for shared stores/providers.
- Capture value options/borrowed identities before initialization and mutable method arguments at admission. Public reads, events, usage/policy/summary callbacks and store bridge data are detached/redacted; callback mutation cannot change durable accounting/history.
- Stop acknowledges cancellation; wait/dispose await real durable settlement. Wait must not occupy the mutation queue or block stop. Busy history/settings changes and concurrent starts are refused. Do not invent a terminal timeout that releases live work.
- Dispose every fork/clone handle. Only the last handle closes group-owned scopes/registry; never delete sessions, unload borrowed registries, close caller providers/stores or global dispatchers.
- Absolute Markdown selectors preserve their known literal cwd/agent/home root (longest match), or their explicit scoped base; nested/outside-base patterns remain globs. Legacy mutable string paths/helper output stay unchanged, and relative strings retain cwd semantics. Supply consistent settings/manager roots; never infer an arbitrary root by scanning files. `resources/resource-absolute-selectors.test.ts`, the actual CLI process leaf and installed legacy Core/SDK/PATH consumer own this boundary.
- Resources and summaries are explicit. Expansion returns text, not a tool registration/prompt. `ResourceManager` / `createAgentResourceLoader` accept optional `discoverSkills` / `discoverPrompts` (default true): false skips automatic/settings/package layers, not explicit `skillPaths` / `promptPaths`. Legacy `disableSkills` / `disablePrompts` remain all-loading denials, including explicit paths; no saved setting or trust grant is added. Manual compaction accepts a supplied summary; automatic compaction requires an explicit callback. Core rechecks signal/session/leaf/local policy admission after inherited-policy and summary waits and before starting persistence, including after manager queue waits. A started durable write is not cancellation rollback; non-cooperative callbacks/stores can delay settlement.

Lower-level `SessionManager.setCompactionContextWindow(tokens?)` admits only positive safe integers or `undefined`; its getter returns the manager-scoped, non-persisted limit. With a limit, automatic admission requires the effective estimate to exceed window minus reserve, and rechecks that window after waits. Clearing it preserves the legacy host trigger; manual targets and the facade remain unchanged. The passive `resolveAgentCompactionContextWindow` helper uses published limits or a 128,000-token non-mock fallback, not authoritative metadata for unknown models. See [compaction ownership](./sessions.md#effective-context-and-compaction).

Lower-level root-exported `SessionManager.navigateTree` requires explicit `summarize: true`; its optional provider adapter has no tools/discovery. `appendCustomEntry`/`appendCustomMessage` accept bounded owned JSON/content: state/details never enter model context, while hidden-display content does. Structural stores remain journal owners without a filesystem path. Awaited `getActiveBranchEntries` returns an owned parent-first private-state path, with last append projections and incomplete/stale-read refusal; it is not raw history/model context or a facade method. Related forks retain selected stable IDs/private/custom ancestry through the same bounded copy path used by independent clones, which remap IDs including legacy prefix anchors; arbitrary IDs inside custom data remain untouched. See [session context](./sessions.md#optional-navigation-summaries).

Native `JsonlSessionStore.getSessionSnapshot(id)` supplies a bounded read-only owned `{session,entries}` from one stable file, with raw rather than active history. Lower-level `SessionForkOptions` adds captured own `{sourceStore?,id?,cwd?,workspaceId?}` to the manager copy method; CLI startup ID/prefix/file forks reuse it. A foreign source is not inserted into the destination manager or rewritten; target persistence owns the copy. Descriptor/scalar/stale-target refusals and explicit undefined-workspace clearing stay lower-level. Neither this snapshot reader nor these copy options expand the SDK facade or structural store ABI.

Unsupported facade surfaces remain explicit: navigation/custom append mutations, executable loading/MCP hosting, OAuth/discovery, settings/instruction auto-loading, provider switching, direct shell/HTML export, cross-process admission, exhaustive fork lifecycle hooks and arbitrary custom-data reference remapping. Host callbacks/stores/providers are privileged integrations, not sandboxed; non-cooperation may delay settlement.

## Validation

Docker only, build genuine Core first, focused `npx vitest run packages/core/src/sdk --maxWorkers=1`, strict Core/test-source checks. Public consumers copy the actual package manifest and emitted dist into an external temporary installation and import only `@ai-harness/core`; positive/negative NodeNext declarations must compile against that package, not source aliases/private replacements. Preserve durable-stop, passive factory, fresh trust, borrowed ownership, split-secret, mutation isolation, raw history and nested accounting assertions.

## Related topics

- [Sessions](./sessions.md)
- [Security](./security.md)
- [Providers](./providers.md)
- [Public contract policy](../../contributors/en/public-contract-policy.md)
