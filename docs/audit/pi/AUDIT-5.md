# Audit Report — Pi 1.2.0 and Pi Web 0.12.2 / AiHarness

> **Status: IN PROGRESS** (2026-10-19)
>
> The source comparison is established; compatibility decisions, functional gaps and runtime qualification remain open in the 43-criterion delivery baseline below.

## 1. Audit Reference

| Element | Value |
|---|---|
| Target observed | Pi `@earendil-works/pi-coding-agent@1.2.0`; Pi Web `@agegr/pi-web@0.12.2`, which pins the Pi packages to `1.2.0` |
| Audited instance | AiHarness `40c8d6f20482a08b54ae9d1c19c3171b1e11bc9f`, origin `https://github.com/Fidigi/AiHarness.git`; working-tree source changes and deletions bounded below |
| Audit date | 2026-10-19 |
| Pinned source | [Pi v1.2.0](https://github.com/earendil-works/pi/tree/06a466935536f8c9bcacb2d5efc0fc021be1bdff), commit `06a466935536f8c9bcacb2d5efc0fc021be1bdff`; [Pi Web v0.12.2](https://github.com/agegr/pi-web/tree/b017cd48425d05aa4952051db2e4fc031c134094), commit `b017cd48425d05aa4952051db2e4fc031c134094` |
| Detailed references | §3 comparison and API mapping; §6 executed checks; §8 source/coverage register, baseline fingerprints and prioritized work packages |

**Objective:** establish the differences between Pi, Pi Web and AiHarness, distinguish missing functionality from intentional architecture/security differences, and maintain stable, testable completion criteria for parity work over time. This is a delivery baseline, not a certification that AiHarness is a drop-in replacement.

**Reading the comparison:** `Pi` is the terminal agent, SDK, extension API and conversation engine. `Pi Web` is a browser host of that same Pi SDK and agent directory, not a second independent engine. AiHarness instead owns a Core engine, CLI, Express server and React client. Similar feature names do not establish file, protocol or extension compatibility.

### Working-tree boundary

- The initial `git status --short` showed **65 deleted audit files** under `docs/audit/pi/`. They were not restored and their earlier closure counts are not reused.
- Two source files were already modified: `packages/cli/src/tui/fullscreen-input.ts` (line-relative Home/End) and `packages/core/src/providers/specialized-models.ts` (classifier image admission/copies). They were read as observed working-tree behavior, not credited as validated deliveries. SHA-256 fingerprints are in §8.
- This report continues the subject's audit numbering and replaces the active navigation entry only; it neither completes nor rewrites historical audits. Earlier IDs must not be silently equated to the new IDs.

### Known limitations

- Static inspection of pinned upstream source/documentation and local implementation/selected tests. Neither product was launched for interactive comparison; no side-by-side browser, terminal, live-provider or OAuth qualification was run.
- Existing test paths below identify reusable coverage, **not passing results from this audit**. A source search finding no implementation is bounded to the inspected production packages, not every possible third-party extension.
- Inspection host: Linux x64, Node `v22.19.0`. Repository test qualification must use the Docker workflow and its pinned runtime, not this host.
- Platform-specific behavior, native dependencies, real credentials, physical mobile keyboards, Safari and public registry installation remain unqualified.
- The initial `make lint-docs` failed with seven obsolete acceptance links. §6 preserves that historical result and records the subsequent reference cleanup; no replacement acceptance was fabricated.
- The comparison is broad but not an exhaustive per-flag, per-provider, per-setting or pixel inventory. Before closing a family, enumerate its required subcases and record exclusions explicitly. No effort estimate or deadline is asserted.
- Any target evolution requires a new audit or an explicitly journaled re-audit. Do not compare a moving `main` or `latest` release against these counts.

## 2. Result

| Status | Count | Details |
|---|---:|---|
| `DONE` | 1 | Source identities and bounded audit baseline recorded; not a functional parity claim |
| `PARTIAL` | 28 | Existing implementation/coverage, with a concrete delta or unverified acceptance boundary |
| `ABSENT` | 7 | Required capability or current qualification receipt not found in the bounded inspection |
| `TO BE DEFINED` | 7 | Product, security or compatibility decision required before implementation |
| `BLOCKED` | 0 | No criterion assigned an external blocker/owner at this baseline |
| `IN PROGRESS` | 0 | No implementation task is claimed as actively started by this documentation change |
| `GAP ACCEPTED` | 0 | No final omission has been approved |
| **Total** | **43** | **2.3% closed: (`DONE` + `GAP ACCEPTED`) / total** |

**Interpretation:** this is criterion closure, not the percentage of features implemented or developer effort completed. The only closed item is audit provenance. Existing functionality is substantial; static inspection cannot certify the remaining criteria. Delivering one subtask does not close its whole family.

### Summary by Surface

| Surface | Done | Partial | Absent | To define | Blocked | In progress | Gap accepted | Total |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Baseline and compatibility | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 2 |
| CLI and terminal | 0 | 3 | 0 | 1 | 0 | 0 | 0 | 4 |
| Agent execution | 0 | 4 | 0 | 0 | 0 | 0 | 0 | 4 |
| Sessions and context | 0 | 2 | 2 | 1 | 0 | 0 | 0 | 5 |
| Models and providers | 0 | 3 | 1 | 1 | 0 | 0 | 0 | 5 |
| Extensions, resources and SDK | 0 | 3 | 0 | 1 | 0 | 0 | 0 | 4 |
| MCP | 0 | 1 | 2 | 1 | 0 | 0 | 0 | 4 |
| Code mode and specialized models | 0 | 2 | 0 | 1 | 0 | 0 | 0 | 3 |
| Browser application | 0 | 5 | 1 | 0 | 0 | 0 | 0 | 6 |
| Security and configuration | 0 | 3 | 0 | 0 | 0 | 0 | 0 | 3 |
| Qualification and distribution | 0 | 2 | 1 | 0 | 0 | 0 | 0 | 3 |

## 3. Traceability by Surface

Priority is proposed: **P0** = decide the contract/protect persisted data and execution; **P1** = core user-visible parity; **P2** = ergonomics/platform breadth. These are not commitments. Evidence references `E01`–`E14` resolve to concrete source and coverage paths in §8. Each cell separates the observed difference from the evidence still required for closure.

### Baseline and compatibility

| ID | Status | Criterion and completion evidence |
|---|---|---|
| BASE-01 | DONE | **P0 · Audit provenance.** Both upstream tags were cloned and their exact commits resolved; installed package metadata identifies Pi `1.2.0` and Pi Web `0.12.2`. AiHarness commit, initial dirty scope, source fingerprints and inspection limits are recorded in §§1/6/8. Criterion is documentary source identity only. |
| BASE-02 | TO BE DEFINED | **P0 · Product contract.** Pi Web resumes Pi files and runs Pi extensions through Pi's SDK; AiHarness owns different packages, data and runtime. Decide functional equivalence versus Pi-compatible import, configuration, extension ABI, SDK and RPC, separately. **Close:** owner-approved contract listing compatibility levels, non-goals, migration guarantees and security invariants; update the affected criteria without accepting gaps by implication. E01/E04/E07. |

### CLI and terminal

| ID | Status | Criterion and completion evidence |
|---|---|---|
| CLI-01 | PARTIAL | **P1 · Invocation, input and headless contracts.** Print/JSON/RPC, piped input, `@file`, model/tool selection, startup sessions and standalone commands already exist. Native goldens lock AiHarness behavior, not Pi wire equality; Pi's MCP selection exception and standalone auth/update command semantics differ. **Close:** versioned Pi→AiHarness command/option/output map for the selected contract, with real emitted/installed CLI and RPC scenarios, stdout/stderr separation, invalid input, cancellation and documented differences. E02/E05/E10/E14. |
| CLI-02 | PARTIAL | **P1 · Terminal editor and rendering.** Both terminal modes exist, but AiHarness's editor/renderer is not Pi's component system. Current editor history handling, cursor movement and slim rendering do not establish Pi's multiline word editing/undo, selection/mouse, inline images, overlays or terminal-protocol support. The pre-existing Home/End patch is unqualified. **Close:** bound the supported terminal capability matrix, then verify multiline/Unicode/IME, paste, resize, interrupt, restore and screen cleanup in real regular/fullscreen processes; record retained differences. E02/E07. |
| CLI-03 | PARTIAL | **P2 · Keybindings, themes and effective settings.** Native configurable actions, passive hotkeys and theme loading exist. Pi has a broader named action vocabulary and theme color formats; several native settings, including `fullscreenCopyOnSelect`, are parsed without a matching host consumer in the inspected source. Parsing/schema acceptance is not implementation. **Close:** per-action/per-setting supported/unsupported map, actual dispatch and reload checks in both hosts, current theme-format validation, safe terminal probes and user documentation. E02/E08. |
| CLI-04 | TO BE DEFINED | **P2 · Installation and service management.** Pi exposes self/package/catalog updates; Pi Web exposes `version`, `status`, `stop`, `open`, `update`. AiHarness Web's parser is startup-only; its release service checks versions, not installation. **Close:** decide which lifecycle commands to deliver or decline, including process ownership, update provenance/rollback, and remote exposure policy; add installed-command tests for the selected behavior. Do not introduce an automatic updater as a presumed parity requirement. E01/E02/E14. |

### Agent execution

| ID | Status | Criterion and completion evidence |
|---|---|---|
| RUN-01 | PARTIAL | **P0 · Admission, stop and durable settlement.** Core reserves pending startup and the SDK distinguishes stop acknowledgement from durable wait. Pi's final `agent_settled` also covers retries and extension-driven continuations; Web uses a different sequenced run contract. **Close:** one documented lifetime model across CLI/JSON/RPC/SDK/HTTP, with stop/EOF/dispose at held trust/hook/provider/preparation/storage boundaries, no late unpublished prompt, and settlement only after durable writes/owned cleanup. Preserve the distinction between logical cancellation and physically stopping uncooperative code. E03/E07/E14. |
| RUN-02 | PARTIAL | **P1 · Steering, follow-up and attention.** Shared bounded queues and delivery modes exist; HTTP/browser reconciliation has dedicated tests. Those controls do not alone prove multi-message delivery, retry/compaction ordering, background attention and reconnect for all hosts. **Close:** enumerate all/one-at-a-time schedules, dequeue/clear, late/stale replies, new runs and view changes; verify actual CLI/RPC delivery and a live browser/server queue journey, with no duplicates or lost drafts. E03/E11. |
| RUN-03 | PARTIAL | **P0 · Overflow, truncation and retry recovery.** Native threshold compaction, transient retries, canonical request guarding and `length` metadata exist. Pi additionally repairs future context with append-only omission edits and supports compact-and-retry overflow/early-length recovery. A local oversized-request refusal is not equivalent to useful recovery. **Close:** deterministic overflow/length/transient cases preserve raw failed history and accounting, repair only future context, compact/retry at most as authorized, and settle queues/hooks consistently across hosts. Depends on SES-02/03/05. E03/E04/E06. |
| RUN-04 | PARTIAL | **P1 · Tool results and nested execution.** AiHarness's outer tool loop executes calls sequentially; `ExtensionToolResult.content` is text, and nested code-mode calls consume it. Pi permits parallel batches, structured tool results and general `ctx.executeTool()` with nested correlation/accounting. **Close:** explicit ordering policy for mutating tools, structured/text/image/error semantics and authorized nested execution, with hook parity, cancellation, truncation/full-output retrieval, exactly-once costs and real multi-tool process evidence. Code-mode concurrency alone is not outer-loop parity. E03/E07/E09/E10. |

### Sessions and context

| ID | Status | Criterion and completion evidence |
|---|---|---|
| SES-01 | TO BE DEFINED | **P0 · Native file/configuration interoperability.** Pi/Pi Web use `.pi`, per-cwd timestamped JSONL v3, nested `message`, ISO entry timestamps and `parentId`; AiHarness uses `.ai-harness`, ID-named JSONL v2, flat entries, numeric timestamps and separate message/entry parents. There is no demonstrated lossless Pi journal import. **Close:** choose native-only, one-way migration or ongoing interoperability; if migration is selected, supply representative v1/v2/v3 fixtures, rich blocks/signatures/custom state/links, refusal of unsupported data, backup/no-write-by-default and round-trip/loss reports. Never point the native writer at Pi files without this decision. E01/E04. |
| SES-02 | ABSENT | **P0 · Branch-relative context edits.** Pi has persisted `context_edit` omission/replacement entries that change future model input without changing transcript or bills. The native entry union/parser has no equivalent. **Close:** append-only owned edits, branch replay, repeated edits, compaction/copy/restart semantics, raw-history immutability and accounting tests, plus public API/protocol and migration decisions. Required before claiming Pi-style recovery. E04/E06. |
| SES-03 | ABSENT | **P0 · Prompt/tool provenance and checkpoints.** Pi persists structured system-prompt/tool deltas and complete compaction checkpoints. AiHarness composes instructions/tools for requests, but its compaction entry has no equivalent prompt/tool checkpoint. **Close:** record and reconstruct the effective historical loadout through reload, model/tool switches, branching, compaction and restart; keep private system/credential material out of browser DTOs; verify model input separately from display. A generic `system` role is not this feature. E04/E08. |
| SES-04 | PARTIAL | **P1 · Fork, clone, navigation and statistics.** Native ancestry, custom state, explicit branch summaries, saved-row copies and journal accounting already have focused coverage. Pi and Pi Web distinguish in-file editing from related-file copies and permit particular running-source copies. **Close:** scenario map for at/before/leaf copies, running sources, shell-only/unsaved/subagent cases, labels or their documented alternative, hooks/veto/summary, IDs, raw ancestry and active/full usage after restart. Reuse native copy/process/browser controls rather than rebuilding the suite. E04/E11/E12. |
| SES-05 | PARTIAL | **P0 · Compaction fidelity.** Core already owns atomic tool-group cuts, previous-summary/custom/command input, public summary projection, source leases and bounded generation. Pi also tracks cumulative file operations, split user spans, extension overrides and projected system checkpoints. **Close:** bounded per-case comparison of manual, threshold, repeated, split-span and recovery compaction; settings/model changes, summary usage, source/cancel races and file provenance must survive native CLI/RPC/SDK/HTTP persistence/reload. Do not erase the existing privacy boundary to imitate a serializer. E04/E06. |

### Models and providers

| ID | Status | Criterion and completion evidence |
|---|---|---|
| MOD-01 | TO BE DEFINED | **P1 · Provider/catalogue scope.** Native built-ins cover OpenAI, Anthropic, Google, Azure, Vertex, Bedrock, local and mock, with custom providers. Pi's catalogue/authentication and llama.cpp router integration are broader; an OpenAI-compatible endpoint is not proof of subscription OAuth or native dialect parity. **Close:** approve a provider/model/auth/transport matrix, including what is custom-configured rather than built in, catalogue freshness/offline policy and which real integrations are release gates. E05. |
| MOD-02 | PARTIAL | **P1 · Selection, discovery and transport.** Full-ID-safe resolution, fuzzy/ordered scopes, ambiguity handling, configured/live metadata, SSE/WebSocket and passive offline startup exist. Pi overlays published/cached catalogues and has its own compatible-endpoint `models.json`. **Close:** native-versus-Pi settings/config map, endpoint wire fixtures and actual startup/cycling/discovery failures; verify cache/offline behavior without granting accidental command/network authority. Preserve existing installed ambiguity/scopes coverage. E05/E14. |
| MOD-03 | PARTIAL | **P1 · Reasoning, replay and request budgets.** Native numeric budgets and exact Anthropic adaptive handling exist; not all model dialects, signed thought continuation, image sizing and host settings are equivalent. The canonical UTF-8/4 guard explicitly is not vendor tokenization or complete media admission. **Close:** model-specific request/replay fixtures for the approved matrix, thinking clamps/off/output reserve, safe model switches and signed/private-block handling, plus CLI/RPC/Web settings composition. Separate estimated context from billed usage. E05/E06. |
| MOD-04 | ABSENT | **P1 · Selectable virtual-model routing.** Pi registers selectable virtual chat models with per-request physical routing, thinking selection, retry reasons and branch-persisted router state. Native specialized models marked `virtual` are not that mechanism; no comparable registration/dispatch surface was found. **Close:** selection versus physical dispatch/provenance, credential checks, no recursive routing, branch state, resume fallback, physical context limits and compaction-before-dispatch tests, or an explicit final scope decision. E05/E09. |
| MOD-05 | PARTIAL | **P2 · Prompt-cache warming and notices.** AiHarness parses `cacheWarming` and `showCacheMissNotices` and accounts provider cache tokens, but the inspected runtime has no consumers implementing Pi's warming scheduler, non-context `usage` entries or corresponding transcript notices. Pi Web exposes the global notice switch and historical notices. **Close:** explicit budgeted opt-in/background policy, idle/run/stop handling, provider support, durable attributed usage and nonduplicated CLI/Web notices with no context pollution or hidden billing; alternatively obtain a documented final omission decision. E05/E06/E11. |

### Extensions, resources and SDK

| ID | Status | Criterion and completion evidence |
|---|---|---|
| EXT-01 | TO BE DEFINED | **P0 · Extension and UI compatibility.** The native versioned API uses `registerOption`, `before:*`, text tools and declarative interactions; Pi uses its own `ExtensionAPI`, event types, TypeBox/rich results, terminal factories and renderers. Loading TypeScript or a legacy `pi` manifest does not make arbitrary Pi extensions compatible. **Close:** decide native API only versus a bounded adapter; publish supported imports/events/results/UI by host and prove selected unchanged or migrated extensions. Keep browser UI inert: arbitrary DOM/React/script is not a parity shortcut. E07. |
| EXT-02 | PARTIAL | **P1 · Lifecycle hooks and session state.** Native before-agent/provider/tool/model, branch/summary admission and branch-local custom state exist. Pi also has actionable `turn_end`/`agent_before_settle`, typed user/custom run triggers, context transformations and post-message/result replacement. **Close:** explicit semantic event map, ordered transformations/veto/error rules, cancellation and reentrancy tests, custom-trigger continuation and state reconstruction on resume/branch/compaction, verified in real hosts. Event-name similarity is insufficient. E03/E04/E07. |
| EXT-03 | PARTIAL | **P1 · Package and resource workflows.** Shared installation/inventory/rollback, JS/TS module resolution, selectors, Markdown skills/templates and themes are implemented. Pi's package identities, settings filtering and host-provided peer imports differ; AiHarness HTTPS/SHA-256 skill registry is not the same as Pi Web's `npx skills add` workflow. **Close:** package/resource compatibility map, selected fixture packages, explicit versus suppressed discovery, trust, arguments, collisions, dependency identity and atomic reload across CLI/Web; exercise install/update/refusal without implicit execution on catalogue GET. E07/E08/E12. |
| EXT-04 | PARTIAL | **P0 · Public embedding SDK.** The native explicit factory requires cwd/provider, defaults to memory/no implicit discovery and exposes asynchronous disposal/stop+wait. Pi defaults to configured persistent sessions and a richer session/model/resource runtime. **Close:** document native adaptation recipes and ownership/capabilities, compile/run public consumers outside the checkout, and cover queues, copies, compaction, stop/dispose/borrowed resources and declared unsupported Pi methods. Do not silently add executable/auth discovery for signature similarity. E07/E14. |

### MCP

| ID | Status | Criterion and completion evidence |
|---|---|---|
| MCP-01 | PARTIAL | **P1 · Configuration, Test, OAuth and hosting.** Native passive inventory, paste/reparse, trusted inheritance, locked mutations, one-shot Test, encrypted OAuth and persistent per-session hosting exist. Pi's full configuration/OAuth vocabulary and shell/TUI management are not all proven equivalent. **Close:** field-by-field map, stdio/HTTP and auth/error fixtures, explicit versus passive credential flows, reconnect/idle/stop/reload, live native CLI and browser journeys; verify untrusted config and stale/sign-out flows cannot run or write. E10/E12. |
| MCP-02 | TO BE DEFINED | **P0 · Default exposure and selection semantics.** Pi `1.2.0` defaults MCP servers to `codemode`; AiHarness defaults to `direct`. Pi's `--tools` primarily selects declarations and only filters MCP when an `mcp__` entry is present; native selection/authorization uses its own loadout. Both support exact-before-pattern overrides. **Close:** decide defaults and declaration/callability policy, migration for existing missing-exposure entries and consistent CLI/SDK/Web settings/help; verify hidden/read-only/excluded/late-discovered tools cannot bypass authorization. Never silently flip existing defaults. E02/E09/E10. |
| MCP-03 | ABSENT | **P1 · Resource listing/templates/reading and rich payloads.** Pi exposes `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`; native hosting discovers tools, not that resource API, and textifies structured results while omitting image/audio payloads. **Close:** bounded pagination/URI/server selection, read-only/exposure/trust gates, cancellation, structured/text/image results and safe binary retention, MCP App exclusion, CLI/RPC/Web tests and docs. A tool result containing a resource link is not resource reading. E09/E10. |
| MCP-04 | ABSENT | **P1 · Extension-registered MCP servers.** Pi provides `registerMcpServer`/unregister with live updates, file-over-registration precedence and owner isolation. Native public extension registration has no such surface; file-host support is not equivalent. **Close:** owned registration lifecycle, conflict/override rules, trust, reconnect/withdrawal on reload, scoped secrets/status and public declaration/process tests. Depend on the EXT-01 contract, not private SDK patching. E07/E10. |

### Code mode and specialized models

| ID | Status | Criterion and completion evidence |
|---|---|---|
| CODE-01 | TO BE DEFINED | **P0 · Script dialect and limits.** Pi accepts raw source, `// @options`, `image()`, structured nested results and a 256 MiB VM; AiHarness accepts `{code}`, fixes 10 s/32 MiB/64 calls/64 KiB output and returns native text results. Pi scripts are not automatically portable. **Close:** select/document the supported dialect and budget policy, explicit migration examples and unsupported options; if adapting, retain hard host limits and verify output/error/timeout/store semantics. Larger upstream limits are not instructions to weaken native bounds. E09. |
| CODE-02 | PARTIAL | **P1 · Classifier/image capabilities.** Native typed helpers exist, but `classify({model,input,labels})` is not Pi's typed questions/probabilities over JSON state; native image generation differs from Pi's text/image input/output blocks and multi-provider catalogue. The pre-existing classifier image patch does not establish end-to-end image consumption. **Close:** supported question/input/provider map, real adapter payload fixtures, capability rechecks after hooks, guest image presentation, unavailable/error/cancel cases and exactly-once usage, with public SDK/installed/browser evidence. E05/E09. |
| CODE-03 | PARTIAL | **P0 · Sandbox, nested authority and branch store.** Disposable worker/QuickJS isolation, frozen intrinsics, current tool selection, hard budgets and successful branch-local store already have targeted controls. Pi exposes richer nested namespaces/schemas/results. **Close:** requalify current installed worker, limits, cancellation/physical termination, live revocation, nested hooks, success-only state and no ambient host access for the selected dialect; retain the warning that completed host effects cannot be rolled back. E09/E14. |

### Browser application

| ID | Status | Criterion and completion evidence |
|---|---|---|
| WEB-01 | ABSENT | **P1 · Durable sidebar organisation.** Pi Web stores family pins/archive plus project order/display names server-side, independently of conversation journals, with undo and cross-browser revisions. AiHarness has workspace/session navigation, unread/attention and native links/copies, but no corresponding pin/archive/order state was found. **Close:** bounded independent persisted UI state, bulk/undo/conflict/readback behavior, family/run/archive predicates and keyboard/mobile navigation, with multi-client/live server and visual evidence. Do not advance a session leaf merely to pin a row. E11. |
| WEB-02 | PARTIAL | **P1 · Conversation, live events and rich reading.** Native detached runs, sequenced replay/reset, paging/around, minimap, Process/Response, Markdown, drafts/attachments, interactions and notifications exist. Pi Web consumes Pi events; native snapshots and routes are different contracts. **Close:** live disconnect/reconnect during model/tool/dialog/retry, history/search/branch restoration, stable focus/selection and stale-view refusal, structured/image/error rendering, large-stream performance and reviewed desktop/mobile Light/Dark captures. Mocked transport tests alone cannot close it. E03/E11/E12. |
| WEB-03 | PARTIAL | **P1 · Settings and resource administration.** Native scoped configuration/provenance, provider/model/skill/plugin/MCP forms and batch controls exist. Pi Web edits Pi's shared models/settings/auth; native stores are separate. Pi Web also queries provider quota/usage summaries, not equivalent to native historical token/cost totals. **Close:** per-control storage/scope map, unsupported quota/auth/catalogue cases, exact-filter batches, save/reload/stale/readback errors and actual backend/browser evidence, localized safe diagnostics and accessible forms. E05/E08/E10/E12. |
| WEB-04 | PARTIAL | **P2 · Files, previews and worktrees.** Native tree/search/uploads/watch/diffs, media/Markdown, linked-directory consent, browse/create and worktree operations exist. `FilePreview` has no PDF/DOCX/CSV-TSV-specific preview equivalent to Pi Web; its viewer has one selected file rather than Pi Web's project file-tab workflow. **Close:** decide supported formats/layout, then safe bounded preview/parser/download/collision tests, real Git/worktree/trust scenarios and view/workspace retirement. No requirement to add an unrestricted filesystem editor. E12. |
| WEB-05 | PARTIAL | **P1 · Interactive terminals.** Native node-pty/xterm, tabs, resize/input, lease/replay and per-workspace restoration exist. Native output uses UTF-8 byte offsets; Pi Web uses UTF-16 offsets and retains panels differently across project switches. **Close:** native contract explicitly documented, no cursor-unit mixing, real PTY Unicode/large paste/reconnect/expiry/exit/termination and workspace ownership tests, plus native installation and desktop/mobile key controls. A serialized terminal screen is not claimed by either bounded replay buffer. E12/E14. |
| WEB-06 | PARTIAL | **P1 · Subagents.** Pi core intentionally omits built-in subagents; Pi Web supplies an extension/runtime and agent profiles, while AiHarness supplies its own scoped profile service and linked child runtime. This is a Pi Web comparison, not a missing Pi-core command. **Close:** profile-format/adaptation decision, inherited tools/skills/extensions/MCP restrictions, bounded concurrency/depth, sync/background completion/stop, child history and parent notification/acknowledgement in live browser/server scenarios; retain native plan/explore profiles rather than assume identical upstream data. E12. |

### Security and configuration

| ID | Status | Criterion and completion evidence |
|---|---|---|
| SEC-01 | PARTIAL | **P0 · Trust, roots and instructions.** Native allowed roots, symlink/link consent and independent pre-trust agent directory are stronger/different boundaries than Pi's OS-user model. Pi documents context loading regardless of trust and an early project `sessionDir` lookup; native behavior must not be weakened to copy those semantics. **Close:** field/resource trust and instruction-precedence map, refusal/ancestor/default/revocation tests across CLI/RPC/SDK/Web, no project-selected secret/executable authority before trust, documented intentional differences. E08/E13. |
| SEC-02 | PARTIAL | **P0 · Credential and export privacy.** Pi persists `auth.json`/`mcp-auth.json`; native credential mutations require encrypted durable storage, with redaction before API/disk. Pi's credential-print commands are deliberately secret-bearing; native metadata/login/logout are a different contract. **Close:** decide any credential-export scope explicitly, verify fail-closed missing-master-key behavior, redaction of actual configured/resolved secrets through error/stream/session/share/export/cache/child paths and owned OAuth revocation/write races. Never treat plaintext storage or secret printing as mandatory parity. E05/E10/E13. |
| SEC-03 | PARTIAL | **P0 · Browser privilege boundary.** Native cookie/Bearer capabilities, separate admin role, Origin checks, rate limits and loopback defaults differ from Pi Web's password/Basic-auth host model. Both run high-privilege host actions; project trust and QuickJS do not sandbox extensions or tool processes. **Close:** actual HTTP/SSE/WebSocket/PTY/file/plugin/auth negative tests and trusted-proxy deployment checks, passive GET guarantees, no token reflection, process-environment filtering and documented residual OS/network exposure. Preserve native controls during parity work. E12/E13. |

### Qualification and distribution

| ID | Status | Criterion and completion evidence |
|---|---|---|
| QUA-01 | ABSENT | **P0 · Current integrated receipt.** No Docker build/type/unit/parity/E2E/production receipt was produced for this exact dirty baseline. Previous results and removed acceptances cannot certify it. **Close:** freeze all included build inputs and source hashes, then record commands, runtime/image identity, exit/signal and artifacts for the required Docker gates; every failure remains visible. Keep documentation checks passing before release approval. E14. |
| QUA-02 | PARTIAL | **P1 · Browser/platform/visual acceptance.** Existing intercepted, production-asset, live server, axe and visual suites cover distinct boundaries. No current side-by-side Pi/Pi Web captures or physical Safari/Windows/mobile qualification were produced. **Close:** approved platform/viewport/theme matrix, bounded differential journeys, baseline review, performance measurements and browser-native evidence without replacing real HTTP tests with fixtures. Treat unavailable platforms as explicit owner-assigned blockers or final decisions, not implicit passes. E11/E12/E14. |
| QUA-03 | PARTIAL | **P1 · Installed consumer and distribution.** Genuine pack/install/PATH-bin/worker controls exist, but they are local archives, not a published-registry/release or cross-platform proof. Pi/Pi Web have separately distributed commands and native PTY packaging. **Close:** approved delivery channel, clean outside-checkout installation of all selected packages/assets/schemas, real CLI/SDK/Web launch and native dependency smoke tests, supported Node/platform matrix, version/help parity and rollback/operator instructions. No public publication is authorized by this audit. E14. |

### API Families

Paths below are mappings, **not route aliases to implement automatically**. Pi's SDK/RPC commands are not HTTP routes. For Pi Web, `[id]` denotes its Next.js dynamic route; for AiHarness, `:id` denotes an Express parameter.

| Target surface | Routes/contracts and evidence |
|---|---|
| Pi automation | Pi `--mode json`, `--mode rpc`, exported SDK and `RpcClient`; native `packages/cli/src/cli/json-output.ts`, `packages/cli/src/rpc/rpc-controller.ts`, `packages/core/src/sdk/types.ts`. Check record payloads, final settlement and errors, not just names. CLI-01/RUN-01/EXT-04. |
| Live agent | Pi Web `POST /api/agent/new`, `GET/POST /api/agent/[id]`, `GET /api/agent/[id]/events`; native `POST /api/agent/runs`, `GET /api/agent/runs/:id`, `POST /api/agent/runs/:id/stop`, `GET /api/agent/sessions/:id/state`, `GET /api/agent/sessions/:id/events`. E03/E11; RUN-01/02, WEB-02. |
| Sessions | Pi Web `GET/PATCH/DELETE /api/sessions/[id]`, `GET .../context`, `POST .../fork`, `GET/POST /api/sessions/ui-state`; native `GET/PATCH/DELETE /api/sessions/:id`, `GET .../messages`, `POST .../fork`, `POST .../clone`, `GET /api/sessions/tree` (session relationships, not a Pi entry-tree alias); no matching native sidebar-state family found. E04/E11; SES-01/04, WEB-01. |
| Models/auth/settings | Pi Web `/api/models`, `/api/models/enabled`, `/api/models-config`, `/api/auth/*`, `/api/provider-usage/query`, `/api/cache-miss-notices`; native `/api/models`, `/api/models/enabled`, `/api/provider-registry`, `/api/configuration`, `/api/config`. Quota and cache-notice families have no demonstrated native equivalent. E05/E08; MOD-01/02/05, WEB-03. |
| MCP | Pi Web `GET/POST /api/mcp`, `POST /api/mcp/test`, `/api/mcp/sign-in`; native `GET /api/mcp`, `POST /api/mcp/preview`, `POST /api/mcp/actions`, `POST /api/mcp/test`, `/api/mcp/oauth/*`; exact auth/Origin/trust and passive-read checks remain native. E10; MCP-01/02/03/04. |
| Files/Git/PTY | Pi Web `/api/files/[...path]`, `/api/file-index`, `/api/worktrees`, `/api/terminal`; native `/api/files`, `/api/files/content`, `/api/files/download`, `/api/files/upload`, `/api/files/git/status`, `/api/files/git/diff`, `/api/workspaces/worktrees`, `/api/terminals`. Native file watcher/PTY events keep their own replay units. E12; WEB-04/05. |
| Resources/subagents | Pi Web `/api/plugins`, `/api/skills`, `/api/subagents/settings`; native `/api/plugins`, `/api/skills`, `/api/subagents/settings`, `/api/subagents/profiles`, `/api/subagents/runs`. E07/E08/E12; EXT-03, WEB-03/06. |

## 4. Convention for Future Audits

| State | Meaning |
|---|---|
| `ABSENT` | The capability or required evidence identified by the criterion does not exist in the inspected scope. |
| `PARTIAL` | A foundation exists, but at least one completion criterion or validation boundary is unmet. |
| `TO BE DEFINED` | A product, security, compatibility or scope decision is required. |
| `IN PROGRESS` | An assigned implementation or verification task is actively underway. |
| `BLOCKED` | An external blocker, accountable owner and concrete unblock trigger are documented. |
| `DONE` | Every scoped criterion is verified and evidence recorded. |
| `GAP ACCEPTED` | A dated, explicit final decision intentionally declines the specified criterion. |

### Closure Rule

Move an item to `DONE` only after its complete criterion is verified, compatibility/migration is covered where relevant, applicable tests/visuals pass, documentation is updated, and the journal records evidence plus commands actually run. Mark the report `DONE` only when every item is `DONE` or `GAP ACCEPTED`.

### Maintenance protocol

1. Select one criterion and a bounded missing acceptance case. Read the existing source/tests listed in §8 before adding tests. Reuse coverage; do not rewrite the suite for the audit.
2. Add a work-package subtask/PR reference, responsible person, exact scope and dependencies. Proposed team roles in §8 are not assigned people. Change the criterion to `IN PROGRESS` only when work actually starts.
3. Keep IDs stable. Split a family only with a journaled old→new ID map and recalculated denominator; do not delete difficult items to improve the percentage.
4. Append dated evidence with the reviewed commit and relevant dirty hashes, files/commands/results, failures, receipt locations and decision source. A bare commit, test filename or screenshot without a scenario is insufficient.
5. Distinguish subtask delivery, complete family closure and global qualification. Preserve CLI process, public SDK, actual HTTP and browser evidence when each boundary matters.
6. Recalculate §2 and its surface summary from §3 after every status change. `PARTIAL` contributes zero to closure; do not invent a weighted completion percentage.
7. On a regression, reopen a `DONE` criterion with evidence and an explicit journal transition. An accepted gap is final for this baseline; a new requirement or re-examination becomes a new explicitly linked criterion/audit.
8. Update the banner date and remaining scope; keep rejected/failed runs and superseded decisions visible. Refresh target versions only through an explicit delta review, never silently.

For code changes, run the owning Docker checks from `docs/ai/project-map.md`. For documentary changes, run `make lint-docs` and `git diff --check`. For final qualification, use `make typecheck`, `make test-parity`, `make test`, `make test-e2e`, and `make build-prod` on frozen inputs. These are **future gates**, not results of this audit.

## 5. Decisions and Accepted Gaps

No functional gap has been accepted. The following are **pending decision requests**, not approvals or mandates to copy upstream behavior. Proposed decision authority: application product owner with security/API maintainers; no individual is assigned by this report.

| ID | Dated decision | Justification | Re-examination trigger |
|---|---|---|---|
| BASE-02 | 2026-10-19 — requested: functional parity versus selected native compatibility | Determines import/SDK/protocol/extension commitments without binding the application to Pi internals | Before implementation of a compatibility adapter or a public replacement claim |
| SES-01 | 2026-10-19 — requested: Pi data import/coexistence guarantees | Native v2 and Pi v3 journals are not interchangeable | Before reading/writing a real Pi agent directory |
| EXT-01 | 2026-10-19 — requested: unchanged Pi extensions, bounded adaptation, or native-only API | TypeScript loading and manifest support do not bridge incompatible events, tools and UI | Before advertising or installing unmodified third-party Pi extensions |
| MCP-02 | 2026-10-19 — requested: retain native direct default or migrate to explicit/indirect policy | Default changes affect model declarations, exposure and existing configuration | Before changing default exposure or tool-selection semantics |
| CODE-01 | 2026-10-19 — requested: native script API versus compatibility dialect | Budgets and rich/image/structured helpers materially differ | Before importing Pi scripts or raising sandbox limits |
| MOD-01 | 2026-10-19 — requested: supported provider/auth/transport catalogue | Avoids treating every remote provider or subscription as a release requirement | Before provider expansion and real-account qualification |
| CLI-04 | 2026-10-19 — requested: lifecycle/update scope and delivery channel | Process management and self-updates add authority and operational obligations | Before adding update/stop/status commands |

If an item is intentionally declined, add its final dated decision, exact behavior omitted, justification, approving source and re-examination trigger here before moving it to `GAP ACCEPTED`. Native encryption, trust, allowed roots and inert browser rendering remain constraints during investigation; no exception was approved.

## 6. Delivery Journal

All entries below are a documentary baseline, not implementation receipts. Source/coverage references are expanded in §8. No old audit's `DONE` status was imported.

| Date | ID(s) | Old → New | Evidence | Validation | Notes/decision |
|---|---|---|---|---|---|
| 2026-10-19 | BASE-01 | Initial classification → `DONE` | §1, §8 fingerprints; upstream package metadata and Git tags | `git status --short`, `git rev-parse HEAD`, `git remote -v`; shallow clones of Pi `v1.2.0` and Pi Web `v0.12.2`, followed by `git -C <clone> rev-parse HEAD`: exact commits in §1; `sha256sum` of both dirty source files recorded | Static provenance criterion only; host identified with `node -p` |
| 2026-10-19 | BASE-02, CLI-04, SES-01, MOD-01, EXT-01, MCP-02, CODE-01 | Initial classification → `TO BE DEFINED` | E01/E02/E04/E05/E07/E09/E10/E14 | Read pinned documentation, public declarations and native parsers/loadouts; source searches established contract differences; no runtime test executed | Decisions requested in §5; no implicit accepted gaps |
| 2026-10-19 | CLI-01–CLI-03, RUN-01–RUN-04 | Initial classification → `PARTIAL` | E02/E03/E06/E07/E11/E14 | Read native tool loop, runtime/event contracts, CLI/RPC encoder/controller, editor tests and queue reconciliation tests; no test execution | Source presence and selected assertions only, not complete cross-host acceptance |
| 2026-10-19 | SES-02–SES-03, MOD-04, MCP-03–MCP-04, WEB-01 | Initial classification → `ABSENT` | E04/E05/E07/E10/E11 | `rg` searches for `context_edit`, `registerVirtualModel`, `registerMcpServer`, `list_mcp_resources`, `read_mcp_resource` in production packages; inspected entry/API unions, MCP host/result formatter and Sidebar against pinned upstream implementations | Absence bounded to native production code; no promise that third-party equivalents cannot exist |
| 2026-10-19 | SES-04–SES-05, MOD-02–MOD-03, MOD-05, EXT-02–EXT-04, MCP-01, CODE-02–CODE-03 | Initial classification → `PARTIAL` | E04–E10/E14 | Read source and relevant fixtures/tests; searched `cacheWarming`/`showCacheMissNotices` consumers; inspected specialized-model tests and pre-existing source diff | Parsed cache settings are not a warming implementation; classifier image changes remain unqualified |
| 2026-10-19 | WEB-02–WEB-06, SEC-01–SEC-03, QUA-02–QUA-03 | Initial classification → `PARTIAL` | E08/E10–E14 | Read native viewer/sidebar, profile service, SDK ownership and upstream browser/session/terminal notes; inventoried existing browser/process/installed tests | No captures, platform certification, public release or live-account result claimed |
| 2026-10-19 | QUA-01 | Initial classification → `ABSENT` | E14; initial documentation check below | Before edits: `make lint-docs` exited 2 (checker reported seven broken links); `git diff --check` exited 0 | No Docker qualification run; historical acceptance files were already deleted |
| 2026-10-19 | BASE-01, QUA-01 | No status change | This report; `docs/audit/README.md`; `docs/ai/project-map.md` | After navigation/API-map edits: `make lint-docs` exited 2 (97 Markdown files, 844 links, same seven violations); `git diff --check` exited 0. Inline Node assertions reconciled 43 unique criteria, all status/surface totals, 43 journaled IDs, 136 native and 92 upstream evidence paths; normalized before/after violation lists matched | AUDIT-5 is the sole active tracker; no deleted file restored. Both pre-existing source SHA-256 values remain unchanged. No application build/test/browser command was run |
| 2026-10-19 | BASE-01, QUA-01 | No status change | Navigation, owning topics and this report | After requested obsolete-reference cleanup: `make lint-docs` exited 0 (97 Markdown files, 837 local links); `git diff --check` exited 0. Repository text-source scan found no remaining named references to deleted audit files | Documentary cleanup only; no criterion closure or application qualification claimed |

### Documentation validation receipt

**Historical checks:** initial `make lint-docs` checked 96 Markdown files and 844 local links and found seven violations over six missing targets. After creating this report, the check covered 97 Markdown files and the same 844 links, retaining those seven failures. `git diff --check` passed. Inline Node assertions verified the criterion/status/surface totals, unique IDs, full initial journal coverage and existence of the registered native/upstream paths.

**Final documentary result after reference cleanup:** at the user's request, obsolete links and named references were removed from navigation, topics and this report. `make lint-docs` now passes (97 Markdown files, 837 local links), as does `git diff --check`; the repository text-source scan finds no remaining named references to deleted audit files. Historical failed checks above remain historical, not current application qualification. No replacement acceptance was invented; QUA-01 remains `ABSENT`, and application tests/builds/visuals remain unexecuted.

## 7. Glossary and Prefixes

| Prefix/term | Scope/definition | Example |
|---|---|---|
| BASE-* | Source baseline and product compatibility contract | BASE-02 |
| CLI-* | Terminal application, invocation and lifecycle commands | CLI-02 |
| RUN-* | Agent lifetime, scheduling, recovery and tool execution | RUN-03 |
| SES-* | Journal, context projection, copies and compaction | SES-02 |
| MOD-* | Provider/model selection, routing, reasoning and cache | MOD-04 |
| EXT-* | Extension API, resources/packages and public SDK | EXT-01 |
| MCP-* | MCP configuration, hosting, resources and registration | MCP-03 |
| CODE-* | Code-mode dialect, specialized models and sandbox | CODE-01 |
| WEB-* | Browser UX and its server-backed workflows | WEB-01 |
| SEC-* | Native trust, credentials and transport authority | SEC-02 |
| QUA-* | Current integration, platform and distribution evidence | QUA-01 |
| P0/P1/P2 | Proposed risk/delivery ordering, not severity of a proven vulnerability | P0: establish file compatibility before import |
| Functional parity | Equivalent user outcome under a documented native contract | Resume a native session in CLI and Web |
| Compatibility | Specified ability to consume an upstream API, file or protocol unchanged or through a declared migration | Pi JSONL v3 import |
| Static evidence | Source/declaration/assertion inspection, not an executed passing scenario | A test file exists and was read |
| Settlement | Finalized owned work, including durable writes; different from cancellation acknowledgement | Native SDK `stop()` then `wait()` |

## 8. Annexes

### Baseline fingerprints

These SHA-256 values identify the **pre-existing uncommitted files** observed during this audit, in addition to the Git commit in §1. Recompute on a later delivery; do not claim these bytes were tested.

| File | SHA-256 |
|---|---|
| `packages/cli/src/tui/fullscreen-input.ts` | `33132ceff9110eef46d5b975b894323593dbae2977cb5cc2133cfefeb9a0ee30` |
| `packages/core/src/providers/specialized-models.ts` | `59d24fda5ba8f13b8ad520edcdf7d7bc365b389bfa50356440a90f9485fb89d0` |

### Source and existing coverage register

Upstream paths are relative to the exact pinned GitHub trees in §1, **not moving `main` links**. `P:` means Pi, `W:` means Pi Web, `A:` means this repository. Tests are reuse candidates; only commands in §6 have actual results. Ranges/globs describe inventories, not extra tests that were run.

| Evidence | Upstream reference | Native source and reusable coverage |
|---|---|---|
| E01 | P: `README.md`, `packages/coding-agent/docs/configuration.md`, `docs/session-format.md` under that package. W: `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `package.json` | A: `package.json`, `packages/core/src/types/index.ts`, `packages/core/src/sdk/types.ts`, `docs/ai/project-map.md`; package version/architecture and persistence contract |
| E02 | P: `packages/coding-agent/docs/cli.md`, `docs/keybindings.md`, `docs/tui.md`, `docs/settings.md` under that package; `src/modes/interactive/interactive-mode.ts`. W: `bin/pi-web.js` | A: `packages/cli/src/index.ts`, `packages/cli/src/cli/tool-selection.ts`, `packages/cli/src/tui/fullscreen-input.ts`, `packages/cli/src/tui/fullscreen-ui.ts`, `packages/cli/src/utils/terminal-actions.ts`, `packages/server/src/web-cli-options.ts`; `packages/cli/src/tui/fullscreen-input.test.ts`, `packages/cli/src/cli/keybindings-process.test.ts`, `packages/cli/src/cli/startup-display-process.test.ts`, `tests/functional-parity/fixtures/manifest.json` |
| E03 | P: `packages/coding-agent/docs/rpc.md`, `docs/extensions.md`, `docs/compaction.md` under that package; `src/core/agent-session.ts`. W: `lib/rpc-manager.ts`, `docs/agents/sessions.md` | A: `packages/core/src/agent/runtime.ts`, `packages/core/src/agent/events.ts`, `packages/core/src/agent/tool-loop.ts`, `packages/core/src/agent/message-queue.ts`, `packages/cli/src/cli/json-output.ts`, `packages/cli/src/rpc/rpc-controller.ts`; `packages/core/src/agent/prestart-admission.test.ts`, `packages/core/src/agent/runtime-prestart.test.ts`, `packages/core/src/agent/message-queue.test.ts`, `packages/cli/src/cli/length-stop-process.test.ts` |
| E04 | P: `packages/coding-agent/src/core/session-manager.ts`, `docs/session-format.md`, `docs/compaction.md` under that package. W: `lib/session-reader.ts`, `lib/session-fork.ts`, `docs/agents/sessions.md` | A: `packages/core/src/sessions/session-manager.ts`, `packages/core/src/sessions/session-context.ts`, `packages/core/src/sessions/session-accounting.ts`; `packages/core/src/sessions/session-active-entries.test.ts`, `packages/core/src/sessions/session-navigation-contracts.test.ts`, `packages/core/src/sessions/session-row-copy.test.ts`, `packages/cli/src/cli/session-statistics-process.test.ts`, `packages/server/src/api/session-row-copy-http.test.ts`, `tests/functional-parity/fixtures/sessions/` |
| E05 | P: `packages/coding-agent/docs/models.md`, `docs/virtual-models.md`, `docs/settings.md` under that package; `src/core/model-runtime.ts`, `src/core/cache-warmer.ts`. W: `lib/model-runtime.ts`, `lib/provider-usage.ts`, `lib/transcript-notices-server.ts`, `app/api/cache-miss-notices/route.ts` | A: `packages/core/src/providers/index.ts`, `packages/core/src/providers/model-catalog.ts`, `packages/core/src/providers/model-metadata.ts`, `packages/core/src/providers/anthropic-thinking.ts`, `packages/core/src/providers/thinking-budgets.ts`, `packages/core/src/config/agent-settings.ts`, `packages/server/src/runtime/provider-registry.ts`; `packages/core/src/providers/model-resolution-ambiguity.test.ts`, `packages/core/src/providers/stream-error-frames.test.ts`, `packages/cli/src/cli/model-resolution-process.test.ts`, `packages/cli/src/cli/thinking-budgets-process.test.ts` |
| E06 | P: `packages/coding-agent/src/core/compaction/compaction.ts`, `src/core/session-manager.ts`, `docs/compaction.md` under that package | A: `packages/core/src/sessions/compaction-preparation.ts`, `packages/core/src/sessions/compaction-generation.ts`, `packages/core/src/sessions/summary-model-messages.ts`, `packages/core/src/agent/provider-request-estimate.ts`, `packages/core/src/agent/provider-request-options.ts`; `packages/core/src/sessions/compaction-context.test.ts`, `packages/core/src/sessions/session-compaction-store-admission.test.ts`, `packages/core/src/sessions/summary-model-messages.test.ts`, `packages/core/src/agent/provider-request-budget.test.ts`, `packages/server/src/api/http-compaction-lifecycle.test.ts` |
| E07 | P: `packages/coding-agent/docs/extensions.md`, `docs/sdk.md`, `docs/tui.md`, `docs/packages.md` under that package; `src/core/extensions/types.ts`, `examples/sdk/01-minimal.ts`, `examples/sdk/14-codemode-mcp.ts`. W: `lib/builtin-extensions.ts`, `lib/rpc-manager.ts` | A: `packages/core/src/extensions/extension-registry.ts`, `packages/core/src/extensions/module-loader.ts`, `packages/core/src/extensions/builtin-extensions.ts`, `packages/core/src/plugins/plugin-service.ts`, `packages/core/src/sdk/types.ts`, `packages/core/src/sdk/agent-session.ts`; `packages/core/src/sdk/prestart-lifetime.test.ts`, `packages/cli/src/cli/extension-session-state-process.test.ts`, `packages/cli/src/cli/typescript-extensions-process.test.ts`, `packages/cli/src/rpc/rpc-extension-ui-process.test.ts`, `e2e/interaction-live-boundary.spec.ts` |
| E08 | P: `packages/coding-agent/docs/configuration.md`, `docs/settings.md`, `docs/skills.md`, `docs/prompt-templates.md`, `docs/themes.md` under that package. W: `components/SkillsConfig.tsx`, `components/SettingsPanel.tsx` | A: `packages/core/src/config/agent-settings.ts`, `packages/core/src/prompts/instruction-context.ts`, `packages/core/src/resources/resource-manager.ts`, `packages/core/src/themes/theme-manager.ts`, `packages/web/src/components/SettingsView.tsx`; `packages/core/src/resources/resource-template-arguments.test.ts`, `packages/core/src/resources/resource-discovery-policy.test.ts`, `packages/cli/src/cli/theme-sources-process.test.ts`, `e2e/settings-navigation.spec.ts`, `e2e/skill-content-live.spec.ts` |
| E09 | P: `packages/coding-agent/docs/codemode.md`, `docs/models.md`, `docs/extensions.md` under that package. W: `lib/codemode-view.ts`, `components/CodemodeToolView.tsx` | A: `packages/core/src/tools/codemode.ts`, `packages/core/src/tools/codemode-worker.ts`, `packages/core/src/providers/specialized-models.ts`, `packages/core/src/types/codemode.ts`; `packages/core/src/tools/codemode.test.ts`, `packages/core/src/tools/codemode-intrinsics.test.ts`, `packages/core/src/providers/specialized-models.test.ts`, `packages/cli/src/cli/codemode-intrinsics-process.test.ts`, `e2e/codemode.spec.ts` |
| E10 | P: `packages/coding-agent/docs/mcp.md`, `src/extensions/mcp/resources.ts`, `src/core/mcp-servers.ts`, `src/core/extensions/loader.ts` under that package. W: `lib/mcp-host.ts`, `lib/mcp-override.ts`, `lib/mcp-sign-in.ts` | A: `packages/core/src/mcp/config-inventory.ts`, `packages/core/src/mcp/session-host.ts`, `packages/core/src/mcp/oauth-flow.ts`, `packages/server/src/api/mcp-routes.ts`; `packages/core/src/mcp/config-inheritance.test.ts`, `packages/core/src/mcp/tool-exposure-patterns.test.ts`, `packages/server/src/api/mcp-oauth-routes.test.ts`, `packages/cli/src/cli/mcp-inheritance-process.test.ts`, `e2e/mcp-inheritance-live.spec.ts`, `e2e/mcp-exposure.spec.ts` |
| E11 | W: `lib/session-ui-state-shared.ts`, `lib/session-ui-state.ts`, `lib/session-tree.ts`, `lib/agent-event-stream.ts`, `hooks/useAgentSession.ts`, `components/ChatWindow.tsx`, `docs/agents/sessions.md` | A: `packages/web/src/components/Sidebar.tsx`, `packages/web/src/components/ChatView.tsx`, `packages/web/src/store/session-store.ts`, `packages/server/src/api/sse-channel.ts`; `packages/server/src/api/agent-event-backpressure.test.ts`, `e2e/queue-reconciliation.spec.ts`, `e2e/session-event-lifetime.spec.ts`, `e2e/session-row-copy-live.spec.ts`, `e2e/native-session-links-live.spec.ts` |
| E12 | W: `docs/worktrees.md`, `docs/terminal.md`, `components/FileViewer.tsx`, `components/DelimitedTable.tsx`, `lib/terminal-manager.ts`, `lib/subagent-runtime.ts`, `lib/subagent-settings.ts` | A: `packages/web/src/components/WorkspacePanel.tsx`, `packages/web/src/components/TerminalPanel.tsx`, `packages/server/src/api/file-routes.ts`, `packages/server/src/runtime/terminal-runtime.ts`, `packages/server/src/runtime/subagent-service.ts`, `packages/server/src/runtime/subagent-runtime.ts`; `packages/server/src/runtime/terminal-runtime.test.ts`, `packages/server/src/runtime/subagent-runtime.test.ts`, `packages/server/src/web-server.test.ts`, `e2e/live-server.spec.ts`, `e2e/terminal-controls.spec.ts`, `e2e/workspace-asset-load.spec.ts` |
| E13 | P: `packages/coding-agent/docs/security.md`, `docs/configuration.md`, `docs/models.md`, `docs/mcp.md` under that package. W: `lib/request-security.ts`, `lib/project-trust.ts`, `lib/web-auth.ts` | A: `packages/core/src/security/project-trust.ts`, `packages/core/src/security/workspace-manager.ts`, `packages/core/src/security/credential-store.ts`, `packages/core/src/providers/credentials.ts`, `packages/core/src/sessions/serialization.ts`, `packages/server/src/security/request-security.ts`; `packages/core/src/security/project-trust.test.ts`, `packages/core/src/sessions/provider-config-redaction.test.ts`, `packages/server/src/api/session-provider-redaction-process.test.ts`, `packages/server/src/web-server.test.ts` |
| E14 | P: `package.json`, `packages/coding-agent/package.json`. W: `package.json`, `bin/prepare-terminal.js`, `lib/pi-packages.test.mjs`, `lib/process-lifecycle.test.mjs` | A: `Makefile`, `.docker/Dockerfile.test`, `.docker/Dockerfile.prod`, `.docker/e2e-suites.mjs`, `tests/functional-parity/fixtures/manifest.json`, `tests/functional-parity/installed-executable.test.ts`, `tests/functional-parity/installed-process.test.ts`, `.github/workflows/ci.yml`, `e2e/accessibility.spec.ts`, `e2e/performance.spec.ts`, `e2e/visual.spec.ts` |

### Proposed delivery work packages

Start with decisions and small reproducible cases, not a monolithic parity rewrite. Leads below are **suggested disciplines**, unassigned until an actual work entry names a person/PR. No implementation is started by this table.

| Order | Work package / criteria | Proposed lead | Prerequisites | First bounded output / exit condition |
|---|---|---|---|---|
| 1 | Contract decisions: BASE-02, SES-01, EXT-01, MCP-02, CODE-01, MOD-01, CLI-04 | Product + API/security maintainers | BASE-01 | Approve separate compatibility levels and supported provider/platform matrix; record declined behaviors individually, not a blanket parity waiver |
| 2 | Data/context: SES-02/03/05, RUN-03 | Core sessions/providers | File/protocol decisions; no need to enable foreign writes | One omission/replacement/reload fixture, then one prompt/tool checkpoint fixture; integrate only after raw-history/accounting/privacy checks |
| 3 | Runtime/public API: RUN-01/02/04, EXT-02/04, CLI-01 | Core + CLI/SDK | Chosen event/API contract; work package 2 for recovery | One stop-at-held-boundary case and one actual queue-delivery case; extend existing process/SDK controls, then verify HTTP/browser boundary separately |
| 4 | Model execution: MOD-02/03/04/05, CODE-02/03 | Providers + sandbox maintainers | Provider/dialect decisions; work package 2 for routed context | One chosen physical-model wire fixture and one specialized-model guest input/output journey; routing and cache warming remain separate deliverables |
| 5 | MCP/resources: MCP-01/02/03/04, EXT-03 | Core integrations + Server/CLI | Extension/exposure/dialect decisions | One resources-only server exercised from real CLI and server; then dynamic registration/withdrawal; preserve passive inventory and read-only authority |
| 6 | Browser workflow: WEB-01–WEB-06, SES-04 | Web + Server | Persisted native contracts; package 3 for live lifetimes | Pin/archive state without journal mutation is a separate first task; richer previews, terminal and delegation each keep their own live/visual receipt |
| 7 | Terminal ergonomics: CLI-02/03/04 | CLI + packaging | Supported terminals/theme/update scope | Qualify existing multiline Home/End before adding another action; publish action/setting support map and review actual regular/fullscreen output |
| 8 | Cross-cutting security and release: SEC-01–SEC-03, QUA-01–QUA-03 | Security + release/QA | Security controls apply to every package; final integration after deliveries | Freeze inputs, keep documentation navigation current, run Docker gates and selected platform/install/visual scenarios; leave failed gates open |

### Visual evidence

None captured in this audit. Existing screenshots and baselines are not represented as a current Pi/Pi Web differential review. Store later reviewed captures with commit, scenario, viewport, theme and criterion IDs; do not fabricate them from a passing API fixture.
