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
- Resources and summaries are explicit. Expansion returns text, not a tool registration/prompt. Manual compaction accepts a supplied summary; automatic compaction requires an explicit callback and never commits an aborted result.

Unsupported facade surfaces remain explicit: executable loading/MCP hosting, OAuth/discovery, settings/instruction auto-loading, provider switching, direct shell/HTML export, cross-process admission and full custom-entry remapping. Host callbacks/stores/providers are privileged integrations, not sandboxed; non-cooperation may delay settlement.

## Validation

Docker only, build genuine Core first, focused `npx vitest run packages/core/src/sdk --maxWorkers=1`, strict Core/test-source checks. Public consumers copy the actual package manifest and emitted dist into an external temporary installation and import only `@ai-harness/core`; positive/negative NodeNext declarations must compile against that package, not source aliases/private replacements. Preserve durable-stop, passive factory, fresh trust, borrowed ownership, split-secret, mutation isolation, raw history and nested accounting assertions.

## Related topics

- [Sessions](./sessions.md)
- [Security](./security.md)
- [Providers](./providers.md)
- [Public contract policy](../../contributors/en/public-contract-policy.md)
