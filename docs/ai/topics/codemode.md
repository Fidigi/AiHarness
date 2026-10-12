# Bounded QuickJS Code Mode

> **Navigation:** See [`project-map.md`](../project-map.md), [`security.md`](./security.md), [`cli-reference.md`](./cli-reference.md), and [`server-api.md`](./server-api.md).

## Overview

Core owns `packages/core/src/tools/{codemode,codemode-worker,tool-search}.ts`. CLI, JSON, RPC and detached Web runs use the same prompt-local loadout and tool loop. The worker is trusted Node infrastructure; user source is evaluated **only in QuickJS**, never in Node `eval`, `Function`, or `vm`.

`codemode` is an inactive-by-default synthetic model-only helper, not a registry mutation. CLI opt-in is `--tools codemode,<permitted nested tools>` or `defaultTools` containing `codemode`; existing allowlists replace defaults and still apply. Trusted agent settings support `codemode.mode` (`on`/`only`) and `codemode.inlineBudget` (0–3000 estimated tokens). Web Settings › Tools exposes Automatic/Always on, presentation and budget at global/project scope. Automatic activation needs eligible indirect tools; merely allowing the helper does not activate it in Web Automatic mode. Empty allowlists, exclusions, chat-only and no-builtins/no-tools remain authoritative.

The Server runs a bounded fixed-script self-test at service construction and caches it per process. `GET /api/tools` reads the cached result without starting a script. Failed/unavailable health disables Web sandbox execution. Inline declarations are capped at four characters per configured estimated token; this is a presentation estimate, not a tokenizer or authority boundary.

## Main Entry Points

| File | Responsibility |
|---|---|
| `packages/core/src/tools/codemode.ts` | Host ceilings, worker lifecycle, redacted bridge and authenticated store metadata |
| `packages/core/src/tools/codemode-worker.ts` | Trusted worker infrastructure and isolated QuickJS guest execution |
| `packages/core/src/tools/tool-search.ts` | Selected prompt-local namespace, live nested authorization and active-branch restoration |
| `packages/core/src/providers/specialized-models.ts` | Credential-private SDK/guest model descriptors, typed requests/results, live availability and deadlines |
| `packages/web/src/components/CodemodeCard.tsx`, `packages/web/src/components/codemode-state.ts` | Specialized presentation and replay-safe nested state |
| `packages/server/src/api/tool-routes.ts` | Cached health and canonical scoped settings/readback |

## Guest Contract

The tool input is exactly `{ "code": "async JavaScript body" }`. Scripts can use:

- `await tools.<provider-safe-name>({...})`: returns redacted tool text; tools may have real side effects.
- `Promise.all()` / `Promise.allSettled()` for parallel work within the host concurrency budget.
- `ALL_TOOLS`, `searchTools(query, { limit?, namespace? })`, `describeTool(name)` and `describeNamespace(name)` for bounded eligible metadata.
- `text(value)`, `console.log/info/warn/error/debug`, `return` and `exit()` for bounded output/completion.
- `store(key, jsonValue)` and `load(key)` for branch-local JSON values; `store(key, undefined)` deletes a key.

There is no guest Node/process/require, filesystem, network, timer or module-loader capability. The dependency is resolved from Core's installation, not the selected workspace. `models.getModelsOfType`, `getAvailableOfType` and `getModelOfType` expose only bounded descriptors of the current provider. `models.classify({model,input,labels})` returns `{label,usage?}`; `models.generateImages({model,prompt,count?,size?})` returns `{images:[{mediaType,data}],usage?}` with base64 data. Requests accept no credential, endpoint, header or host-signal fields. Model IDs must match the live catalogue and kind again after any hook. The configured chat model supplies a virtual JSON-label classifier; OpenAI Chat providers expose native `dall-e-2`/`dall-e-3` (not Azure), mock supplies a fixture image, and typed extensions may implement native methods. No upstream API naming/schema compatibility or complete provider breadth is claimed.

The exported Core `SpecializedModels` SDK uses the same contract with host-only `{signal}` options. Model calls have a 10-second deadline including cancellable `before:model` hooks. Code mode installs this dedicated hook through the shared tool loop: native/virtual model requests are not conversational `before:provider` turns. Hooks receive the operation AbortSignal and a context whose notifications/interactions cannot publish after it settles. Their output/usage persists once on the outer tool result, not as extra assistant turns. Direct SDK users can provide the optional bounded hook callback. Inputs are 32 KiB; labels are 1–100 unique strings (500 bytes each); image counts are 1–4, decoded output is capped at 8 MiB and accepts PNG/JPEG/WebP signatures only. Remote image URLs are never followed. Image data additionally consumes the guest's 256 KiB cumulative nested JSON limit; oversized images fail rather than escaping that budget. Built-in requests reuse provider network policy and credentials; no key crosses into QuickJS.

## Resource and Policy Bounds

| Resource | Hard default ceiling |
|---|---|
| Whole hosted operation, including indirect preparation | 10 seconds |
| QuickJS allocation / stack | 32 MiB / 256 KiB |
| Interrupt-handler fuel | 10,000 callbacks (not a JavaScript instruction count) |
| Bridge operations / simultaneous host calls | 64 / 4 |
| Source / one nested JSON input / aggregate script output | 64 KiB each |
| Cumulative successful nested-result JSON | 256 KiB |
| Guest output records / eligible tool snapshot | 1,000 / 2,000 |
| Store keys / one value / complete committed store | 128 / 64 KiB / 256 KiB |
| Active workers per process | 8 |

The worker also has Node heap/stack resource limits and an empty inherited environment. A host timer terminates it on deadline, fuel/output failures or cancellation, and forwards an abort to outstanding tools. An indirect source ignoring abort cannot indefinitely retain preparation. A trusted host tool ignoring abort may finish later, but cannot publish late sandbox output/store or notifications. OS-level containment of that tool is outside QuickJS.

Hidden and model-only tools never enter the nested namespace. `codemode`, `tool_search`, and `spawn_subagent` are excluded even if mislabeled by a trusted registration. Current static/dynamic policy is recomputed before **every** nested operation, including queued calls. Dynamic MCP candidates have already passed the session host's fresh read-only annotation filter; invocation rechecks the latest `readOnlyHint`. Discovery results, source text, guessed names or persisted metadata cannot grant permission. Static selected tools win name collisions.

`direct` tools may be declared normally and called through scripts; `model-only` controls stay top-level; `deferred` tools become directly declared only after authenticated discovery for the next provider turn; `codemode` tools remain **script-only**, even after search; `hidden` tools are neither declared nor nested-callable. `only` removes nested-callable direct declarations, not model-only controls. MCP servers and trusted extensions remain ordinary privileged host/remote code: sandboxing JavaScript does not sandbox them or make dishonest read-only annotations safe.

## Persistence and Failure

The common extension before-hook/event pipeline wraps nested tools. Full nested tool results are not independently inserted as top-level provider messages. Host-issued IDs `${outerToolCallId}:${bridgeOperationId}` correlate running/completed/failed/cancelled calls exclusively to their outer invocation; metadata/search operations consume budget but do not create execution cards. Events use `tool.progress` with `kind: codemode`, and active snapshots retain at most 64 nested calls. Shared provider/tool and outer/nested code-mode durations use monotonic elapsed time, rounded to nonnegative integer milliseconds, so wall-clock regressions cannot create invalid persisted messages or discard a progress snapshot. JSON/RPC carry the same IDs through `tool_execution_update`; interactive renderers show correlated status while print stdout stays final-text-only. Late results/notifications cannot modify settled metadata. The outer result carries bounded duration, model usage, known cost subtotal, explicit `costComplete`, nested statuses and authenticated store metadata with `engine: QuickJS`. Usage persists and enters session/server totals once, including completed requests in a failed or interrupted script. On parent-run abort, the shared loop appends one error result with `metadata.interrupted: true`, retains authenticated completed-call accounting, removes pending store changes and stops before another tool or provider request. Durable cleanup does not reuse the aborted execution signal or trigger compaction; the detached journal publishes `run.stopped` only after the result, and a replacement run cannot start before cleanup settles. Calls completing after sandbox settlement cannot add usage or output; unknown usage from a cancelled remote request is not invented. Only results issued by the loadout's private WeakSet can supply that metadata.

Store changes publish only on successful script completion, after JSON size checks and credential redaction. Failure/cancellation leaves the previous store intact; calls already performed are **not rolled back**. Restore follows only the active session parent chain (including resume, fork and compaction), not a sibling branch. Session metadata/output is sensitive user data, not a secret vault. Web lazily loads the specialized card and its scoped CSS, keeping the existing entry/CSS budgets. It renders plain-text script/output, duration, cost completeness and a scrollable twelve-call preview with an omitted count; legacy/foreign/malformed metadata falls back to generic tool blocks. Replay rejects crossed parents, duplicate IDs, terminal resurrection and nested top-level promotion. Tool changes/reload retain model-only declarations, pending parent interactions and independent child-agent controls; terminal runs cancel remaining interaction requests.

## Critical Flow

The shared loadout prepares eligible indirect metadata under the operation deadline, starts one worker and sends bounded JSON metadata/store. QuickJS requests cross the host bridge; host queue admission and dispatch both recheck current policy, then invoke the normal hosted executor. Success publishes redacted output and authenticated store metadata; any failure terminates the worker and aborts outstanding calls before releasing worker capacity. The tool loop persists only the outer result, and restoration walks only the active session chain.

## Associated Tests and Validation

Use the repository's Docker-only workflow:

- `make typecheck`, `make test`: budgets, isolation, async/parallel calls, live policy, queued revocation, cancellation, redaction, transactional/branch store, hosted tool-loop metadata, CLI execution outside the installation and HTTP scoped settings.
- `make test-e2e E2E_ARGS='e2e/codemode.spec.ts --retries=0'`: scoped save/readback, failed health, visible restrictions, axe, overflow and reviewed desktop/mobile Light/Dark baselines.
- `make lint-docs`; `git diff --check`.

Relevant tests are `packages/core/src/providers/specialized-models.test.ts`, `packages/core/src/agent/runtime.test.ts`, `packages/web/src/components/codemode-state.test.ts`, `packages/core/src/tools/{codemode,tool-search}.test.ts`, `packages/cli/src/cli/invocation.test.ts`, `packages/server/src/api/tool-settings.test.ts`, and `e2e/codemode.spec.ts`. MCP-specific nested safety also lives in `packages/core/src/mcp/session-host.test.ts`.

## Common Changes

### Change a guest capability or ceiling

Update `packages/core/src/tools/{codemode,codemode-worker}.ts` together. Keep host and guest bounds aligned, reject larger injected limits, and add budget/abort/leak regressions in `codemode.test.ts`.

### Change selection, exposure or settings

Update `packages/core/src/tools/tool-search.ts`, live MCP policy and each CLI/RPC/Server adapter. Preserve script-only/model-only boundaries and branch authentication; extend scoped HTTP tests and Light/Dark mobile/desktop browser proofs.

## Related Domains

- [`security.md`](./security.md) — host trust, credentials and privileges outside QuickJS
- [`cli-reference.md`](./cli-reference.md) — CLI/JSON/RPC activation and adapters
- [`server-api.md`](./server-api.md) — scoped settings and sandbox health
