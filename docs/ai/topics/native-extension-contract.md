# Native Extension and Embedding Contract v1

> **Navigation:** Read [`project-map.md`](../project-map.md) first. Loader/security details remain in [extensions](./extensions.md); this file owns the EXT-01–EXT-04 host/adaptation map.

## Overview

AiHarness is an independent product: Core API 1, extension API 1 and journal schema 2 are separate contracts. Import only the public `@ai-harness/core` root. JavaScript/TypeScript support and the legacy `pi` manifest key do not imply Pi extension, SDK, RPC, file or renderer compatibility. Never alias Pi imports to native objects.

## Main Entry Points

| Path | Responsibility |
|---|---|
| `packages/core/src/extensions/{extension-registry,execution-hooks}.ts` | Owned registrations, native event vocabulary, bounded output/continuation admission |
| `packages/core/src/agent/{tool-loop,runtime}.ts` | Shared output/turn/settlement boundaries and typed initial triggers |
| `packages/core/src/{extensions/module-loader,plugins/plugin-service}.ts` | Trusted executable generations and explicit package administration |
| `packages/core/src/sdk/{types,agent-session,resource-loader}.ts` | Explicit embedding, owned lifetimes, passive resource composition |

## Imports, results and UI by host

“Core” below means the same shared loop, not an independent host implementation. A borrowed registry alone does not construct a CLI, command dispatcher, terminal renderer or browser.

| Capability | Regular / fullscreen | Print / JSON | RPC | Server / browser | SDK facade |
|---|---|---|---|---|---|
| Public Core imports, JS/TS factories | Trusted loader | Same loader | Startup loader | Server loader only | Explicit host loader; never automatic |
| `registerOption` | Two-phase argv | Same | Startup argv | No contributed HTTP flags | No argv parser |
| `registerCommand` | Slash dispatch | Positional slash text stays literal | Native extension command dispatch | Native command endpoint | Host invokes registry command explicitly |
| Tool/provider registrations | Core | Core | Core | Server executes; browser sees inert DTOs | Borrowed preconfigured registry; provider identity remains factory-bound |
| Text/structured/image/error results | Text-first; images retained, no inline terminal-image promise | Print final text / JSON rich records | Rich native records | Existing inert rich renderer | Owned history/events |
| `registerUI` | Fullscreen text panels only | No renderer | Use optional `context.ui`, not panels | Server text widgets | No renderer |
| `context.requestInteraction` | Not supplied by ordinary terminal loop | Not supplied | Bounded dialogs/controls, explicit replay | Bounded declarative forms/queue | Runtime handle + respond method; host renders |
| `context.ui` | Absent | Absent | Plain-text status/widget/title/editor intents | Absent | Absent |
| Executable reload | Explicit `/reload` | Restart | Restart; settings reload is not executable reload | Explicit resource reload, same-cwd rollback / failed-workspace retirement | Explicit owner-managed loader; facade resources are Markdown only |

No arbitrary extension React, HTML, DOM, CSS, client scripts, custom terminal components, Pi peer aliases or private Core subpath aliases. Check optional context methods before use. A JS `api.on`/`api.before` registration with an unknown or foreign name throws; TypeScript rejects it. Retained APIs cannot register commands/tools/providers/UI/listeners/hooks after unload. Factory failures remove partial registrations. Node imports/effects are privileged and not rolled back.

## Semantic event map

| Native surface | Meaning and authority |
|---|---|
| `on('session:*'/'message:*'/'compaction:*')` | Explicit named lifecycle observations via attached manager; concurrent/error-isolated, not transformations. SDK borrows only branch/summary/compaction admission, not another host's lifecycle binding |
| `on('agent:*'/'provider:call:*'/'tool:*')` | Existing host observations, not Pi event aliases or a complete typed transcript. Core runtime journal is the SDK/Web run event source |
| `before:agent` | Initial input/provider transform; runtime supplies readonly user/custom trigger and startup signal. Direct legacy callers may omit trigger/signal; absent trigger means user |
| `before:provider` | Per-request context transformation (`messages`) and options; final bounded/redacted payload validation and loadout recording remain authoritative. Does not rewrite the journal |
| `before:tool` / `before:model` | Selected tool input/context or specialized request transformation, with existing authorization/capability rechecks |
| `before:message` | After provider completion/accounting, before assistant publication: return `{content}` only. Cannot rewrite reasoning, tool calls, model, usage or source |
| `before:tool:result` | Top-level selected result after execution, before persistence/model delivery: return `{result:{content,structuredContent?,blocks?,isError?}}`. No `details`, activation, store or usage authority. Nested calls retain their ordinary tool hooks; no separate post-result callback is promised for nested records |
| `before:turn:end` | After complete assistant/tool persistence and ordinary turn observation; receives session/round/current trigger/tool count, live context and host signal. Successful logical turns only, not failed transport retries or recovered length attempts |
| `before:agent:settle` | After a tool-free final candidate and turn hook, before logical settlement/queued host follow-ups. Does not replace durable cleanup or `wait()` |
| `before:session:branch/summary/compaction` | Existing ordered cancel-only / output-only bounded admission; see [extension contracts](./extensions.md#ordered-branch-and-summary-admission) |

The `*` groups above are documentation shorthand, not wildcard subscriptions. For migration, Pi's actionable `turn_end` and `agent_before_settle` concepts correspond to native `before:turn:end` and `before:agent:settle`, not to observational `on('agent:end')`. Context transformation uses `before:provider`; post-message/result replacement uses the two explicit output hooks above. These are semantic adaptations with different payloads and authority, never event aliases.

For the four output/turn/settlement hooks, callbacks run in registration order, with detached public result/trigger/continuation data and frozen top-level event. Context remains an explicitly privileged live capability. Only explicit own-data outputs transform the next handler; undefined keeps the prior value. Unknown keys, accessors, invalid outputs and thrown errors fail closed with fixed diagnostics. False or own `{cancel:true,reason?}` stops the chain. Later callbacks do not run after cancellation. Registration/removal/unload withdraws unpublished hook work even if a callback ignores its signal; late output cannot publish. This retires authority, not privileged Node execution or admitted storage writes.

Message veto/error fails the run, retains the completed response's authentic usage and failed text evidence, and executes no pending tool calls. Erasing an originally nonempty answer still persists its authentic usage; ordinary empty completions retain the existing no-message behavior. Tool-result veto/error becomes an error result, retaining authenticated completed nested usage but not granting activation/store authority. Turn/settlement veto fails without appending a continuation. Stop remains stopped. Streamed raw text may already have been displayed before a replacement or veto: output hooks are not a streaming secret filter; use the host credential redactor. The regular terminal appends an explicit accepted replacement frame rather than claiming to erase previous lines; fullscreen/history/reload use the accepted content.

## Typed triggers and bounded continuations

`AgentRunTrigger` is `{kind:'user'}` or `{kind:'custom',type}`. Runtime/SDK defaults to user. Explicit custom starts use `prompt(text,{trigger:{kind:'custom',type:'review:check'}})` and persist a native model-visible `custom_message`, not an invented user message. Custom starts accept text only. CLI/RPC/browser initial prompts remain user inputs; extension continuations work in their shared loop without new argv/wire aliases.

A turn/settlement hook can return `{continuation:{type,content}}`; the last defined value wins, and `{continuation:null}` explicitly clears it. A final settlement hook sees the preceding turn continuation. Types match `[A-Za-z][A-Za-z0-9:_.-]{0,127}`; continuation own JSON is bounded to 64 KiB, nonempty text/no NUL. The existing `maxToolRounds` budget includes continuation turns: no recursion, fresh run, reset budget or unserviceable final trigger is appended. Cancellation is checked again inside the manager mutation queue through the additive fourth `appendCustomMessage` admission argument. Already-admitted writes finish.

```ts
import type { ExtensionAPI } from '@ai-harness/core';
export default function review(api: ExtensionAPI) {
  api.before('before:agent:settle', event => event.round === 0
    ? { continuation: { type: 'review:check', content: 'Check the answer once.' } }
    : undefined);
}
```

Private durable state uses `appendCustomEntry` and awaited `getActiveBranchEntries`, not factory closure variables or model messages. Restore it from the selected parent path after resume/reload/navigation; related forks preserve selected state, clones remap known IDs, compaction retains pre-compaction private ancestry. Existing state/branch tests cover those distinctions; custom type names are conventions, not tenant isolation. Continuations reuse native v2 entries; no migration or Pi import is added.

## Package and resource adaptation

| Pinned Pi concept | Native recipe / retained difference |
|---|---|
| Package identity/install | Explicit `package install/check/update/remove` through Core `PluginService`: `npm:`, restricted HTTPS Git or allowed local path; native IDs/state/scopes, no Pi store synchronization |
| Resource manifest/filter | `aiHarness` fields; legacy `pi` fields are metadata fallback only. Package-relative per-kind include/exclude filters narrow manifest inventory; settings selectors act before executable imports |
| Suppress discovery / explicit entry | CLI `--no-extensions` preserves explicit `-e`; independent `--no-skills`, `--no-prompt-templates`, `--no-themes` preserve their explicit selections, never bypass trust |
| Skills/templates and arguments | Bounded native Markdown/frontmatter, ordered selectors, existing positional/default argument semantics; expansions return text. No `npx skills add` subprocess adapter |
| Themes | Native JSON terminal palettes; no Pi color-format/CSS or browser-theme ABI promise |
| Collisions and dependencies | Duplicate owned command/tool/provider/UI names refuse candidate; actual paths deduplicate; exact Core root resolves to host identity. Other peer imports require actual dependencies; native caches remain native |
| Update/reload | Staged install/update with locked state/files rollback; same-cwd executable generation restores previous factories on failure. Native effects/dependency caches are not a transaction. CLI and Server own separate generations; SDK loading remains explicit |
| Passive inventory | `package list` and authenticated catalogue GET never install, update, import modules or contact npm/Git |

## Embedding adaptation recipes

Use `createAgentSession` with explicit cwd/provider/trust; add `JsonlSessionStore` plus `{kind:'resume',id}` only for wanted persistence. Borrow a preconfigured registry for hooks/tools, and an explicit resource loader for Markdown. Constructor and reads do not discover executable/auth/MCP/model resources. Select models with idle `setModel`; provider switching requires a new explicitly bound group. Use `steer`/`followUp`/`clearQueue` during active work, `fork`/`branchBefore`/`clone` while idle, supplied-summary `applyCompaction` and an explicit summarizer for automatic compaction. Await `stop()` then `wait()`, and dispose every child handle; only the last closes group-owned resources. Never close caller stores/providers/registries or another handle's leases. See [complete SDK reference](../../../packages/core/src/sdk/README.md).

Unsupported Pi facade methods are not synthesized: automatic configured/persistent startup, executable/MCP/auth discovery, provider switching, custom React/terminal components, shell/HTML export, cross-process admission and arbitrary payload-ID remapping. Public negative declaration consumers enforce native names/options rather than relying on signature similarity.

## Associated Tests

- `extensions/execution-hooks.test.ts` under Core: order, output ownership, invalid/accessor/foreign names, abort/unload/unsubscribe and stale registration refusal.
- Core `sdk/{execution-hooks,public-consumer,session-branch-hooks,session-compaction-lifecycle,prestart-lifetime}.test.ts`: typed custom starts, bounded continuation, resume/copy state, stop/reentrancy, borrowed ownership and external emitted declarations/runtime.
- `packages/cli/src/cli/extension-execution-process.test.ts` and `tests/functional-parity/installed-executable.test.ts`: actual print/JSON/RPC and regular/fullscreen PTYs, authentic usage, persisted custom triggers and original-ID results; genuine pack/install/PATH consumer reruns the same probe.
- `packages/server/src/api/extension-execution-http.test.ts`: loaded extension, actual authenticated HTTP/replay/JSONL and passive inventory; `e2e/extension-execution-live.spec.ts` separately verifies actual browser output/continuation, cold reload and inert script-shaped text; `e2e/interaction-live-boundary.spec.ts` protects inert browser dialog response/cancel.
- Existing Core module/selector/alias/plugin/resource tests, CLI `extension-session-state-process.test.ts`, Server module-generation tests and `e2e/settings.spec.ts` cover native package/resource/refusal/rollback boundaries. Test presence alone is not an executed audit receipt.

## Common Changes

- Add a hook in `extension-registry.ts` and `execution-hooks.ts`, root exports, shared loop boundary, positive/negative declarations and real-host probe; preserve authentic metadata/accounting and physical settlement.
- Change host/UI/resource support only with the owning CLI/Server/Web adapter and its separate process/HTTP/browser evidence; never infer a renderer from Core registration.

## Related Domains

- [Extensions](./extensions.md) — loading, ownership, packages and interactions.
- [Session SDK](./session-sdk.md) — facade lifetimes and borrowed resources.
- [Native runs](./run-lifecycle.md) — settlement, queues and rich results.
