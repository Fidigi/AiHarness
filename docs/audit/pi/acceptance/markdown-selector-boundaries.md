# Markdown selector boundaries — acceptance

Date: 2026-10-14–15 UTC; final qualification 2026-10-15. Base: `cea4760500a144aa4f121cc62afeee69c86540f9`.
Decision/evidence: DEC-78 / E-AH-MARKDOWN-BOUNDARY-01 in [AUDIT-2](../AUDIT-2.md).

**Qualified bounded maintenance, not whole-audit completion.** Final types/lint,140 focused,2,800 full units,34 parity and production Core/PTY/headless/HTTP smoke pass. Earlier failures remain explicit below.

## Scope

One Core product owner, `resources/resource-manager.ts`, fixes three reproduced boundaries without changing public options, declarations, persisted formats, resource schemas or body admission:

1. `+path` is exact for both discovery and the pre-read trust search root. Glob metacharacters in a file/directory are literal, not alternate resource authority.
2. Resource membership reuses `isResourcePathWithin` from the shared selector owner. A legitimate child component beginning with two dots, such as `..private`, is not the parent component `..`. Refused project children remain unread; trusted children are classified project, not temporary/global. Genuine outside siblings and the explicit operator-owned agent-root exception remain distinct.
3. `-path` and `!glob` only remove already admitted candidates, before any body reads. Their patterns need not have permission to scan an ancestor: no discovery takes place. Exact subtree removal uses the shared root-safe predicate, including filesystem-root removal; later exact reinclusion remains ordered.

Existing Markdown traversal, file/count/depth/aggregate/body limits, stable no-follow single-link reads, frontmatter, strict skill directory names, valid-candidate collision handling, package eligibility, CLI/RPC/SDK interfaces and tool/extension behavior remain. This is not migration of Markdown discovery to the theme/extension engine, a new public selector representation or hostile-writer/OS isolation.

## Criteria and residual

CLI-CFG-09 stays **PARTIAL**. A separate public-Core control demonstrates a remaining literal-declaring-directory bug: settings under `agent[literal]` with `prompts: ['templates/*.md']` resolve to an absolute glob, then discover `agentl/templates/review.md` rather than the literal declaring directory. `/tmp/aih-markdown-scoped-base-control.mjs` uses real `loadAgentSettings`, `resolveAgentResourcePaths`, and `ResourceManager`; exit1/OOMfalse, Node24.15.0, no load errors. The identical script also fails on the final production image under Node26.12.0 (`aih-markdown-scoped-base-production-control`), returning the same unrequested sibling. Current unprefixed/automatic/package Markdown path semantics still need complete reconciliation; exact `+` is the supported literal workaround. This failure is retained, not an accepted exception or a reason to invent closure.

The two-dot refusal correction maintains CLI-SEC-02's project-body boundary. Existing CLI-RES-01/02 behavior remains qualified only within its covered scope. **89 DONE / 63 PARTIAL / 152 (58.6%)**, no criterion closes here.

## Tests

79 added cases: **35 Core** plus **44 emitted CLI**. Existing ten CLI resource-manager cases remain unchanged.

- Core: exact metacharacter file/directory additions across all six explicit/global/project prompt/skill selector lists; refused and trusted two-dot children through explicit/global/package ingress; exact removal/reinclusion; subtree/glob/root exclusions; outside sibling conservation; ancestor-scan refusal; operator-owned root exception and filesystem-root project refusal.
- CLI: actual print/JSON/RPC × prompt/skill × settings/explicit × exact/refused; twelve further settings-exclusion cases. Eight genuine regular/fullscreen PTYs exercise `/resources` inventory. A disposable preload observes Markdown FileHandle reads: only the exact body may be read; refused/excluded cases read zero bodies. Exact output/protocol framing and child exit/signal remain asserted.
- Public Node probes use the emitted Core entry, not source aliases. Production checks include the original exact-add/two-dot controls unchanged, actual headless processes and real PTYs.

No assertion, timeout, retry, screenshot, fixture golden, compiler strictness, runtime policy, package or lockfile is weakened. The test observer records synthetic temporary paths only and does not substitute bodies or alter product authority.

## Causal controls

- Original accepted theme image `sha256:feab08f193b26dc869dfaea7f3da08f5ed49bf37e6b2af5c5c22747ea8617f23` plus **only the two final test leaves**: `aih-resource-boundaries-complete-base-control`, **70 failures / 19 passes across89 cases**, exit1/OOMfalse, `04:12:28.292310034Z–04:13:28.440703696Z`. Ten conserved cases pass. Original first61-case expansion control separately reports58 failures/13 passes across71 cases.
- Intermediate initial fix image `sha256:bce43247025c7939f1c4210ae6b7031bdae2409470150c52294a5fbb8edfcab9` plus final new leaves: `aih-resource-boundaries-exclusion-control`, **19 failures / 60 passes**, exit1/OOMfalse. This exposes ignored ancestor exclusions and filesystem-root removal, rather than assuming the initial exact/two-dot fix completes all modifiers.
- Initial overlay passes71 cases; expanded product passes89. Those overlays are exploratory controls, not final image qualification.

## Exact final inputs

Final test image: `sha256:724c45d6b83e0f1c3887ed9ec0259dc097d15b9513ae59aec32a09fa875000ac` (Node24.15.0).
Final production image: `sha256:4cdbbe67f206e275096170d99e82b233a811b8d82b5e7e456c1c3a804a835abc` (Node26.12.0).
First exclusion-fixed image: `sha256:4a947f143ba6c634268c0e5675ba5d0e1caea50eb793bf81c00ff6535d97b3d8`. Three working-tree hashes independently match both test images:

```text
115e7d9473881aaa840fca9a102a5ef4ac27fdcc687bb399fee18dee89ed9efa  packages/core/src/resources/resource-manager.ts
9abbcb48aa15aad1df4bfd5976f6961a7876fdfc1e07edda06dfd69a5eb2d587  packages/core/src/resources/resource-selector-boundaries.test.ts
bb0f2c77aa6839f46591a6f229570cbb478a1c651054a01bb536222f68a2d6a2  packages/cli/src/cli/resource-selector-boundaries-process.test.ts
```

Owning docs: security topic and EN/FR Markdown user sections; audit/receipt/completion review are admitted separately. Markdown is outside Docker's code context. The shared Core path helper is reused without modification. The original resource-manager input hash is `e44c240a943f56a9b235047b06ffc20b0142e4fbd254862868125e6bd3ad58ef`, independently equal in accepted Git base and control image.

## Retained qualification history

1. Initial source fixes: workspace types and71 focused cases pass; first full240-file/2,782-unit gate passes. The temporary qualification driver mistakenly supplied `IMAGE_TEST_RUN` to `make typecheck`, which uses `IMAGE_TYPECHECK`. No focused container was created, its exit file was empty, and the shell's empty numeric check erroneously continued. This is a driver/setup failure, not strict/lint/test evidence. A separate correctly created focused run passes122 cases with strict owning-test types and zero-warning lint.
2. Initial parity:26 cases pass but installed-executable worker terminates **SIGTRAP** during unchanged byte equality in setup; Make2. Retain stack trace; no product/assertion/runtime change or native cause is inferred. Two independent complete installed-file diagnostics each pass8; that does not diagnose the crash. Initial independent final parity34 and production build subsequently pass, but predate the exclusion correction.
3. Final exclusion-fixed image: workspace/strict two-leaf types and three-owner zero-warning lint pass. Initial focused run is **1 failure / 139 passes**: existing installed provider case's final strict SDK compiler returns `code:null`; its signal is not captured. Container exit1/OOMfalse, `04:13:47.813040035Z–04:14:52.296074581Z`. The null exit remains **undetermined**.
4. The first three attempted compiler diagnostics selected only the provider test, omitting the preceding test that writes `consumer.ts`. All three fail **TS6053**, not a native crash. Child observer records30 closes, six compilers, with the three expected compiler2/runner1 results. No product fixture is changed. The correctly selected dependency pair then passes2/deselects6,12 child closes/three compilers/no abnormal exit. Its host wait used unavailable `ps`, so it did not actually serialize behind the whole-unit driver; retain this orchestration defect. Neither diagnostic explains the preceding null exit.
5. First final-image full gate: **239 files pass/one fails,2,799 passes/one failure**. Existing source/tsx CLI `package --help` scenario returns `code:null` and empty stderr; Make2. Three independent observed repetitions each pass1/deselect25, six child closes/no abnormal exit. Original signal/cause remains unavailable; subsequent success is not a diagnosis.
6. The final independent whole qualification on2026-10-15 passes all2,800 units/34 parity and the separate140-case focused run. No failed checkpoint is overwritten or converted into a retry-success claim. Source hashes remain identical; image IDs are recorded separately. The existing production Docker base is a moving `node:26-bookworm-slim` tag and resolves to Node26.12.0 in this final build, not the previous day's26.11.1. No Dockerfile/runtime option was edited and no native-crash repair is inferred from that base update or any later pass.

## Final gates and production evidence

| Gate | Actual result |
|---|---|
| Final `make typecheck` | exit0; workspace/public parity types, default Node24.15.0 |
| Strict owning-test types and ESLint | Two new leaves, three owners, zero warnings; exit0 |
| Independent final focused | 8 files/140 passed; exit0/OOMfalse;2026-10-15T17:07:11.051328436Z–17:08:09.008749403Z |
| Final `make test` | 240 files/2,800 passed; exit0 |
| Final `make test-parity` | 34 passed; exit0 |
| Final `make build-prod` | exit0;148 KiB entry/159 KiB eager gzip,17 JS chunks; unchanged budgets |
| Source/artifact identity | Three sources match final test image; original product hash matches accepted base; two emitted hashes equal between final test/production |
| Production smoke | exit0/OOMfalse, network disabled; Node26.12.0 |
| Documentation/whitespace | `make lint-docs`:101 Markdown files/696 local links,exit0; staged whitespace clean |
| Matrix/completion review |152 unique criteria,89 DONE/63 PARTIAL;CLI39/48,Web50/15;statuses unchanged;exact63-ID open checklist |

Identical emitted SHA-256:

```text
7ebbc37e21d7ea7f15a64d585ce7adcfb0bb3fc47f3dc958b7f8efad97480496  packages/core/dist/resources/resource-manager.js
0218f54aaf3dd670a975287b8279556b34bf3a9b1b7d1a77e0f3d1cdfc8a3049  packages/core/dist/resources/resource-manager.d.ts
```

Production container `aih-resource-boundaries-production-smoke`: **2026-10-15T17:08:11.915986277Z–17:08:44.853200623Z**. The original public exact-add/two-dot controls now pass unchanged. Thirty headless calls cover prompt/skill admission/refusal plus subtree/glob/filesystem-root exclusions; eight genuine regular/fullscreen PTYs assert inventory and observed exact/zero Markdown body reads. New resource evidence prints at17:08:25.263055355Z. Previous theme/startup/module/native-alias/manifest/TypeScript smoke contracts also pass; final explicit health/HTML/JS HTTP200 is observed at17:08:44.833935687Z.

Docker's retained watchdog samples fail at17:08:14.521015183Z–14.607444210Z and17:08:19.608734294Z–19.686496637Z, while CLI probes run before Server startup. The captured health remains `unhealthy`, failing streak1. Later HTTP200 does not erase those samples or certify uptime. No browser sources/baselines change; previous browser evidence is not a new browser certification.

Local evidence: `/tmp/aih-resource-boundaries-*`, `/tmp/aih-markdown-{literal-*,dotdot-*,scoped-base-*}`; command logs, statuses, container states, source/artifact hashes and observer JSONL. These are local artifacts, not published CI or live-vendor/device/release acceptance.
