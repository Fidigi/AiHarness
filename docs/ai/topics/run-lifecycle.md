# Native Run Lifecycle

> **Navigation:** See [`project-map.md`](../project-map.md) for package boundaries and Docker validation.

## Overview

RUN-01–RUN-04 define one native lifetime, queue, recovery and tool-result model for interactive/print/JSON CLI, JSONL RPC, the Core SDK and detached HTTP runs. Wire formats remain native: Pi's events and Pi Web's run protocol are not compatibility targets. A cancellation acknowledgement is not durable settlement.

## Main Entry Points

| Repository path | Ownership |
|---|---|
| `packages/core/src/agent/{runtime,prestart-admission,work-retention}.ts` | Session reservation, captured caller signal, unpublished retirement, detached run completion |
| `packages/core/src/agent/{tool-loop,provider-turn,nested-tools,tool-result}.ts` | Awaited provider/retry/parallel/nested work, owned rich results, durable interrupted-tool records |
| `packages/core/src/providers/context-overflow.ts` | Bounded value-free structured HTTP overflow classification |
| `packages/core/src/extensions/extension-registry.ts` | Ordered hooks, original host cancellation, no later hook/tool admission after withdrawal |
| `packages/core/src/sdk/agent-session.ts` | Per-handle prompt reservation, stop acknowledgement, wait/dispose and borrowed ownership |
| `packages/cli/src/index.ts` | Interactive and print/JSON input lifetime, queues, signals and owned MCP cleanup |
| `packages/cli/src/cli/json-output.ts` | Separate agent-end and final settlement encoding |
| `packages/cli/src/rpc/{rpc-controller,rpc-server}.ts` | Prompt admission, command dispatch, abort/EOF/close, output join |
| `packages/server/src/api/{agent-routes,session-copy-request}.ts` | Real disconnect ownership until detached admission; stop's bounded wait |

## Public Contracts and Invariants

### Common state model

1. **Reserved, unpublished:** capture prompt/session/workspace/capabilities and reserve the owning slot before asynchronous admission. Pending trust, `before:agent` and provider resolution cannot lend their result to a replacement lifetime. Reject competing ordinary starts/history mutations.
2. **Admitted:** an accepted operation owns its controller, provider/preparation work, retries, tools, continuations, writes and cleanup. A detached run ID does not imply its user prompt is already persisted: MCP preparation precedes that write.
3. **Cancellation requested:** pin cancellation synchronously, refuse later unpublished prompt/tool/queue publication and propagate the original signal. Work already admitted to durable storage finishes; cancellation is not rollback.
4. **Settling:** join admitted callbacks, provider transport promises, stream delivery, interrupted-tool accounting, writes and owned cleanup. Do not release a same-session run slot or publish final settlement while these are pending.
5. **Settled:** publish the terminal run result or final `agent_settled`; resolve the matching completion promise. No callback retained from that provider turn may publish more stream output. Provider return retires text, completion and error callbacks together, even while accepted stream delivery is still draining; late results cannot change tools, model or usage, and late errors cannot replace the accepted outcome.

Core's `getRun()`/sequenced terminal events are authoritative results. The `phase: stopped` object returned by `stop()` is only an acknowledgement; live state remains nonterminal until durable settlement. SDK `stop()` likewise acknowledges, while `wait()` and admitted-run disposal join settlement. Each SDK `wait()` captures the prompt lifetime accepted at the time of the call; later admission cannot replace its result. A withdrawn unpublished SDK prompt has no run; its waits return `undefined`, never the previous prompt's result.

### Host mapping

| Host | Withdrawal / acknowledgement | Durable completion and EOF policy |
|---|---|---|
| Interactive CLI | Escape / existing interrupt dispatch aborts the active input lifetime | Shutdown joins every owned input and admitted append before closing services; no forced `process.exit` across writes. Terminal capability/driver behavior belongs to CLI-02 |
| Print / JSON | First active SIGINT/SIGTERM pins exit 130/143, suppresses final print and later positional prompts | Await input work, MCP cleanup and shutdown/output flush; retain handlers through repeated signals. JSON emits one final settlement after cleanup |
| RPC | `abort` withdraws pending prompt/steer/follow-up admission and acknowledges active cancellation without waiting on an ignored provider | `agent_end` ends a conversation lifecycle; one `agent_settled` follows all accepted follow-ups and dynamic-tool releases. `close()` joins owned work/output and propagates cleanup failure |
| RPC clean EOF | Retire unpublished ordinary prompt, navigation, compaction and context-reload admission; close UI dialogs | Drain already accepted runs, then close. Existing 30-second drain deadline is an error, not a synthetic successful settlement. Transport errors remain errors; only signal-owned premature input closure is suppressed |
| Core / SDK | Borrow `StartAgentRunRequest.signal`; SDK owns its per-prompt signal and retires unpublished work before its serial tail | Core `wait(runId)` joins that exact run; SDK `wait()` does not occupy the mutation queue, so stop/dispose can proceed. Already-admitted metadata saves are joined even if no run was published |
| HTTP | Disconnect before admission withdraws the request's unpublished work using the real request-aborted/response-close boundary | At admission transfer ownership to the detached runtime. Normal response EOF and later SSE disconnect do not stop it. Stop waits up to five seconds, then returns nonterminal state if settlement is still pending |

**RPC consumer migration:** do not count `agent_settled` per follow-up or treat an `abort` response as an idle/durability barrier. Continue counting the unchanged per-conversation `agent_start`/`agent_end` records if needed; await the single final settlement, or join controller close in embedded hosts. No command names, response shape, persisted schema or event payload fields change.

RPC extension commands are independent privileged host callbacks, not ordinary model-prompt admission. Preserve their existing concurrent UI-update/reply path and session-change/dialog retirement. They do not implicitly start a model run or earn an `agent_settled` event.

### Physical limits and errors

[IMPORTANT] An in-process privileged extension/provider/trust callback is not a sandbox. Retiring unpublished admission prevents host continuation/publication, observes late rejection and skips later hooks; it does **not** terminate arbitrary JavaScript, revoke borrowed resources or undo external effects. A callback can retain its own handles or block the event loop. Do not describe logical retirement as physical whole-host termination.

Once work is admitted, non-cooperative provider/tool/hook/preparation promises can delay completion indefinitely. Core's `retainAgentWork()` holds a releasable Node reference during admission/execution and active CLI cleanup: a promise without other handles must not naturally exit as if settled. Retired unpublished callbacks do not retain this authority. Stop acknowledgement remains distinct; never time out into a passing terminal receipt. CLI process signals do not force-exit across admitted writes. Owned process trees, provider network deadlines and MCP shutdown bounds retain their existing implementations; this contract grants no descendant/OS-wide kill authority. Active CLI owners use `requireSettlement` cleanup: join every branch, surface failures and restore output only afterward. The unchanged early-exit deadline records a cleanup failure but never abandons admitted work or becomes synthetic success. Bootstrap before an active invocation remains native OS process termination, not an admitted run or a synthetic run-settlement receipt.

Core records an owned-cleanup failure as `failed`, not successful/stopped settlement, and observes its detached task. RPC propagates cleanup/output failure through close; no successful settlement is emitted before failed release. Notifications are isolated observers, not extension-driven continuation authority. Native steering/follow-up continuations and retries admitted by the host are inside the run; arbitrary detached callbacks are not.

### Queue delivery and attention

Core owns bounded steering/follow-up queues and both `all` / `one-at-a-time` modes. Steering precedes follow-up. `all` consumes one entire current batch; `one-at-a-time` consumes one item per admitted boundary. Initial/queued turns already own their scheduler-selected batch: do not dequeue again on round zero. A post-tool turn may admit steering; a network retry or context-recovery attempt does not admit another batch. Clear and stale/terminal replies grant no new run authority.

CLI and detached runtime retain distinct user entries within an all-mode batch. RPC conserves its existing native combined user message, joining batch text with two newlines and combining blocks. This is delivery-policy equivalence, not identical histories or Pi wire compatibility. SDK `steer()` / `followUp()` use the same scheduler with explicit run-default modes; they register no tools or summary provider implicitly.

Browser queue recall edits the session-owned draft without silently delivering it. Clear removes pending items, not an unsent draft. View switching closes/reopens the genuine session stream and rehydrates canonical queues; remote-session unsent drafts remain view-local, **not cold-reload durable**. Bind the active conversation again when its route-matching metadata arrives after workspace/cache hydration, so a cached selection cannot make another visible conversation's completion look foreground. Background failures mark attention; opening that conversation clears the mark without changing another draft. Preserve the existing sequenced/correlation guards for late responses and replacement runs.

### Bounded useful context recovery

- One recovery budget belongs to a complete `runToolLoop`, not each provider attempt. Recognize `ProviderRequestContextError.kind === 'overflow'`, the native `ProviderContextOverflowError`, and a tool-free `stopReason: 'length'` response. Ordinary transient retries remain separate and refuse replay after visible output.
- HTTP classification reads at most 64 KiB of failed 400/413 bodies and admits only exact structured context codes or Anthropic's structured `invalid_request_error` / `prompt is too long:` prefix. Cancel the body; never return remote diagnostic prose. Other vendor phrases/statuses are not universal overflow detection.
- Request automatic compaction with reason `overflow`, bypassing only the threshold. Preserve enablement, host/session policy, source/generation, signal, the four-message compaction minimum, complete-tool cuts and summary accounting. SDK callers must explicitly supply a summary callback; existing policy still controls admission.
- Retry only after an applied compaction reduces Core's estimated context. Refresh effective messages and current declarations. These estimates are not exact vendor tokenization or a guarantee that the next request fits.
- Persist accepted length/failed visible text/reasoning and authentic usage first. After useful compaction, append an omission only if that failed assistant entry remains in effective context. Never rewrite raw history or bills. Private value-free `run.context_recovery` entries record reason, exhaustion and measured outcome; they do not authorize model input, execution or usage.
- A disabled/ineffective/repeated overflow fails without blind replay. Disabled/ineffective/exhausted length recovery retains the native visible length outcome; it is not invented success at full length. Print/JSON keep output-limit failure sticky across positional prompts, but a recovered intermediate length attempt is not a final failure. Cancellation never starts a replacement request. No extra steering is consumed by repair.

### Parallel, nested and rich tool results

`ExtensionTool.readOnly: true` is explicit **trusted host classification**, not a purity proof or a model/MCP metadata claim. Run at most four adjacent classified calls together. Unclassified/mutating tools and `codemode`, `tool_search`, `spawn_subagent` are serial barriers. Composite hosts classify the actual selected executor, not a coincident static name. Join every admitted promise before declared-order result publication and before compaction/next dispatch. A result observer failure must not discard another completed batch member. Each live tool has correlated progress; `activeTool` remains the first-member compatibility projection and additive `activeTools` represents the batch. Clear terminal cards on settlement.

The host may issue optional `context.executeTool(name, input)` **during a real invocation only**. It preserves signal, ID, parent and progress across hook context replacement and privately rechecks current selection after hooks. Nested siblings are serial/depth-first; ignored promises are joined; retired callbacks reject without dispatch. Root/ancestor recursion along the issued invocation lineage and nested control tools above are refused. Inputs are descriptor-safe owned JSON captured at call admission. No callback or result details grant billing, activation or branch-store authority. Existing code-mode guest isolation/store/model helpers remain separate; this is not a new guest ABI or a Node sandbox.

| Native admission limit | Bound |
|---|---|
| Nested depth / accepted calls | Four child levels / 64 per outer invocation |
| Nested input | 64 KiB owned JSON |
| Nested result ledger | 384 KiB ordinary aggregate; reserve refusal/correlation headers within 512 KiB |
| Structured result | 256 KiB owned JSON, including after redaction |
| Result blocks | At most 64 text/image blocks |
| Accepted content + blocks | 4 MiB; oversized/invalid results fail closed, not an unbounded full-output promise |

`ExtensionToolResult.content` remains required compatible text. Optional `structuredContent` is inert JSON, copied without producer accessors/toJSON; redact raw strings/keys before JSON escaping and credential-shaped primitives before publication. Include its JSON text before ordinary truncation and expose it in native tool-result blocks/JSON details. Fold text blocks into compatible text. Images must be bounded inline base64 data URLs with matching declared PNG/JPEG/GIF/WebP MIME types and admitted plain fields; no remote fetch/SVG authority or pixel-content redaction is implied. Text-only consumers receive compatible text, not terminal image rendering.

Own/redact results before nesting, persistence and model projection. Nested records retain real IDs/parents, outcomes/duration, results and bounded correlated progress, not authenticated usage. Arbitrary `usage` in details/progress/structured JSON stays display data. Preserve existing authenticated outer provider/code-mode accounting exactly once. Retain accepted truncated full text through the existing native full-output path; rejected oversized nested output is an error, not downloadable original content. Parallel/nested contexts do not share the legacy single-process raw output sink/path.

OpenAI chat, Responses, Anthropic, Gemini and Bedrock project tool images as separate attributed user attachments **after the complete contiguous result batch**, never between call/result pairs and never as persisted synthetic messages. Native JSON/RPC carries image data and structured details; Web reuses its ordinary image renderer. Historical metadata and display blocks still grant no execution authority. MCP's existing tool-result normalization and code-mode's text-oriented guest bridge are not a claim of Pi result/renderer compatibility.

## Critical Flows

- **Stop during admission:** reserve → await trust/hook/provider → cancel → retire unpublished continuation → no run/prompt/provider publication; a previously admitted metadata save still finishes.
- **Stop during preparation/tool/storage:** acknowledge → abort → join preparation/tool → persist interrupted results and actual usage → close owned resources → publish terminal result → resolve wait.
- **Follow-up / retry:** retain the same run owner through retry delay, hooks, queued conversation lifecycles and dynamic-tool releases → emit one final settlement, not one per intermediate lifecycle.
- **HTTP disconnect:** bind cancellation before host awaits → recheck before metadata/run admission → pass the original signal into Core → detach request listeners once the runtime accepts ownership.

## Associated Tests

Reuse the existing families; do not build a second test framework or replace real process/API boundaries with mocks.

| Tests | Evidence boundary |
|---|---|
| Core `agent/{prestart-admission,runtime-prestart,prestart-process}.test.ts` | Captured authority, held trust/hook/provider cancellation, no late publication and genuine emitted Core |
| Core `sdk/{prestart-lifetime,agent-session,public-consumer}.test.ts` | Memory/native/structural ownership, admitted metadata writes, disposal, previous-result retirement and genuine external package/declarations |
| Core `agent/{runtime-settlement,work-retention-process,runtime-interaction-queue,tool-loop-progress}.test.ts` | Held MCP preparation/release, cleanup failure, held provider/tool hooks, retired delta/completion/error callbacks (including held accepted delivery), durable interrupted tool results and real provider ownership without other Node handles |
| CLI `rpc/{run-lifetime,rpc-controller,rpc-server,rpc-extension-ui-process}.test.ts` | Prompt/steer/follow-up × abort/EOF/close, busy refusal, held cleanup, one final continuation settlement, normal EOF and real command/UI dispatch |
| CLI `cli/{headless-signal-process,interactive-settlement-process,tool-progress-child,lifecycle}.test.ts`, `tests/functional-parity/installed-executable.test.ts` | Real emitted and outside-checkout installed print/JSON/RPC × both signals, held admission and SSE transport, repeated signals during async shutdown, exact channels/exits and durable readback; real regular/fullscreen PTY shutdown joins a held append before the shutdown observer reads the journal; strict cleanup records deadline failure and still joins physical completion. Real arbitrary-tool cancellation observes RPC abort acknowledgement while held, then joins exactly one interrupted result, final settlement and fresh-process journal replay |
| Server `api/{run-admission-http,session-live-mutations,interaction-queue-http,http-compaction-lifecycle}.test.ts` | Actual HTTP disconnection at trust/hook/storage, detached response ownership, stop's nonterminal acknowledgement and durable writes |
| Core `agent/{runtime-queue-delivery,context-recovery,tool-results,runtime}.test.ts`, `providers/{context-overflow,index,length-stop}.test.ts` | All queue modes and held retry/recovery boundaries; useful/disabled/repeated/cancelled recovery and raw/accounting conservation; joins, current selection, hooks, inert/redacted results and five adapter projections |
| CLI `cli/run-contract-process.test.ts`, `rpc/rpc-controller.test.ts`, installed executable tests | Actual print/JSON/RPC/SDK rich/nested/parallel/recovery paths, regular/fullscreen/RPC/SDK queue schedules, failed RPC text/reasoning and outside-checkout packages/declarations |
| `e2e/tool-progress.spec.ts` with `e2e/tool-progress.config.ts` | Built Web plus genuine Express/upstream/extension: parallel reconnect, image rendering/reload, queue recall/clear/view/draft journeys, background attention and HTTP recovery/native journal/accounting; no mocked product state |
| `e2e/{live-server,queue-reconciliation}.spec.ts` | Separate browser/server persistence smoke and browser detached-protocol reconciliation; intercepted protocol evidence is not a live provider/transport qualification |

## Common Changes

- Change a cancellation boundary in Core first; recheck after awaited hooks/preparation and before publication. Keep host signal identity and durable-write admission rules intact.
- Change JSON/RPC completion in `json-output.ts` and `rpc-controller.ts` together. Preserve `agent_start`/`agent_end` payloads; qualify final settlement ordering separately from extension-command UI concurrency.
- Change HTTP admission in `agent-routes.ts` with actual socket-disconnect tests. Never bind accepted detached runs to a later SSE connection or completed request-body close.

## Related Domains

- [Session SDK](./session-sdk.md)
- [CLI invocation](./cli-invocation-contract.md)
- [Server API](./server-api.md)
- [Detached streams](./detached-streams.md)
