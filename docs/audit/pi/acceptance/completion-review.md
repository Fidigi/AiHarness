# AUDIT-2 completion review — 2026-10-13

**Result: not complete.** Passing the current integration gates cannot close missing capabilities.

## User request translated into deliverables

1. Finish the pending developments associated with [AUDIT-2](../AUDIT-2.md), preserving earlier accepted behavior and failures.
2. Implement every criterion in its two tracks: Pi CLI 1.0 functional/safety parity and the Pi Web 0.9.3 → 0.10 delta, using AiHarness-owned interfaces.
3. Retain associated tests and acceptance evidence; commit only qualified work. No remote push/deployment is inferred from permission to commit.

The canonical requirement-to-evidence mapping remains AUDIT-2 §3 (all 152 unique criterion IDs), §3.3 (named API/contract families), Annex A (owning artifacts) and Annex C (remaining delivery batches). This review does not replace those requirements with a smaller manifest.

## Prompt-to-artifact checklist

| Deliverable | Inspected state | Result |
|---|---|---|
| Pending MCP lock correction | Commit `62c5d52`; [six-case acceptance checklist](./mcp-lock-handoff.md), real filesystem RED/GREEN control, integrated unit/type/lint proof | Qualified scoped maintenance |
| Pending RPC UI protocol/capabilities/replay/lifecycle | Commit `8524422`; [RPC acceptance checklist](./rpc-extension-ui.md), state tests, actual emitted process and external declaration consumer, EN/FR contracts | Qualified CLI-AUT-07 scope; not complete CLI-EXT-06 |
| Pending detached Web normalization/queue/stream/reply/process work | [Eight-criterion checklist and current gates](./detached-web.md); source inspection additionally found and corrected failure-time automatic compaction | All 533 final integrated browser cases pass, alongside 2,133 unit tests and 32 parity cases; qualified scoped delivery, not complete release acceptance |
| Discovered-file extension selectors | [Selector acceptance](./extension-selectors.md), Core bounded selection, CLI/RPC ordinary/contributed startup and genuine PTY reload, 41 new positive/negative cases and literal declaring-directory identity | Scoped CLI-CFG-09/CLI-EXT-01 progress; both remain PARTIAL. That batch's 2,174-unit/32-parity gates pass; preceding native/shell failures remain recorded |
| Numeric thinking budgets | [Budget acceptance](./thinking-budgets.md), per-turn Core ownership, CLI/RPC composition, real numeric HTTP payloads, genuine PTY refresh, public declarations and 47 new cases | Scoped CLI-MOD-07 progress; still PARTIAL. That batch's 2,221-unit/32-parity gates pass; an ESLint native SIGSEGV/139 remains unexplained despite later isolated passes |
| Published Anthropic adaptive request dialect | [Adaptive acceptance](./anthropic-adaptive.md): exact Sonnet 4.6 native effort/disabled, preserved defaults/caps and per-call model selection; 19 Core + 13 emitted built-in/HTTP/RPC cases | Scoped CLI-MOD-07 progress; still PARTIAL. Original control 29 failures/3 passes; current 102 focused, 2,253 units and 32 parity pass, with exact hashes and production smoke. Other profiles and signed thinking replay remain open |
| Entire audit implementation | Actual matrix parses as 152 unique rows: 88 DONE, 64 PARTIAL; no duplicate IDs | **Not achieved** |
| All named commands/gates | `make typecheck`, `make test`, `make test-parity`, `make build-prod`, Docker-only browser matrix, owning strict tests/lint, `make lint-docs`, `git diff --check`; individual results in each scoped acceptance record | Evidence only for their actual sources and covered contracts, not proof of all 152 requirements |
| Remote Pages publication and physical mobile equivalence | AUDIT-2 WEB-OPS-02/WEB-CHAT-11 explicitly retain missing remote/device proof | **Unverified; cannot close** |

The 88 DONE rows retain their preceding evidence; this continuation has not independently rerun every historical platform, provider or physical-device assertion. The already-open rows alone disprove full completion.

## Every remaining criterion

| Family | Open IDs | Remaining scope from the actual matrix |
|---|---|---|
| Invocation | CLI-RUN-02, CLI-RUN-06, CLI-RUN-07, CLI-RUN-08, CLI-RUN-10 | Renderer/input capability semantics, complete RPC/rebinding, remaining startup options, full session picker/cross-project lifecycle and interactive commands |
| Terminal | CLI-TUI-03, CLI-TUI-04, CLI-TUI-05, CLI-TUI-06, CLI-TUI-09, CLI-TUI-10 | Editor/IME/paste, attachment search/display, searchable selectors, collapsible feedback, mouse/scroll/image/capability behavior, full keybindings/hotkey UI |
| Models/auth/providers | CLI-MOD-01, CLI-MOD-02, CLI-MOD-03, CLI-MOD-04, CLI-MOD-05, CLI-MOD-07, CLI-MOD-08, CLI-MOD-10 | Provider breadth/dialects, browser OAuth/built-in registrations, CLI custom catalogue, complete offline metadata, complete thinking model maps/defaults/adaptive dialects beyond numeric budgets and the published Sonnet 4.6 request profile; signed thinking-block continuation, multimodal/export conformance, cache/accounting |
| Configuration | CLI-CFG-05, CLI-CFG-06, CLI-CFG-07, CLI-CFG-09, CLI-CFG-10 | Live selectors/branch tools, complete compaction/summary policy, terminal/display behavior, built-in extension switches, updates/telemetry/warnings and mutation UI |
| Sessions | CLI-SES-01, CLI-SES-02, CLI-SES-03, CLI-SES-04, CLI-SES-05, CLI-SES-06, CLI-SES-07, CLI-SES-08 | Project discovery/storage, cross-project picker, complete custom schemas/append-only metadata, labels/filter navigation, clone compaction/custom entries/hooks, exact accounting, overflow/context/summary generation |
| Tools | CLI-TOOL-02, CLI-TOOL-10 | Complete schemas/image reads/output lifecycle/platform process semantics; crash-durable running progress |
| Extensions | CLI-EXT-01, CLI-EXT-02, CLI-EXT-03, CLI-EXT-04, CLI-EXT-05, CLI-EXT-06, CLI-EXT-07 | Remaining TypeScript/module discovery and built-in switches, context/event/lifecycle contracts, extension MCP ownership, custom state/entries, TUI UI, disposer/shutdown coverage |
| Automation/security | CLI-AUT-01, CLI-AUT-02, CLI-AUT-03, CLI-AUT-04, CLI-AUT-05, CLI-AUT-06, CLI-SEC-06, CLI-SEC-07 | Remaining event/command/ordering/accounting/rebind/export behavior; cross-platform descendant/race and accidental-write coverage; offline/warning/diagnostic UX, shell-alias and Windows/terminal guidance |
| Web foundation/tools/files | WEB-BASE-01, WEB-BASE-02, WEB-BASE-05, WEB-TOOL-05, WEB-FILE-06 | Remaining migrated interactions, extension-level built-in switches/MCP registration, aliases/restoration/pinning, dynamic session-evidence file authority |
| Web mobile/settings | WEB-CHAT-11, WEB-SET-01, WEB-SET-02, WEB-SET-07, WEB-SET-08, WEB-SET-09, WEB-SET-10 | Physical keyboard/zoom behavior, selected-server persistence, shared settings primitives, general rename, bounded pre-trust review, per-project navigation and complete localization |
| Web operations | WEB-OPS-02, WEB-OPS-04, WEB-OPS-05 | Actual authorized Pages publication, remaining delta regression coverage and remaining operator/ADR documentation |

Each row still requires implementation and direct positive/negative evidence for its complete wording. Neither scoped commits, green suites, percentages nor this checklist authorize changing the goal to complete.
