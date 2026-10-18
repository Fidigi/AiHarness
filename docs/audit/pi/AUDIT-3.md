# AUDIT-3 — AiHarness Remaining Work and Pi CLI 1.3.0 / Pi Web 0.12.2 Changes

> **Status: IN PROGRESS — sole active audit — last updated 2026-10-18.**
>
> **Current checkpoint: 99 entries = 1 DONE + 94 PARTIAL + 2 ABSENT + 2 TO BE DEFINED; 98 remain open.** `A3-CLI-13` is qualified in `7174970`. `A3-CLI-11` has a committed final-JSON subset (`81129d5`); mixed-delta ordering is committed in `ca8eb79`. The child-termination receipt increment (parent `ca8eb79`) passes full local E2E (570/570), but production build FAILED natively. Neither subset closes the review or release qualification. The review remains PARTIAL. Integrated E2E is FAILED, not waived. See §9 for delivery evidence, current failures and pending decisions.
>
> [AUDIT-2](./AUDIT-2.md) is administratively closed and archived: its 50 open criteria are tracked exclusively here, without changing their historical statuses.
>
> This document carries forward the **50 criteria still PARTIAL** in AUDIT-2 and adds **49 review criteria for the installed-version delta**. It does not require redoing the 102 criteria already declared DONE or turn any historical failure into a success. Current implementation results supersede initial findings only within their explicitly qualified scope.
>
> **Version warning: installed Pi CLI = 1.3.0; installed Pi Web = 0.12.2, embedding Pi 1.2.0.** Fixes specific to Pi 1.3.0 must therefore not be assumed present in Pi Web.

## 1. Mandate, Scope and References

### 1.1 Deliverables and Succession Rule

The initial request was documentation-only: carry forward what was not completed in [AUDIT-2](./AUDIT-2.md), then establish a new audit incorporating the latest installed changes. The subsequent implementation goal makes this report the live tracker. On 2026-10-18 the user explicitly requested reconciliation with delivered work **before further implementation**, then an update at every advance. Initial comparison/editorial observations remain historical; current delivery and validation are recorded in §9.

This report delivers:

1. An exact inventory of remaining criteria, preserving their identifiers and acceptance boundaries.
2. A verifiable reference to the versions actually installed, distinct from versions available on an upstream branch.
3. A comparison of material Pi CLI `1.0.0 → 1.3.0` and Pi Web `0.10.0 → 0.12.2` changes against current AiHarness foundations.
4. A prioritized backlog, its technical owners, existing evidence and outstanding validation.
5. An explicit account of what was checked during drafting, followed by a maintained delivery journal distinguishing committed work, work in progress, qualified subsets, failures and remaining requirements.

The full wording of the 50 inherited requirements remains in [AUDIT-2 §3](./AUDIT-2.md#3-traceability-by-surface). The tables below summarize **the remaining work**, not a new, reduced definition of those requirements. The journal, decisions, retractions and historical evidence records remain in AUDIT-2 and its [latest completion review](./acceptance/completion-review.md). AUDIT-2 is frozen as a historical reference; only its status banner records its archival and the transfer of tracking to this document.

AiHarness retains its own APIs, names, paths, JSONL formats, commands and trust rules. Pi is a behavioral reference, not a dependency to introduce or a binary/source compatibility obligation. More restrictive security differences must not be removed to resemble upstream.

### 1.2 Observed State and Versions

| Item | Observed reference |
|---|---|
| Initial comparison baseline | `0f5ebb89d1139946257eee88b61aea4927b49048`; clean working tree before initial drafting |
| Current implementation checkpoint | Product commits `7174970`, `81129d5`, `ca8eb79`; the dispatcher receipt correction is included with this journal increment (parent `ca8eb79`), limited to `.docker/e2e-suites.{mjs,d.mts,test.mjs}` and validation/tracking docs. Frozen inputs and actual gates are in §9: local E2E 570/570; production build failed; no release qualification |
| Latest AUDIT-2 state | DEC-102: 152 unique criteria = 102 DONE + 50 PARTIAL; CLI 48 DONE / 39 PARTIAL, Web 54 DONE / 11 PARTIAL |
| Previous targets | Pi CLI 1.0.0, commit `a13d35a742c6ef8462812a28fbe1d8c8b7431c32`; Pi Web 0.10.0, commit `6fcd7d44981ab51a21d6cd6eb06d361d0e3d3068` |
| Installed Pi CLI | `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/package.json` and `pi --version`: **1.3.0**; direct Pi dependencies declared at exactly `1.3.0` |
| Pi CLI reference source | [earendil-works/pi, v1.3.0](https://github.com/earendil-works/pi/tree/71023aec1546d6d677a65669c5665c0927ce0dd0), commit `71023aec1546d6d677a65669c5665c0927ce0dd0`; successor to the repository historically named pi-mono |
| Installed Pi Web | `/usr/local/lib/node_modules/@agegr/pi-web/package.json` and `pi-web version`: **0.12.2** |
| Pi Web reference source | [agegr/pi-web, v0.12.2](https://github.com/agegr/pi-web/tree/b017cd48425d05aa4952051db2e4fc031c134094); annotated tag `3360e93c49e6d88efc4d3970fa056324072476b5`, peeled commit `b017cd48425d05aa4952051db2e4fc031c134094` |
| Pi Web npm metadata | `npm view @agegr/pi-web@0.12.2 gitHead`: `520ce8d52718f4411ad7b1495154c85166869709`; this is not the tag's peeled commit. The diff between them contains only `package.json` and `package-lock.json`, with 3 version insertions / 3 deletions |
| Pi embedded in Pi Web | Coding-agent package **1.2.0**, reference commit [v1.2.0](https://github.com/earendil-works/pi/tree/06a466935536f8c9bcacb2d5efc0fc021be1bdff). Pi Web's seven direct Pi dependencies are pinned to 1.2.0; coding-agent, agent-core, ai, codemode, mcp, telemetry and tui in its installation were inspected at 1.2.0 |
| Reviewed Web delta | [0.10.0…0.12.2](https://github.com/agegr/pi-web/compare/6fcd7d44981ab51a21d6cd6eb06d361d0e3d3068...b017cd48425d05aa4952051db2e4fc031c134094): 464 files, +45,266 / −10,562 lines; excluding `demo/`, 442 files, +44,516 / −10,465; 156 non-merge commits |

The npm outputs provide these integrity values:

```text
@earendil-works/pi-coding-agent@1.3.0
sha512-V/WoCjA2hQSe3QLWIUB24cTRdtEdeLiIzkDqU5RMXV6VWuD+KGZnzVBMhglwdnQTySkehZsjt8a3g6Jd2g4nnw==

@agegr/pi-web@0.12.2
sha512-YuSpJA6JACszhYpjU2DL1b2oW4A+BVAYhvhXWg8xi31iH6G/UQoYrXXyM0pRJVdj6sZ/Zu2qiJeUiNVVSUFgsg==
```

These integrity values identify the published archives according to npm; they are not a bit-for-bit verification of local installations or the `.next` build. Commits serve as immutable source references, not package reproducibility certificates.

### 1.3 Initial Comparison Method and Evidence Scope

- Read the canonical `docs/ai/project-map.md`, AUDIT-2 matrices and closure evidence records, installed manifests, the README and changelog sections after 1.0.0.
- Targeted reading of AiHarness implementations, public contracts and owning tests; comparison against installed Pi JavaScript/declarations and Pi Web sources at the specified tag. Upstream tests are reference scenarios, **not** AiHarness results.
- Consulted the full Web diff and history; reviewed changed families in depth: sessions, navigation, MCP, models, subagents, files, rendering, terminal and operations. Internal, CSS, dependency and test changes are grouped by observable contract; this is not a line-by-line review certificate for all 464 files.
- The 102 DONE criteria are **retained as historical acceptances**, not requalified against the new targets. Reviews that may affect them have their own `A3-*` identifiers; no implicit reopening is applied to AUDIT-2.
- No provider calls, real MCP connections, logins, installations/updates, deployments or user-session manipulation. Pinned source checkouts are in `/tmp/aih-audit3-pi` and `/tmp/aih-audit3-pi-web`, outside the repository.
- No product suites were rerun during the **initial documentation audit**. The presence of code or a test is not a passing test result, and a negative text search alone does not prove functional absence.

These drafting limitations do not describe subsequent implementation runs: actually executed Docker gates and their failures are recorded in §9. No later green subset replaces an earlier failed aggregate.

## 2. Summary and Conventions

### 2.1 Outcome

| Set | Count | Interpretation |
|---|---:|---|
| Previously accepted criteria | 102 | Not duplicated in the backlog; evidence and failures retained in AUDIT-2 |
| Inherited remaining criteria | 50 | 39 CLI + 11 Web, all PARTIAL; exhaustive inventory in §3 |
| New delta reviews | 49 | 20 CLI + 29 Web; **1 DONE, 44 PARTIAL, 2 ABSENT, 2 TO BE DEFINED**; current statuses and exit conditions in §4 |
| AUDIT-3 work entries | 99 | 50 inherited criteria + 49 reviews; **1 closed / 98 open**, not 99 independent features |

| Current status | Count |
|---|---:|
| DONE | 1 |
| PARTIAL | 94 |
| ABSENT | 2 |
| TO BE DEFINED | 2 |
| BLOCKED | 0 |
| IN PROGRESS | 0 |
| GAP ACCEPTED | 0 |
| **Total** | **99** |

Administrative entry closure is `(1 DONE + 0 GAP ACCEPTED) / 99 = 1.0%`. This is **not an overall parity percentage**: several reviews strengthen the same historical criterion or an already delivered guarantee. Do not add these rows to the 152 historical criteria or reuse 67.1%. Active subset work is recorded in §9 without promoting its whole PARTIAL criterion.

### 2.2 Statuses and Priorities

The statuses `PARTIAL`, `ABSENT`, `TO BE DEFINED`, `BLOCKED`, `DONE` and `GAP ACCEPTED` retain the meanings defined in [AUDIT-2 §4](./AUDIT-2.md#4-convention-for-future-audits). For additions:

- **PARTIAL**: an identified foundation exists; the full additional contract is not qualified. This is not necessarily a reproduced bug.
- **ABSENT**: a specific surface is missing from the inspected contract/path; this does not mean the entire family is absent.
- **TO BE DEFINED**: a product/security decision is required before implementation; no gap is accepted by default.

**P0** = security, authority, cancellation, integrity or false success; **P1** = important functional capability or consistency; **P2** = usability, presentation, distribution or external operation. These are proposed AiHarness priorities, not ratings of confirmed vulnerabilities. All §3 rows are PARTIAL, even where a sub-behavior is absent.

## 3. Exhaustive Carryover of AUDIT-2's 50 Remaining Criteria

The `AH-*` references point to owners and source evidence in §5. The last column identifies related new work without replacing the inherited criterion.

### 3.1 Invocation and Terminal — 9 Criteria

| Retained ID | Priority | Work remaining to implement or qualify | Owners / delta links |
|---|---|---|---|
| CLI-RUN-02 | P1 | Complete regular/fullscreen semantics, input and capability-based fallback; the `--tui-mode` choice and its validation exist. | AH-TUI; A3-CLI-15 |
| CLI-RUN-06 | P0 | Complete RPC capabilities, rebind and lifecycles, with descendant/process evidence on target platforms; preserve existing pure stdout and LF framing. | AH-RPC; A3-CLI-12 |
| CLI-RUN-08 | P1 | Full picker, project grouping, global cwd confirmation and selection/copy conflicts; do not redo already delivered ID/prefix/file selectors. | AH-SES; A3-WEB-06 |
| CLI-RUN-10 | P1 | Changelog/debug views, resume and local-model workflows, and rich interactive selectors. **The shortcut browser is now delivered by DEC-101**: do not repeat the old blanket claim that hotkeys are absent. | AH-TUI, AH-CLI |
| CLI-TUI-03 | P1 | Editing, selection, multiline, paste/IME and external editor: complete real regular/fullscreen interactions beyond the current editor. | AH-TUI; A3-CLI-15 |
| CLI-TUI-04 | P1 | `@` search/completion, image paste/drag and terminal display; startup `@path` images do not cover these gestures. | AH-TUI, AH-TOOLS; A3-CLI-06 |
| CLI-TUI-05 | P1 | Searchable command menu and model/settings/session selectors, including extension completion. | AH-TUI, AH-EXT |
| CLI-TUI-06 | P1 | Thinking/tool collapse and expansion, context pressure and cache notices; preserve actual status and explicitly indicated incomplete costs. | AH-TUI, AH-PROV; A3-WEB-21 |
| CLI-TUI-09 | P1 | Full mouse/wheel/selection/copy/scrollbar contract, fullscreen exit, links, images, progress and resize. Shortcuts alone do not prove it. | AH-TUI; A3-CLI-15 |

### 3.2 Providers, Configuration and Sessions — 16 Criteria

| Retained ID | Priority | Work remaining to implement or qualify | Owners / delta links |
|---|---|---|---|
| CLI-MOD-01 | P1 | Extend categories and hosted/gateway/subscription/classifier/image providers beyond current adapters. | AH-PROV; A3-CLI-07, A3-CLI-10 |
| CLI-MOD-02 | P0 | Complete dialects, endpoints, streams/reasoning/tools and normalization; verify real errors and multimodal messages. | AH-PROV; A3-CLI-10, A3-CLI-11 |
| CLI-MOD-03 | P0 | Native provider OAuth with browser/callback/PKCE and usable registrations, beyond configured device endpoints; distinguish this authentication from already delivered MCP OAuth. | AH-PROV, AH-MCP; A3-CLI-03 |
| CLI-MOD-04 | P1 | Shared CLI/Server custom catalog, overrides and local-model/llama.cpp control; the Server custom catalog exists. | AH-PROV; A3-CLI-07, A3-CLI-08 |
| CLI-MOD-05 | P1 | More complete authoritative metadata and durable offline catalog/cache; current offline mode is a startup policy, not that cache. | AH-PROV; A3-CLI-08, A3-CLI-09 |
| CLI-MOD-07 | P1 | Complete thinking profiles/defaults/maps and signed continuation. Numeric budgets and adaptive Sonnet 4.6 remain accepted, not generalized to all models. | AH-PROV; A3-CLI-10 |
| CLI-MOD-08 | P1 | Cross-provider/export multimodal conformance and interactive attachments; preserve existing image ingestion/persistence. | AH-PROV, AH-TOOLS; A3-CLI-06, A3-WEB-09 |
| CLI-MOD-10 | P1 | Exact usage/cache/transport/timeout/retry conformance, cache warming and tiered pricing; do not confuse delivered journal accounting with full provider policy. | AH-PROV; A3-CLI-10, A3-WEB-21 |
| CLI-CFG-05 | P1 | Live selectors, branch-persistent tool changes and consistent session/startup setting mutations. | AH-CFG, AH-TOOLS; A3-CLI-01 |
| CLI-CFG-07 | P1 | Detailed terminal/fullscreen/image/Markdown/Mermaid settings and settings UI; quiet/header/full/verbose must not be redone. | AH-CFG, AH-TUI; A3-CLI-14, A3-CLI-15 |
| CLI-CFG-10 | P2 | Configurable update/telemetry/warnings, mutation UI and full reload scope; preserve current paths, provenance and offline snapshot. | AH-CFG, AH-CLI; A3-CLI-17, A3-CLI-18 |
| CLI-SES-01 | P1 | Project-grouped storage/discovery and global retrieval; the memory journal and directory overrides exist. | AH-SES; A3-WEB-27 |
| CLI-SES-02 | P1 | Full picker, global index, cross-project confirmation and cwd-change protections; do not redo delivered rich copies. | AH-SES |
| CLI-SES-03 | P0 | Complete message/schema families and migrations, strictly append-only metadata evolution; retain AiHarness JSONL v2 without importing Pi's format. | AH-SES; A3-CLI-19, A3-WEB-20 |
| CLI-SES-04 | P1 | Labels, filters and full tree navigation; metadata is not represented exclusively as append-only entries. | AH-SES; A3-WEB-02 |
| CLI-SES-07 | P0 | Complete useful overflow recovery + reconstruction, post-hook system/tool/media wire budgets and effective/unknown→known model handling, CLI/RPC budget composition, renderer/hooks/provenance, general prestart authority, physical settlement and actual usage of retired/invalid generations. DEC-92…97 already delivered the known source/store/preparation/generation/HTTP/admission subsets: do not repeat their former defects as current ones. | AH-COMPACT; A3-CLI-12, A3-CLI-19 |

### 3.3 Tools, Extensions, Automation and Security — 14 Criteria

| Retained ID | Priority | Work remaining to implement or qualify | Owners / delta links |
|---|---|---|---|
| CLI-TOOL-02 | P0 | Complete schema/result contracts, image reads, retained-output lifecycles and cross-platform processes; bounded tools/atomic edits exist. | AH-TOOLS; A3-CLI-06, A3-CLI-11 |
| CLI-TOOL-10 | P1 | Durable journal of every in-flight progress update for crash recovery. Native progress/replay, parentage and interrupted settlement are accepted, but live updates are process-local. | AH-TOOLS, AH-STREAM |
| CLI-EXT-02 | P1 | Complete versioned public event/context/lifecycle contract; preserve already delivered markers, options and loader. | AH-EXT; A3-CLI-04, A3-CLI-12 |
| CLI-EXT-03 | P0 | Ordering, concurrency, cancellation/transformation and errors across the full event set, not just already qualified branch hooks. | AH-EXT; A3-CLI-12 |
| CLI-EXT-04 | P0 | Extension-provided MCP registration and full ownership/conflict handling for dynamic capabilities; tools/providers and the Core MCP host exist. | AH-EXT, AH-MCP; A3-CLI-04 |
| CLI-EXT-06 | P1 | Full interactive TUI extension UI; declarative RPC/replay/capabilities and Web exist, without arbitrary browser components. | AH-EXT, AH-TUI; A3-CLI-15, A3-WEB-18 |
| CLI-EXT-07 | P0 | Owned disposers, full lifecycle, dependency reload and shutdown of blocked extensions on target platforms. | AH-EXT; A3-WEB-24 |
| CLI-AUT-01 | P0 | Complete JSONL events, overflow/accounting and summary retry outside RPC; preserve the versioned protocol and pure stdout. | AH-RPC, AH-STREAM; A3-CLI-12, A3-CLI-13 |
| CLI-AUT-02 | P0 | Complete cross-command validation/ordering and cross-platform shutdown; the canonical protocol is `{type,id}`, not the legacy migration envelope. | AH-RPC; A3-CLI-12 |
| CLI-AUT-03 | P0 | Input/extension handler semantics and every cancellation window for prompt/images/steer/follow-up/abort/new-session. | AH-RPC, AH-EXT; A3-CLI-12 |
| CLI-AUT-04 | P1 | Live mutations, authoritative catalog/maps and ordering/response details for state/messages/model/thinking/modes. | AH-RPC, AH-PROV; A3-CLI-08, A3-CLI-09 |
| CLI-AUT-05 | P0 | Overflow, retry/shell reload, exact accounting and abort/process races; limited context-settings reload is already delivered. | AH-RPC, AH-COMPACT; A3-CLI-11 |
| CLI-AUT-06 | P1 | External-file rebind and full export; stats, trees, commands and rich copies exist. | AH-RPC, AH-SES; A3-CLI-18 |
| CLI-SEC-06 | P0 | Complete evidence for descendants/races/accidental asynchronous writes and filtered environments on supported platforms; do not infer containment from documentation-only CLI-SEC-07 DONE. | AH-TOOLS, AH-RPC |

### 3.4 Web — 11 Criteria

| Retained ID | Priority | Work remaining to implement or qualify | Owners / delta links |
|---|---|---|---|
| WEB-BASE-01 | P1 | Interaction capabilities still missing from the SDK migration; do not redo delivered MCP host, OAuth, search and QuickJS. | AH-EXT, AH-TOOLS; A3-WEB-18 |
| WEB-BASE-02 | P0 | Built-in switches composed on Web and extension-provided MCP; CLI/RPC switches do not qualify Server/Web. | AH-MCP, AH-EXT; A3-CLI-04, A3-WEB-12 |
| WEB-BASE-05 | P1 | Resource aliases and full active-tool restoration across startup/reload/navigation and packages/profiles. | AH-TOOLS, AH-SUB; A3-CLI-01, A3-WEB-14 |
| WEB-TOOL-05 | P1 | Web pinning and full selection/default/dynamic/inactive restoration; preserve current preset/allowlist/read-only refiltering and branch-scoped deferred activation. | AH-TOOLS; A3-CLI-01 |
| WEB-FILE-06 | P0 | Define, then prove, the access policy derived from session evidence; AiHarness already enforces its roots/trust. Do not broaden this authority by copying upstream. | AH-FILES; A3-WEB-08 |
| WEB-CHAT-11 | P1 | Physical Android/iOS/Safari evidence, zoom/browser bars/IME/rotation, beyond the already delivered controlled Chromium viewport detector. | AH-WEB; A3-WEB-22 |
| WEB-SET-02 | P1 | Shared list/detail/scope/save/reasons/trust/footer/dialog/focus primitives across resources; Settings navigation and MCP detail are delivered separately. | AH-SET; A3-WEB-13 |
| WEB-SET-07 | P0 | General multi-host/shared-runtime rename and recovery. The current restricted default-OFF/single-writer option, base-path discovery and passive OAuth paste exist. | AH-PROV; A3-WEB-13 |
| WEB-SET-08 | P0 | Bounded pre-approval view of existing MCP targets and stacked accessibility; the general dialog deliberately reads without opening unapproved project bodies. A security decision is mandatory. | AH-MCP, AH-SET; A3-WEB-12 |
| WEB-OPS-02 | P2 | Actually authorized and observed Pages publication, remote settings/approvals; the pipeline and local demo are delivered, not deployment. | AH-OPS |
| WEB-OPS-04 | P0 | Coverage of still-open capabilities + integrated/release qualification; preserve prior native/canonical failures without borrowing passing subsets. Earlier E2E aggregates failed: page crash, then standard startup/occupied health URLs (§9.2). Latest full local E2E: 570/570 pass; default production build failed with native Server compiler abort/134 (§9.6). Historical causes remain unknown; no release qualification. | AH-OPS; A3-WEB-29 |

## 4. Latest Changes: Comparison and New Reviews

Each row gives an **exit condition**, not a delivery announcement. Upstream `packages/...` paths in §4.1 are relative to the [Pi 1.3.0 commit](https://github.com/earendil-works/pi/tree/71023aec1546d6d677a65669c5665c0927ce0dd0); those in §4.2 are relative to the [Pi Web 0.12.2 commit](https://github.com/agegr/pi-web/tree/b017cd48425d05aa4952051db2e4fc031c134094). Features introduced before 1.3 must also be reviewed in embedded Pi 1.2; those marked 1.3-only are not attributed to it.

### 4.1 Pi CLI 1.0.1 to 1.3.0 — 20 Reviews

| ID | Status / priority | Upstream change and reference | AiHarness finding and exit condition |
|---|---|---|---|
| A3-CLI-01 | PARTIAL / P1 | 1.0.4: `--tools`/`--exclude-tools` patterns, `--no-mcp`, separate MCP selection. 1.1: CLI `+`/`-` modifiers. 1.3: active-tool restoration on resume, then modifier application. `packages/coding-agent/src/core/agent-session.ts`, `packages/coding-agent/src/core/mcp-servers.ts`, docs `cli.md`, `settings.md`. | AH-TOOLS: exact Core selection and settings modifiers exist, as does branch-scoped deferred activation. Qualify replacement vs adjustment, glob, explicit MCP removal, reload/resume/fork and switches without reactivating a denied tool. Do not impose the `mcp__` name on AiHarness. |
| A3-CLI-02 | PARTIAL / P0 | 1.0.1: project override of a user server without `command`/`url`. `toolExposure` patterns with exact-match precedence, then first pattern. Docs `mcp.md`, `packages/coding-agent/src/extensions/mcp/config.ts`, `packages/coding-agent/src/core/mcp-servers.ts`. | AH-MCP: the runtime union requires a target, and `mcpToolExposure()` handles exact matches only; AiHarness defaults to `direct`. Add or decide on overrides without secret copying, orphan diagnostics, pattern/exact ordering, fresh trust and global/project writes; preserve the AiHarness default unless an explicit migration changes it. |
| A3-CLI-03 | PARTIAL / P0 | 1.0.1: CIMD; 1.0.4: native OIDC client; 1.1/1.2: auth cancellation at every stage, total deadline, no late call after refresh, `iss` validation even without metadata. `packages/mcp/src/oauth`, docs `mcp.md`. | AH-MCP has PKCE/loopback/paste, CAS/logout and bounded fetch. Its config contract does not expose CIMD. Review issuer/state/redirect, occupied port, scope and registration, cancellation during discovery/refresh/shutdown with real local fixtures; no browser-side tokens. No vulnerability conclusion without reproduction. |
| A3-CLI-04 | PARTIAL / P1 | 1.2: `reachesTools`, namespace aliases, declared MCP types and arbitrary JSON `structuredContent`; connection without enumerating all resources. `packages/coding-agent/src/core/extensions/types.ts`, `packages/mcp/src/client.ts`. | AH-EXT/AH-MCP: namespace without aliases/reach metadata; `formatToolResult()` already stringifies structured content but returns a flattened result. Define discovery/routing and read-only resources, preserve arrays/null/primitives without losing `isError`, never wait for an unbounded remote listing before tools. Explicit Test, which currently lists capabilities within bounds, is distinct from the prompt host. |
| A3-CLI-05 | PARTIAL / P0 | 1.0.1…1.3: bounded output/linear assembly, frozen guest built-ins, visible schema constraints, misplaced options rejected, termination of non-interruptible computation and admission counting workers until exit. `packages/codemode/src/runtime`, docs `codemode.md`. | AH-TOOLS: disposable QuickJS, output/call/concurrency limits, global counter of 8 and `finally` awaiting `worker.terminate()` exist. Do not import Bun's “two workers” limit or declare that defect present. Under abort/deadline storms, prove the actual physical bound, no surviving workers, prototype-pollution resistance, linear cost and validation of AiHarness-specific declarations/options. |
| A3-CLI-06 | PARTIAL / P1 | 1.0.3/1.0.4: `image()` saves a private file and `tools.read(image)` provides a reusable image; private full outputs; image/reload/Took fixes. `packages/coding-agent/src/core/tools`, `packages/codemode`. | AH-TOOLS: input images and specialized generation exist, but tool reads and MCP binary sharing remain limited/omitted. Define nested image transport, permissions, size, provenance/cleanup/revocation and export/reload continuity; test monotonic timestamps rather than repeating the former date difference. |
| A3-CLI-07 | PARTIAL / P1 | 1.0.1: Clef; 1.1: GPT-6 Luna Decisions, classifier images, non-chat llama.cpp `/v1/systemone` models. `packages/ai`, docs `models.md`, `llama-cpp.md`. | AH-PROV: `ClassificationRequest` = `model,input,labels`, without images; credential-private classifier/image bridges exist. Extend adapters and authoritative capabilities as needed, reject images for text models, do not list decision models as chat, bound results/hooks/costs. |
| A3-CLI-08 | PARTIAL / P1 | 1.2: key-specific OpenRouter catalog, limits/prices/regional endpoint and offline cache; persistent published catalog. `packages/ai`, `packages/coding-agent/src/core/{model-runtime,models-store}.ts`, docs `providers.md`. | AH-PROV: small published catalog + bounded discovery, without an equivalent durable catalog. Implement non-secret persistence with key/tenant isolation, auth/config invalidation and offline reads; negative placeholder prices must not be billed as real prices. |
| A3-CLI-09 | PARTIAL / P1 | 1.3 only: `--model` prefers the provider with credentials, then reports ambiguity; `--models`/scope cover every provider and warn; trailing comma fixed in 1.0.1. `packages/coding-agent/src/core/model-resolver.ts`. | AH-PROV: full-ID-first resolution and ambiguity handling exist; non-glob `resolveModelScope()` uses a single resolution. Review exact/fuzzy/bare IDs, multiple authenticated/unauthenticated providers and thinking pins; no silent selection based on catalog order. |
| A3-CLI-10 | PARTIAL / P1 | 1.0.2…1.3: per-level sampling, Azure Foundry Chat Completions, Haiku 5.5/Opus 5 and new Gemini/MiMo maps, Bedrock effort/size-based pricing, GPT-6 cache and Kimi Chat Completions `/v1`, dropping another model's thinking. `packages/ai/src/providers`, docs `models.md`. | AH-PROV: Sonnet 4.6/numeric budgets do not cover these profiles. Reconcile every dialect/endpoint/header/map/price and signed replay with chat/stream/switch payload fixtures; do not automatically rename an AiHarness provider because a Pi identifier changed. GPT-6/Kimi/switch items from 1.3 remain CLI-only in the reference installation. |
| A3-CLI-11 | PARTIAL / P0 | 1.1…1.3: busy/capacity/upstream retries, strict-tools rejection followed by bounded fallback, thinking before text within one chunk, malformed final JSON rejected, partial Unicode retained during streaming, Claude/Bedrock error images moved after tool results. `packages/ai/src/providers`, changelog 1.3.0. | AH-PROV/AH-TOOLS: **final textual JSON refusal is committed in `81129d5`**: whole batch refused before complete tool events/hooks/effects, fixed body-free diagnostic and no ordinary-turn retry, with valid/empty forms conserved. [Final JSON evidence](./acceptance/final-tool-json.md). **Mixed reasoning/text ordering is committed in `ca8eb79`**, with unit/public/installed gates and the subsequent complete local E2E (570/570) passing; original failures remain unexplained and the later production build failed natively; [ordering evidence](./acceptance/mixed-delta-order.md), §9. Still open: busy/capacity/upstream policy, bounded strict-tools fallback, complete Unicode and error-image ordering, arbitrary-provider schema/accessor/size admission and remaining races. Neither subset closes this review. |
| A3-CLI-12 | PARTIAL / P0 | 1.1: `agent_settled.aborted`. 1.2: `before_agent_start` also for custom triggers, user/custom union, stable system, nextTurn and busy from startup with deferred abort. `packages/coding-agent/src/core/agent-session.ts`. | AH-EXT: `AgentRuntime.start()` awaits `before:agent`/provider before publishing its ActiveRun. Reservation/concurrency during those awaits requires direct evidence. Define typed hooks and prestart authority for user/custom/queue, second-start refusal and shutdown without late message/provider work, including all hosts and SDK. This source finding is a risk to test, not a demonstrated exploit. |
| A3-CLI-13 | DONE / P0 | 1.2: print preserves truncated text, warns on stderr and exits 1 when the output limit is reached. `packages/coding-agent/src/modes/print-mode.ts`. | AH-CLI/AH-STREAM: **qualified in `7174970`**. Print/JSON preserve available final output, warn on stderr and exit 1 on explicit `stopReason: length`, including an earlier capped prompt followed by success. JSON/RPC retain length evidence and usage/history; RPC stays usable. Actual emitted and installed empty/partial/ordinary controls, framing and exact channels/exits pass. [Clause checklist and validation](./acceptance/print-output-limits.md). This does not close CLI-AUT-01, CLI-SES-07 or integrated Web qualification. |
| A3-CLI-14 | PARTIAL / P1 | 1.2: published settings/models/keybindings/themes schemas and identical startup/reload theme validation, strict vars/metadata. `packages/coding-agent/schemas`, docs `settings.md`, `themes.md`. | AH-CFG: keybindings/theme schemas delivered by DEC-101; a validated settings loader exists, but equivalent settings/models editor schemas are not delivered in AiHarness's `packages/cli/schemas` directory. Complete assets/versioning and round-trip outside the checkout, verify identical startup/reload rules without reopening the 58 already qualified tokens. |
| A3-CLI-15 | PARTIAL / P1 | 1.0.3…1.3: Home/End vs Ctrl+Home/End, OSC 7501, forced OSC52, hardware cursor only, outputPad, Shift/Kitty, fragmented color responses, EIO, images and owner-closed overlays. `packages/tui`, docs `terminal-setup.md`, `keybindings.md`. | AH-TUI: control filters, Escape handling and 22 actions are delivered. Complete the real terminal contract, working/blocked/done/failed/aborted status, safe remote copy, overlay ownership and disappearance/resize cleanup; PTY matrices, then physical terminals. No unfiltered OSC emission from remote content. |
| A3-CLI-16 | PARTIAL / P2 | 1.2: `~` expansion in `!/+/-` selectors; 1.3: empty `""`/`''` template arguments retained and positional defaults. `packages/coding-agent/src/core/resource-loader.ts`, `prompt-templates.ts`. | AH-CFG has selector scoping/literal roots; `parseResourceCommandLine()` already has `tokenStarted`, so do not claim the empty-argument bug is present. Add positive/negative comparisons and real CLI/RPC/SDK tests, tilde/exclusions and declaring sources; preserve trust and the legacy ABI. |
| A3-CLI-17 | TO BE DEFINED / P2 | 1.0.1/1.1/1.3: Nix, managed installer, retention of two releases, user PATH, exact internal pins, dependency fixes; unpublished experimental stack removed in 1.2. `package.json`, changelog, upstream flake/installer. | AH-OPS: npm/Docker distribution and genuinely installed tests exist. Decide whether installer/Nix/update support is an AiHarness need; otherwise record a dated decision with a review trigger, rather than copying Pi names. Audit the lockfile/distribution chain and PATH without claiming an AiHarness CVE from an upstream CVE. The source-only experimental stack is not an API to port. |
| A3-CLI-18 | ABSENT / P2 | 1.3 only: `/share` destination `auto/gist/radius`. `packages/coding-agent/src/core/settings-manager.ts`, docs `sessions.md`. | AH-CLI: hardened sharing and privacy warning are delivered, but no equivalent destination setting exists in the inspected schema. Decide permitted AiHarness destinations, confirmation/auth/failure without unintended fallback, redacted content and tests without external uploads; do not introduce Radius by default. |
| A3-CLI-19 | PARTIAL / P0 | 1.2: `serializeConversation()` omits thinking from compaction/branch summaries/bug reports to avoid summarizing a context larger than the useful context. 1.1 adjusts the chars/token estimate. `packages/coding-agent/src/core/compaction/utils.ts`. | AH-COMPACT still copies canonical blocks into shared preparation; that does not mean every renderer sends them. Reconcile what each host actually serializes, reasoning/signature/private exclusions, text/tool/public-custom preservation and wire/output budgets. Do not change a global ratio to hide CLI-SES-07 or degrade atomic cuts. |
| A3-CLI-20 | PARTIAL / P1 | 1.0.1/1.1: unknown/delayed tool renderers, `durationMs` and `outputPad` in render context and events; 1.3: numeric-string/null read ranges. `packages/coding-agent/src/core/extensions/types.ts`, tool/export components. | AH-EXT/AH-TOOLS: persisted monotonic duration exists, but the full TUI renderer API remains open. Define fallback before MCP connection, validated range labels, identical reload/tree/export rendering and overlay identity; no arbitrary renderer execution in the browser. |

### 4.2 Pi Web 0.10.0 to 0.12.2 — 29 Reviews

| ID | Status / priority | Upstream change and reference | AiHarness finding and exit condition |
|---|---|---|---|
| A3-WEB-01 | ABSENT / P1 | Server-persisted pins/archive, cross-client revision, Undo, automatic return of an active family. `lib/session-ui-state*.ts`, `hooks/useSessionUiState.ts`, `app/api/sessions/ui-state/route.ts`. | AH-WEB/AH-SES: no server-side pin/archive contract in inspected surfaces. Add UI state separate from the journal, limits/locking/atomicity, family flags, authorized access, revisions/concurrency and canonical rollback; archiving must not move files or the active leaf. |
| A3-WEB-02 | PARTIAL / P1 | Virtualized tree, project groups, manual/touch-drag ordering, project aliases, pagination of 20, menus/keyboard/focus and per-project archive. `components/SessionTree.tsx`, `SidebarMenu.tsx`, `lib/session-tree.ts`, `hooks/useGroupDrag.ts`. | AH-WEB: project/worktree/search Sidebar exists, not this full contract. Deliver stable navigation, accessible reveal/focus, reduced-motion, unavailable storage, name collisions and large volumes; no collapse action may silently change cwd/session. |
| A3-WEB-03 | PARTIAL / P0 | Bulk project/archive deletion, running/awaiting-input guard, reparenting to the nearest retained ancestor, children before parents and per-ID results. `lib/session-delete.ts`, `app/api/sessions/delete/route.ts`. | AH-SES: confirmed deletion/cascade exists, not a qualified bulk equivalent. Test concurrent start after confirmation, rights on each session, partial deletion, selection changes during the request and orphaned UI state; never delete a run that has become active. |
| A3-WEB-04 | PARTIAL / P1 | Fork from row menu at the actually displayed leaf, independent copy without loading a runtime, including an active source, suffixed name and subagent/unsaved refusal. `lib/session-fork.ts`, `session-fork-name.ts`, fork route. | AH-SES: rich copies and “New from here” during a run are already delivered, with a stricter complete-tool-group policy. Add Sidebar/leaf/title/late-navigation journeys and evidence without provider/MCP/extension activity; do not adopt upstream copying of an incomplete tool group. |
| A3-WEB-05 | PARTIAL / P1 | Native session links, new-tab/project menu, downstream contextmenu hook; a missing-session link does not open a different session. `lib/session-links.ts`, `initial-navigation.ts`, `components/SessionSidebar.tsx`. | AH-WEB: React deep links exist. Verify Ctrl/Cmd/middle-click, subpath, no URL token, no implicit new session/prompt and no fallback to an unrequested conversation; define the downstream hook without granting backend authority. |
| A3-WEB-06 | PARTIAL / P1 | Project/worktree choice above an empty composer, transfer of draft/images/model/thinking, scoped defaults and focus after remount. `lib/new-session-context.ts`, `components/NewSessionContextBar.tsx`, `ProjectWorktreePicker.tsx`. | AH-WEB has drafts and workspace selection. Qualify explicit target changes without losing/duplicating a send, trust/default readback and no borrowed project-model selection; include images still being prepared, late requests and picker cancellation. |
| A3-WEB-07 | PARTIAL / P1 | Files under Sessions or in a tab, resizing, retained explorer and file tabs per project/worktree; late scroll reports directed to the old generation. `components/file-tab-state.ts`, `hooks/useFilesPlacement.ts`, `useResizablePanel.ts`. | AH-FILES: optional pane/current-file and per-workspace PTY are delivered; this is not a multi-project file-tab catalog. Define this preference, bounded memory without content/secrets, full retirement and focus when a control disappears; preserve existing lazy-asset guards. |
| A3-WEB-08 | PARTIAL / P0 | Reveal Git-ignored entries with a reason, refresh open folders on tools/focus, diff from the file's own repository and bare-worktree grouping. `lib/file-tree-visibility.ts`, `git-changes.ts`, `worktree.ts`, git diff route. | AH-FILES: Git visibility and force retry are delivered; client `showHidden` is insufficient if the server excluded entries. Qualify tracked files under ignored paths, read vs visibility actions, nested repos and no execution of `core.fsmonitor`, symlink/UNC/Windows. WEB-FILE-06 remains a decision, never authorization through MCP/codemode text. |
| A3-WEB-09 | PARTIAL / P1 | Attach-any-file button and chat/explorer drop into the exact subfolder; images attached, others uploaded + mentioned, explicit skip vs overwrite, errors retained. `lib/file-upload-client.ts`, `components/ChatWindow.tsx`, `FileExplorer.tsx`. | AH-FILES: collision/progress-aware uploads and composer images exist, but not the full targeted-drop chain. Use the single trust-gated writer, bound names/sizes, do not treat browser-machine paths as server paths and never replace without a choice; a “skipped” mention must visibly refer to the existing file. |
| A3-WEB-10 | PARTIAL / P2 | Virtualized CSV/TSV with quoting/multiline/BOM/delimiter and incomplete prefix; multi-chunk HTML, on-demand Prism languages, unclipped gutter and tabs. `lib/delimited-table.ts`, `components/DelimitedTable.tsx`, `FileViewer.tsx`, `lib/prism-languages.ts`. | AH-FILES: source/Markdown/media previews exist, not an equivalent CSV table. Define progressive reads and inert HTML/links, UTF-8/record boundaries, row/memory bounds, source fallback, scrolling and lazy loading without budget regression. |
| A3-WEB-11 | PARTIAL / P1 | Full skill instructions and relative Markdown references in the detail pane, without main-document navigation. `components/SkillsConfig.tsx`, `app/api/skills/content/route.ts`, `components/MarkdownBody.tsx`. | AH-SET has catalog/toggles/registry and shared Markdown. Verify trust-gated content reads, resolution relative to the declaring source, inert internal anchors, traversal/link refusal and no execution on GET; do not reimplement already qualified batches/frontmatter. |
| A3-WEB-12 | PARTIAL / P0 | Project overrides of user MCP servers, consistent read-only/exposure and less redundant detail; Pi 1.1/1.2 adaptations. `lib/mcp-override.ts`, `mcp-read-only-policy.ts`, `components/McpConfig.tsx`. | AH-MCP: selected detail, mutations/OAuth/locale are already delivered. Compose A3-CLI-02…04 on HTTP/UI with inherited/override provenance, fresh confirmation and DTO migration; do not load project bodies before trust merely to show targets. |
| A3-WEB-13 | PARTIAL / P1 | Discovery preserves capabilities/protocol and model order, deferred providers at `session_start`, shared runtime/bounded invalidation, Kimi quota and editable managed contextWindow. `lib/deferred-provider-models.ts`, `model-runtime.ts`, `model-discovery.ts`, `components/ModelContextWindow.tsx`. | AH-PROV: catalog/config/custom overrides and instance cache exist. Qualify deferred model availability at the very first prompt and fresh auth without reimporting extensions on each GET; honest context override/pruning/validation/readback/restart, non-secret quota and correct endpoint. No GET may gain new extension-execution authority. |
| A3-WEB-14 | PARTIAL / P0 | Child profiles with named skills, extension scope reapplied on reload/resume, late tools, `codemode: inherit/on/off`, `mcp: on/off` and resource snapshots. `lib/subagents.ts`, `subagent-skills.ts`, `subagent-runtime.ts`. | AH-SUB: tool/skill/extension allowlists and shared Core runtime exist; no profile-specific MCP/codemode switches in the inspected contract. Define child/resume resources without expansion, unsandboxed code factories, read-only/chat-only, model-only tools not exposed as nested tools and cwd-specific trust. |
| A3-WEB-15 | PARTIAL / P0 | Profile authority over thinking/turn limit/context, model with `:level` suffix, resume refusing creation overrides and `input_files` budget tied to child context before effects. `lib/subagent-input.ts`, `subagent-runtime.ts`. | AH-SUB: `StartSubagentRequest` contains task/provider/profile, not this input-file/isolation/resume contract. Qualify bounds on actually inherited context, known/unknown effective model and refusal before creation/processes; do not confuse current maxToolRounds with SDK wrap-up semantics. |
| A3-WEB-16 | PARTIAL / P0 | Worktree isolation and result reporting kept/removed/branch, refusal to resume a missing cwd; durable child even when stopped in queue/MCP, interrupted status after restart, once-consumed notification. `lib/subagent-runtime.ts`, `subagent-extension.ts`. | AH-SUB: persisted children and runs in bounded maps exist; inspected start uses the parent's cwd, without equivalent worktree isolation. Define durable run journal + ID-based retrieval, stop/crash/restart effects, no recreation of a deleted cwd or implicit forced deletion of changes. |
| A3-WEB-17 | PARTIAL / P1 | Read-only child view in a tab without starting/retaining a runtime, per-agent time/token/cost stats and unduplicated family total. `components/SubagentViewer.tsx`, `components/subagent-viewer-state.ts`, sessions stats route. | AH-SUB/AH-WEB: panel and monitor exist. Add read-only projection, visibility/bounds/pagination-aware polling, project epochs, unknown/partial costs and separate parent/child accounting; opening the view must neither prompt nor connect MCP. |
| A3-WEB-18 | PARTIAL / P1 | Extension status command buttons, shelf widgets, resizable custom panels/dialogs and retained terminal QR. `components/ExtensionStatusBar.tsx`, `ExtensionWidgets.tsx`, `lib/extension-dialog-fit.ts`. | AH-EXT: native declarative Web UI and queue are delivered, not upstream executable components. Define typed/authorized command intent, busy disabling, restoration/revocation and bounded width; never infer an executable command from arbitrary text/ANSI or deliver extension HTML/React. |
| A3-WEB-19 | PARTIAL / P1 | Invisible custom `display:false`, collapsible custom/compaction headers, subagent completion as turn anchor, Process open without a real reply, dismissible error and Stop→Compact double-click guard. `lib/message-display.ts`, `components/MessageView.tsx`, `ChatInput.tsx`. | AH-STREAM: Process/length-stop/phase/dialogs are qualified under the native contract. Add these distinct rendering/context checks, display-flag persistence and model-content preservation; test error/empty endings, keyboard vs pointer and no unintended compaction after Stop. |
| A3-WEB-20 | PARTIAL / P1 | Streaming rerenders only the reply, block-based Markdown, chunked thinking, stable live→entry keys, duplicate-free cursor pagination, minimap numbering from the start + preview lock, iterative very-deep export; provider signatures omitted from browser copies, retained for continuation/export. `lib/message-keys.ts`, `lib/message-signatures.ts`, `markdown-blocks.ts`, `streaming-message.ts`, `components/ChatMinimap.tsx`. | AH-STREAM/AH-WEB: groups/replay and loaded windows exist; former checks do not qualify these optimizations. Measure long scripts/thinking/media, preserved DOM state/scroll/focus, late pages/fork/cold reload and memory; project history/tree/SSE without signatures or mutation of originals, preserve context and private exports, Markdown semantics and full fallback if chunking fails. |
| A3-WEB-21 | PARTIAL / P1 | 0.12.2: Pi cache-miss/warming/compaction/summary-cost and thinking-drop notices, derived without duplicate display; corrected turn duration/tokens per second. `lib/transcript-notices-server.ts`, `turn-duration.ts`, `stream-token-rate.ts`. | AH-PROV/AH-STREAM: usage/cache/nested accounting exist; `showCacheMissNotices`/`cacheWarming` are declared in settings, with no operational consumer found outside the schema. Add authoritative per-branch calculation, effective setting, incomplete costs, once-only replay and browser/server clock separation; notices and warming are distinct capabilities. |
| A3-WEB-22 | PARTIAL / P1 | Portrait Termux extra keys, one-shot CTRL/ALT, keyboard that does not close xterm and independent terminal theme applied to the live PTY. `components/TerminalExtraKeys.tsx`, `hooks/useTerminalTheme.ts`, `lib/terminal-extra-keys.ts`. | AH-WEB: per-workspace xterm/replay exists, with a fixed dark palette in `TerminalSurface`. Add touch UI/cursor modes, disabled input/connection handling, no PTY remount on theme change; physical mobile validation is distinct from Chromium viewport tests and WEB-CHAT-11. |
| A3-WEB-23 | PARTIAL / P2 | Customizable font families/fonts/weights and swatch-based palettes, code colors preserved across switches, preferences with blocked storage. `lib/font-preferences.ts`, `hooks/useFontPreferences.ts`, `lib/theme.ts`. | AH-WEB: v4 preferences, system/light/dark/mist/rose/pine themes and size exist. Decide palette/font expansion, CSS validation and bounded migration; contrast/axe, EN/FR, source/code and coarse controls without mandatory network fonts. Do not copy theme names as a visual-parity requirement. |
| A3-WEB-24 | PARTIAL / P2 | `version/status/stop/open/update --check` commands, server/probe records, exact instance, extension liveness registry and bounded shutdown. `bin/pi-web-commands.js`, `run-records.js`, `pi-web-update.js`, `lib/rpc-manager.ts`. | AH-OPS: launcher parses startup flags only; HTTP update status and closer exist. Define AiHarness commands/install mode/confirmation, private tamper-resistant record, stop without targeting a foreign PID, no update on a simple GET; liveness must block neither explicit Stop nor shutdown. |
| A3-WEB-25 | TO BE DEFINED / P0 | Runtime PWA name `PI_WEB_APP_NAME`, service worker not waiting for cache writes, preview-secret rotation at startup to avoid proxy bypass. `app/manifest.ts`, `public/sw.js`, `bin/rotate-preview-secrets.js`. | AH-OPS: static manifest and cookie/Bearer/Origin security, not the same Next proxy or preview mode. Decide whether runtime naming/preview is needed, then check AiHarness-specific flows: private caches/auth/logout/upgrade and origins. Do not declare the upstream bypass an AiHarness vulnerability or add an unnecessary “preview mode.” |
| A3-WEB-26 | PARTIAL / P1 | Awaiting-input visible on a background session; notification/sound/push never reports “completed” for aborted runs, AudioContext suspended outside use and mobile unlock. `hooks/useAudio.ts`, `lib/browser-notifications.ts`, `web-push.ts`, agent running route. | AH-WEB/AH-STREAM: attention/notifications/push and statuses exist. Verify cancellation vs error vs success, one attention per new request, multiple tabs/permissions/background, no late chime on return; real-phone evidence for audio/energy policy. |
| A3-WEB-27 | PARTIAL / P1 | External session creation/deletion discovery without refresh; incremental append-tail scan with inode/header/rewrite invalidation, lean lists and one rebuild per run end/name change after a run. `lib/session-list-scanner.ts`, `session-reader.ts`, `rpc-manager.ts`. | AH-SES: metadata lists/pagination/search and title SSE lifetime are accepted, without qualification of this index. Measure journals at AiHarness limits, updates by another process, same-size rewrites and partial appends, permissions/redaction/bounded caches; do not import upstream limits or index approximations that would miss a rewrite. |
| A3-WEB-28 | PARTIAL / P0 | Two-second connect timeout, effective Web `httpIdleTimeoutMs` and HTTP proxy preserving CONNECT to apply the timeout. `lib/http-dispatcher.ts`, `instrumentation-node.ts`. | AH-PROV: Core network/proxy/deadline policy exists, with a different architecture. HTTP/HTTPS/proxy/NO_PROXY tests, header/body stalls, abort and proxy secrets, on CLI and Server; do not copy the two-second value without an AiHarness policy decision and slow fixtures. |
| A3-WEB-29 | PARTIAL / P0 | Tests refocused on behavior, performance/lazy assets, updated demo, localized copy and new responsive surfaces. `e2e/`, `demo/`, `*.test.mjs` tests, `lib/i18n/messages`. | AH-OPS: nine-suite runner, four CI partitions and synthetic demo are delivered. New CLI/Core unit/public gates pass; child-termination receipts have 19 direct dispatcher controls, fresh typecheck/full 5,090 tests and complete local E2E 570/570 passing. Both previous E2E failures remain unexplained (§9.2), and the default production build FAILED with native Server compiler abort/134. [Scope and limits](./acceptance/e2e-termination-evidence.md); no release/remote/physical qualification. Each remaining addition needs appropriate negative/live/public/installed tests and EN/FR visuals. Reconcile discovered suites with complete commands, never select green cases from a failed configuration or grant fixtures backend authority. |

### 4.3 What Must Not Be Blindly Reimplemented

- Internal Pi/Next dependency/framework changes, removal of unpublished experimental packages and upstream benchmark figures are not AiHarness architecture obligations.
- OAuth callbacks, keyboard/theme schemas, settings navigation/trust/focus, rich copies, MCP runtime, deferred search, QuickJS, shared Markdown, demo and localizations already have acceptances. Additions require **delta reconciliation** and new negative tests, not a second engine.
- `parseResourceCommandLine()` already preserves empty arguments; codemode already awaits worker termination before decrementing; tool accounting already uses monotonic durations. None of these upstream fixes is declared an AiHarness defect without causal checks.
- AiHarness's MCP exposure default remains `direct`, its SDK performs no implicit discovery/executable/auth loading, and linked access outside roots remains limited descriptive consent. Upstream defaults and expansions do not replace these rules.
- Browser interfaces remain declarative/text-only; receiving provider signatures, scripts, filenames or a status does not grant execution authority.

## 5. AiHarness Evidence and Owner Register

Paths are relative to the AiHarness root. The register combines original owners and subsequently delivered subsets; presence alone does not assert execution. Use §9 and its linked records for current runs, and AUDIT-2 for historical results.

| Reference | Inspected implementations/contracts or identified owners | Retained checks and limitations |
|---|---|---|
| AH-CLI | `packages/cli/src/index.ts`, `packages/cli/src/commands/handler.ts`, `packages/cli/src/cli/` | Real dispatch, print/json/interactive, help/hotkeys/standalone; [privacy](./acceptance/cli-security-warnings.md), [startup](./acceptance/startup-credential-authority.md); [output-limit completion](./acceptance/print-output-limits.md), `7174970` |
| AH-TUI | `packages/cli/src/tui/{terminal-ui,fullscreen-ui,fullscreen-input,terminal-escape}.ts`, `packages/cli/src/utils/{keybinding-manager,terminal-actions,hotkey-view}.ts`, `packages/cli/schemas/` | [22 actions and schemas](./acceptance/terminal-keybindings.md); keyboard delivered, not certification of all capabilities/physical terminals |
| AH-RPC | `packages/cli/src/rpc/{rpc-server,rpc-controller,rpc-extension-ui}.ts`, `packages/cli/src/cli/json-output.ts`, `tests/functional-parity/` | [RPC UI](./acceptance/rpc-extension-ui.md), goldens/installed consumers; does not prove all races/platforms |
| AH-PROV | `packages/core/src/providers/{index,tool-arguments,model-catalog,model-metadata,specialized-models,provider-network}.ts`, `packages/core/src/agent/provider-turn.ts`, `packages/server/src/runtime/{model-catalog,provider-registry,provider-administration}.ts` | Existing model/length/specialized/network controls; [adaptive](./acceptance/anthropic-adaptive.md), [budgets](./acceptance/thinking-budgets.md), [offline](./acceptance/offline-startup.md); [final JSON](./acceptance/final-tool-json.md), `81129d5`; [mixed order WIP](./acceptance/mixed-delta-order.md). Remaining provider clauses stay open |
| AH-CFG | `packages/core/src/config/agent-settings.ts`, `packages/core/src/resources/{resource-manager,file-selectors}.ts`, `packages/core/src/themes/theme-manager.ts` | Schema acceptance of `showCacheMissNotices`/`cacheWarming` does not prove runtime effect; [selectors](./acceptance/literal-absolute-resource-roots.md), [discovery](./acceptance/markdown-discovery-policy.md) |
| AH-SES | `packages/core/src/sessions/{session-manager,session-context,serialization,session-accounting}.ts`, `packages/cli/src/sessions/startup-session.ts`, `packages/server/src/api/{session-pagination,session-copy-request}.ts` | [Startup copies](./acceptance/startup-fork-state.md), [branches](./acceptance/session-branching-lifecycle.md), [stats](./acceptance/session-statistics.md); independent of new archive/index flags |
| AH-COMPACT | `packages/core/src/sessions/{compaction-model-messages,compaction-generation,compaction-preparation}.ts`, `packages/core/src/agent/{provider-request-estimate,provider-request-payload}.ts`, `packages/server/src/api/{agent-routes,proxy}.ts` | [Source](./acceptance/manual-compaction-source-lifetimes.md), [preparation](./acceptance/compaction-model-preparation.md), [generation](./acceptance/compaction-generation.md), [HTTP](./acceptance/http-compaction-lifetimes.md), [ordinary admission](./acceptance/provider-request-admission.md); these records do not close CLI-SES-07 |
| AH-TOOLS | `packages/core/src/tools/{tool-selection,tool-search,codemode,codemode-worker,workspace-tools}.ts`, `packages/core/src/agent/tool-loop.ts` | `codemode.test.ts`, `tool-selection.test.ts`, `packages/core/src/providers/specialized-models.test.ts`; exact selection, global sandbox limit 8, termination awaited; MCP binary content deliberately omitted |
| AH-MCP | `packages/core/src/mcp/{config-inventory,session-host,server-test,oauth,oauth-flow,oauth-fetch}.ts`, `packages/server/src/api/mcp-routes.ts`, `packages/web/src/components/McpSettings.tsx` | `oauth-integration.test.ts`, `server-test.test.ts`, [selected detail](./acceptance/mcp-selected-detail.md); mandatory runtime config target, exact exposure, Test explicitly distinct from a prompt |
| AH-EXT | `packages/core/src/extensions/extension-registry.ts`, `packages/core/src/agent/runtime.ts`, `packages/core/src/sdk/agent-session.ts`, `packages/web/src/components/ExtensionInteractionDialog.tsx` | [Full loader](./acceptance/module-entry-resolution.md), [state](./acceptance/extension-session-state.md), [detached](./acceptance/detached-web.md); awaiting the hook before run publication requires review |
| AH-FILES | `packages/server/src/api/{file-routes,workspace-routes,workspace-file-manager}.ts`, `packages/web/src/components/{WorkspacePanel,WorkspacePanelBoundary}.tsx`, `packages/web/src/services/api.ts` | `e2e/live-server.spec.ts`, `e2e/workspace-asset-load.spec.ts`, `e2e/pane-lifetime.spec.ts`; roots/trust/linked consent are not an allowlist derived from an arbitrary transcript |
| AH-SUB | `packages/server/src/runtime/{subagent-service,subagent-runtime}.ts`, `packages/server/src/api/subagent-routes.ts`, `packages/web/src/components/{SubagentPanel,SubagentMonitor,SubagentSettings}.tsx` | `subagent-service.test.ts`, `subagent-runtime.test.ts`; AiHarness JSON profile, existing maxTurns/allowlists, process-local runs and child initially in parent's cwd |
| AH-WEB | `packages/web/src/App.tsx`, `packages/web/src/components/{Sidebar,ChatView,TerminalPanel}.tsx`, `packages/web/src/store/{session-store,preferences}.ts`, `packages/web/src/hooks/useMobileKeyboard.ts` | Per-workspace UI, v4 preferences, modal/Escape and controlled detector accepted; new pin/archive, light xterm/keys and physical devices not qualified |
| AH-STREAM | `packages/core/src/agent/events.ts`, `packages/server/src/api/{sse-channel,agent-event-policy}.ts`, `packages/web/src/components/ProcessBlock.tsx`, `packages/web/src/components/process-turns.ts`, `packages/web/src/services/api.ts` | [Detached contracts](./acceptance/detached-web.md); running progress is process-local, no inferred persistence of every update |
| AH-SET | `packages/web/src/components/{SettingsView,EcosystemSettings,McpSettings}.tsx`, `packages/web/src/store/{settings-navigation,mcp-selection}.ts` | [DEC-102 navigation](./acceptance/settings-navigation.md), [DEC-100 locale](./acceptance/settings-delta-localization.md); no complete cross-resource primitives |
| AH-OPS | `Makefile`, `.docker/`, `.docker/e2e-suites.mjs`, `.github/workflows/{ci,demo-pages}.yml`, `demo/`, `packages/server/src/{web-cli,web-cli-options}.ts`, `packages/server/src/runtime/app-update.ts` | Docker required for tests/types; remote publication unproven; [operator documentation](./acceptance/operator-architecture-documentation.md) already accepted |

### 5.1 Directly Corroborated Upstream Sources

In the installed CLI package, `dist/core/extensions/types.d.ts` declarations expose `aliases`, `reachesTools`, `structuredContent`. `dist/core/agent-session.js` also starts custom runs; `dist/core/compaction/utils.js::serializeConversation()` excludes thinking; `dist/core/settings-manager.js` reads/writes the share destination. The nested MCP package documents and checks `iss` in `dist/oauth/flow.js` and accepts arbitrary structured JSON in `dist/client.js`. The codemode host documents worker termination in `dist/runtime/host.js`.

The installed changelog explicitly separates versions `1.0.1`, `1.0.2`, `1.0.3`, `1.0.4`, `1.1.0`, `1.2.0`, `1.3.0`. Pinned Web sources and their associated tests corroborate the additions in §4.2. No upstream `main` state is used as an installed version.

**Example of documentary caution:** upstream `docs/agents/sessions.md` retains an old paragraph describing fallback for a missing link, then describes its repair further down. A3-WEB-05 uses the repaired contract and its `AppShell`/`initial-navigation` test, not the contradictory historical paragraph. Likewise, the “running turn elapsed” commit is clarified by current source policy, which avoids subtracting browser and server clocks; A3-WEB-21 requires that consistency, not a timer inferred solely from the commit title.

## 6. Recommended Order and Acceptance Criteria

### Batch 1 — Authority, Security and False Success (P0)

Current progress takes precedence over the original ordering: do not redo A3-CLI-13 or the committed final-JSON subset. Mixed-delta ordering is implemented in `ca8eb79`, with a later complete 570/570 local E2E pass. Earlier failures remain unexplained; the receipt correction preserves future native outcomes but cannot retrospectively diagnose them (§9.2). Default Node v26.12.0 production compilation failed natively; release qualification stays open. Pending product/security choices are listed in §9.3; no unanswered question is an approved requirement or accepted gap.

1. CLI-SES-07 and A3-CLI-12/19: prestart reservation, hooks and abort, effective model/budget, wire/media, physical settlement/accounting and useful overflow recovery.
2. A3-CLI-02/03/04/11: MCP overrides without copied secrets, issuer/cancelled refresh, remaining tool argument/schema/size admission, structured content, resources and selection without expansion.
3. CLI-SEC-06/EXT-07 and A3-CLI-05: descendants/disposers/physical worker exit; adversarial tests on the supported runtime, without claiming Bun is supported by AiHarness.
4. A3-WEB-03/12/14/15/16/25/28: bulk writes and child resources, missing cwd, scopes/trust, authenticated caches and proxy deadlines.

Review of WEB-FILE-06/WEB-SET-08 and every new grant precedes implementation: showing a target before trust does not authorize reading an arbitrary project body. Every intentional gap must become an explicit, dated, justified decision with a review trigger.

### Batch 2 — Models, Tools and Resources (P1)

Offline/key-scoped catalog, dialects/thinking/cache, CLI custom and specialized models; active tools/modifiers/resume; settings/models schemas, renderers and durations; subagent snapshots and read-only view. Replay existing acceptances (copies, privacy, trust, active/inactive, read-only) rather than reimplementing them.

### Batch 3 — Navigation and Experience (P1/P2)

Server-side pins/archive UI state; tree/menu/bulk; composer project/worktree and file tabs; upload/drop/previews; streaming/history performance; notices; mobile terminal and theme/font preferences; launcher commands and PWA customization only after a decision.

### Batch 4 — Integrated and External Qualification

For each row, map **every clause** to positive and negative evidence: owning code, source and actually emitted/installed tests where applicable, real HTTP/SSE, migrations/round-trip, accessibility and Light/Dark desktop/mobile visual tests, EN/FR documentation. Causal RED/GREEN checks when asserting a defect; no native diagnosis inferred from a green rerun.

| Surface changed in an implementation batch | Minimum gates, to run in Docker according to the project map |
|---|---|
| Documentation only | `make lint-docs`, exhaustive ID/link/version checks, `git diff --check` |
| Core/session/provider/extension | `make typecheck`, `make test`; public/SDK/installed consumers for affected contracts |
| CLI/TUI/RPC | Previous gates + `make test-parity`, real processes and PTYs; stdout/stderr/exit-code and shutdown evidence |
| Server/Web/cross-package streaming | `make typecheck`, `make test`, `make test-e2e`; live tests for what intercepts cannot prove |
| Packaging/launcher/assets/dependencies | Relevant previous gates + `make build-prod`, pack/install outside the checkout and asset verification |
| Publication or physical device | Exact remote/device evidence, recorded authorization and environment; no mock/Chromium test replaces these observations |

An entire failed configuration remains failed; do not select its passing cases. Qualify all nine E2E configurations and four CI partitions if used, without double-counting the same tests. Historical SIGSEGV/null/timeout failures and watchdog issues reported by AUDIT-2 remain facts of their own executions, **not a fresh health measurement from this session**. No push, Pages deployment or overall native success is established here.

## 7. Initial Documentation Audit Log and Checks — Historical

This section records initial drafting, not the current implementation checkpoint. Its original counts and statements about unexecuted product suites must not be read as current status; see §2 and §9.

### 7.1 Observations Actually Made

| Action | Result / scope |
|---|---|
| `git status --short`, `git rev-parse HEAD` before drafting | Clean working tree; base `0f5ebb89d1139946257eee88b61aea4927b49048` |
| Node parse of the AUDIT-2 matrix | 152 rows, 102 DONE / 50 PARTIAL; extraction of the 50 open identifiers and verification of CLI/Web separation |
| Reading three `package.json` files, `pi --version`, `pi-web version` | 1.3.0 / 0.12.2 / Web SDK 1.2.0; verified actually nested versions, not just declared ranges |
| Pi/Pi Web `git ls-remote` and Pi/Pi Web tag checkouts outside the repository | Commits and annotated tag in §1.2; no work on a moving upstream branch |
| `git diff --stat`, `--shortstat`, `v0.10.0..v0.12.2` history | Volumes in §1.2; delta families grouped in §4.2 |
| `npm view … gitHead dist.integrity --json` | Published metadata in §1.2; Web gitHead/tag divergence explained by the exact diff of the two commits |
| Source/test reads and searches | Register in §5; confirmed distinctions: empty arguments retained, worker exit awaited, exact exposure config, text classifier, child runtime without worktree isolation, print length persisted without exit-code evidence |
| Docker available | Docker Server 29.4.1 observed; no environmental impossibility invoked to avoid product tests, which are simply outside documentation scope |
| Product suites | **Not rerun**: `make typecheck`, `make test`, `make test-parity`, `make test-e2e`, `make build-prod`; no new qualification result claimed |

The editorial checks `make lint-docs`, identifier-set equality, evidence-path existence and `git diff --check` are recorded after execution in the summary below. The audit directory has a local `.gitignore` containing `*`: the new file must explicitly be made visible to Git so it is not omitted from documentation checks; no other ignored files should be added.

### 7.2 Request → Artifact Checklist

| Request success criterion | Evidence to check in this deliverable |
|---|---|
| New `docs/audit/pi/AUDIT-3.md` | This file, in English, separate from AUDIT-2; documentation-only change |
| Carry forward unfinished work | §3: exactly the 50 PARTIAL IDs from the current matrix, without duplication/omission; boundaries and already delivered subsets explicitly preserved |
| Do not repeat completed work | 102 DONE criteria not placed back in the inherited backlog; DEC-92…102 examples and guard against upstream fixes already present (§3, §4.3) |
| Incorporate the latest installed changes | §1.2 and §4: CLI 1.3.0, Web 0.12.2, embedded Pi 1.2.0; immutable references, CLI/Web version differences and npm/tag divergence documented; 49 reviews compared with current source |
| Actionable audit, not just a changelog | Priorities, statuses, AH owners, exit conditions, dependencies/batches and gates in §2…6 |
| Verifiable conclusions | Register in §5 and commands actually run in §7.1; explicit observation limits and unexecuted tests |
| Do not confuse document completion with product completion | At initial establishment: **99 open entries**; current checkpoint in §2/§9: **98 open / 1 closed**, still no full parity, migration, deployment or overall health |

### 7.3 Initial Editorial Check Results

Checks successfully executed when creating the document on October 18, 2026, before the administrative closure of AUDIT-2 described in §8:

- Node documentation check (`/tmp/aih-audit3-document-check.mjs`, outside the repository): 152 unique historical IDs; **50/50 PARTIAL carried forward in exact order**, 39 CLI + 11 Web, no DONE carried forward; 49 unique sequential new IDs, 20 CLI + 29 Web, 45 PARTIAL / 2 ABSENT / 2 TO BE DEFINED. Valid priority/owner references and table structure.
- **191 literal path occurrences**, after brace expansion, exist in AiHarness or the appropriate pinned upstream checkout; 16 AH owners resolved. This checks existence, not semantics by itself: source findings and limits are reviewed in §3…5.
- `make lint-docs`: **135 Markdown files, 1,108 local links**, zero link/anchor/versioning-boundary violations. The new document is included despite the directory's local filter.
- `git diff --check`: passed, no whitespace errors.
- At this initial stage, byte-for-byte comparison of AUDIT-2 against HEAD: identical. `git diff --stat` / `git status --short`: **one new file only, AUDIT-3.md**; no product code or generated artifacts changed, no commit made.

**Conclusion of the §7.2 checklist: documentation deliverable completed.** The new-audit request is satisfied; the product backlog remains open. Product tests/type checks/builds and physical/remote observations explicitly remain unexecuted in this work, without preventing delivery of this documentation audit.

## 8. Administrative Closure of AUDIT-2 — October 18, 2026

Following user confirmation, AUDIT-2 is **ARCHIVED — superseded by AUDIT-3**. Its 102 DONE criteria remain accepted within their historical scope, and its 50 PARTIAL criteria are transferred without changing identifiers or statuses. This is neither functional completion nor acceptance of the remaining gaps.

AUDIT-3 is now **the sole active tracking document** for the 50 inherited criteria and 49 delta reviews. AUDIT-2 and its evidence records remain available as read-only references for full wording, decisions, evidence and failures; they will no longer receive a parallel development journal.

Preservation check passed: only AUDIT-2's opening banner is replaced; the DEC-102 checkpoint and all subsequent historical content, including the 152 matrix rows, are preserved identically. The Node comparison confirms 50/50 PARTIAL transferred in order, 49 reviews retained and only the two documents changed. `make lint-docs` passes on 135 files and 1,110 local links; `git diff --check` also passes. No product suite is rerun during this archival step.

## 9. Current Implementation Journal — 2026-10-18

This is the live delivery checkpoint. §7/§8 remain historical, and supporting acceptance files do not replace updates to this document. The reconciliation in `e939b2b` was documentation-only. Product work subsequently resumed; later journal entries distinguish partial code delivery from integrated acceptance.

### 9.1 Delivery and Verification

This table retains the `e939b2b` reconciliation checkpoint. Later entries in §9.6 supersede only the stated current scope/results, without erasing these historical failures or WIP states.

| Date | ID(s) | Old → New | Evidence | Validation | Notes/decision |
|---|---|---|---|---|---|
| 2026-10-18 | All 50 inherited IDs in §3; A3-CLI-01…A3-CLI-20; A3-WEB-01…A3-WEB-29 | Initial import: 95 PARTIAL / 2 ABSENT / 2 TO BE DEFINED | Exact historical matrix and initial source comparison, §1…§8 | Initial editorial checks in §7.3/§8; no product rerun at import | Establishes every entry's baseline; later rows supersede only the stated subset/status. |
| 2026-10-18 | A3-CLI-13 | PARTIAL → **DONE** | `7174970`; `packages/cli/src/index.ts`, `packages/cli/src/cli/json-output.ts`, emitted `length-stop-process.test.ts`/probe, installed consumer; [complete clause mapping](./acceptance/print-output-limits.md) | Docker typecheck; focused 24/24; parity 81/81; full 335 files / 4,898 tests; docs/whitespace passed | Partial/empty/ordinary controls, exact stdout/stderr/exit, multiple prompts, usage/history and RPC reuse qualify this CLI-only scope. No inherited automation/session criterion or browser/release closure. |
| 2026-10-18 | A3-CLI-11 | PARTIAL → PARTIAL; final textual JSON subset committed | `81129d5`; Core `providers/tool-arguments.ts`, `providers/index.ts`, `agent/provider-turn.ts`; real HTTP/SSE/WebSocket, emitted CLI and installed SDK/bin tests; [clause mapping](./acceptance/final-tool-json.md) | RED 25 failed / 31 controls passed; Docker typecheck; focused 101/101; parity 105/105; full 338 files / 5,021 tests; **E2E FAILED: 569 passed / 1 page crash**, all nine configurations completed | No malformed batch tool execution/hooks or ordinary-turn retry. Empty/valid JSON ABI retained. Integrated qualification and every remaining review clause stay open. |
| 2026-10-18 | A3-CLI-11 | PARTIAL → PARTIAL; mixed-delta ordering **uncommitted WIP** on `81129d5` | Six source/test files pinned below; [ordering clause mapping](./acceptance/mixed-delta-order.md); maintainer/user docs in working tree | RED 20 failed / 25 controls passed; Docker typecheck; focused 119/119; parity 117/117; full 340 files / **5,090 tests**; **E2E FAILED**, §9.2 | Reasoning first only within a mixed native delta/shared callback; distinct event order and independent redaction buffers unchanged. No commit or integrated acceptance is claimed for this patch. |
| 2026-10-18 | WEB-OPS-04; A3-WEB-29 | PARTIAL → PARTIAL | Both complete E2E command attempts, preserved aggregate/report/log evidence in §9.2 | First runner: one failed configuration. Latest runner: eight failed application configurations / demo passed | Passing unit/public/demo results do not close integrated/release qualification. No crash/startup root cause is established and no assertion/budget/retry/ownership bypass is introduced. |

The ordering source/test snapshot captured while uncommitted at reconciliation was SHA-256 matched against both `aih-a3-mixed-delta:parity` and `aih-a3-mixed-delta:full`; the included SDK README was hashed separately. Its exact executable scope is:

```text
b59f0fee513f46b5e26be3f23c5055d0accd2743c6a1f52bccd9d8a3e24a56e7  packages/core/src/providers/index.ts
f5c9fde861f1a9abc1f98fe988be76c3fe75ef32df3d02232a81616b50c27beb  packages/core/src/agent/provider-turn.ts
e2ca1089c0e8ccc9eb5e3781d103f3f6256981e84f0b54358c1f4dc0020a2d19  packages/core/src/providers/mixed-delta-order.test.ts
a0089dca10f2c7164dbb3ed7711305d61d6d80c8053e1e4e008400624d3ee1e2  packages/cli/src/cli/fixtures/mixed-delta-probe.mjs
ed4a4dca1062b5c37c86c568aba14e12042e98dec959481b1544e557e635aeea  packages/cli/src/cli/mixed-delta-process.test.ts
1488ef469131a18c9e8428cf192471391888a54e769acf851f8a90ca210a44cf  tests/functional-parity/installed-executable.test.ts
```

The first two product commits excluded the then-draft audit documents. The reconciliation records those advances in the active tracker; subsequent increments maintain it together with the code rather than continuing a disconnected sidecar-only history. AUDIT-2's existing archival banner is retained without altering its historical body.

### 9.2 Integrated Failures — Still Open

| Snapshot / executed command | Actual result | Preserved evidence / limitation |
|---|---|---|
| Final-JSON increment; `make test-e2e IMAGE_TEST=aih-a3-tool-json:e2e` | Make exit 2 / runner status 1; 569 passing / 1 failing test; all nine configurations completed. `interactions` fails at `interaction-single-asset-load.spec.ts:112`: `page.goto: Page crashed`, before the terminal/focus assertions | [Full per-configuration counts](./acceptance/final-tool-json.md#integrated-e2e--failed-not-waived); aggregate, failed context and HTML report copied to `/tmp/aih-a3-tool-json-e2e-artifacts/`; original log `/tmp/aih-a3-tool-json-e2e.log`. Chromium 154.0.8037.92 / Debian 12; no causal diagnosis or waiver |
| Uncommitted ordering snapshot; `make test-e2e IMAGE_TEST=aih-a3-mixed-delta:e2e` | Make exit 2 / runner status 1. `standard` fails before announcing test execution; the seven subsequent application configurations refuse occupied health URLs at 3099 or 3080. Only `demo` reports executed tests: 8 passed. **Eight failed configurations, not 562 passing application tests** | The original aggregate, archived under `/tmp/aih-a3-mixed-delta-e2e-artifacts/`, records status 1 for standard/interactions/locale/workspace/pane/linked/title/progress and 0 for demo. `/tmp/aih-a3-mixed-delta-e2e.log` retains startup and occupied-URL messages. Standard's termination cause and remaining server ownership are not established; no causal repair is inferred from a later pass |
| Receipt increment, unchanged product `ca8eb79`; `make test-e2e IMAGE_TEST=aih-a3-e2e-exit:e2e` | **Make exit 0 / runner status 0; 570/570 pass**, all nine configurations: standard 387, interactions 69, locale 8, workspace 11, pane 18, linked 43, title 2, progress 24, demo 8 | Current `test-results/e2e-suites.json`: every command status 0 / code 0 / signal null. [Frozen input/receipt proof and complete limits](./acceptance/e2e-termination-evidence.md); log `/tmp/aih-a3-e2e-exit-e2e.log`. This is current local integration evidence, not a diagnosis or replacement of either older failure. Production build still failed natively (§9.6) |

Source inspection on 2026-10-18 identified an evidence limitation in the failed snapshots' `execute` in `.docker/e2e-suites.mjs`: it reduced termination to a number (`code`, 130 for SIGINT, otherwise 1) without preserving the signal or spawn outcome in the aggregate. Therefore the silent `standard` failure cannot currently be distinguished from a signalled exit using that report alone. This is not a diagnosis of the original failure. The receipt correction in this increment retains actual child termination in direct process tests; fresh-image typecheck, full 5,090 tests and complete 570/570 local E2E pass. The required production build failed with a native Server compiler abort (§9.6). This is not a retrospective diagnosis; do not change browser flags, timeouts or server reuse to make the failure disappear.

All three commands used the owned complete runner, one worker and zero retries. Neither passing demo/bundle checks nor a future passing run alone diagnoses these failures. AUDIT-2's earlier native/canonical failures also remain historical failed evidence. Production deployment, remote publication and physical-device qualification have not been performed by these increments.

### 9.3 Pending User Decisions

These questions were raised but have no recorded approval. Existing criterion statuses remain unchanged; no default choice or GAP ACCEPTED is inferred. Resume each affected policy scope only after an explicit answer.

| Decision / affected ID | Clarification required |
|---|---|
| `WEB-FILE-06` | Confirm that session content never grants new access and only explicit roots/consents determine permissions |
| `WEB-SET-08` | Keep metadata-only MCP display before approval, or add distinct explicit consent for a bounded content preview? |
| `A3-CLI-17` | Add Nix/managed installer/update distribution, or retain npm/Docker as the supported distribution scope? |
| `A3-CLI-18` | Which sharing destinations beyond the existing server are authorized; is Gist desired? No Radius or unintended fallback by default |
| `A3-WEB-25` | Is runtime-configurable PWA naming required? Do not add a preview mode merely to copy an upstream architecture |

Other rows that require product definitions remain open as written; this list is not a claim that every later ambiguity has been resolved.

### 9.4 Mandatory Ongoing Maintenance

At **every advance**, including a partial implementation, decision, validation failure or discovered limitation:

1. Update the affected current finding/remaining clauses in §3/§4 and its evidence/commit or explicit uncommitted scope.
2. Append a dated six-column journal entry here; supporting acceptance records supplement, never replace, this tracker.
3. Recalculate §2 and the banner when a criterion changes status. A qualified subset alone does not close its whole criterion or linked inherited requirements.
4. Record actual commands/results and preserve failed aggregates; distinguish committed code from work in progress and questions from approved decisions.
5. Include the tracker update with the corresponding committed increment; refresh it before reporting interim progress even when code is not ready to commit. Before resuming implementation after an interruption, reconcile this checkpoint with the working tree.
6. Validate identifier/count consistency, local links/versioning boundaries and whitespace. Preserve AUDIT-2 as historical, rather than restarting a parallel journal there.

### 9.5 Reconciliation Verification — 2026-10-18

- `node /tmp/aih-audit3-progress-check.mjs`: passed. AUDIT-2's historical body and 152 matrix rows remain unchanged; 50/50 inherited IDs retain exact order, 49 new IDs retain their sequences, all 99 have baseline journal coverage, and the seven current status totals reconcile. Only A3-CLI-13 is DONE. Both recorded product commits exist; all six uncommitted source/test hashes match. Six-column journal structure, 16 owners and 195 expanded literal path occurrences validate.
- `make lint-docs`: passed, **138 Markdown files / 1,122 local links**, no link/anchor/versioning-boundary violations.
- `git diff --check` and `git diff --cached --check`: passed. This reconciliation changes tracking/evidence documentation only; it does not commit or alter the pending product patch and does not rerun product gates. Their actual results remain recorded above.

### 9.6 Post-Reconciliation Increments — 2026-10-18

| Date | ID(s) | Old → New | Evidence | Validation | Notes/decision |
|---|---|---|---|---|---|
| 2026-10-18 | A3-CLI-11 | PARTIAL → PARTIAL; ordering code delivered in `ca8eb79`, parent `e939b2b` | The same six frozen source/test hashes above; [ordering checklist](./acceptance/mixed-delta-order.md); native/shared order fixes, emitted and installed probes, EN/FR/maintainer docs | Already executed frozen-candidate typecheck, 119 focused, 117 parity and full 5,090 tests pass; E2E remains FAILED as recorded in §9.2. No passing rerun is substituted | This commits a limited implementation, not integrated acceptance or whole-review completion. Other clauses stay open; the code is no longer an uncommitted promise. |
| 2026-10-18 | WEB-OPS-04; A3-WEB-29 | PARTIAL → PARTIAL; evidence limitation identified | `execute` in `.docker/e2e-suites.mjs` and declarations/tests inspected | Source inspection only: child signal/spawn details are discarded; no new process outcome or root cause is inferred | Preserve native termination receipt before further diagnosis. No runner/process/browser policy change is included in the ordering increment. |
| 2026-10-18 | WEB-OPS-04; A3-WEB-29 | PARTIAL → PARTIAL; dispatcher receipt correction included with this journal increment, parent `ca8eb79` | `.docker/e2e-suites.{mjs,d.mts,test.mjs}`, canonical validation guidance; [direct process evidence](./acceptance/e2e-termination-evidence.md) | Causal actual-dispatcher RED: 4 failed / 13 controls passed. Overlay GREEN: 19/19 passed, including actual self-SIGTERM/self-SIGINT, normal exit 7/0 and missing executable. Fresh-image typecheck passed, including 19/19 controls in the filtered build context; three code/declaration hashes and included SDK README match the full-test and actual E2E images; all six frozen ordering inputs also match the E2E container. Full root passed: 340 files / 5,090 tests. Build-prod FAILED: default Node 26 Server `tsc` native zone-allocation error, abort/exit 134 (Make 2); no final production image. Exact-base inventory records Node v26.12.0 / V8 14.6.202.34-node.39 / Linux x64 (linked evidence); no rebuild/cause inferred. Complete E2E passed: 570/570 across all nine configurations, Make/runner status 0; raw code 0 / signal null for every command | Preserve numeric aggregation plus raw child code/signal and safe spawn code; no args/env/path/error-message leak, retry/filter/budget/reuse/kill change. Both earlier failed aggregates archived before replacement. No original crash/startup diagnosis is claimed. |
| 2026-10-18 | A3-CLI-11; WEB-OPS-04; A3-WEB-29 | PARTIAL → PARTIAL; latest local aggregate settled, prior evidence retained | Current nine-command aggregate; same six ordering hashes and three receipt hashes; [complete counts, sources and failure boundaries](./acceptance/e2e-termination-evidence.md); both subset records reconciled | Fresh-image typecheck, 19 dispatcher controls, full 340 files / 5,090 tests, complete local E2E 570/570 pass; **production build FAILED**, Server native abort/134 on Node v26.12.0. No source/flag/budget/retry/baseline change during qualification | Current integration is green, not the historical runs or release qualification. No criterion status changes: 1 DONE / 94 PARTIAL / 2 ABSENT / 2 TO BE DEFINED, 98 open. Remaining clauses, policy decisions, remote and physical evidence stay open. |

Delivery checks for the receipt increment: identifier/order/count/owner/journal and AUDIT-2 historical-body checks passed; three receipt inputs, six ordering inputs and the separately included SDK README still match their frozen manifests. `make lint-docs`: **139 Markdown files / 1,133 local links**, passed. Working/staged whitespace checks passed. Root documentation is outside the Docker context; no executable input changed during these final tracking updates.
