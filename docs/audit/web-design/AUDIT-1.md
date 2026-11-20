# Audit Report — AiHarness Web Design and UX

> **Status: IN PROGRESS** (2026-11-20)
>
> Six implementation decisions approved. VIS-01–03, FILE-01–05 and ACT-01–02 are verified: semantic palette/contrast, left explorer/right reader, compact accessible controls and non-overlapping conversation utilities. Category-modal Settings, five General subpanels, four Models section destinations and contextual credential/connection/model-catalogue/custom-model/installed-skill/tool/MCP/child-profile/package list/detail navigation are implemented; PREF-04 is verified. Other contextual layouts, dirty-close confirmation, final visual-direction review and global qualification remain open.

## 1. Audit Reference

| Element | Value |
|---|---|
| Target observed | `@ai-harness/web` 0.1.0: themes, visual hierarchy, action controls, workspace explorer and Settings information architecture |
| Audited instance | Local commit `b98572c6354ec4996cd4121f33c1ac8697a68047`; initial dirty tree contains only `packages/core/src/providers/anthropic-federation.test.ts`, outside this audit and left untouched |
| Audit date | 2026-11-18 |
| Pinned source | `https://github.com/Fidigi/AiHarness.git`, commit `b98572c6354ec4996cd4121f33c1ac8697a68047`; Web source and E2E files have no local diff against that commit at inspection |
| Detailed references | Source inventory in §8, inspected versioned images in §9, calculated color pairs in §8.1 and existing coverage in §10 |
| Method | AiHarness source/test inspection, eight existing baseline images and standalone sRGB contrast arithmetic; user screenshot U1 (§9.1) followed by bounded live browsing of the preferred external UX reference U2 (§9.2). No AiHarness application/browser test executed in the initial assessment; subsequent implementation evidence is journaled in §6 and §11–30 |

**Objective:** Identify concrete causes of weak color separation, excessive textual chrome, awkward file navigation and long-page Settings; propose a minimal, accessible redesign with independently verifiable completion criteria. The six implementation decisions in §5 are user-approved; this report does not authorize removing features or changing unrelated product contracts.

### Initial assessment limitations

- Existing images are historical artifacts present at the pinned commit, not fresh screenshots of that commit running. They illustrate density and styling, but cannot prove current runtime geometry. In particular, the inspected dark file-pane image was last changed in `39d300bb` (2026-10-03), versus `2373895b` (2026-11-02) for its light counterpart (`git log -1 --format='%h %cs %s' -- <capture>`); do not infer a theme-dependent functional difference from those images.
- Color ratios use opaque CSS declarations and their source-resolved background, not browser-computed styles, pixel sampling or a full WCAG conformance evaluation. Interaction, opacity, focus, platform rendering and actual visibility still need browser verification.
- Directory refresh/search findings are traced from state and rendering paths, not reproduced against a live filesystem. No latency, task-time, screen-reader or user-study measurements are claimed.
- No fresh Mist/Rose/Pine, forced-colors, zoom or physical-device captures were produced. Browser test definitions are evidence of intended coverage, not passing results from this session.
- U2 was inspected only at 1440×1000 in a fresh browser context, without changing themes, submitting prompts or saving settings. HTTP mutation requests were blocked during the detailed reference review; some background agent requests therefore failed. This is layout/navigation observation, not account, feature-parity, accessibility or backend qualification. Neither reference changes the pinned AiHarness target.
- CLI themes, the independent `demo/`, backend/API correctness, security certification and a complete chat/terminal redesign are outside scope. Preserve their existing contracts.
- The initial assessment added only this report and its two navigation entries (committed as `8f1dde38`). Subsequent product changes are explicitly journaled below, without rewriting the pinned historical evidence.

## 2. Result

These states describe **redesign acceptance criteria**, not whether the assessment document has been written. Three semantic-theme criteria, five explorer criteria, both action/input criteria and General preference separation are verified; five criteria remain open and no gap is accepted.

| Status | Count | Details |
|---|---:|---|
| `DONE` | 11 | VIS-01–03, FILE-01–05, ACT-01–02 and PREF-04: semantic themes, explorer contracts, accessible controls/input and General preference separation |
| `PARTIAL` | 4 | Implementation foundations or approved design direction exist, including category-modal Settings, but completion evidence remains missing |
| `ABSENT` | 0 | No criterion is entirely absent |
| `TO BE DEFINED` | 0 | Six starting decisions approved; visual refinement follows the first render |
| `BLOCKED` | 0 | No audit-wide external blocker |
| `IN PROGRESS` | 1 | QA-01: final global qualification |
| `GAP ACCEPTED` | 0 | No waiver requested or granted |
| **Total** | **16** | **68.75% closed: (11 + 0) / 16 × 100** |

### Summary by Surface

| Surface | Done | Partial | Absent | To define | Blocked | In progress | Gap accepted | Total |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Visual system | 3 | 1 | 0 | 0 | 0 | 0 | 0 | 4 |
| Actions and input | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 2 |
| File explorer | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 5 |
| Settings | 1 | 3 | 0 | 0 | 0 | 0 | 0 | 4 |
| Qualification | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 1 |
| **Total** | **11** | **4** | **0** | **0** | **0** | **1** | **0** | **16** |

## 3. Traceability by Surface

Priority: **P1** = accessibility/task-orientation problem to address first; **P2** = consistency, density or organization improvement. These are implementation priorities, not security severities. Evidence keys resolve to exact files in §8–10.

### Visual system

| ID | Status | Priority | Finding and criterion for DONE |
|---|---|---|---|
| VIS-01 | DONE | P1 | Colors are mostly literal values across several stylesheets; variables cover focus/layout but not a semantic palette (S1–S4). Introduce shared surface/text/border/action/status tokens, used by audited chrome and states. DONE requires a reviewed token inventory and browser-computed checks showing those surfaces consume theme-owned values rather than unrelated overrides. |
| VIS-02 | DONE | P1 | Light file syntax, Git badges and frontmatter retain pale dark-theme colors; specific ratios are 1.58–2.04:1 (§8.1). Fix each identified pair; qualify normal text at ≥4.5:1, large text at ≥3:1 and essential non-text controls/state indicators at ≥3:1 against adjacent colors. Decorative separators need not all reach 3:1. DONE requires computed-color and visible-state evidence, including hover/focus/selected states. |
| VIS-03 | DONE | P2 | Mist/Rose/Pine recolor only body/main/sidebar/chat-toolbar/input-container backgrounds (S2), leaving Settings, file viewer and most controls on the default navy palette. Give every selectable theme complete audited-surface coverage. DONE requires chat, Settings and explorer captures plus contrast checks for all five explicit themes and both System resolutions, without silently deleting saved theme choices. |
| VIS-04 | PARTIAL | P2 | The user approved the six starting decisions in §5 on 2026-11-18, using U1/U2 as the preferred reference: neutral surfaces/blue accent, thin icons, horizontal category tabs, desktop modal/mobile full-screen Settings, left explorer/right reader and retained alternate themes. No starting design arbitration remains. Exact colors, spacing and responsive details may be refined after the first render. DONE still requires reviewed desktop/mobile Light/Dark visuals covering surface separation, typography and icon weight; approval of direction alone is not visual qualification. |

### Actions and input

| ID | Status | Priority | Finding and criterion for DONE |
|---|---|---|---|
| ACT-01 | DONE | P2 | Textual toolbar buttons coexist with emoji and Unicode glyphs (`📁`, `📄`, `⌘`, arrows) of inconsistent appearance (S5, V1–V8). Use one consistent SVG icon style for frequent utilities and an overflow menu for secondary actions; retain text for ambiguous/destructive/consent actions. DONE requires translated accessible names, decorative icon hiding, keyboard-visible tooltips and clear hover/pressed/disabled states, with no removed capability or larger eager bundle beyond its existing budget. |
| ACT-02 | DONE | P1 | Upload relies on a non-focusable label whose file input is `display: none`; the resizer has a separator role but no keyboard focus/handler/value model. File mention buttons have opacity zero unless a row is hovered (S3, S5). Make upload keyboard-operable, resizing keyboard-operable or provide an equivalent accessible width control, and show row actions on focus as well as touch. DONE requires real Tab/Enter/Space/arrow and coarse-pointer journeys. Small visual icons must not imply tiny targets: use ≥24×24 CSS-pixel targets as a baseline, with a preferred 44×44 touch target, visible focus and no overlap. |

### File explorer

FILE-01–05 are verified by §14–15. The findings below retain the pinned baseline and its acceptance contract.

| ID | Status | Priority | Finding and criterion for DONE |
|---|---|---|---|
| FILE-01 | DONE | P1 | `activePath` drives file tabs, but is never passed into recursive `FileNode`; tree rows have no active-file indication (S5). Keep file selection visible independently from hover/focus and expose its semantics; show the current full path without depending only on a tooltip. DONE requires opening from tree, search and message link to locate the same file, reveal ancestors where necessary and distinguish duplicate basenames without changing workspace authority. |
| FILE-02 | DONE | P1 | Directory expansion is a button inside nested lists, without `aria-expanded`, explicit chevron or pending state; only directory emoji changes. Each row/action joins the normal Tab order (S5). Add an accessible disclosure or a complete tree pattern, not incomplete ARIA roles. DONE requires announced expanded/collapsed/loading state and predictable keyboard traversal on a three-level fixture. If using tree semantics, implement roving focus, arrows, Home/End and typeahead; preserve distinct open-file and mention actions. |
| FILE-03 | DONE | P1 | Each `FileNode` caches `children`; Refresh fetches only the root and Git status. Same-key nodes retain the old child cache, so a nested addition/removal can remain invisible after Refresh (S5). Refresh expanded directories or invalidate their caches while keeping useful expansion/selection. DONE requires an actual nested add/remove followed by Refresh and canonical rows, including safe handling of a delayed older expansion response. |
| FILE-04 | DONE | P1 | Search renders a bare list for any truthy `query`, while requests require trimmed nonempty input. Loading, no-match and request failure all look like an empty region; JSX supplies no explicit labeled reset control, leaving native search-clearing affordances browser-dependent (S5). Distinguish those states, normalize whitespace consistently and provide reliable reset. DONE requires delayed/failed/zero-result/superseded searches and a whitespace query to give explicit, localized feedback without opening or mentioning a stale result. |
| FILE-05 | DONE | P2 | Linked-directory, search, upload collision and hidden-file controls occupy permanent rows; viewer and explorer share a vertical stack whose tree shrinks to a 140px flex basis when a viewer opens (S3, V1, V3). Put uncommon options in an accessible menu/upload flow, retain Files/Changes discovery and prioritize the file list. DONE requires a many-file/long-path fixture at 1440×900 and 390×844 plus short-mobile checks; source/preview/diff, upload collision policy, trust and maximize/restore must remain reachable. Existing maximize already hides tree/chrome; do not report it as missing. |

### Settings

| ID | Status | Priority | Finding and criterion for DONE |
|---|---|---|---|
| PREF-01 | PARTIAL | P1 | At the pinned baseline, `SettingsView` renders all sections sequentially and the boundary restores a scroll target (S6–S8). §19 adds seven categories and desktop-modal/mobile-full-screen presentation; §20 adds General contextual panels, §21 adds MCP, §22 child-profile and §23 package list/detail navigation; §24 separates the four Models sections; §25 adds tool list/detail and selected Code mode controls; §26 adds installed-skill metadata list/detail without automatic instruction reads; §27 adds the existing built-in credential rows; §28 adds connection-descriptor list/detail; §29 adds grouped model-catalogue metadata independent of actual model selection/enablement; §30 adds custom-definition list/detail without retargeting its shared editor. Registry/form layouts and complete acceptance remain open. Introduce horizontal icon-and-label category tabs on desktop, with contextual left navigation where needed and only the selected category presented as active content, following U1 and the preferred live reference U2. DONE requires visible labels/current state, direct category addressing, Back/Forward/reload, keyboard navigation, accessible panel dismissal and mobile access; adding anchor buttons to the same long form alone does not meet this request. |
| PREF-02 | PARTIAL | P1 | Existing per-cwd section/group/row/scope memory, hash entry and guarded focus return are valuable, but assume all sections are mounted (S7–S8, T3). Adapt them to category ownership, preserving `#mcp`, `#model`, other existing section links and per-workspace intent. DONE requires no-project, two-workspace, trust-change, delayed-content and unsaved-form retirement evidence without navigation writes triggering configuration mutations. |
| PREF-03 | PARTIAL | P2 | Appearance saves browser preferences immediately; API-key/default forms require explicit saves; scoped tools/resources have their own writes (S6, S9). Those distinctions are real and should not be flattened into a misleading universal Save. Add consistent local/global/project/effective-source labeling and local save/pending/error/override feedback. DONE requires scoped readback and an explicit rule for dirty edits on category change, with no autosave of secrets or loss concealed as a successful save. |
| PREF-04 | DONE | P2 | Appearance also contains send behavior, reasoning visibility, sound, browser notifications and Push settings (S6, V4–V5). Separate visual appearance from behavior and notifications; align checkbox/switch labels horizontally rather than the current grid placing the input above the text. DONE requires EN/FR desktop/mobile review and unchanged browser permission/Push consent behavior. |

### Qualification

| ID | Status | Priority | Finding and criterion for DONE |
|---|---|---|---|
| QA-01 | IN PROGRESS | P1 | Existing coverage protects Light/Dark, file tabs, preview, Settings restoration and some focus/axe behavior (T1–T6); it does not establish all-theme design quality or the new tree/category contracts. Extend only the owning scenarios for the gaps in §10. DONE requires Docker validation, fresh reviewed artifacts and reconciled criterion evidence. Neither historical baseline presence nor an axe pass alone proves usable navigation or a successful redesign. |

## 4. Convention for Future Audits

| State | Meaning |
|---|---|
| ABSENT | Required behavior/evidence does not exist. |
| PARTIAL | Foundations exist, but the complete criterion is unmet. |
| TO BE DEFINED | A bounded product/design decision remains. |
| IN PROGRESS | Implementation or verification is actively underway. |
| BLOCKED | An external dependency and owner/trigger are recorded. |
| DONE | The whole criterion is verified with source, applicable browser/visual evidence and recorded validation. |
| GAP ACCEPTED | An explicit dated final decision declines the criterion with justification and a re-examination trigger. |

Closure is `(DONE + GAP ACCEPTED) / total`. A completed assessment does not close its remediation criteria. Keep the report IN PROGRESS until every item is DONE or GAP ACCEPTED. Do not weaken test assertions, snapshot tolerances or accessibility thresholds to obtain closure.

## 5. Decisions and Accepted Gaps

| ID | Dated decision | Justification | Re-examination trigger |
|---|---|---|---|
| None | 2026-11-18: no accepted gaps | Design approval is not a waiver of remediation or validation | Explicit user decision or an evidence-backed remediation batch |

The user explicitly favors better theme separation, a minimal icon-led interface, improved file-tree UX and category tabs for Settings. On 2026-11-18 the user clarified that direction with U1 (§9.1): horizontal icon-and-label tabs above a contextual list and main content, inside a wide Settings panel. The user subsequently supplied the local Pi Web URL and explicitly preferred its UX (U2, §9.2). Use that interface as the primary layout/interaction reference, with U1 as its visual illustration, instead of the initial vertical-tab proposal. Preserve AiHarness capabilities while rearranging them; the reference is not a request for additional provider/account integrations. On 2026-11-18 the user accepted all six proposed arbitrations and deferred refinement until after the first render. The following decisions supersede earlier provisional wording in this report. Keep explicit labels for consent, Save, Stop, deletion and authentication where an icon alone is ambiguous. This is compatible with reducing routine textual chrome.

### Approved starting decisions — 2026-11-18

| Decision | Approved implementation baseline |
|---|---|
| Settings presentation | Large centered modal on desktop, full-screen on mobile; retain `/settings` and existing section deep links. |
| Categories | General, Models, Skills, Tools, Plugins, Child agents, MCP; General subnavigation and contextual entity lists. |
| File layout | Explorer on the left below conversations; file reader on the right. Preserve independent file/terminal controls. |
| Visual system | Neutral surfaces, blue accent, thin consistent icons; coherent Light/Dark and retained, harmonized Mist/Rose/Pine themes. Exact colors and spacing can be refined on the first render. |
| Saving | Visual/browser preferences apply immediately; configuration saves remain per form, not a universal Save transaction. Existing explicit side-effect/consent boundaries remain intact. |
| Unsaved edits | Keep drafts in memory across category changes within the same context. Confirm before user-driven closure/context navigation that would discard edits. Never persist secret drafts in browser storage; never carry them across workspace/trust changes. External authority/trust withdrawal must still retire unsafe forms immediately rather than being blocked by a confirmation dialog. |

Approval resolves the starting product decisions, not implementation or acceptance. The source assessment remains pinned to `b98572c6354ec4996cd4121f33c1ac8697a68047`; this decision-only update was recorded at local commit `84f962274a23d5bbd536625579d9df5517db32f3`, without a product re-audit.

## 6. Delivery Journal

| Date | ID(s) | Old → New | Evidence | Validation | Notes/decision |
|---|---|---|---|---|---|
| 2026-11-18 | VIS-01–03, ACT-01–02 | Unassessed → PARTIAL | S1–S5; V1–V8; source color calculations in §8.1 | `git rev-parse HEAD`, `git status --short`, `git remote -v`, Web/E2E diff check and source/image reads completed; `node --input-type=module` arithmetic completed | Static findings only. Initial Python arithmetic attempt could not run because `python3` is absent; Node calculation succeeded. No browser pass claimed. |
| 2026-11-18 | VIS-04 | Unassessed → TO BE DEFINED | §7 design proposal; S1–S4; V1–V8 | Inspected existing theme declarations and images | Palette and grouping require review, not assumed approval. |
| 2026-11-18 | FILE-01–05 | Unassessed → PARTIAL | S3, S5; T1–T2; V1–V3 | Traced directory state, root refresh, search branches, activePath and viewer CSS | Runtime reproduction and physical-device evaluation not executed. Existing file tabs/maximize acknowledged. |
| 2026-11-18 | PREF-01 | Unassessed → ABSENT | S6–S8; V4–V8 | Inspected complete Settings return structure and navigation binding | No category tabs delivered. |
| 2026-11-18 | PREF-02–04, QA-01 | Unassessed → PARTIAL | S6–S9; T1–T6; V4–V8 | Existing owning test definitions inspected; no test suite run | Preserve existing state/security/lazy-loading contracts; focused missing coverage listed below. |
| 2026-11-18 | VIS-01–04, ACT-01–02, FILE-01–05, PREF-01–04, QA-01 | Findings unchanged | This report, `docs/audit/README.md`, `docs/ai/project-map.md` | `make lint-docs` PASS (110 Markdown files, 1,621 links); `git diff --check` PASS; placeholder scan empty; standalone Node checks PASS (16 IDs/status counts, 27 evidence paths, eight PNG dimensions) | Documentation only; no product, dependency, test or generated-file changes. Host `file` utility was unavailable; PNG headers were checked with Node instead. |
| 2026-11-18 | VIS-04, ACT-01, FILE-02, PREF-01, PREF-03 | States unchanged; design direction clarified | User-supplied Pi Web Settings screenshot U1 (§9.1); updated §3, §5 and §7.3 in this report | Visual inspection of the supplied image; `make lint-docs` PASS (110 files, 1,621 links); `git diff --check` PASS; placeholder scan empty | Horizontal top-level tabs replace the earlier vertical-tab recommendation. Reference is not product qualification or approval to copy features/save semantics. |
| 2026-11-18 | VIS-04, ACT-01–02, FILE-02, FILE-05, PREF-01–03, QA-01 | States unchanged; preferred UX reference inspected | U2 (§9.2), updated recommendations and the two audit navigation entries | `curl` returned HTTP 200; Docker-hosted Chromium reference browsing inspected Settings/categories and Escape dismissal; `make lint-docs` PASS (110 files, 1,621 links); `git diff --check` PASS; Node consistency check PASS (16 criteria, unchanged counts, 27 paths, no placeholders) | Initial default Playwright launch failed because its managed browser was absent; explicit `/usr/bin/chromium` succeeded. HTTP mutations blocked during detailed browsing; no account actions or AiHarness test pass. |
| 2026-11-18 | VIS-04; FILE-05, PREF-01–03 | VIS-04: TO BE DEFINED → PARTIAL; other states unchanged | User acceptance of all six arbitrations; §5 approved decisions and aligned §7 | `make lint-docs` PASS (110 files, 1,621 links); `git diff --check` PASS; Node consistency check PASS (16 criteria: 15 PARTIAL, 1 ABSENT; no placeholders) | Starting decisions resolved; first-render visual review and all implementation/qualification remain open. |
| 2026-11-18 | VIS-01–03, ACT-02, QA-01 | PARTIAL → IN PROGRESS | Reader foundation in §11; sixteen new source/frontmatter/short-mobile images; rendered contrast and native input journeys in `e2e/files.spec.ts` | Docker `make typecheck` PASS on the subsequent isolated invocation (initial native SIGSEGV retained below); `make test TEST_ARGS='packages/web/src'` PASS (71 files / 617 tests); `make test-e2e E2E_ARGS='e2e/files.spec.ts e2e/file-tabs.spec.ts e2e/accessibility.spec.ts --retries=0'` PASS (26 tests, 49.5s, no snapshot updates); production build/budgets PASS (entry 147 KiB gzip, eager 159 KiB gzip); `make lint-docs` PASS (110 files / 1,621 links); `git diff --check` PASS | Reviewed reader palette/focus/selected states for all five themes and both System resolutions, and Light/Dark touch-emulated captures. No threshold was weakened. Remaining shell/icon/Settings work and broader qualification prevent closure of any whole criterion. |
| 2026-11-18 | VIS-01–03, ACT-02, QA-01 | IN PROGRESS → IN PROGRESS | Shared semantic palette, native control boundaries, selection markers and reviewed captures in §12 | Frozen palette: workspace/parity typechecks PASS; Web units 71/617 PASS; focused no-update/no-retry browser gate **39/39 PASS** (1.2m), with canonical 1 GiB shared memory; build budgets PASS (147/158 KiB gzip entry/eager). Earlier full workspace units: 653/11,590 PASS before final CSS/test refinements | Bounded color progress only. Full browser campaign 218/221 and diagnostic shard set 220/221 retain native failures; baseline comparison and its limits are documented below. Icons/layout/category work and final QA remain open. |
| 2026-11-18 | ACT-01–02, FILE-02, QA-01 | States unchanged | Decorative SVG family, preserved translated names, disclosure semantics and reviewed captures in §13 | Canonical typechecks and Web 71/617 PASS; 108 distinct no-update/no-retry owning browser cases PASS (40 focused, 43 linked, 17 workspace assets, 8 locale assets); source/image SHA-256 equality for all 29 staged source files; bundle budgets PASS (148/159 KiB gzip entry/eager) | Initial locale-source assertion and tactile CSS regression corrected; native global/diagnostic failures remain recorded. Icon consistency does not close action-density, mobile-header overlap, explorer or Settings work. |
| 2026-11-18 | FILE-01–04; VIS-01–03, ACT-02, QA-01 | FILE-01–04: PARTIAL → DONE; other states unchanged | Functional explorer, hierarchical flow repair, contrast/path captures and criterion mapping in §14 | Canonical typechecks PASS; Web 71/617 PASS; frozen no-update/no-retry owning browser gates **104/104 PASS** (35 standard, 17 workspace assets, 44 linked/real files, 8 locale assets); all ten changed source files SHA-256-equal to the frozen workspace; budgets PASS (148/159 KiB gzip entry/eager) | Mock and actual filesystem/API/browser regressions reproduced before repair. Native build failures and the initial locale-inventory assertion remain recorded. FILE-05 layout/chrome, Settings and final global qualification remain open. |
| 2026-11-19 | FILE-05; ACT-01–02, QA-01 | FILE-05: PARTIAL → DONE; other states unchanged | Left explorer/right reader, responsive fallback, grouped controls and reviewed long-tree/path captures in §15 | Docker types/parity and Web 71/617 PASS; frozen no-update/no-retry owning browser gates **305 pass / 1 native worker failure**; FILE-05 scenarios pass; all 23 changed product/test sources SHA-256-equal to the frozen workspace; budgets PASS (148/159 KiB gzip entry/eager) | Visual review exposed defects despite successful generation; tree allocation, selected-row reveal and upload progress were repaired. Responsive readiness assertions and eight stale Markdown baselines were corrected without weakening thresholds. Settings, remaining control/input polish and final qualification stay open. |
| 2026-11-19 | ACT-01; ACT-02, QA-01 | ACT-01: PARTIAL → DONE; other states unchanged | Translated keyboard hints, compact utility controls, explicit states and constrained chat fit in §16 | Final Docker build/types and Web 71/617 PASS; **320/320** distinct owning browser cases PASS without updates/retries; all 13 changed source files SHA-256-equal to the frozen workspace; budgets PASS (149/160 KiB gzip entry/eager); 38 reviewed baseline changes | Retained native generation failure and initial functional chat failure. Controlled response timing reproduced the 180px tail gap on current and retained layout sources; synchronous explicit jumps corrected it without weakening the 96px assertion. Mobile terminal overlap, Settings and final global qualification remain open. |
| 2026-11-19 | ACT-02; VIS-01–03, QA-01 | ACT-02: IN PROGRESS → DONE; other states unchanged | Composer-flow terminal control, keyboard-viewport bounds and message-bounded minimap in §17 | Final Docker build/types and Web 71/617 PASS; **342/342** distinct owning browser cases PASS without updates/retries; eight changed source files SHA-256-equal to the frozen container; budgets PASS (149/160 KiB gzip); 101 reviewed baseline changes | Retained incorrect-name, rectangle, keyboard-bound and capture-framing failures. No timeout, threshold or runtime-flag change. Palette inventory still has a compact-action override to correct; Settings and final global qualification remain open. |
| 2026-11-19 | VIS-01–03; QA-01 | VIS-01–03: IN PROGRESS → DONE; QA-01 unchanged | Token inventory, nine retained reds, repaired compact action/cache notice and explicit criterion mapping in §18 | Docker build/types and Web 71/617 PASS; **342/342** distinct owning browser cases PASS without updates/retries; four changed source files and all 304 tracked PNGs SHA-256-equal to the frozen container; budgets PASS (149/160 KiB gzip); ten reviewed baseline changes | The earlier inventory omitted both overrides; Light/System Light notice contrast was 1.015:1. Historical native/functional failures remain retained. This closes the bounded semantic-theme criteria, not Settings, VIS-04 or global QA-01. |
| 2026-11-19 | PREF-01–04; QA-01 | PREF-01: ABSENT → PARTIAL; other states unchanged | Category-modal ownership, history/drafts, local feedback and accessible notice host in §19 | Final partial-foundation build/types and Web 71/617 PASS; **229/229** distinct bounded owning cases PASS with isolated containers, no updates/retries; 55 source files and all 306 E2E baselines match the frozen inputs, with 100 reviewed changes. First campaign retained 444 PASS/19 FAIL; the second launcher exited 139 before tests and five subsequent suites refused occupied ports. Detailed development/failure evidence remains in §19 | No Settings criterion closed. Contextual entity lists, General subpanels, dirty-close confirmation and global qualification remain open; generation and bounded corrections are not release qualification. |
| 2026-11-19 | PREF-04; PREF-01–03, QA-01 | PREF-04: PARTIAL → DONE; other states unchanged | Five contextual General panels, preserved hashes/drafts/consent, 33 reviewed captures and real form-control bounds in §20 | Corrected Docker build/types and Web 71/619 PASS; 409 PASS / 2 native page-crash failures across 411 distinct owning cases, no updates/retries. All 17 changed sources and 312 E2E PNGs match frozen inputs. First startup139 and 124 PASS/8 FAIL campaign remain separately retained | This closes only the mapped preference-separation criterion, not complete Settings, physical-device or global qualification. |
| 2026-11-19 | PREF-01–03; QA-01 | States unchanged | MCP contextual list/detail, mobile Back/focus, draft conservation and eighteen reviewed captures in §21 | Frozen Docker build/types and Web 71/619 PASS; 421 PASS / 2 native worker SIGSEGV failures across 423 distinct owning cases, no updates/retries. Ten changed sources, 312 E2E PNGs and eighteen reviewed replacements match the freeze; separate generation and earlier development failures retained | No whole Settings criterion or global campaign closed. Existing trust, selection, Test/OAuth and explicit-write authority preserved. |
| 2026-11-19 | PREF-01–03; QA-01 | States unchanged | Child-profile list/detail, filter-stable selection, visible focus and resize passivity in §22; ten reviewed capture replacements | Corrected frozen Docker build/types and Web 71/619 PASS; 431 PASS / 1 native worker SIGSEGV failure across 432 distinct owning cases, no updates/retries. Seven changed sources, all 312 E2E PNGs and ten replacements match the freeze. Older-source 432/432, separate generation and development/native failures remain distinct | No whole criterion closed. Existing scope, editor, permissions, explicit writes and actual child lifecycle preserved; other Settings layouts, dirty protection and global qualification remain open. |
| 2026-11-19 | PREF-01–03; QA-01 | States unchanged | Package list/detail, scoped actual-row administration, volatile draft conservation and pending Back focus in §23; six reviewed replacements | Frozen build/types and Web 71/619 PASS; 290 PASS / 1 native worker SIGSEGV failure of 291 distinct owning cases, no updates/retries. Thirteen sources, all 312 E2E PNGs and six replacements match the freeze; development/generation remain separate | No whole criterion closes. The system-light worker failure remains unexplained and is not rerun unchanged. Other contextual layouts, dirty protection and global qualification remain open. |
| 2026-11-19 | PREF-01–03; QA-01 | States unchanged | Four contextual Models sections, retained drafts/handlers, shared Back-outline repair and 36 reviewed captures in §24 | Corrected frozen build/types and Web 71/619 PASS; **211/211** distinct owning browser cases PASS without updates/retries. Sixteen sources, all 318 E2E PNGs, 36 adopted captures and eighteen native-view attachments match the freeze. First frozen 210 PASS / 1 stale accessibility-journey failure remains separate | No whole criterion closes. Models entity lists, remaining contextual layouts, dirty protection, final visual review and global qualification remain open. |
| 2026-11-19 | PREF-01–03; QA-01 | States unchanged | Scoped tool list/detail, selected Code mode controls, pending focus and long-name containment in §25; eight reviewed replacements and fourteen viewport attachments | Corrected frozen build/types and Web 71/619 PASS; **185/185** distinct owning browser cases PASS without updates/retries. Ten sources and all 318 E2E PNGs match the corrected freeze. First frozen campaign retains 168 PASS and startup139 before seventeen asset cases; development failures remain separate | No whole criterion closes. Complete Models/Skills layouts, dirty protection, retirement acceptance and visual/global qualification remain open. |
| 2026-11-19 | PREF-01–03; QA-01 | States unchanged | Installed-skill metadata list/detail, separate explicit instruction reads, unchanged filtered-group batches and pending keyboard focus in §26; ten reviewed replacements and eighteen viewport views | Frozen build/types and Web 71/619 PASS; **214/214** distinct owning browser cases PASS without updates/retries. Eleven sources, all 318 E2E PNGs and reviewed captures/views match the freeze. Development failures, separate generation and one-pixel unadopted outcome deltas remain retained | No whole criterion closes. Registry operations retain their own authority; metadata selection cannot read instructions or authorize invocation. Models entity layouts, dirty protection, remaining presentation/retirement acceptance and final visual/global qualification stay open. |
| 2026-11-19 | PREF-01–03; QA-01 | States unchanged | Built-in credential list/detail, independent active-provider intent, volatile drafts and retained Vertex mode/save authority in §27; four new reviewed captures and twelve viewport views | Frozen build/types and Web 71/619 PASS; **230 PASS / 1 browser-crash FAIL / 28 unstarted of 259 planned cases**, without updates/retries. Native launcher exits 139 before its case listing; tablet-light provider visual reports `Target crashed` before image comparison. Eight sources and all 322 E2E PNGs match the freeze | Validated partial presentation progress, not a passing complete campaign. Both failures remain unexplained and are not rerun unchanged. Remaining entity layouts, dirty protection, retirement acceptance and visual/global qualification stay open; no criterion closes. |
| 2026-11-19 | PREF-01–03; QA-01 | States unchanged | Built-in/custom connection list/detail, independent shared-editor target, operation-owned OAuth drafts and newer Back/selection intent in §28; ten reviewed replacements and eighteen viewport views | Frozen build/types and Web 71/619 PASS; **263 PASS / 1 page-crash FAIL of 264 selected cases**, without updates/retries. Standard retains a Models reload `Page crashed`; the earlier unchanged Code mode worker SIGSEGV is deliberately not rerun or included in selected totals. Eleven sources and all 322 E2E PNGs retain frozen inputs | Validated partial presentation, not complete qualification. Both current failures remain unexplained/open; no gap is accepted and no criterion closes. Remaining model/registry layouts, legacy forms, dirty protection, retirement acceptance and visual/global qualification stay open. |
| 2026-11-19 | PREF-01–03; QA-01 | States unchanged | Grouped model-catalogue metadata list/detail, independent active-model/enablement authority, pending Back and eighteen reviewed replacements/nine viewport views in §29 | Frozen build/types and Web 71/619 PASS; **251 PASS / 18 unstarted of 269 selected cases**, without updates/retries. Pane-lifetime Server startup exits 139 before its eighteen cases. The earlier unchanged Code mode SIGSEGV remains deferred/open, outside selected totals. Eleven sources and all 322 E2E PNGs retain frozen inputs | Validated partial presentation, not a passing complete campaign. No failure is rerun unchanged or accepted as a gap; no criterion closes. Custom-model/registry forms, dirty protection, retirement acceptance and visual/global qualification remain open. |
| 2026-11-20 | PREF-01–03; QA-01 | States unchanged | Custom-definition metadata list/detail, independent shared-editor target, fresh-key restoration and native imported-model journeys in §30; six reviewed replacements/eight viewport views | Frozen build/types and Web 71/619 PASS; **285/285 selected browser cases PASS**, without updates/retries. Two exact unchanged worker SIGSEGV cases remain deferred/open outside the 285-case selection; the complete bounded owning universe is 287. Seventeen sources, all 322 E2E PNGs and reviewed hashes equal frozen inputs | Validated partial presentation, not complete qualification or an accepted gap. Earlier failures remain retained; registry/forms, dirty protection, retirement acceptance and visual/global qualification stay open. No criterion closes. |

## 7. Approved Direction and Delivery Order

### 7.1 Minimal does not mean low contrast

Use neutral surfaces with one restrained accent, readable secondary text, a clearly outlined focused control and a selected state distinguishable by shape/marker as well as color. Avoid making every heading, button and selected item compete with the same saturated accent. Use spacing and typography before adding another card border. Preserve visible errors, trust restrictions and running/Stop states.

Start with a small shared token set: canvas, panel, raised/input surface, primary/secondary text, subtle/control border, accent/on-accent, selected/hover/focus and success/warning/danger. Derive light and dark semantic roles first; then complete Mist/Rose/Pine using those roles. Exact hex values should follow a reviewed mockup and measured contrast, not this report's taste alone. Do not require 3:1 between every background panel: explicit text, structure and essential control boundaries matter more than maximizing decorative contrast.

Use 16–18px icons inside approximately 32px desktop controls and preferred 44px touch controls. Choose one stroke/size convention. Refresh, upload, copy, download, maximize, collapse and information are good candidates. Keep category names, file names and settings labels textual. Put less frequent options behind a named overflow button, never hover-only discovery. Tooltips supplement accessible names; they are not the sole touch explanation. No new icon package is mandated; bounded local SVGs may suffice.

Use U2's workspace hierarchy as inspiration: a compact global toolbar, grouped project/conversation navigation, a visually distinct file-tree region, a dominant conversation/composer area and optional secondary panels. Its file header groups icon-only utilities instead of permanent full-width option rows. Apply the approved desktop placement: explorer at left below conversations and reader at right, preserving independent file/terminal controls. Do not copy tiny targets merely because they look minimal: observed file-header utilities in U2 were approximately 23×26 CSS pixels, so ACT-02's target-size/focus requirements still apply.

### 7.2 File workspace layout

- Placement: explorer below conversations on the left; separate file reader on the right, rather than forcing the tree above the reader.
- Header: Files / Changes and a compact Refresh / Upload / More action group.
- Tree: explicit chevrons, neutral file-type icons, visible active row, aligned status marker and a mention action discoverable by focus/touch. Keep full-path context available outside `title` alone.
- Search: search icon, clear control, explicit pending/empty/error states and optional result count; no new fuzzy-search backend is needed.
- More: Show hidden files and Linked directories. Upload reveals destination and collision handling before submission; do not silently change the existing root destination or overwrite policy.
- Viewer: retain the eight bounded file tabs and their full-path disambiguation, keyboard switching, source/preview/diff and maximize/restore. A later layout can reduce stacked chrome without replacing the preview/read/trust machinery.

### 7.3 Settings categories

Following U1 and the user's preferred live reference U2, implement the approved **wide centered Settings modal with horizontal category tabs on desktop**, each combining a small outline icon and a short label. Use a thin active-tab underline plus semantic selected state, subtle separators and neutral surfaces. Inside categories with many entities, put a compact selectable list on the left and the selected entity's details on the right. Reserve filled accent buttons for the primary action; use borderless icon utilities and quiet secondary controls. This replaces the initial recommendation for vertical top-level tabs; the left column is contextual navigation, not another competing category bar.

Use flat model/resource rows with aligned names, metadata, values and toggles rather than a separate prominent card and repeated action bar for every row. Retain the useful textual action labels visible in the reference: minimalism means fewer competing controls, not an icon-only interface. A selected row must remain distinguishable without relying on its background tint alone.

The approved grouping preserves all **15 current section IDs**, counted from S8. The reference shows six categories; the approved adaptation adds a separate Tools category to keep AiHarness's existing tool/code-mode controls discoverable. Labels and spacing can be refined after the first render.

| Top-level category | Contextual content retained |
|---|---|
| General | `defaults`, `sessions`, `appearance`, `shortcuts`, `authentication`, `about`; separate Appearance, Behavior, Notifications, Access and About subpanels rather than another long combined form |
| Models | `providers`, `provider-lifecycle`, `model`, `custom-models`; provider/entity list on the left and selected configuration/catalogue on the right |
| Skills | `skills`, including catalogue and registry |
| Tools | `tools`, including presets and code mode |
| Plugins | `plugins` |
| Child agents | `subagents` |
| MCP | `mcp` |

On mobile, use full-screen Settings and let contextual navigation and details occupy separate views with an explicit Back action; use a labeled category picker or accessible overflow rather than squeezing all tabs and both columns into the viewport. Preserve the selected entity while moving between those views. The screenshot supplies no mobile layout or Dark palette evidence.

Preserve `/settings` and existing deep links with the approved desktop dialog presentation. The modal must trap focus, label its heading, make the background inert, support Close/Escape through the existing layer ownership and restore focus safely. Dismissal must preserve the underlying conversation/draft and follow the existing safe return-address behavior. If categories become routes/links, use native navigation semantics and `aria-current`; if implemented as in-place tabs, implement the complete tablist/tab/tabpanel keyboard contract. Do not assign tab roles to ordinary page links.

Keep the workspace/scope visible where relevant; browser-only preferences are not project configuration. Preserve old section hashes by resolving each to its new category and then its subsection. Persist only navigation metadata, not form values/secrets. Keep dirty forms in memory across same-context category changes; show a confirmation before a user-driven close/context change would discard them. Never persist secret drafts in browser storage or retain them across workspace/trust changes; authority withdrawal still retires unsafe forms immediately. Do not cancel detached server work merely on tab switch or imply browser transport abort rolls back a committed write. Keep expensive sections lazy and isolate pending/error feedback per category.

### 7.4 Delivery batches

| Order | Scope | Verify before advancing |
|---|---|---|
| 1 | Apply §5 decisions; VIS-01–03 color roles and ACT-02 accessibility repairs | First-render desktop/mobile Light/Dark review under VIS-04; failing color pairs corrected; keyboard upload/row actions/resize verified |
| 2 | FILE-01–05 and ACT-01 explorer controls | Nested-refresh, active-file, search feedback, keyboard/touch and preview conservation |
| 3 | PREF-01–04 category architecture | Direct links, history, per-cwd memory, dirty drafts, trust retirement, scopes and save/readback |
| 4 | QA-01 final cross-surface review | All criteria mapped to fresh evidence; no silent theme removal or relaxed baselines |

These are sequencing recommendations, not time estimates. Consult §6 and §11 for actual execution and remaining work.

## 8. Source Evidence

Paths and line ranges below refer to the pinned commit, not future edits.

| Key | Repository-root path | Relevant implementation |
|---|---|---|
| S1 | `packages/web/src/index.css` | Lines 11–20 focus variables; 23–49 base/canvas/sidebar; 263–299 Settings width, sections and controls |
| S2 | `packages/web/src/agent.css` | Lines 303–368 Light and shell-only alternate themes; 369–374 preference label grid and legend colors; toolbar/composer rules elsewhere in the same file |
| S3 | `packages/web/src/workspace-panel.css` | Lines 5–66 panel/tree/viewer geometry, hidden upload input and hover-only actions; 87–129 source colors, frontmatter and partial Light overrides |
| S4 | `packages/web/src/settings.css` | Literal resource/catalogue colors, card controls and separate Light overrides |
| S5 | `packages/web/src/components/WorkspacePanel.tsx` | Lines 31–78 recursive nodes/child cache; 127–184 refresh/search; 210–270 active-file reads; 377–524 controls, search, tree, tabs and viewer |
| S6 | `packages/web/src/components/SettingsView.tsx` | Lines 185–629 sequential sections; 465–546 mixed Appearance/notifications; 714–751 presentation boundary |
| S7 | `packages/web/src/components/settings-navigation.ts` | DOM scroll/focus restoration, ancestor opening, unique row lookup and presentation retirement |
| S8 | `packages/web/src/store/settings-navigation.ts` | Lines 2–7: fifteen section IDs; bounded per-cwd/no-project navigation metadata |
| S9 | `packages/web/src/components/EcosystemSettings.tsx`; `packages/web/src/store/preferences.ts` | Scoped settings/save/readback versus immediate browser preference persistence; six theme choices including System |

### 8.1 Color calculations

The source supplies the following foreground/background pairs. Light file viewer uses white (`S3`), while its syntax/frontmatter/badge colors have no Light replacement in the inspected stylesheets. Ratios rounded to two decimals are **diagnostic static calculations**, not a full browser audit.

| Use | Foreground / background | Ratio | Interpretation |
|---|---|---:|---|
| Light source string | `#9fdb9f` / `#ffffff` | 1.60:1 | Below normal-text target |
| Light source number | `#e8b97a` / `#ffffff` | 1.80:1 | Below normal-text target |
| Light source keyword | `#8eb7ff` / `#ffffff` | 2.03:1 | Below normal-text target, despite bold weight |
| Light frontmatter summary | `#aab6cd` / `#ffffff` | 2.04:1 | Below normal-text target; also pale in V1/V3 |
| Light modified Git badge | `#f1c967` / `#ffffff` | 1.58:1 | Status letter is poorly contrasted; letter plus color is good redundancy, not a contrast fix |
| Light untracked Git badge | `#62d998` / `#ffffff` | 1.77:1 | Below normal-text target |
| Dark source line number | `#56647f` / `#111a31` | 2.90:1 | Readability concern; prioritize actual code/content and evaluate line-number applicability separately |
| Dark source comment | `#7f8da8` / `#111a31` | 5.16:1 | Counterexample: already above normal-text target |
| Light secondary text | `#52627b` / `#ffffff` | 6.19:1 | Counterexample: secondary text need not be made universally darker |
| Dark toolbar secondary text | `#b5c0d4` / `#16213e` | 8.67:1 | Counterexample: existing readable role |
| Dark canvas / sidebar | `#1a1a2e` / `#16213e` | 1.07:1 | Explains weak surface separation; not itself a WCAG failure |
| Dark file input border / fill | `#30466e` / `#0f172d` | 1.89:1 | Needs essential-control-boundary review against both adjacent colors in browser |

Reproduce the arithmetic with Node (no app/test runner needed); supply the table's hex pairs to `contrast`:

```js
const luminance = hex => [1, 3, 5]
  .map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
  .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (foreground, background) => {
  const [low, high] = [luminance(foreground), luminance(background)].sort((a, b) => a - b);
  return ((high + 0.05) / (low + 0.05)).toFixed(2);
};
console.log(contrast('#9fdb9f', '#ffffff')); // 1.60
```

## 9. Visual Evidence Reviewed

All eight repository images were opened during the initial assessment. Their exact bytes are identifiable through the pinned commit; no image was edited, regenerated or promoted to fresh acceptance evidence. Dimensions below describe stored images/crops, not necessarily the full browser viewport. Treat illustration and source-backed findings separately.

| Key | Repository-root capture path | Stored view / theme | Relevant criteria |
|---|---|---|---|
| V1 | `e2e/visual.spec.ts-snapshots/workspace-files-desktop-light-chromium-linux.png` | 1440×900, Light; stacked explorer/viewer, many toolbar rows, pale frontmatter/status | VIS-02, ACT-01, FILE-05 |
| V2 | `e2e/visual.spec.ts-snapshots/workspace-files-desktop-dark-chromium-linux.png` | 1440×900, Dark; older viewer-only presentation, low surface separation | VIS-01, VIS-03; historical illustration only |
| V3 | `e2e/visual.spec.ts-snapshots/workspace-files-mobile-light-chromium-linux.png` | 390×844, Light; stacked file controls and repeated viewer heading | ACT-01, FILE-05 |
| V4 | `e2e/visual.spec.ts-snapshots/preferences-desktop-dark-chromium-linux.png` | 1440×900, Dark; long mixed Appearance form, substantial unused width | PREF-01, PREF-04 |
| V5 | `e2e/visual.spec.ts-snapshots/preferences-mobile-light-chromium-linux.png` | 390×844, Light; stacked checkbox/label layout and notifications below the fold | PREF-04 |
| V6 | `e2e/visual.spec.ts-snapshots/mcp-inventory-desktop-light-chromium-linux.png` | 1440×2768, Light; full content capture, repeated textual card actions | ACT-01, PREF-01, PREF-03 |
| V7 | `e2e/settings-navigation.spec.ts-snapshots/restored-model-desktop-light-chromium-linux.png` | 536×512 section crop, Light; batch-action duplication and model restoration | ACT-01, PREF-02 |
| V8 | `e2e/settings-navigation.spec.ts-snapshots/restored-model-mobile-dark-chromium-linux.png` | 326×661 section crop, Dark; wrap/density of repeated batch actions | ACT-01, PREF-02 |

### 9.1 User-supplied design reference (U1)

On 2026-11-18 the user supplied a 2139×1674 screenshot of a Pi Web interface, explicitly identifying it as an example of minimalism and tabbed Settings. Its Models tab is active. Visible design cues are:

- a large centered white Settings dialog over a dimmed workspace;
- horizontal General / Models / Skills / Sub-agents / Plugins / MCP tabs, each with a consistent outline icon and short label;
- a contextual provider/model list at left and a wider details area at right;
- flat, aligned model rows, restrained gray surfaces/dividers, generous whitespace and a limited blue accent;
- compact refresh and close icons, but retained textual primary, connection and batch actions;
- an underlying file tree with explicit disclosure chevrons, outline folder/file icons and consistent indentation, relevant to FILE-02's proposed visual treatment.

**Provenance and limits:** U1 is the image attached to the user's follow-up message, not a repository file or a capture generated by this audit. This description preserves the design intent in versioned text; no local image path is fabricated. The reference application's version, commit, interaction behavior and computed contrast were not verified. Its visual appearance does not qualify AiHarness, prove keyboard accessibility or authorize copying subscription integrations, context-limit fields, save semantics or filesystem layout. In particular, the screenshot's bottom Save button does not justify replacing AiHarness's distinct immediate browser preferences and explicit scoped/credential saves with one global transaction.

### 9.2 Preferred live UX reference (U2)

On 2026-11-18 the user provided a session-specific URL at `http://localhost:30141/` and explicitly preferred its UX to the current AiHarness arrangement. The private session selector is deliberately omitted here. The page identifies itself as **Pi Web**. Its application commit/version is unknown; the fetched HTML exposed Next build identifier `BATwAhbFDnBzeFUXK6hFb` and had SHA-256 `c48db935814dcb689170b56a6c32a7a516aa9a4d6ef586877f777f76e58b15da`. These identify the observed shell, not a stable deployment or complete asset/data snapshot.

**Actual inspection:** `curl --max-time 15` returned HTTP 200 (`text/html`, 11,477 bytes). Exploratory Playwright-driven browsing ran inside Docker image `sha256:eb1edd177f336a23b2b696532d1130e604e0d10e0189ba577ec14ffe3449042d`, using explicit `/usr/bin/chromium` (Chromium 156.0.8078.79), Node `--no-maglev`, a fresh context and a 1440×1000 viewport. This reused the image only as a browser environment; it did not run its AiHarness product/test artifacts against U2. Initial launch with Playwright's default managed-browser path failed before navigation; the corrected system-browser launch succeeded.

The detailed browsing scripts blocked HTTP methods other than GET/HEAD/OPTIONS. Background agent lease/update POSTs were consequently refused; that limitation must not be diagnosed as a defect in the reference. No Save, connect/disconnect, account action, file write, prompt submission or credential reveal was invoked. Temporary General/Models views were inspected locally but are not versioned or linked because their surrounding workspace can contain private session/configuration information. No conversation text or credential values are reproduced in this report.

| Observation | Design consequence | Limit |
|---|---|---|
| Settings opens over the workspace; General, Models, Skills, Sub-agents, Plugins and MCP can be selected without leaving the dialog; Escape dismissed it | Stable horizontal category navigation and safe return to the workspace should guide PREF-01–02 | Only category selection/dismissal observed; focus trapping, unsaved edits and server work lifetimes not qualified |
| General uses theme swatches, grouped sections, compact labels, reset icons and aligned switches | Reduce card/button noise and make current visual choices recognizable | Do not add every reference theme/font feature; no theme was changed or contrast measured |
| Models presents a contextual entity list on the left and a broad editing area on the right, consistent with U1 | Keep navigation/selection separate from detailed editing; preserve useful widths and aligned controls | Existing configuration was not edited, saved or functionally validated |
| File-header utilities use consistent SVG icons and accessible labels for refresh, upload, search, ignored files and host file manager | Consolidate routine utilities into a compact action group | Measured controls were approximately 23×26px; do not infer target-size compliance from appearance |
| The reference exposes category controls as ordinary buttons, not ARIA tabs | Copy the visual hierarchy, not unverified semantics | AiHarness must still implement the chosen native navigation/tab keyboard contract and visible selected state |

**Preference, not equivalence:** The user describes broadly similar functions with a better arrangement. No exhaustive feature comparison was performed. Treat U2 as the preferred UX direction, not evidence that its subscriptions, providers, filesystem actions, persistence rules or accessibility should replace AiHarness contracts. Mobile/Dark behavior, keyboard traversal, performance and full functionality remain unreviewed.

## 10. Existing Coverage and Precise Missing Evidence

The initial assessment added no tests. The following inventory records pre-remediation coverage; subsequent focused additions are recorded in §11. Reuse and extend the owning scenarios rather than creating another UI test framework. Use synthetic fixtures/loopback transports only; no real accounts, credentials or opt-in live-service mode.

| Key | Existing tests inspected | Already represented in definitions | Specific gap to cover |
|---|---|---|---|
| T1 | `e2e/files.spec.ts` | File/Git badges, diffs, previews, file links, maximize, upload via `setInputFiles` | Keyboard upload is not proved by programmatic file assignment; add real trigger activation and selection/state feedback |
| T2 | `e2e/file-tabs.spec.ts` | Eight-file bound, duplicate basenames, arrow/Delete file-tab behavior, responsive maximize and retired reads | These are viewer tabs, not file-tree navigation. Add nested tree keyboard/selected-file, root-plus-child refresh and search-state cases |
| T3 | `e2e/settings-navigation.spec.ts` | Cwd/no-project/group/row/scope restoration, peer intent, trust refresh, guarded focus and Light/Dark crops | Real category activation/history/hash migration, dirty form handling, inactive-category retirement and lazy-entry behavior |
| T4 | `e2e/accessibility.spec.ts` | Light/Dark axe and selected keyboard/focus journeys | Expanded tree/source syntax/hover-only action states, alternate themes, non-text contrast and new tab semantics; no full WCAG claim from axe |
| T5 | `e2e/visual.spec.ts` | Desktop/tablet/mobile Light/Dark historical captures | Fresh all-theme states, many nested/long files, open menus and focus states; review changes without loosening 2% tolerance |
| T6 | `e2e/settings.spec.ts` | Preference selection/persistence including Pine | Selection/persistence does not qualify Pine's whole-surface palette or Mist/Rose contrast; add focused computed-role checks and reviewed theme captures |

After product changes, run the required Docker `make typecheck`, `make test` and `make test-e2e`; focused iterations may filter the owning files through the documented Make arguments. Preserve separate real-server file/scoped-save evidence where frontend interception cannot prove a disk change or durable save. Check lazy JS/CSS budgets in the normal Web build. Add manual screen-reader and 200% zoom review for navigation, plus desktop/mobile Light/Dark EN/FR checks; physical-device coverage must be labeled separately.

For documentation-only changes, required validation is `make lint-docs` and `git diff --check`, plus count/placeholder/path consistency checks. Their actual results belong in §6, not an assumed product green gate.

## 11. Remediation Evidence — Reader Foundation

Scope at commit `3edfd478`: `packages/web/src/themes.css`, its entry import in `index.tsx`, `workspace-panel.css`, the shared focus token in `index.css`, accessible controls in `components/WorkspacePanel.tsx`, and focused extensions of `e2e/files.spec.ts`. This increment does **not** qualify the whole shell, Settings, icons, file-tree behavior or final layout.

### Token inventory

| Roles | Ownership and current use |
|---|---|
| `--surface-{canvas,panel,raised,input,hover,selected}` | Light/Dark palette and Mist/Rose/Pine surface overrides; explorer/reader chrome consumes panel, raised, input, hover and selected roles. Canvas adoption outside the reader remains pending. |
| `--text-{primary,secondary,link}`, `--border-{subtle,control}` | Reader text, metadata, frontmatter, control boundaries and nonessential separators; subtle borders deliberately have no universal 3:1 claim. |
| `--accent`, `--on-accent`, `--focus-ring` | Shared action/focus roles; focus is already shared globally, while filled-action migration remains pending. |
| `--status-{success,warning,danger}`, `--surface-{success,danger}` | Git status and diff text/backgrounds. Letters/signs preserve non-color status information. |
| `--syntax-{comment,string,number,keyword}` | Aliases to semantic text/status roles, including Light overrides instead of retaining pale Dark colors. |

All five explicit themes are retained; System still resolves through the existing preference store. No preference schema or API change is introduced. Browser defaults use the appropriate native `color-scheme`.

### Focused behavioral evidence

- The existing file scenario now reaches Upload through Tab, opens the native chooser through Enter and Space, performs a synthetic upload, reaches Mention through Tab without hover, and adjusts the focusable separator with arrows. Width exposes minimum/maximum/current values and supports Home/End as well as pointer dragging.
- Two short-mobile (390×600) Light/Dark cases use Chromium coarse-pointer/touch emulation, verify visible mentions and 44px targets, then exercise mention, independent panel reopening and maximize/restore. This is **not** physical-device evidence.
- Seven theme cases measure rendered source syntax, line numbers, Git letters, metadata, selected source, hover text, diff and frontmatter at ≥4.5:1, plus the search control boundary/focus at ≥3:1. They also check the actual reader background against its semantic token. These focused measurements do not certify every application state.
- New images live under `e2e/files.spec.ts-snapshots/`: `reader-source-{theme}-chromium-linux.png`, `reader-colors-{theme}-chromium-linux.png` and `reader-touch-{light,dark}-chromium-linux.png`. They supplement rather than reinterpret V1–V8. Whole-shell desktop/mobile, EN/FR, zoom, forced-colors and assistive-technology review remain pending.

The first reproduction run failed all eight added/extended desktop scenarios on the old implementation (including Light syntax ≈1.60:1 and Dark line numbers ≈2.90:1). After the initial repair, ten existing functional cases passed, and the seven palette cases reached screenshot creation but failed because their baselines did not yet exist in CI. An explicit snapshot-generation run then passed 19/19 cases. A preview-loading assertion was added to wait for the actual Markdown heading rather than capture its temporary raw-text fallback. The final baseline-generation run passed 19/19, followed by 26/26 passing reader/file-tab/accessibility cases **without** snapshot updates or retries.

The focused Web unit run passed 71 files / 617 tests. The first canonical `make typecheck` attempt failed with a native TypeScript `SIGSEGV`, not a type diagnostic; this failed attempt is retained rather than reported as green. A subsequent isolated canonical invocation passed all workspace and parity typechecks, without compiler configuration changes or automatic retries. Both outcomes are retained. Final batch validation and outstanding scope are recorded in the delivery journal.

## 12. Shared Theme Rollout — Qualification in Progress

The increment committed as `7f8bbbe1` extends the same roles to `index.css`, `agent.css`, `sidebar.css`, `settings.css`, terminal **chrome**, and the lazy provider, tool-progress, code-mode, linked-directory, session-menu, extension-dialog and workspace-loading styles. Redundant component-specific Light/alternate-theme color branches are removed rather than layering another competing palette over them. Component layout and configuration/API behavior remain unchanged; native text-control borders are normalized to the shared solid one-pixel treatment.

- Neutral Light/Dark surfaces and blue actions now share one theme-owned palette. Mist/Rose/Pine own their canvas, panel, raised, input, hover, selected and border values instead of recoloring only the outer shell.
- `--surface-warning` completes the existing status roles. Chat code consumes the shared syntax roles even before the file-panel stylesheet is loaded. The sixteen existing ANSI text classes have theme-owned counterparts, so moving command output onto themed surfaces does not make Light output unreadable.
- Active branch and command-palette rows now use the same inset blue marker as conversation/file/terminal selection, not just a low-contrast tint. The seven theme scenarios open the real keyboard command palette and measure its selected marker against the selected surface at ≥3:1.
- Native range/checkbox/progress indicators use the already-readable `--text-link` blue, not the filled-button `--accent`: source arithmetic during image review found the latter only 2.32–2.75:1 against the dark/alternate panel surfaces. The browser cases verify the corrected indicators at ≥3:1. Filled actions retain their separate white-on-blue text role.
- Capture review also found native inset borders on typeless provider inputs and unthemed textarea content. Text fields now share solid one-pixel role-colored boundaries, excluding native checkbox/radio/range/file controls. Six existing provider-form scenarios additionally assert border style/width and text/boundary contrast.
- Independent terminal content/theme selection, generated diagram artwork and document canvases are retained; this is not a terminal emulator or diagram-renderer redesign. Content-specific surfaces, shadows and backdrops remain literal. The earlier inventory was incomplete: §17 later identifies an omitted compact-keyboard primary-action override, and §18 identifies a cache-notice foreground override. Neither was qualified by this rollout; §18 records their repair and subsequent verification.

### Added evidence and validation state

`e2e/visual.spec.ts` adds seven **shared semantic surfaces** cases: five explicit themes plus both System resolutions. They verify computed canvas/panel/input roles, source and metadata contrast, all sixteen ANSI classes, Settings text and essential control boundaries. The shell cases now keep the explorer closed and assert the four syntax roles themselves, covering the earlier gap where opening the explorer could mask lazy stylesheet ownership. The existing reader contrast calculation was moved unchanged into `e2e/fixtures/contrast.ts` and reused rather than adding a second test framework. All accounts/content remain synthetic or loopback-only.

The new cases first failed 7/7 against the prior shell colors. An intermediate fixture probe incorrectly appended a color-normalization span inside native textarea/select elements; moving the probe to the document body while reading the subject's computed custom properties fixed the measurement without weakening any expected value. The seven cases then passed (23.4s), producing `theme-shell-{theme}-chromium-linux.png` and `theme-settings-{theme}-chromium-linux.png` under `e2e/visual.spec.ts-snapshots/`. The later regenerated captures include the native-indicator correction. Light/Dark shell and all five explicit Settings palettes were reviewed, along with System Light, provider-form mobile Dark, MCP inventory Light and the mobile Dark command palette. System Light/Dark shell captures are byte-identical to their explicit counterparts. This is color qualification, not acceptance of the still-sequential Settings layout or its checkbox alignment.

The first expanded Docker browser run (`visual`, `files`, `file-tabs`, `accessibility`, `terminal-controls`, `settings-navigation`, `settings`) completed **220/221** cases in 5.8 minutes. The real-PTY case failed at `page.goto('/')` with **Page crashed**, before terminal interaction. It is not a passing run and is not diagnosed as a product assertion failure or assigned an unproved root cause. The subsequent serialized `--update-snapshots=all` run passed the real-PTY case but again finished **220/221** (5.7 minutes): the mobile Dark message-metadata case instead crashed in `page.goto`, before its content assertions. Thus concurrent unit execution does not explain away the failure. A focused diagnostic run with `DEBUG=pw:browser` then passed the real-PTY case plus all six message-metadata variants (**7/7**, 17.2s), regenerated the remaining capture and reported a clean browser process exit. Both earlier crashes remain unexplained; no assertion, timeout, browser launch flag or automatic-retry policy was weakened.

Canonical Docker typecheck passed, followed by the full workspace suite: **653 files / 11,590 tests passed** in 3,079.8s. That full-suite build preceded the final CSS/test-only refinements. The canonical Docker image containing those refinements was retained before icon work: workspace/parity typechecks and **71 Web files / 617 tests** also passed on that exact palette image. The latest production build passed existing budgets (entry 147 KiB gzip; eager 158 KiB gzip; entry CSS 59.48 kB raw / 10.84 kB gzip versus 60.99 kB raw at the reader increment). Snapshot generation used explicit `--update-snapshots=all` to record actual new pixels even where old Dark captures remained within the unchanged comparison tolerance. The full **221-case** verification with `--update-snapshots=none --retries=0` and browser diagnostic logging finished **218 passed / 3 failed** (5.5 minutes): two native Node worker `SIGSEGV`s and one `SIGTRAP`, whose V8 backtrace reports `Check failed: !IsFreeSpaceOrFillerMap(map)`. It is not reported as green.

A disposable diagnostic container overlaid committed source and snapshots from **`3edfd478`**, without touching the working tree or exporting its old baselines. Newer unreferenced files were not purged; this is not a pristine-checkout certification. SHA-256 comparison confirmed its `index.css` and `visual.spec.ts` matched that commit. Its 122-case visual run ended **111 passed / 11 failed** (2.8 minutes), including a native worker `SIGSEGV` in the model-catalogue scenario and ten existing snapshot mismatches. This reproduces a native crash with the pre-palette entry source/test; it does not identify the runtime/hardware cause, excuse snapshot mismatches, or certify infrastructure stability.

The same frozen palette image was also checked in four ordinary Playwright shards, with identical 221-case discovery, thresholds and zero retries. Shards 1/3/4 passed **56/55/55** cases. Shard 2's first invocation terminated during Web TypeScript compilation with native `SIGSEGV`, before any browser case ran. Its subsequent isolated invocation completed **54 passed / 1 failed**, another native worker `SIGSEGV`, this time in System Dark. The executed shard set is **220 passed / 1 failed**, not a green campaign. These manual diagnostic containers, including the historical-source comparison, used Docker's default shared-memory size rather than Make's 1 GiB ceiling; they are not environment-identical canonical comparisons. No compiler/browser flag was changed. The visual fixtures also freeze **Date only** for conversation-age stability, not timers or network ordering.

A final **bounded palette gate**, on the exact frozen image with Make's 1 GiB shared-memory ceiling restored, passed **39/39** (1.2 minutes), without snapshot updates or retries: all seven shared-theme cases, six real provider-form variants, reader/file-tabs and accessibility. This validates the color/control increment's focused behavior, not the failed global campaigns or runtime stability. No whole criterion is closed; the native failures, remaining icon/layout work and final cross-surface qualification remain open.

## 13. Decorative Icons — Bounded Implementation

The increment committed as `b205ad48` adds `components/Icon.tsx`: one local, typed, `currentColor` SVG family (24-unit view box, 1.75-unit stroke, 18px display). Decorative paths are hidden from accessible names and keyboard focus. Shell, navigation, chat, explorer, terminal chrome and local notices/dialogs replace their heterogeneous action glyphs without changing their callbacks. Owning translated control names remain; worktree deletion gains an explicit Delete name. Meaningful text such as terminal keys, mention signs, Git letters and destructive/consent confirmation copy remains text. No dependency or public API is added.

The existing accessibility helper now checks decorative attributes, accessible control names and 24px minimum targets. Defaults are 28px desktop / 36px coarse pointer, with existing larger component targets retained. The first focused run exposed a real CSS-specificity regression: two reader touch targets became 36px instead of their established 44px. Lower-specificity defaults corrected it; the unchanged touch assertions then passed in **33/33** focused scenarios (1.2m, explicit capture generation). A historical Settings locale-consumer assertion initially failed on the replaced star glyph; its narrow source projection preserves the historical inventory, copy and locale ownership. Canonical typechecks and **71 Web files / 617 tests** subsequently passed. Build budgets remain unchanged: **148 KiB gzip entry / 159 KiB eager**.

The frozen icon image is separate from subsequent explorer work. Its expanded standard-host capture run completed **261 passed / 1 failed** (19.2m), a native worker `SIGSEGV` in desktop Dark MCP inventory. Production-host files named in that command were excluded by standard discovery; they receive separate owning-configuration evidence, not credit from the 262 standard cases. The missing MCP capture was subsequently generated. The focused no-update check finished **39 passed / 1 failed** (1.3m), another native worker `SIGSEGV`, this time in accessibility. That failure is retained; an isolated unchanged accessibility run subsequently passed **7/7** (21.2s).

Dedicated production-host checks retain their own outcomes: workspace asset ownership **17/17 PASS** (15.4s); locale asset ownership first failed before browser execution with compiler `SIGSEGV`, then passed **8/8** (12.8s). Linked-directory ownership first ended **33 passed / 1 native worker SIGSEGV / 9 not run**; its subsequent capture-generation run passed **43/43** (3.3m). Fresh linked consent/browse captures include both the palette and decorative-icon changes. No runtime flags, comparison thresholds, case timeouts or automatic retries were weakened.

Light/Dark shell, mobile Dark explorer and Light linked-directory consent captures were reviewed. The mobile explorer still shows global floating controls overlapping its legacy header; that structural issue remains explicit work for the file-layout increment, not accepted accessibility. Final no-update/no-retry checks on the frozen icon source passed **40/40** focused browser cases (1.3m) and **43/43** linked-directory cases (3.4m). Together with the separate 17-case workspace and 8-case locale gates, this supplies **108 distinct passing owning cases**, not a retroactive pass for the failed 262-case run. All 29 staged product/test source files were SHA-256-equal to that frozen image; later explorer edits and captures remain a separate worktree increment. Whole-criterion/cross-surface acceptance stays open.

## 14. Explorer Interaction Foundation

The functional explorer increment keeps its existing placement for now. `WorkspacePanel` owns expansion and current-file identity. Recursive native disclosures expose expanded/busy state, localized live loading feedback and chevrons; their abortable loads retire on collapse, replacement or a newer explicit Refresh. Explicit Refresh invalidates every open directory, while watch ticks retain bounded root-only refresh. Canonical file reads reveal ancestors, but a delayed read cannot undo a newer manual disclosure action. Message/file-written intents reopen a collapsed pane and select Files/reset search at admission, rather than clearing a later user query when the read finishes.

Tree, search and Git rows expose `aria-current`; a marker/tint survives unrelated hover/focus. The reader exposes a focusable, wrapping full path, and existing bounded file tabs still distinguish duplicate basenames. Normalized, debounced searches now separate loading, empty, failure and whitespace feedback in EN/FR, with an explicitly named reset and scoped/abortable result retirement. Opening and mentioning remain separate. No API, authority or persistence-format change is introduced.

Visual inspection also found that the old shared flex selector treated recursive root list items like flat search rows. Children could appear beside/above their parent and the selected row did not span its available width. Excluding recursive nodes from that flat-row selector restores vertical hierarchy. The three-level fixture now measures each child's indentation and position below its parent, in addition to native keyboard/disclosure behavior.

### Evidence and retained failures

- The initial four behavior reproductions failed on the frozen icon implementation; the initial repair passed **4/4** (13.1s).
- Strengthened existing scenarios reproduced two additional failures against the earlier file implementation: external opening left Changes active, and a delayed read reopened a manually collapsed directory. Both assertions are preserved.
- Geometry reproduction first stopped in TypeScript compilation with native `SIGSEGV`, before executing a browser case. A separate direct Playwright diagnostic using that already-built pre-fix image then reproduced the geometry defect: the child began at **194.27px**, above the required parent bottom of **274.27px**. This is not a successful compiler rerun.
- The added real-server scenario uses the existing private linked-directory workspace, ordinary in-root files and no HTTP interception. Actual disk removal/addition and API readback succeeded on the frozen icon source, but its UI still could not show `added.ts` after Refresh. This independently reproduces the cache defect through the filesystem/API/browser boundary, rather than only through the mutable mock fixture.
- The first expanded capture attempt stopped in Vite with native `SIGSEGV`. Later 35-case capture/verification runs passed before the final hierarchy correction; the final hierarchy capture generation also passed **35/35** (1.2m). Generation alone is not final qualification.
- One Web-unit run finished **616/617** because the historical locale-allocation guard did not yet project the six new eager EN/FR feedback literals. Explicit post-inventory additions fixed the expectation without regenerating its historical inventory or allowing unrelated key/value changes. Canonical typechecks passed, and the final Web-unit run passed **71 files / 617 tests** (7.36s). Production budgets remain **148/159 KiB gzip entry/eager**, with unchanged limits.

Final frozen-source checks, with 1 GiB shared memory and no snapshot updates or retries, passed **104 distinct owning cases**: standard host **35/35** (1.1m), workspace asset boundary **17/17** (15.2s), linked-directory real host **44/44** (4.1m, including the actual filesystem/API/browser refresh) and locale asset boundary **8/8** (13.3s). All ten changed product/test source files match the frozen workspace by SHA-256. Light/Dark selection/path captures were reviewed, and the existing seven-theme checks now also measure the selected-row marker, full path and selected Git badge.

| Criterion | Completion evidence |
|---|---|
| FILE-01 | `file-tabs.spec.ts` checks duplicate basenames, full paths and current rows. `files.spec.ts` opens the same nested file from tree, message and search, reveals ancestors, reopens a collapsed pane and protects newer manual disclosure intent. Real workspace/linked ownership gates retain authority behavior. |
| FILE-02 | The three-level fixture checks Tab/Enter traversal, expanded/collapsed/busy semantics, live loading text, vertical/indented geometry and a distinct keyboard mention without a content reread. Native disclosures are used, not partial ARIA tree roles. |
| FILE-03 | Mutable canonical HTTP fixtures exercise a delayed older expansion response and preserved selection without rereading content. The real-host scenario additionally performs actual filesystem add/remove, checks canonical API readback, then verifies refreshed rows, selected path and unchanged reader content. |
| FILE-04 | Both EN/FR scenarios cover pending, failure, zero results, normalized/whitespace queries, reset, supersession and separate fresh-result mention/open. Old results cannot be acted on after a newer query. |

These four contracts are closed on this increment, not the whole redesign. The left explorer/right reader layout, compact options/upload flow, mobile header overlap, category Settings and final global qualification are not delivered by this functional increment.

## 15. Explorer Placement and Compact Controls

On desktop, the lazy explorer is portaled beneath conversations in the Sidebar; the independent reader stays right of the main content. A hidden Sidebar or narrow viewport uses the combined fallback without forcing navigation open. Sidebar/breakpoint changes preserve the mounted reader, current path, mode and bytes; they do not become authority/lifetime boundaries. Conversation navigation takes its content height, capped at 35% while the tree is expanded, instead of reserving an equal empty area. Collapsing files returns the freed height to conversations. Canonical selection receives a one-shot scroll reveal when its row mounts, including after host changes, without taking focus or reopening a newer manual disclosure.

Files/Changes, Refresh and Upload remain direct. File options groups hidden files, linked directories, terminal, collapse and close. Upload exposes the existing workspace-root destination, reject/rename/overwrite policy and native Choose files action; progress stays compact and cancellable. Named EN/FR groups use ordinary Tab traversal, Escape/outside dismissal and stable triggers; the linked-directory boundary receives the persistent Options trigger, not a retiring popup item. No upload destination feature, API, permission or persistence-format change is introduced.

The reader retains full paths, eight-file tabs, source/preview/diff and preview/download utilities. Its maximized surface is a named modal with focus containment, Escape restoration and protection against the global focus-prompt shortcut. Terminal requests leave maximization; the existing narrow-screen terminal handoff still retires files. Ordinary mobile panes/loading placeholders start below the 56px header, and coarse controls keep their larger targets. Collapse/expand restores focus explicitly rather than remount autofocus.

### Reproductions, review and retained failures

- Both new compact-layout scenarios first failed against the frozen foundation because the separate reader did not exist. The first implementation build failed with `TS1117`: a duplicate `more` glyph; the duplicate was removed, leaving no Icon source change.
- Early assertions incorrectly omitted the mock upload's `U` badge and expected mobile files to survive the established terminal handoff. The latter capture run was **28 pass / 1 fail**. Expectations were corrected to retain those existing contracts, not to change product behavior.
- Initial expanded generation passed **169/169**, but visual review found excessive empty navigation space and an offscreen current file. Strengthened tests reproduced both: tree height **150.28px** versus navigation **257.80px**, and selected-row viewport ratio **0**. The first repair passed mobile but left a desktop ratio of **0.99755859375**; scroll margin fixed the fractional clipping without lowering the required ratio of 1. Both cases then passed.
- A held-upload fixture separately reproduced the moved progress strip growing into spare vertical space (**2/2 red**, `flex-grow: 1` rather than 0). Compact sizing, cancel targets and toolbar disabled/expanded/hover states were repaired. Final compact controls passed **2/2** (10.0s), also included in the standard gate below.
- Subsequent generation was **168 pass / 1 fail** because the desktop scenario toggled navigation before the responsive handoff had committed. The first owning asset gate similarly finished **15 pass / 2 fail** while hit-testing a still-transitioning placeholder. The tests now await observable Sidebar/viewport readiness and retain the center hit-test; no timeout or retry was added.
- Final layout review also caught the content-height rule continuing after collapse. The existing nested-disclosure scenario reproduced navigation staying at **70.15625px** rather than growing; a collapsed-state override restores that space, with the geometry assertion retained and passing in the final standard gate.
- The related Markdown/chat/terminal/real-server gate initially finished **46 pass / 4 snapshot failures**. Desktop conversation width had changed with placement; other Markdown baselines still contained the earlier palette/icons, including dark code surfaces in Light. Actual/expected images were inspected, all eight affected Markdown captures were generated (**4/4**) and reviewed, then the full 50-case group passed without updates. These mismatches are not native crashes or waived assertions.

- Before that final collapsed-state correction, the six groups had passed **306/306**; the 169-case standard group also passed after removing unrelated pixel-only baseline changes. Those earlier successes are not a green result for the final revision. Its expanded standard run finished **168 pass / 1 failure**: the Playwright worker exited with `SIGSEGV` in the desktop-Light plugin-catalogue visual case. There was no automatic retry, new runtime flag or relaxed assertion. The other owning groups passed; the cause of the native failure is not established.

### Frozen qualification and closure

Production build and workspace/parity typechecks passed in Docker. Web units passed **71 files / 617 tests** (7.45s). Budgets remain **148/159 KiB gzip entry/eager**, 28 JS chunks, with unchanged limits. All **23 changed product/test source files** match the retained container by SHA-256. Final browser checks used **1 GiB shared memory**, **zero retries** and **no snapshot updates**:

| Owning surface/configuration | Result | Duration |
|---|---:|---:|
| Standard files, file tabs, keyboard/responsive, accessibility, real previews and visual scenarios | 168 pass / 1 native failure | 4.6m |
| `workspace-asset-load.config.ts` | 17/17 | 15.4s |
| `linked-modal-boundary.config.ts`, including actual linked-directory/filesystem scenarios | 44/44 | 4.1m |
| `settings-locale-asset-load.config.ts` | 8/8 | 12.4s |
| `pane-lifetime.config.ts` | 18/18 | 20.3s |
| Terminal controls, live server, Markdown and chat | 50/50 | 1.7m |
| **Distinct total** | **305 pass / 1 native failure** | — |

Light/Dark desktop/mobile workspace captures were reviewed after the geometry repair: long path and selected row remain visible, and the desktop tree uses the previously empty space. Reader touch/preview captures, options/upload attachments and the refreshed Markdown captures were also reviewed. Broad generation initially rewrote 70 baselines. Pixel comparison identified twelve unrelated variations with unchanged dimensions and only 1–16 changed pixels (maximum channel delta 7); those were restored to HEAD rather than committed as design changes. The remaining 58 baselines cover the changed presentation and refreshed Markdown evidence. Generation alone was not accepted as qualification.

| FILE-05 requirement | Concrete completion evidence |
|---|---|
| Compact options, direct Files/Changes and useful tree height | `files.spec.ts` checks named groups, native keyboard choice, hidden-file action, Escape/focus restoration, direct mode switching and tree/navigation geometry. Options/upload attachments show the actual grouped presentation. |
| Many files/long paths at 1440×900 and 390×844 | Existing mock fixture extended with 40 files and nested long paths; full selected-row intersection is asserted initially and after Sidebar/breakpoint return. `visual.spec.ts` captures both Light/Dark placements. |
| Short mobile and reachable source/preview/diff/maximize/restore | Existing touch and short-height file/tab journeys retain source/preview/diff, resize, maximize/restore geometry, focus containment and Escape. The reader mode/path survives presentation changes without another content read. |
| Upload policy, trust and independent terminal controls | Mock request bodies retain root/collision policy; real preview uploads retain reject/rename behavior and bytes. Owning linked/asset/pane suites preserve cancellation, authority and modal ownership. Native PTY tests retain the narrow handoff and desktop independence. |

FILE-05 is closed; five of sixteen criteria are now verified. Remaining control/tooltips/input work, category Settings and final reconciled cross-surface acceptance stay open. This bounded FILE-05 acceptance does not qualify the failed plugin-catalogue case, erase earlier native failures or constitute physical-device verification.

## 16. Control Hints and Compact-Chat Correction — ACT-01 Qualified

`IconControlHints.tsx` visually mirrors existing translated icon-control names without adding an accessible-name duplicate, focus target, command, Escape lease or stored draft. Keyboard hints also cover native-title controls; untitled icon controls receive hover hints. Geometry uses fractional rectangles and follows scroll; hidden/inert/disconnected owners and changed names retire the hint. Clicking the hint cannot take focus or activate its control. Copy/download and the documentation link reuse the decorative SVG family. File/explorer mode buttons expose their pressed state; low-specificity pressed/disabled defaults preserve larger component/touch targets.

Review at 1280px exposed a model input reduced to **19.59375px**, plus a French toolbar action extending outside the chat column. Toolbar/composer wrapping and a bounded minimum model width now preserve readable controls with a reader open. Existing EN/FR accessibility scenarios were extended with keyboard/hover/click/Escape, full hint visibility, non-overlap, contrast, binary-copy disability and 1280/960px control geometry. No configuration save, authority or transport behavior changes.

Retained development evidence:

- Two initial red cases lacked keyboard hints. The first implementation then failed both strict boundary assertions because integer dimensions overlapped the trigger; fractional rectangles fixed this without relaxing the assertion.
- A strengthened click check reproduced focus loss in both locales; preventing hint mouse-focus while retaining its owner corrected it.
- Both compact-pane cases reproduced the collapsed model field; both pressed-state checks then found `box-shadow: none`. The corrected accessibility group passed **9/9**, before the final documentation-glyph/observer refinement.
- Current production build/budgets and workspace/parity types pass; Web units pass **71 files / 617 tests**. Entry/eager sizes are **149/160 KiB gzip**, with 28 chunks and unchanged limits.
- Broad capture generation retained **232 passes / one native worker SIGSEGV**, in the mobile-Light terminal visual case. Six owning About captures subsequently passed for the documentation glyph. Generation is not final qualification.
- Minimap review found 16–32px capture-only scroll differences despite passing real-pagination anchor assertions. The capture now normalizes position only after that original assertion; no tolerance or timeout changed. Its first discovery attempt retained a parenthesis syntax error (no cases executed); the corrected owning generation passed **6/6**.

The first no-update campaign passed **232/233** cases but failed the existing long-chat “Back to bottom” check. Its four dedicated configurations passed **17 + 44 + 8 + 18**, giving **319 distinct passes / one functional failure**, not global acceptance. Uncontrolled single-case and five-case diagnostics passed on both current and retained layout sources; those successes did not clear the failure. A controlled completion hold in the existing scenario then reproduced an exact **180px** tail gap on both sources against the unchanged **<96px** limit: a response arriving during the smooth jump invalidated its original target after intermediate scrolling revoked follow-tail intent. Explicit jumps now reach the current tail synchronously; normal follow-tail behavior is unchanged. The strengthened scenario passed **1/1** after this correction. No extra case, retry, wait extension or threshold relaxation was introduced; the final-source gates below supersede the earlier bounded results without erasing them.

Capture reconciliation retained 38 changed baseline images. Eighteen unrelated task-generated images were restored: sixteen small raster variations (1–57 pixels, maximum channel delta 14), plus two mobile-agent captures differing only in message scroll beneath the existing notice. Six minimap frames retain the explicit post-assertion framing described above. Reviewed EN/FR hint attachments show full edge visibility and readable compact-column controls; reviewed reader, workspace, About and minimap captures retain their scope.

### Final frozen-source verification

| Gate | Result |
|---|---|
| Production Web build and existing budgets | PASS — 149/160 KiB gzip entry/eager; 28 chunks |
| Workspace/parity types | PASS |
| Web units | PASS — 71 files / 617 tests |
| Eleven owning standard/related browser files | **233/233 PASS**, 6.9m |
| Workspace asset loading, owning configuration | **17/17 PASS**, 15.6s |
| Linked directories/modal boundary, owning configuration | **44/44 PASS**, 4.2m |
| Settings locale asset loading, owning configuration | **8/8 PASS**, 14.6s |
| Pane lifetime, owning configuration | **18/18 PASS**, 21.2s |

These **320 distinct browser cases** used Docker with 1 GiB shared memory, no retries and no snapshot updates. All thirteen changed product/test source files match the frozen container by SHA-256. The eleven standard files are `files`, `file-tabs`, `keyboard-responsive`, `visual`, `accessibility`, `file-previews-live`, `settings-navigation`, `terminal-controls`, `live-server`, `markdown` and `chat`.

ACT-01 acceptance maps to the typed decorative SVG family (§13), the keyboard-operated secondary Options group (§15), retained text for ambiguous/consent actions, EN/FR accessible names and visible keyboard hints, explicit hover/pressed/disabled checks in `e2e/accessibility.spec.ts`, and the unchanged build limits above. Reader Copy/Download preserve their original operations. Current focused gates pass; the native capture failure and older global failures remain separate, not retroactively green.

**Still open:** visual review exposes the existing floating terminal launcher overlapping mobile/tablet composer controls, visible in both HEAD and current captures. ACT-02 remains open for that focused correction. Category Settings and final cross-surface/global qualification remain open; this lot does not claim physical-device verification.

## 17. Conversation Utility Placement — ACT-02 Qualified

The existing responsive scenarios checked horizontal overflow and explorer access, but did not detect a floating utility covering another control. Their new rectangle-intersection checks reproduce three defects: at 360px the terminal launcher covers Auto-compaction and Send; at 768px it covers the message composer; at 1024px it covers Send. The first test attempt used an incorrect accessible name and failed lookup in all three cases; the corrected name exposed these actual intersections.

`App` retains terminal visibility/authority and provides the same named control to `ChatView`. It now occupies normal composer flow, with an explicit non-submit button type and a 44×44px target. Loading, unavailable-session and empty states retain a flow-based entry; file Options and keyboard shortcuts are unchanged. The existing narrow terminal request still retires the file overlay without changing its saved preference.

The three geometry cases passed after placement. The existing keyboard scenario additionally verifies Tab from the composer, Enter opening Terminal, unchanged draft and no agent-run submission. EN/FR hint traversal follows the new normal Tab order. A 23-case accessibility/responsive/native-terminal group passed; visual review then found inherited primary-button paint on the new composer utility, corrected with neutral component-owned colors before final build/capture qualification. The existing mobile-keyboard scenarios previously covered Send/attachments and viewport ownership, not this launcher. Their new coarse-pointer bounds checks also fail on the retained pre-placement image in both Light and Dark: terminal bottom **764px**, outside the compact form ending at **492px**. The corrected source is being checked under the same controlled viewport signals; this is keyboard emulation, not Android/iOS device evidence. Build/budgets (149/160 KiB gzip), workspace/parity types and Web 71/617 pass. The additional keyboard generation passed **18/18**. Broad generation retained **232 passes / one capture-framing failure**: desktop-Light minimap normalization drifted 40px after the original pagination assertion had passed. A real pointer input now retires the pagination settling lease before capture-only positioning; the original anchor assertion and 1px framing tolerance remain unchanged, and the six owning captures passed after correction.

Visual review then exposed another existing collision: the minimap's fixed bottom offset covered the composer and its Back-to-bottom control. A new bounds assertion in the existing six scenarios failed on both desktop themes (**56.1875px** overlap) and both mobile themes (**121.109375px**); the two tablet cases passed. A shared flex message region now bounds the minimap without measuring the composer or changing pagination, scrolling, export or navigation actions. All six cases pass after this correction, and reviewed desktop/mobile captures show the composer and Back-to-bottom control unobscured.

Capture reconciliation retains 101 changed images after restoring ten unrelated task-generated raster variations (2–57 pixels, maximum channel delta 1). Reviewed ordinary/compact mobile composers, active-agent controls, empty reader footers and desktop/mobile minimaps show the corrected placement; existing theme and real-preview captures retain their content semantics.

### Final frozen-source verification

| Gate | Result |
|---|---|
| Production build / workspace-parity types / Web units | PASS; 71 files / 617 tests; budgets 149/160 KiB gzip entry/eager, 28 chunks |
| Fourteen standard/related browser files | **255/255 PASS**, 8.0m |
| Workspace asset loading, owning configuration | **17/17 PASS**, 14.1s |
| Linked directories/modal boundary, owning configuration | **44/44 PASS**, 4.2m |
| Settings locale asset loading, owning configuration | **8/8 PASS**, 12.6s |
| Pane lifetime, owning configuration | **18/18 PASS**, 20.2s |

The **342 distinct browser cases** ran without retries or snapshot updates, in Docker with 1 GiB shared memory. The fourteen-file campaign extends §16's eleven files with `mobile-keyboard`, `performance` and `selection-anchor`; it verifies the final message-region wrapper as well as launcher placement. Eight changed source files match the frozen container by SHA-256. Earlier failed runs and the capture-generation distinction remain retained.

ACT-02 acceptance combines §11/§15's actual Tab/Enter/Space upload, arrow-key resizing, visible focus/mention and coarse-pointer file journeys with §16's minimum-target/name checks and this lot's responsive non-overlap, 44px terminal, no-submit and keyboard-viewport controls. The minimap keeps all its actions while respecting the composer boundary. This closes the defined input/control criterion, not a physical-device or whole-application accessibility certificate.

**Open at this increment (subsequently repaired in §18):** the new keyboard captures expose a remaining VIS-01 gap: `hooks/mobile-keyboard.css` hard-codes the compact primary action to red/white instead of consuming the shared action tokens. Its contrast is not the issue; token ownership and consistency still require correction before Settings work.

## 18. Palette Remainder and Inventory — VIS-01–03 Verified

The remaining source review found two control/text overrides: compact keyboard Send used fixed red/white, and `CacheNotices.tsx` forced a pale foreground on the themed notice surface. Existing mobile-keyboard scenarios covered geometry/axe but not action-token ownership; the seven shared-theme cases did not contain a cache notice. Those scenarios now reuse the existing contrast fixture and a synthetic cache notice, without new test cases or live accounts.

The nine initial red cases separate **two action-role mismatches**, **five notice-role mismatches**, and **two actual notice contrast failures**: Light and System Light measured **1.0150394989:1** against the unchanged 4.5:1 threshold. Compact Send now consumes `--accent`/`--on-accent`; notices consume `--text-primary`, preserving their existing surface, text, derivation and billing. The corrected generation passed seven theme cases and eighteen mobile-keyboard cases. The strengthened final theme scenario also requires the notice to be fully in the viewport before measuring it.

### Reviewed token ownership

`themes.css` defines forty shared roles, loaded before component styles. Dark is the root palette; Light overrides its roles, Mist/Rose/Pine override their surfaces/borders while retaining readable Dark text/status roles, and preferences resolve System to Light/Dark without removing any saved choice.

| Role family | Ownership and evidence |
|---|---|
| Six base surfaces plus success/warning/danger surfaces | Shared shell, Settings, explorer, reader, dialog and card consumers; browser-computed role checks in the seven theme cases |
| Primary/secondary/link text, subtle/control borders, focus | Normal text ≥4.5:1; essential control boundaries/markers ≥3:1; reader hover/focus/selection and shared Settings/control checks in §11–12 |
| Accent/on-accent and three status foregrounds | Filled-action text is distinct from the higher-contrast link/indicator role; native indicators and the newly corrected compact action are checked |
| Four syntax aliases and sixteen ANSI roles | Chat syntax is verified with the explorer closed; reader syntax and all command-output classes retain rendered contrast checks |
| Deliberate non-token content/shading | Independent terminal themes, generated Mermaid artwork, PDF/document canvases, shadows and dimming backdrops remain separate; this is not an emulator or renderer redesign |

CSS and JSX literal-color review after the two repairs found no additional competing control/text override in the audited chrome; the retained content/shading exceptions are explicit above. Ten intended captures remain: seven theme-shell notices and three compact-keyboard views. All five explicit shell palettes and both System resolutions were reviewed, alongside compact Light/Dark and the loopback root view. One unrelated generated desktop-keyboard image was restored (12 pixels, maximum channel delta 1).

### Final frozen verification

Build/budgets (149/160 KiB gzip, 28 chunks), workspace/parity types and Web **71/617** pass. The container retains canonical **1 GiB shared memory**. Every final browser invocation used `--retries=0 --update-snapshots=none`:

| Owning suite | Result |
|---|---|
| Fourteen standard/related files, including theme/reader/state and keyboard scenarios | **255/255 PASS**, 8.0m |
| Workspace assets | **17/17 PASS**, 15.6s |
| Linked directories/modal boundary | **44/44 PASS**, 4.2m |
| Settings locale assets | **8/8 PASS**, 13.1s |
| Pane lifetime | **18/18 PASS**, 21.4s |
| **Distinct owning total** | **342/342 PASS** |

Each dedicated suite used its owning configuration. After all runs, all four changed source files and **304 tracked PNGs** were SHA-256-equal between checkout and container. Logs, reports/results and source/image manifests remain under `/tmp/aih-web-design-palette-remainder-*`; this is frozen bounded evidence, not a whole-application campaign or physical-device certification. No retry, timeout, threshold, budget or runtime-flag relaxation was introduced.

### Criterion reconciliation

| Criterion | Acceptance evidence |
|---|---|
| VIS-01 — semantic inventory and consumption | The forty-role inventory above, §11–12 shared/reader consumers, and browser-computed role checks now also covering the omitted compact action and cache notice. Explicit content/shading exceptions are retained, not competing chrome palettes. |
| VIS-02 — identified contrasts and states | §11's original syntax/Git/frontmatter reds and corrections; §12 normal text/control/marker checks; reader hover/focus/selection and §16 pressed/disabled evidence; the new Light/System Light notice red and correction. The final owning campaign re-executes those checks at unchanged 4.5:1 text and 3:1 essential-indicator thresholds. |
| VIS-03 — every selectable theme | The existing seven reader/source and seven shared chat/Settings scenarios pass again, with reviewed captures for Light/Dark/Mist/Rose/Pine and both System resolutions. The preference choices/resolver remain intact; no saved theme is deleted. |

VIS-01–03 are **DONE** on that mapping, not on generation alone. VIS-04 remains PARTIAL pending the completed Settings presentation and final desktop/mobile review. Category Settings and QA-01/global qualification remain open; historical failures in earlier increments are not erased by this campaign.

## 19. Category-Modal Settings Foundation — Partial Delivery

This increment follows §5 without adding providers or changing service authority. `SettingsView.tsx`, `settings-categories.ts` and `settings.css` present seven labeled native category links with current-state underline, a centered desktop dialog and a full-screen mobile category picker. All fifteen section hashes remain valid. Hidden-but-mounted category bodies preserve volatile drafts and pending operations; workspace id/cwd/both-trust replacement still retires them. Navigation v1 adds only optional validated same-category section metadata, retaining existing bounds and rejecting inherited/mismatched values. Hashless restored entries gain a stable history target before category navigation; peer metadata updates never navigate the mounted category.

### Ownership and feedback repairs

- Ready modal publication, rather than chunk/locale loading, owns background inertness. The separately portaled command palette suspends Settings only after it mounts; Escape while its import is pending cancels that request before Settings dismissal.
- Entry restoration ignores its own dialog's initialization focus but still yields to real pointer/key intent. Desktop category outlines are inset rather than clipped by the navigation overflow container. Hidden MCP/import/profile editors relinquish focus/Escape leases and reactivate their preserved drafts when presented again.
- Provider-key success/error feedback stays in the corresponding row, not hidden General authentication. Authentication has independent status. Editing a key clears only that row's feedback; no secret is autosaved.
- A stable `StatusCenter` portal host moves into/out of Settings without replacing notice DOM or restarting timers. Notices stay accessible and dismissible in bounded dialog flow rather than underneath an inert backdrop. Existing pause/dismiss behavior remains intact.

### Retained development evidence

The existing navigation, Settings, defaults, chat and boundary scenarios were extended before their repairs. Retained reds cover absent modal/initial restoration, delayed palette ownership, peer-navigation drift, hidden provider feedback, native-picker theme roles, inaccessible notices, clipped category focus and hidden editor traps. The first eager-copy build exceeded the unchanged 516,096-byte entry cap by 120 bytes; moving category copy into the existing lazy dictionaries repaired it. A missing scoped `presented` forwarding caused TS6133/TS2304 and was corrected before the subsequent build/types/Web 71-file/617-test pass. Budgets remain 149/160 KiB gzip entry/eager with 28 chunks.

Navigation generation passes 12/12; the child-editor check passes 1/1. The dedicated pane suite initially retained six old nonmodal/cross-category journeys; real category selection and available palette nesting replace inaccessible sidebar actions, with all original visibility, focus, IME, route and no-mutation checks retained. Corrected owning suites pass pane 18/18, linked 44/44, workspace assets 17/17 and locale assets 8/8. Expanded Settings-related generation passes 115/115. These are overlapping bounded campaigns, not a summed global pass count.

Visual generation retained 123 passes and six plugin-framing failures; assertions now measure actual modal scroll extent at the unchanged subpixel tolerance, and all six corrected cases pass. Initially, seventy-one task-owned captures were reviewed and reconciled: 53 visual Settings/modal captures, eight defaults crops (including four stale pre-palette/pre-terminal composer references), six navigation crops and four actual-service administration crops. Nineteen unrelated generated differences were not adopted. MCP's expanded inventory is explicitly a full-content artifact, not native mobile-viewport evidence. The visible long General form and resource cards remain unfinished presentation work, not accepted final design.

The 45-case synthetic-credential/loopback campaign retained 42 passes and three failures: two cache-notice assertions still demanded the pre-semantic fixed foreground, and one native signed MiniMax case reported `Target crashed`. The cache cases now check actual theme roles and unchanged 4.5:1 contrast and pass 2/2. No runtime cause is inferred for the crash. Provider/replay/privacy assertions remain intact; UI journeys close Settings before using the inert sidebar.

### Qualification boundary and remaining work

A complete Docker-filtered context was exported before building the qualification image, including nested package documentation; its 2,610-file manifest is distinct from the subsequently regenerated build outputs. The first frozen campaign used canonical 1 GiB shared memory, owning configurations, no snapshot updates and zero retries. Its standard gate finished at 312/331: sixteen capture failures exposed omitted MCP/keyboard/model/resource baseline reconciliation; one accessibility journey still expected all categories visible simultaneously; a child-agent accessibility worker exited with SIGSEGV and Chromium terminated with `stack smashing detected` during MCP OAuth axe analysis. All nineteen failures remain recorded. The accessibility journey now visits every category for actual Light/Dark axe/control checks and passes in 18.9s without changing its timeout. Twenty-four additional OAuth/model/resource crops were then reviewed and reconciled. Reviewing the five short-keyboard MCP crops also exposed clipped content; their replacement uses the real modal viewport with explicit field/Preview visibility rather than an expanded or occluded locator crop. Initial end alignment exposed fractional clipping in three mobile cases (Preview ratio 0.997632622718811); eight pixels of real scroll clearance now preserve both the focused field and Preview at the unchanged 100% visibility threshold. All five corrected keyboard cases pass generation, and their native-view captures were reviewed, bringing reconciliation to 100 images. The first frozen live campaign passes 45/45, with pane/linked/workspace/locale 18/44/17/8 also passing: 444 passes and nineteen failures across 463 distinct cases, not a successful global campaign. The second complete-context image again passes build/types/Web 71/617, but its standard Playwright process exits 139 before any cases start. The five subsequent suites refuse the occupied 3080/3099 ports; these are setup failures, not executed tests. Process evidence was retained and only that task-owned container was stopped. New bounded checks use one isolated container per owning suite, preventing an orphaned listener from contaminating the next configuration; no server-reuse flag, retry or timeout increase is introduced. Their results remain separate from both failed campaigns; no successful global campaign is claimed. Local logs, captures, results and manifests use `/tmp/aih-web-design-settings-categories-*`.

### Final bounded foundation checks

The corrected frozen image passes production build/budgets (149/160 KiB gzip entry/eager; 28 chunks), workspace/parity types and Web units (71 files / 617 tests). Each browser group below owns a separate container with 1 GiB shared memory, zero retries and no snapshot updates:

| Owning configuration | Result | Duration |
|---|---:|---:|
| Eleven standard Settings/defaults/batches/navigation/MCP/i18n/chat/accessibility/keyboard files | 142/142 | 4.6m |
| Pane lifetime | 18/18 | 21.7s |
| Linked directories/modal boundary | 44/44 | 4.2m |
| Workspace asset loading | 17/17 | 16.6s |
| Settings locale asset loading | 8/8 | 15.1s |
| **Distinct bounded total** | **229/229** | — |

The complete Docker-filtered export records 2,610 inputs, all equal to the host at freeze. All five final containers preserve the 1,958 immutable inputs byte-for-byte, including modes and symlink targets; 652 regenerated build-output inputs are separately classified, not misrepresented as immutable. All 55 changed product/test source files and all 306 E2E baseline PNGs match those inputs. The 100 reviewed changed images are uniquely recorded by SHA-256; no unreviewed changed baseline remains. These bounded results validate the partial modal/category foundation, not the nineteen first-campaign failures, the second campaign's startup failures, physical devices, complete Settings acceptance or global QA-01.

### Still required

PREF-01 is **PARTIAL**, not DONE. Contextual entity list/detail views, flat resource rows, General Appearance/Behavior/Notifications/Access/About subpanels, explicit dirty-close/context-navigation confirmation and complete retirement/acceptance evidence remain required. Current close still discards component drafts; category conservation is not universal dirty protection. PREF-02–04 and VIS-04 remain PARTIAL, QA-01 IN PROGRESS, and closure stays 10/16 (62.5%). General subpanels are subsequently implemented in §20; that does not retroactively complete this foundation.

## 20. General Contextual Panels — PREF-04 Verified

General now exposes exactly Appearance, Behavior, Notifications, Access and About. Defaults/shortcuts are grouped under Behavior and sessions under About; all fifteen historical hashes remain valid, with `behavior` and `notifications` extending the existing bounded v1 whitelist to seventeen. Desktop uses native contextual links and current-state markers. Mobile uses an explicit General overview/Back control with keyboard focus handoff. Hidden mounted bodies preserve token/default-model drafts across panels without writes or secret persistence. Immediate preferences, explicit configuration saves, local-notification permission handling and independent Push consent/event categories retain their original handlers. Five new bilingual labels stay Settings-lazy.

### Focused gaps, failures and visual review

Existing preference scenarios covered the combined form, not separation, contextual keyboard navigation or checkbox geometry. Four EN/FR desktop/mobile Light/Dark scenarios and the existing Push scenario initially failed **5/5** against the old layout. The first implementation passed one and timed out four times because an exact Theme label matcher excluded its option text; a bounded prefix matcher repaired that lookup without changing timeouts. Subsequent focus/history/contrast/consent checks pass **5/5**. Exact locale-inventory tests initially failed on the new Push-label class and sessions h3-to-h4 move; explicit source projections preserve the literal/ownership assertions. Related development coverage retained **98 passes / five failures** from Defaults journeys still opening the default Appearance panel; those journeys now address `#defaults` explicitly, preserving save/readback/security assertions.

Controls/defaults generation passes **10/10** and selected visual generation **19/19**; review-only preference checks pass **4/4**. Visual review nevertheless found a clipped French mobile send-mode selector despite a passing page-width check. New select/range assertions against the actual section's padded bounds reproduce **−46px** against the unchanged **−0.1px** tolerance. Scoped `min-width: 0` on preference-grid labels/selects repairs that overflow; preference/Push checks pass **5/5** without snapshot updates. Checkbox labels now remain horizontal with 24px desktop/44px mobile minimum heights. Appearance/Behavior attachments were reviewed in all four scenarios; only the repaired French mobile Behavior image changed afterward.

Initially 29 intended baseline changes were reviewed and reconciled: six new Notifications/mobile-overview images, four Defaults, six Appearance, seven theme-Settings and six About/update images. One unrelated Pine shell variation was excluded. The first frozen live campaign exposed four additional Defaults readback crops whose width/position changed with General navigation; all four were reviewed, generation passes **4/4**, and its bytes equal the reviewed failed-run actuals. The accepted manifest therefore contains **33** changes. These captures do not qualify physical devices or unfinished entity layouts.

### Frozen campaign boundary

The complete Docker-filtered context records **2,616** inputs, equal to the host at freeze, including nested documentation. Build/budgets pass at **149/160 KiB gzip**, 28 chunks; workspace/parity types and Web **71 files / 619 tests** pass. The standard browser launcher exits **139 before cases begin**. The separate synthetic-credential/loopback suite finishes **38 PASS / 7 FAIL of 45**: one Moonshot worker SIGSEGV, two reasoning-budget journeys opening default Appearance rather than `#defaults`, and four unreconciled readback crops. The corrected reasoning journeys pass **2/2**, preserving native parent/child request and authority assertions. No cause is inferred for either native failure.

Pane lifetime retains **17 PASS / 1 FAIL of 18**: an instantaneous focus-containment read after nested-folder dismissal returned false. The existing hook schedules restoration on `requestAnimationFrame`; the assertion now awaits the same containment predicate with the existing default timeout, without changing focus machinery or accepting a different destination. The corrected bounded pane suite passes **18/18**. The first campaign's remaining owning suites pass linked **44/44**, workspace assets **17/17** and locale assets **8/8**: **124 PASS / 8 FAIL across 132 executed cases**, separate from the standard startup failure. All six containers retain the **1,964 immutable inputs** with no hash/mode/link mismatches; **652 regenerated build inputs** are explicitly classified. Corrected-source results follow separately below. Every qualification invocation uses its own Docker container, **1 GiB shared memory**, owning configuration, **zero retries and no snapshot updates**. Generation remains separate. Logs, results and manifests are retained under `/tmp/aih-web-design-settings-general-*`.

### Corrected frozen-source results

A fresh complete-context image again passes build/budgets, workspace/parity types and Web **71/619**. Each owning selection uses its own container and the same no-update/no-retry/1 GiB policy:

| Owning selection | Result | Duration |
|---|---:|---:|
| Settings/navigation/defaults/chat/i18n/accessibility/full visual | 232/232 PASS | 6.1m |
| Synthetic-credential/loopback provider and administration journeys | 44 PASS / 1 FAIL of 45 | 4.7m |
| Pane lifetime | 18/18 PASS | 21.9s |
| Linked directories/modal boundary | 44/44 PASS | 4.2m |
| Workspace assets | 17/17 PASS | 17.3s |
| Settings locale assets | 8/8 PASS | 15.3s |
| Mobile keyboard, responsive keyboard, administration, model/resource batches and MCP selection | 46 PASS / 1 FAIL of 47 | 1.8m |
| **Distinct owning total** | **409 PASS / 2 FAIL of 411** | — |

The live French/Dark desktop administration case passes its Defaults readback capture and model batch assertions, then reports **`page.reload: Page crashed`** at line 129 before the remaining reload/package assertions. The additional eager-editor keyboard case reports **`page.goto: Page crashed`** at line 372 before its interaction journey. Both failures remain open and unexplained; no successful global campaign, later-stage assertions or repair of earlier native failures is inferred. No unchanged failed case was retried to obtain a green aggregate.

All seven final containers preserve **1,964 immutable inputs** from the **2,616-entry** context; **652 regenerated build inputs** remain separately classified. All **17 changed product/test sources**, **312 E2E PNGs**, and all **342 repository PNGs included in the context** match their frozen hashes/modes. The other **20 repository PNGs** are Docker-excluded and unchanged against HEAD. All **33 changed captures** match the reviewed manifest; the unrelated Pine shell image remains untouched. Root documentation is Docker-excluded and checked separately; nested documentation present in the exported context is included in immutable validation. Documentation lint passes **110 Markdown files / 1,621 links**, criterion counts reconcile to sixteen unique IDs, and whitespace checks pass.

### PREF-04 acceptance mapping

| Requirement | Evidence |
|---|---|
| Separate visual appearance, behavior and notifications | `SettingsView.tsx` presents only the selected General panel; the four preference scenarios verify hidden alternatives, native history, reload and retained values. Appearance contains no checkbox or send-mode control. |
| Horizontal checkbox/switch labels | The same four scenarios measure caption gap ≥4px, vertical-center difference ≤3px and 24px desktop/44px mobile label heights; actual select/range containment reproduces and repairs the French overflow without relaxing bounds. |
| EN/FR desktop/mobile visual review | Reviewed Appearance/Behavior attachments for all four locale/viewport scenarios, four Notifications baselines, two mobile General overviews and the owning Appearance/theme captures; keyboard selection, visible focus/3:1 markers, axe and mobile Back handoff also pass. |
| Unchanged browser permission and Push consent | The local-notification permission handler and Push configuration handlers are preserved; the existing synthetic Push journey verifies zero permission requests before explicit activation, then consent, independent event categories and unsubscribe. These are simulated browser-service controls, not real-account or physical-device evidence. |

PREF-04 is **DONE** on this mapping. PREF-01–03 and VIS-04 remain **PARTIAL**, QA-01 **IN PROGRESS**: other contextual entity lists/details, flat rows, dirty-close/context-navigation protection and complete retirement/global evidence are still required. Closure is **11/16 (68.75%)**, not complete Settings or application qualification.

## 21. MCP Contextual List and Detail — Partial Settings Delivery

This increment starts from `d201e014e37931b471ebfec207ace6d013460fea`, with ten changed product/test sources and eighteen reviewed baseline replacements. `McpSettings.tsx` separates flat scope/name navigation rows from the selected detail on desktop. Mobile alternates list/detail with explicit Back and focus handoff. Native buttons expose current/expanded/control relationships and transport/configuration-state descriptions, semantic selected/focus markers and disabled feedback. Existing bounded selection metadata, fresh inventory/config-key admission, trust/revision checks and Test/OAuth/import/mutation handlers remain authoritative. Unselected cards stay hidden but mounted, retaining volatile OAuth callback drafts across server selections without storing them. This adds no execution, login or configuration authority.

### Reused coverage, retained failures and review

The existing two EN-desktop/FR-mobile `mcp-selection.spec.ts` scenarios covered selected details and persistence but not a separate named list, side-by-side geometry or mobile Back/focus. Strengthening them before implementation produced **2/2 RED** for the missing navigation. The first implementation passed one and failed one because retained hidden metadata was queried through an accessibility-visible locator; `includeHidden` now applies only to metadata inspection, never forced interaction. The eight-case selection suite then retained **7 PASS / 1 FAIL** from an obsolete unselected-server Test journey; explicit real selection repaired it to **8/8**. Scope/history/trust, no implicit Test/execution, axe and unchanged contrast checks remain.

The first broader MCP development selection retained **27 PASS / 21 FAIL of 48**: stale all-visible/card-nesting journeys, expected capture changes and two `/mcp` focus failures. Journeys now choose their actual contextual row before operating, without relaxing request/readback/privacy assertions. OAuth scenarios additionally preserve a pasted callback across server selections, assert no redirect submission before explicit activation and exclude the callback code from local storage. The two unchanged `/mcp` focus cases also fail on the preceding General release image. `settings-navigation.ts` now allows its own dialog's initialization focus to refine to the addressed MCP section, using the same owned-entry predicate in restoration and intent detection; real newer-intent/competing-modal guards remain. Both cases pass after repair (**2/2**, 8.7s).

Ready development build/types/Web **71/619** pass, selection passes **8/8** (19.4s), and related capture generation passes **48/48** (1.5m). A later strengthened pending-Test assertion independently reproduces missing disabled feedback (**1/1 RED**, opacity 1 instead of 0.5). Scoped navigation disabled styling repairs it; all eight selection cases pass again (**20.4s**, no updates), followed by separate visual/keyboard generation **8/8** (29.6s). These overlapping generations/development passes are not summed into distinct qualification.

All **18** adopted Docker-generated replacements were reviewed: eight OAuth authorize/connected crops, four hidden-tool exposure crops, two desktop keyboard-MCP native-dialog captures and four MCP inventory images. The final OAuth/exposure/keyboard bytes equal the previously reviewed generation; the final inventory captures include the disabled-state refinement. Both final EN-desktop/FR-mobile contextual attachments were also reviewed. Inventory images deliberately expand the scroll container for complete-content inspection; they are not native viewport evidence. Keyboard captures retain actual dialog framing and unchanged 100% field/Preview visibility assertions. No unrelated baseline is adopted.

### Frozen qualification boundary

The complete Docker-filtered context contains **2,616 inputs**, equal to the host at freeze, including nested documentation. Production build/budgets pass at **149/160 KiB gzip** entry/eager with **28 chunks**; workspace/parity types and Web **71 files / 619 tests** pass. Each browser selection uses its own container, **1 GiB shared memory**, **zero retries and no snapshot updates**, on image `sha256:5cb11550de38e2d4b8226bf408577fca462b426e798c97bdeb26683adf0a47e7`. Logs, results and manifests remain under `/tmp/aih-web-design-settings-mcp-context-*`; development generation is separate.

| Owning selection | Result | Duration |
|---|---:|---:|
| Fifteen standard Settings/navigation/MCP/keyboard/batch/accessibility/visual files | 289 PASS / 2 FAIL of 291 | 8.4m |
| Synthetic-credential/loopback provider and administration journeys | 45/45 PASS | 4.6m |
| Pane lifetime | 18/18 PASS | 22.0s |
| Linked directories/modal boundary | 44/44 PASS | 4.2m |
| Workspace assets | 17/17 PASS | 17.3s |
| Settings locale assets | 8/8 PASS | 14.3s |
| **Distinct owning total** | **421 PASS / 2 FAIL of 423** | — |

The standard selection includes `settings`, `settings-navigation`, `defaults`, `chat`, `i18n`, `accessibility`, `visual`, `mcp-selection`, `mcp-exposure`, `mcp-inheritance-live`, `mobile-keyboard`, `keyboard-responsive`, `settings-administration`, `model-batches` and `resource-batches`. Both failures are **worker process exited unexpectedly (code=null, signal=SIGSEGV)**: the desktop-Dark Process/ANSI/extension-form visual case at `e2e/visual.spec.ts:749`, and the mobile-Dark versions/release-notes case at line 864. The inner failure stage/cause is not established; no unchanged failed case is rerun to obtain a green aggregate. The MCP, navigation and owning lifetime checks pass, but the broader campaign remains failed.

All six final containers retain **1,964 immutable inputs**, including file modes and symlink targets, with zero mismatches; **652 regenerated build inputs** remain separately classified. All **ten changed product/test sources**, **312 E2E PNGs** and **342 context-included repository PNGs** match the frozen inputs. The other **20 repository PNGs** are Docker-excluded and unchanged against HEAD. All **eighteen changed captures** match the reviewed manifest, and both frozen native-context attachments are byte-identical to their reviewed development counterparts. Root documentation remains Docker-excluded and separately checked; nested included documentation remains immutable. Documentation lint passes **110 Markdown files / 1,621 links**, the sixteen unique criterion counts reconcile, and whitespace checks pass.

No additional criterion is closed by this MCP increment. PREF-01–03 and VIS-04 remain **PARTIAL**, QA-01 **IN PROGRESS** and closure **11/16 (68.75%)**. Other entity contexts/flat rows, dirty-close/context-navigation protection, complete retirement evidence and final global qualification remain required. Earlier native and failed global campaigns remain unexplained rather than being cleared by this partial delivery.

## 22. Child-Agent Profile List and Detail — Partial Settings Delivery

This increment starts from `76e20870ed51a86cd3d83aa3baf624363051fce6`, with seven changed product/test sources and ten reviewed baseline replacements. `SubagentSettings.tsx` retains engine/scope/filter/create controls and separates flat profile navigation from the selected detail on desktop. Mobile uses explicit Back/current-row focus handoff. Existing bounded cwd navigation metadata restores only a fresh unique visible ID in the matching target scope; unavailable or filtered explicit choices never silently select another profile. Actual row actions establish selection before their original handlers, preventing a filtered implicit selection from drifting when the filter clears. Scope changes and the existing Settings authority key still retire the scoped component; the editor, permissions, API payloads and explicit writes remain unchanged. New Back/unavailable copy stays lazy in `subagent-settings-messages.ts`.

### Focused gaps, retained failures and visual review

The existing six visual cases protected the long profile form, not named contextual navigation, selected detail, mobile handoff or actual focus-outline clearance. Strengthening those cases for EN/Light and FR/Dark at desktop 1440, tablet 820 and mobile 390 widths produced **6/6 RED** before implementation. The first build/types/Web **71/619** pass retained **3 PASS / 3 expected capture failures**. The first Settings CRUD/native selection retained **two failures**: an obsolete all-visible created-profile journey and an unexplained native worker **SIGSEGV**. Explicit real-row selection repairs the hidden-control journey; corrected operations retain **1 PASS / 1 FAIL**, the latter an old native child-panel capture differing by **103 pixels** before profile CRUD. No hidden control is force-clicked and no native failure cause is inferred.

Separate profile generation passes **6/6** (19.2s), related navigation/accessibility/child-lifetime checks **25/25** (1.3m), and strengthened pending-toggle disabled/keyboard checks **7/7** (21.2s). Native lifecycle generation passes **5/5** (43.3s). All six profile images and four native child-panel images were reviewed; the native references predated the existing semantic palette/icon chrome and are reconciled separately from profile layout and the retained crash. The native English desktop CRUD journey now also verifies that deleting the selected copy leaves no visible profile article, reports the unavailable choice and requires explicit selection to recover.

Additional owning regressions reproduce lost Plan selection after clearing a filter (**1/1 RED**) and a clipped mobile-Light focus outline despite 100% button visibility (**−2.921875**, unchanged **−0.1px** clearance tolerance). Establishing explicit selection before row actions and insetting contextual button outlines repairs those defects. The next seven-case check retains **6 PASS / 1 FAIL**: the French mobile checkbox outline still exceeds the actual Settings viewport by **3.03125px**. Its already-queued generation retains **5 PASS / 1 FAIL** on the same assertion; neither is counted as successful qualification. A scoped eight-pixel checkbox scroll margin preserves the original native outline and repairs the remaining clearance (**1/1**, 7.0s). All seven controls then pass without updates (**20.0s**), followed by separate six-case generation (**19.8s**). The actual four tablet/mobile detail attachments were reviewed with fully visible focus outlines. Ready native **5/5** (43.1s) and related **25/25** (1.3m) runs remain separate, overlapping development evidence.

While the first frozen campaign was running, source review identified a remaining focus-lifetime gap: reactivating an unchanged desktop profile left a pending handoff that later stole filter focus on a mobile resize. Both strengthened desktop cases reproduce it (**2/2 RED**). Only mobile row activation now schedules the handoff; the seven controls pass (**21.4s**, no updates), followed by separate generation **6/6** (**20.1s**). All six final profile PNGs are byte-identical to the previously reviewed generation. The first campaign remains tied to its older source; it cannot qualify this later repair. No timeout, accessibility threshold, snapshot tolerance or bundle budget was weakened, and these overlapping development/generation runs are not summed into a distinct qualification count.

### Frozen source boundaries

The first image, `sha256:6a781d8aba1e36802826b22560c97df9ce0f357f289d3db75e40b5b4cee543a5`, completes **432/432** source-local owning cases: standard **300** (9.4m), synthetic-credential/loopback live **45** (4.6m), pane **18** (22.3s), linked **44** (4.2m), workspace assets **17** (18.4s) and locale assets **8** (14.9s). It predates the same-selection resize assertion/repair and therefore does not qualify the final source. The later two-case red remains evidence of the uncovered defect, not erased by that broad pass. Its build/types/Web **71/619** pass, and all seven containers retain **1,965 immutable inputs** from **2,617** exported entries, with **652 regenerated build inputs** separately classified and zero hash/mode/link mismatches. Logs, images, results and manifests remain under `/tmp/aih-web-design-settings-subagents-context-*`.

The corrected image is `sha256:0558cc9da603174c991f4075850397e630d9035b798e389f934cf4db1ff16476`, exported separately under the `-release-*` prefix. Production build/budgets pass at **149/160 KiB gzip** entry/eager with **28 chunks**; workspace/parity types and Web **71 files / 619 tests** pass. Every owning browser selection uses its own container, **1 GiB shared memory**, **zero retries and no snapshot updates**:

| Owning selection | Result | Duration |
|---|---:|---:|
| Seventeen standard Settings/navigation/MCP/profile/keyboard/batch/accessibility/visual files | 299 PASS / 1 FAIL of 300 | 9.5m |
| Synthetic-credential/loopback provider and administration journeys | 45/45 PASS | 4.6m |
| Pane lifetime | 18/18 PASS | 21.8s |
| Linked directories/modal boundary | 44/44 PASS | 4.2m |
| Workspace assets | 17/17 PASS | 18.0s |
| Settings locale assets | 8/8 PASS | 14.7s |
| **Distinct corrected-source total** | **431 PASS / 1 FAIL of 432** | — |

The standard selection retains §21's fifteen files and adds `e2e/subagent-lifecycle-live.spec.ts` and `e2e/subagent-lifetime.spec.ts`. Its desktop-EN-Light General preference case at `e2e/settings.spec.ts:1056` reports **`Error: worker process exited unexpectedly (code=null, signal=SIGSEGV)`**. The inner failure stage/cause is not established. No unchanged failed case is rerun to manufacture a green aggregate, and the earlier source's pass does not clear this failed campaign. The owning profile, actual child lifecycle and lifetime cases pass on the corrected source; this is not whole-application or physical-device qualification.

All seven corrected-source containers retain **1,965 immutable inputs** from **2,617** exported entries, including nested documentation, modes and symlink targets; **652 regenerated build inputs** remain separately classified. There are zero mismatches; all containers are stopped and report `OOMKilled:false`, which does not diagnose the worker failure. All **seven changed product/test sources**, **312 E2E PNGs** and **342 context-included repository PNGs** equal the freeze. The other **20 repository PNGs** are Docker-excluded and unchanged against HEAD. All **ten changed captures** match the reviewed manifest, and all four frozen tablet/mobile detail attachments are byte-identical to the reviewed controls. Root documentation is Docker-excluded and checked separately. Documentation lint passes **110 Markdown files / 1,621 links**, the sixteen unique criteria reconcile, and whitespace checks pass.

No additional criterion is closed. PREF-01–03 and VIS-04 remain **PARTIAL**, QA-01 **IN PROGRESS**, with closure **11/16 (68.75%)**. Other entity contexts/flat rows, dirty-close/context-navigation protection and final retirement/cross-surface qualification remain required. Historical native failures and failed campaigns remain explicitly open.

## 23. Package List and Detail — Partial Settings Delivery

This increment starts from `96928de545cac967a9fb36dd1035851bc59cd5bd`, with thirteen changed product/test sources and six reviewed capture replacements. `PluginSettings.tsx` presents flat Project/Global package navigation beside selected detail on desktop, and separate list/detail views with Back on mobile. Existing bounded cwd metadata restores only a fresh unique visible scope/key pair; filtered or missing explicit selections report unavailable rather than silently substituting another package. Implicit selection follows rendered Project-then-Global order. Per-package actions establish presentation intent before their original handlers. Installation drafts and still-listed native disclosures survive category/entity navigation without browser persistence. New Back/unavailable copy stays Settings-lazy in `plugin-settings-messages.ts`.

Install, check/update, scoped enable/disable, reload, confirmed removal, epoch/readback/trust guards and skill-catalogue hydration retain their existing handlers and authority. Scoped batch controls remain in the navigation and apply to all filtered packages in that scope, not merely selected detail. Standalone extensions remain a separate readonly catalogue. Only mobile row activation schedules focus handoff. MCP, child-profile and package Back controls now focus an enabled current row or their named navigation when pending work disables that row; the fallback adds no normal Tab stop and uses an inset visible outline.

### Focused gaps, retained failures and reviewed captures

The six existing catalogue captures did not cover named contextual navigation, selected detail, mobile Back/focus, actual outline clearance or passive same-selection resize. Strengthening them for EN/Light and FR/Dark at 1440/820/390 widths first produces **6/6 RED** on missing navigation. The first implementation passes build/types/Web **71/619** and retains **3 PASS / 3 expected capture failures**. Reviewing the actual desktop image exposes ineffective selected-border styling: the intended three-pixel marker is only **1px** because generic button rules win. A computed-width assertion reproduces all six failures rather than lowering the threshold.

Existing held-request tests checked disabled choices but not Back focus in that state. The MCP Test and profile-toggle cases both reproduce failed navigation focus: disabled current rows cannot receive it. The combined control run is **8/8 RED**. Scoped CSS specificity and the enabled-row-or-navigation fallback repair those defects. The pending pair passes **2/2** (9.4s); all six package behavioral assertions pass, with **3 PASS / 3 expected capture failures** retained separately (21.0s).

The first related journey selection retains **1 PASS / 4 FAIL of 5** (53.7s), exposing obsolete all-visible package access. The actual-row helpers in `e2e/fixtures/settings-navigation.ts` now expose mobile Back and select a named row within its real scope; no hidden action is force-clicked. Corrected six-case CRUD/administration/workspace checks retain **5 PASS / 1 FAIL** (20.0s): a new workspace correctly opens its independent General context, while the old journey still assumes Plugins is presented. Explicit category entry repairs that journey, yielding **6/6** (15.4s). The strengthened package scenario also preserves an unsaved installation source/native disclosure without storing the draft, checks pending disabled feedback/Back focus, and requires explicit recovery after selected-package deletion. Workspace navigation restores its own package choice without configuration writes.

Emitted-Server/static-Web administration separately passes **4/4** (19.3s), preserving filtered one-request batches, hidden enabled packages and canonical readback after an uncertain response. Related navigation/accessibility/MCP/profile-lifetime checks pass **33/33** (1.5m). Separate generation passes **6/6** (19.2s). All six generated package PNGs and four actual tablet/mobile detail attachments were visually reviewed before adoption; overview captures alone do not prove focused-detail geometry. Development and generation overlap and are not added to the frozen distinct count. No budget, timeout, contrast/geometry threshold or screenshot tolerance is relaxed.

### Frozen owning qualification

Image `sha256:c7707864d30ff7fb5da0231d86d43350cc4e080e3c5749a12c59d72a7130dc22` is built from a separately exported Docker-filtered context. Production build/budgets pass at **149/160 KiB gzip** entry/eager with **28 chunks**; workspace/parity types and Web **71 files / 619 tests** pass. Every browser selection has its own container, **1 GiB shared memory**, **zero retries and no snapshot updates**:

| Owning selection | Result | Duration |
|---|---:|---:|
| Eleven standard Settings/navigation/keyboard/MCP/lifetime/workspace/accessibility/visual files | 243 PASS / 1 FAIL of 244 | 7.3m |
| Native Settings administration | 4/4 PASS | 22.1s |
| Pane lifetime | 18/18 PASS | 21.6s |
| Workspace assets | 17/17 PASS | 17.3s |
| Settings locale assets | 8/8 PASS | 14.7s |
| **Distinct total** | **290 PASS / 1 FAIL of 291** | — |

The standard files are `settings`, `settings-navigation`, `accessibility`, `visual`, `mcp-selection`, `settings-administration`, `workspaces`, `subagent-lifetime`, `mobile-keyboard`, `keyboard-responsive` and `i18n` under `e2e/*.spec.ts`. The separate native selection is `e2e/settings-administration-live.spec.ts`; pane/workspace/locale use their owning configs. This bounded selection covers the changed presentation, retained package administration and focus/asset boundaries; unrelated provider-live and linked-modal campaigns are not silently repeated or counted as fresh evidence.

The `shared semantic surfaces: system-light` case at `e2e/visual.spec.ts:37` reports **`Error: worker process exited unexpectedly (code=null, signal=SIGSEGV)`**. Its inner failure stage and cause are not established. The campaign remains failed; no unchanged failed case is rerun to manufacture a green aggregate. The owning package and pending-focus cases pass, without clearing this failure or any historical campaign.

All six containers retain **1,966 immutable inputs** from **2,618** exported entries, including nested documentation, modes and symlink targets; **652 regenerated build inputs** are separately classified. There are zero mismatches; containers are stopped with `OOMKilled:false`, which does not diagnose the worker failure. All **thirteen changed sources**, **312 E2E PNGs** and **342 context-included repository PNGs** equal the freeze. The other **20 repository PNGs** are Docker-excluded and unchanged against HEAD. All six replacements match the reviewed manifest; the four frozen detail attachments are byte-identical to the reviewed generation. Root documentation is Docker-excluded and checked separately. Documentation lint passes **110 Markdown files / 1,621 links**; sixteen unique criteria, twenty-four topic entries/line estimates and whitespace checks reconcile. Logs, results, captures and manifests remain under `/tmp/aih-web-design-settings-plugins-context-*`.

No additional criterion is closed: **11/16 DONE (68.75%)**, PREF-01–03/VIS-04 **PARTIAL**, QA-01 **IN PROGRESS**. Remaining entity contexts/flat rows, dirty-close/context-change protection, retirement acceptance and final visual/global qualification stay open, together with the retained native failures.

## 24. Models Contextual Sections — Partial Settings Foundation

This increment starts from `81e78dbecfbce96338e806a557fc0376f7c4d174`. `SettingsView.tsx` and `settings-categories.ts` reuse General's contextual navigation owner for the four existing Models destinations: `providers`, `provider-lifecycle`, `model` and `custom-models`. Desktop shows named section links beside the selected content; mobile uses an overview and explicit Back with keyboard focus handoff. Historical hashes, category addressing and bounded v1 navigation metadata are unchanged. Hidden-mounted sections retain credential, provider-editor, catalogue-filter and custom-model drafts across panel/category changes without implicit writes or draft persistence. New EN/FR navigation/Back labels remain in the lazy Settings dictionaries.

This deliberately bounded foundation separates sections, not individual provider/model entities. Existing provider selection, credentials, OAuth, rename/canonical readback, model selection and scoped batch handlers remain unchanged. Provider/entity list-detail and flat-row layouts, legacy credential/editor presentation, dirty-close/context-navigation protection and complete retirement acceptance remain open. No new provider/account capability, persistence schema or universal Save is introduced.

### Focused gaps, retained failures and visual review

The existing navigation scenarios covered category restoration but not four contextual Models destinations or draft conservation between them. Two initial EN-desktop/FR-mobile reproductions fail **2/2** because the four links are absent; the first implementation passes **2/2**. The final four scenarios cover EN/Light and FR/Dark at 1280px and 390px: visible section entry/current metadata, retained volatile drafts, no implicit writes or secret persistence, keyboard Back/current-link handoff, 44px mobile links, contrast, actual outline clearance, overflow and native Back/Forward/reload.

Review exposes clipped shared General/Models Back focus despite button visibility. Strengthened mobile EN/FR assertions reproduce **2/2 RED at −5px** against the unchanged **−0.1px** detail-viewport clearance tolerance. A scoped inset outline repairs this without changing contrast or geometry assertions; the final four Models scenarios pass **4/4** (19.7s). Sixteen native panel attachments and two mobile focused-Back attachments were retained through `testInfo.outputPath`, visually reviewed and hashed. Earlier body-only attachments were not retained by the reporters and are not claimed as review evidence.

The first Web unit gate retains **618 PASS / 1 FAIL of 619** because its explicit lazy-locale projection omitted the two new labels. Extending only the post-inventory additions repairs that guard without regenerating historical copy. The first integration selection retains **66 PASS / 25 FAIL of 91** (6.7m): obsolete simultaneous-section journeys, expected capture changes and a stale paint-probe assumption. Tests now visit actual visible panels before selection, rename/readback, model batches or native subscription actions; hidden controls are never force-clicked. Restored-model Tab wraps to the dialog header rather than entering hidden Custom models. The historical custom-provider selector-boundary probe now explicitly supplies its original counterfactual accent (`#a12645`) and enters General/Behavior before dirtying Defaults; exact sizing and positive/negative paint assertions remain, and this injected-color probe is not native-theme visual evidence.

Corrected targeted controls pass **16/16** (1.7m). Separate model/provider/resource/restored-navigation generation passes **16/16** (52.1s), and catalogue/provider/custom-model generation passes **12/12** (22.4s). Ready no-update development checks pass related **93/93** (3.8m), native Codex/Copilot/Settings administration **8/8** (1.3m), pane lifetime **18/18** (22.7s), locale assets **8/8** (13.9s) and Models visuals **12/12** (20.9s). Native negative fixtures print `[Server] Request failed.` without failing their eight cases. These overlapping development/generation results are not frozen qualification or a summed distinct campaign.

All **36** adopted Docker-generated PNGs were reviewed: thirty replacements and six new separate Custom models captures. Catalogue/provider visuals use real hidden sibling panels instead of capture-only CSS suppression. Provider-rename references also reconcile older pre-modal/narrow framing; their entire delta is not attributed to this increment. The two category-strip changes affect only the final raster row (1,009 pixels each), without changed dimensions or controls. Long forms/catalogues remain scrollable; element crops do not prove viewport fit or complete the entity-layout direction. No pixel editing, comparison-tolerance, timeout, accessibility-threshold or bundle-budget relaxation is introduced.

### Retained first frozen campaign

Image `sha256:0fd012a1b1951bf7a829584a1f7ae4c670eb8aa2632282bc234eca73482d8e66` passes build/budgets, workspace/parity types and Web **71/619**, but retains **210 PASS / 1 FAIL of 211** distinct owning browser cases: standard **147/148** (6.3m), Models visuals **12/12** (21.2s), native **8/8** (1.3m), pane **18/18** (21.8s), workspace assets **17/17** (17.4s) and locale assets **8/8** (14.8s). The accessibility journey at `e2e/accessibility.spec.ts:93` times out clicking the hidden catalogue while the Providers panel is selected. This is an obsolete simultaneous-section journey, not a diagnosed native crash. All seven containers preserve **1,972 immutable inputs** from **2,624 exported entries**, with **652 regenerated inputs** separately classified and zero hash/mode/link mismatches. All eighteen frozen native-view attachments equal the reviewed development captures.

The existing accessibility scenario now visits each of the four real Models destinations and applies its original Light/Dark axe/name/icon/target checks there. The corrected single case passes **1/1** (26.0s) with its original 30-second timeout; no category or assertion is dropped. That development pass does not clear the failed first campaign. Corrected-source qualification is separate below.

### Corrected frozen owning qualification

Image `sha256:f269bba61ef43f074074ba5e8a862e92acdebf27db4f601f032d81a29b1cb8fd` is built from a new complete Docker-filtered export. Docker `build --target test-runner`, `npm run typecheck` (workspace/parity) and `npx vitest run packages/web/src` pass; Web units are **71 files / 619 tests**, and unchanged bundle budgets pass at **149/160 KiB gzip** entry/eager with **28 chunks**. Each browser selection uses a separate container, **1 GiB shared memory**, its owning configuration and `--workers=1 --retries=0 --update-snapshots=none`:

| Owning selection | Result | Duration |
|---|---:|---:|
| Thirteen standard Settings/navigation/provider/batch/accessibility/lifetime files | 148/148 PASS | 6.3m |
| Models catalogue/provider/custom-model visuals | 12/12 PASS | 21.2s |
| Native Codex/Copilot/Settings administration | 8/8 PASS | 1.3m |
| Pane lifetime | 18/18 PASS | 21.7s |
| Workspace assets | 17/17 PASS | 17.5s |
| Settings locale assets | 8/8 PASS | 15.3s |
| **Distinct corrected-source total** | **211/211 PASS** | — |

The standard files are `settings`, `settings-navigation`, `provider-settings`, `model-batches`, `resource-batches`, `accessibility`, `mcp-selection`, `settings-administration`, `workspaces`, `subagent-lifetime`, `mobile-keyboard`, `keyboard-responsive` and `i18n` under `e2e/*.spec.ts`. The separate visual selection uses `visual.spec.ts --grep 'catalogue de modèles|providers et modèles personnalisés'`; native files are `codex-subscription-live`, `copilot-subscription-live` and `settings-administration-live`. Pane/workspace/locale use their dedicated configs. This qualifies the changed sections, original provider/model operations and shared navigation/focus/asset boundaries; unselected visual, linked-modal and other provider campaigns are not claimed as freshly passing. In particular, the preceding system-light worker failure remains unexplained, not cleared by omission.

All seven corrected-source containers retain **1,972 immutable inputs** from **2,624 exported entries**, including nested documentation, modes and symlink targets; **652 regenerated build inputs** remain separately classified. There are zero mismatches; containers are stopped with `OOMKilled:false`. All **sixteen changed product/test sources**, **318 E2E PNGs** and **348 context-included repository PNGs** equal the frozen inputs. The other **20 repository PNGs** are Docker-excluded and unchanged against HEAD. All **36 adopted captures** match their reviewed hashes, and all **eighteen frozen native-view attachments** are byte-identical to the reviewed development captures. Root documentation is Docker-excluded and checked separately. Documentation lint passes **110 Markdown files / 1,621 links**; sixteen unique criteria, twenty-four topic entries/line estimates and whitespace checks reconcile. Logs, captures, source/context manifests and equality results remain under `/tmp/aih-web-design-settings-model-panels-*`, with corrected qualification under `-release-*`.

No additional criterion is closed: **11/16 DONE (68.75%)**, PREF-01–03/VIS-04 **PARTIAL**, QA-01 **IN PROGRESS**. This section-navigation foundation does not complete Models entity lists, other contextual/flat-row layouts, dirty-close/context-change protection, retirement acceptance, physical-device evaluation or final visual/global qualification. Historical failures remain retained.

## 25. Tools Contextual List/Detail — Partial Settings Foundation

This increment starts from `10bf51ac871511fab861ac8734e61e790144f68a`. `ToolSettingsPanel` in `EcosystemSettings.tsx` uses a requested-scope-keyed owner, flat named navigation and one selected detail. Desktop shows both columns; mobile uses an overview and explicit Back. Bounded cwd metadata restores only a unique fresh tool name in its matching global/project scope; an explicitly missing choice remains unavailable instead of silently selecting another tool. Native current/expanded/control/description relationships, 44px choices, inset focus and pending Back-to-navigation fallback retain keyboard access. Desktop selection/resize does not steal scope focus. Long opaque names wrap in both list and detail.

Scope, effective-source, preset and the separate PowerShell policy control remain shared. Existing Code mode fields move into the selected `codemode` detail and remain mounted when hidden; the server retains that tool entry even when sandbox health fails. Native change/blur saves, health/limits/warnings, unavailable reasons, epoch guards and canonical pending values are unchanged. Navigation stores only scope/name metadata, never executes tools and never reduces writes to the selected row: the original complete enabled-name payload is retained. Effective provenance does not choose the write target. Feature-only EN/FR copy stays lazy in `tool-settings-messages.ts`; there is no new persistence schema, tool, permission, consent or universal Save.

### Focused gaps, retained failures and reviewed captures

Existing tests cover scoped Code mode configuration/reload, disabled reasons and transcript replay, but not tool navigation/selection, mobile Back, pending return or metadata-only restoration. Two initial cases fail for missing named navigation, then pass after implementation. Four EN/Light and FR/Dark cases at 1280px and 390px cover scope-specific selection/reload, current metadata, no implicit writes/execution, unavailable tools, exact complete mutation bodies, canonical unchecked readback, missing explicit choices, axe, contrast, 44px targets and actual focus clearance at the unchanged −0.1px tolerance. A held `.uncheck()` initially fails because the controlled checkbox correctly stays canonical until the response; native focus+Space tests the action without introducing optimistic semantics. The strengthened scope-focus selection passes **4/4** (21.5s).

Visual review finds unrelated Code mode fields dominating other selected tools. Four strengthened hidden-field assertions reproduce **4/4 RED**; relocating the unchanged fields resolves them. The first placement unit gate retains **618 PASS / 1 FAIL of 619** because historical consumer lines have different indentation. An explicit Code mode-only source projection repairs the guard without regenerating locale inventories or changing text. Corrected build/types and Web **71/619** pass; six placement controls pass **6/6** (25.5s), and the four final context/Code mode viewport journeys pass **4/4** (23.1s).

The first remaining Code mode selection retains **8/8 screenshot failures**: four changed Settings crops and four historical transcript-card references. A separate pre-Tools comparison on the Models release image `sha256:f269bba61ef43f074074ba5e8a862e92acdebf27db4f601f032d81a29b1cb8fd` reproduces all four card failures; its actual PNGs equal the current-source actuals byte-for-byte. Those deltas predate Tools. Separate Settings and card generation each pass **4/4** (17.9s / 16.3s). All **eight adopted replacements** were visually reviewed: Settings also reconciles older pre-modal/narrow framing and palette changes, while cards preserve script, nested states/durations, authoritative cost, bounded scrolling, omitted count and output. No assertion, tolerance, timeout or budget is relaxed.

The existing native administration scenarios now select an actual tool, save to Project despite inherited Global provenance, and verify the complete HTTP allowlist, canonical readback, real disk publication, unchanged global configuration and reload. First native administration/Code mode selection retains **8 PASS / 1 FAIL of 9** (29.5s): FR-Light390 reaches a closed model catalogue after reload at `e2e/settings-administration-live.spec.ts:132`, before Tools. The read-then-click check can race deferred entry opening; explicit summary focus establishes user intent before inspecting/toggling it. The original unchecked/readback assertion and timeout remain. Corrected native administration passes **4/4** (18.8s). Existing pane lifetime coverage adds distinct tool selections across two workspaces without configuration writes.

Ready development checks pass related **83/83** (2.8m), pane **18/18** (20.9s), workspace assets **17/17** (16.7s) and locale assets **8/8** (13.8s). Final source review then adds a long opaque name to the four existing contextual cases: desktop **2 PASS**, mobile EN/FR **2 FAIL** on actual horizontal overflow. One scoped `overflow-wrap:anywhere` property repairs the detail; all Code mode cases pass **14/14** (46.4s), without updates/retries. Four long-name viewport captures are reviewed; the preceding ten Code mode/unavailable-tool/pending-focus views remain byte-identical. These overlapping development and generation runs are not a summed frozen total. Long Code mode help remains vertically scrollable at 390×844; element crops do not prove simultaneous viewport fit or physical-device usability.

### Retained first frozen campaign

Image `sha256:a645b5c1e6afc27955d68add3d1c323093fe82c741c70f0d4c78800d67582ee2` predates the long-name CSS/test repair. Build/budgets, workspace/parity types and Web **71/619** pass. Standard **133/133** (5.1m), native **9/9** (27.0s), pane **18/18** (21.8s) and locale **8/8** (14.3s) pass, totaling **168 executed passes**. The workspace-asset launcher exits **139 before its seventeen planned cases start**. Its inner stage/cause is not established; zero executed case failures is not a successful campaign. Six separate containers preserve **1,973 immutable inputs** from **2,625 exported entries**, with **652 regenerated inputs** separately classified and zero hash/mode/link mismatches. All are stopped with `OOMKilled:false`; that does not diagnose the startup failure.

### Corrected frozen owning qualification

Image `sha256:bfe26ec6e0adb26a4a8e2e39fd4e70b4a1291f69567c1a57b0f26bb526a9438e` comes from a new complete Docker-filtered export. Docker build, workspace/parity types and Web **71 files / 619 tests** pass; unchanged budgets report **149/160 KiB gzip** entry/eager and **28 chunks**. Each browser selection uses a separate owning container, **1 GiB shared memory** and `--workers=1 --retries=0 --update-snapshots=none`:

| Owning selection | Result | Duration |
|---|---:|---:|
| Eleven standard Settings/Code mode/navigation/accessibility/lifetime files | 133/133 PASS | 5.1m |
| Native Settings administration and Code mode | 9/9 PASS | 25.9s |
| Pane lifetime | 18/18 PASS | 21.8s |
| Workspace assets | 17/17 PASS | 17.2s |
| Settings locale assets | 8/8 PASS | 15.4s |
| **Distinct corrected-source total** | **185/185 PASS** | — |

Standard files are `codemode`, `settings`, `settings-navigation`, `accessibility`, `mcp-selection`, `settings-administration`, `workspaces`, `subagent-lifetime`, `mobile-keyboard`, `keyboard-responsive` and `i18n` under `e2e/*.spec.ts`. Native files are `settings-administration-live` and `codemode-live`; pane/workspace/locale use their dedicated configs. Unselected provider, visual and linked-modal campaigns are not claimed as fresh passes; preceding native failures remain unresolved.

All six corrected-source containers retain **1,973 immutable inputs** from **2,625 exported entries**, including nested documentation, modes and symlink targets; **652 regenerated inputs** remain separately classified. Containers are stopped with `OOMKilled:false` and zero mismatches. An initial summary inspection happened while the last container was still stopping; its pre-stop report is retained, and only metadata was reinspected after shutdown—no tests were rerun. All **ten changed sources**, **318 E2E PNGs** and **348 context-included repository PNGs** equal the corrected freeze; the other **20 repository PNGs** are Docker-excluded and unchanged against HEAD. All eight adopted captures and fourteen frozen viewport attachments match their reviewed hashes. Root documentation is Docker-excluded and checked separately. Logs, captures, manifests and equality checks remain under `/tmp/aih-web-design-settings-tools-*`, with corrected qualification under `-release-*`.

No additional criterion closes: **11/16 DONE (68.75%)**, PREF-01–03/VIS-04 **PARTIAL**, QA-01 **IN PROGRESS**. Models/Skills entity layouts, dirty-close/context-navigation protection, complete retirement acceptance, final visual review and global qualification remain open. The corrected campaign does not retroactively clear the first startup failure or historical campaigns.

## 26. Installed Skills Contextual List/Detail — Partial Settings Foundation

This increment starts from `835da445117cafeac346a9874ea954542381b46c`. `SettingsView.tsx` presents the existing Project/Global/configured-path/package groups beside one installed-skill metadata detail. Mobile separates overview/detail with explicit Back and owned focus. Bounded cwd metadata restores only a unique fresh visible group/key pair; missing or filtered explicit selections remain unavailable without clearing the filter or borrowing another scope. Native current/expanded/control/description relationships, 44px choices, inset focus, pending Back fallback and wrapped names/paths preserve keyboard and narrow-view access. Desktop selection/resize does not steal filter focus.

Metadata selection is separate from `selectedSkill` instruction-read intent. It never mounts `SkillContentPane`, fetches instruction bytes, installs a skill or changes autonomous invocation. Only the separately named Read instructions action opens the existing volatile reader; selecting another skill retires its predecessor. The original source/cwd/project/trust key and abort/epoch guards remain. Checkbox labels still own their native control, and group batches still use every filtered group row, not merely selected detail. Scope/source/trust/loading/error/refresh and canonical save/readback remain unchanged. Registry search/scope/install/update stays in its existing separate disclosure; registry entry IDs are not installed-skill key authority. Feature-only EN/FR copy stays lazy in `skill-settings-messages.ts`; no schema, permission, consent, filter or Save mechanism is added.

### Focused gaps, retained failures and visual review

Existing tests protect explicit instruction reads/references, native invocation toggles and filtered group publication, but not metadata-only selection/restoration or responsive contextual focus. Two initial cases fail for absent named navigation; implementation passes **2/2** (10.7s). Four EN/Light and FR/Dark cases at 1280px and 390px then cover category/reload and exact stored metadata, no implicit read/write, current relationships, fresh missing/other-scope choices, filters, long names, axe, 44px targets, outline contrast and actual clearance at the unchanged −0.1px tolerance. With the two existing scope/trust cases, ready controls pass **6/6** (24.1s).

A held batch response exercises canonical unchecked readback, the exact scoped one-row mutation and mobile Back-to-navigation while choices are disabled. The first strengthened selection retains **2 desktop PASS / 2 mobile FAIL**: pointer activation is not a keyboard `:focus-visible` signal. Native focus+Enter tests the intended keyboard signal without a product change; corrected selection passes **4/4** (21.3s). No timeout, threshold, trust boundary or mutation payload is relaxed.

The first native selection retains **16 PASS / 1 FAIL of 17** (6.7m): the delayed workspace-retirement scenario tries the inert background picker beneath ready Settings and reaches its 30,000ms timeout, with a subsequent `page.unrouteAll` target-closed cleanup error. Its actual close → picker → reopen journey retains canonical workspace, retired-pane/late-body and disk assertions; the corrected case passes **1/1** (8.5s). Source retirement also explicitly selects alternate metadata and verifies the old reader is absent before requesting its instructions. Native body, label, reference, refusal and disk checks remain distinct from mocked metadata evidence.

Initial resource comparisons retain **2 PASS / 4 screenshot FAIL of 6**; initial Skills overview comparisons retain **4 PASS / 2 tablet screenshot FAIL of 6**. Separate resource and visual generation pass **4/4** (23.3s) and **6/6** (13.7s). All **ten adopted replacements** are reviewed: four selected Skills crops and six catalogue overviews. Group crops change from 1110×283 to 784×267 on desktop and 302×375 to 302×293 on mobile; checked state, complete path/source, explicit instruction action and unchanged group batch controls remain. Registry-open desktop/mobile overviews show only part of installed content; tablet overviews show the installed list and also reconcile older 20px scroll framing. They do not establish simultaneous fit of long forms. Four generated outcome references each differ by one pixel at unchanged dimensions and are not adopted; their original PNG bytes remain. Model references are unchanged.

Development related checks pass **121/121** (4.9m), and built-pane checks pass **18/18** (23.3s), including distinct skill selections across two workspaces without instruction/configuration writes. Eight metadata/long-name views and two pending-keyboard views are individually reviewed and byte-identical to the frozen standard attachments. Eight native frozen reader views are separately reviewed in EN/FR desktop/mobile Light/Dark; their disposable paths/timestamps are not a development-byte-equality claim. The reader remains vertically scrollable. Overlapping development/generation passes are not a summed frozen total, and native Chromium input is not physical-device certification.

### Frozen owning qualification

Image `sha256:aa9d7ac6e6e56f159a9b7024f8e62c29886b18e3ec7ae18e4e87dfe58d2cc6d8` is built from a complete Docker-filtered export. Docker build, workspace/parity types and Web **71 files / 619 tests** pass; budgets remain **149/160 KiB gzip** entry/eager and **28 chunks**. Every browser selection has a separate owning container, **1 GiB shared memory** and `--workers=1 --retries=0 --update-snapshots=none`:

| Owning selection | Result | Duration |
|---|---:|---:|
| Twelve standard Settings/Code mode/resource/navigation/accessibility files | 143/143 PASS | 5.9m |
| Native Settings administration, Code mode, skill content and skill batches | 22/22 PASS | 5.3m |
| Skills catalogue visuals | 6/6 PASS | 12.8s |
| Pane lifetime | 18/18 PASS | 23.0s |
| Workspace assets | 17/17 PASS | 17.2s |
| Settings locale assets | 8/8 PASS | 15.9s |
| **Distinct frozen total** | **214/214 PASS** | — |

Standard files are `codemode`, `settings`, `settings-navigation`, `accessibility`, `resource-batches`, `mcp-selection`, `settings-administration`, `workspaces`, `subagent-lifetime`, `mobile-keyboard`, `keyboard-responsive` and `i18n` under `e2e/*.spec.ts`. Native files are `settings-administration-live`, `codemode-live`, `skill-content-live` and `skill-batches-live`; visuals use `visual.spec.ts --grep 'catalogue de skills'`, and pane/workspace/locale retain their dedicated configs. Unselected provider/visual/linked-modal campaigns are not claimed as fresh passes, and historical native failures remain unresolved.

All seven containers are stopped with `OOMKilled:false`, retaining **1,974 immutable inputs** from **2,626 exported entries**, including nested documentation, modes and symlink targets; **652 regenerated inputs** remain separately classified. There are zero mismatches. All **eleven changed sources**, **318 E2E PNGs** and **348 context-included repository PNGs** equal the freeze; the other **20 repository PNGs** are Docker-excluded and unchanged against HEAD. All ten adopted captures and eighteen frozen viewport attachments match their reviewed hashes. Root documentation is Docker-excluded and checked separately. Documentation lint passes **110 Markdown files / 1,621 links**; sixteen unique criteria, twenty-four topic entries/line estimates and whitespace checks reconcile. Logs, captures, manifests and equality checks remain under `/tmp/aih-web-design-settings-skills-context-*`.

No additional criterion closes: **11/16 DONE (68.75%)**, PREF-01–03/VIS-04 **PARTIAL**, QA-01 **IN PROGRESS**. Models entity lists, remaining registry/legacy-form presentation, dirty-close/context-change protection, complete retirement acceptance and final visual/global qualification remain open. This bounded success does not clear preceding campaigns or the Tools startup139 failure.

## 27. Built-in Credential Contextual Detail — Partial Models Foundation

This increment starts from `8c4ec0f5e23509e61b13769d10bd5bf1ee735612`. Within the historical `providers` section, the eight existing built-in credential types gain named contextual navigation and selected detail. Desktop pairs both columns; mobile uses overview/Back, separate from the outer Models-panel Back control. Existing bounded `positions.providers` stores only `builtin`/type metadata. Only a fresh available type restores selection; an explicit missing type stays unavailable rather than silently selecting another row. Current/expanded/control/description relationships, 44px choices/fields/buttons, semantic colors and inset outlines retain native keyboard access. Passive resize preserves active-provider select focus.

Credential-row selection never changes the actual active provider or submits a key. Its existing select/status stay shared and independent. All input nodes remain mounted while hidden, preserving unsaved per-type values and the Vertex Bearer/API-key choice across rows/categories without browser persistence. Original explicit save, mode-specific payload, masking and local success/error handlers remain unchanged. Feature-only EN/FR labels stay lazy in `provider-credentials-messages.ts`; no new provider, credential type, API, navigation schema, scope, permission, OAuth flow or universal Save is added. Dynamic provider connections, model catalogues and custom-model editors remain separate unfinished layouts.

### Focused evidence and reviewed captures

Existing tests cover direct key saves/errors and cross-section drafts, but not metadata-only row navigation, independent active-provider intent or cross-row drafts. Two initial cases are RED for absent named navigation; implementation passes **2/2** (10.9s). First Docker build/types and Web **71/619** pass. Four EN/Light and FR/Dark cases at 1280px and 390px add exact metadata/reload, no implicit writes, no secret storage, missing-choice recovery, actual focus clearance at the unchanged −0.1px tolerance, 44px targets, outline/input contrast, axe and overflow checks. Their first strengthened selection retains **2 desktop PASS / 2 mobile FAIL**: the visible parent-nav locator cannot resolve metadata after that nav becomes hidden. A direct `includeHidden` current-button locator fixes inspection only; all actions still use visible choices/Back. Corrected selection passes **4/4** (21.9s), without changing product semantics or thresholds.

Original key save/error assertions follow the visible credential choice and pass **2/2** (8.8s), retaining exact POST bodies, server feedback, masking and unsaved failed values. The four Models cross-panel journeys now select OpenAI before editing their original secret field; they pass **4/4** (20.3s) with the original editor/catalogue/history/no-write assertions. Initial native Vertex passes **1/1** (10.3s); the subsequently strengthened complete native-dialects file passes **2/2** (11.5s). Before the unchanged native Save, its synthetic Vertex key and API-key mode survive OpenAI → Vertex selection; actual HTTP publication, encrypted storage, isolated inference/redaction and zero credential-bearing discovery remain asserted. No real-account mode or user credential store is introduced.

Separate snapshot generation passes **4/4** (23.3s). The **four new credential crops**, individually reviewed and copied from Docker, are 968×579 on desktop and 350×304 on mobile. They show Anthropic credentials while the actual active provider remains Mock, with the synthetic draft password-masked. Eight selected/unavailable credential views and four OpenAI draft/focus views are individually reviewed. Ten frozen views equal the development review bytes; two mobile OpenAI focus views each have a two-pixel outline-edge delta and are separately reviewed from frozen output. Their final hashes are recorded, not declared development-byte-equal. An initial attachment inventory accidentally included reporter `-actual` PNGs and failed with `ENOENT`; the viewport-only manifest corrects bookkeeping without rerunning tests or editing PNG pixels.

The latest no-project scenario also retains an unsaved credential draft across categories without storing it. Development navigation/provider/model checks pass **43/43** (2.5m). The existing built-pane scenario adds Anthropic in one workspace, fresh OpenAI then explicit Google AI in the other, and restored Anthropic on return, preserving original model/tool/skill and no-write assertions; pane checks pass **18/18** (22.8s). Development, generation and frozen results remain distinct and are not a passing union.

### Frozen campaign — failures retained, qualification incomplete

Image `sha256:43ae992a28d8943dfe34487decba98de3c80579754615f44417d2c0e5f2018c4` comes from a complete Docker-filtered export. Docker build, workspace/parity types and Web **71 files / 619 tests** pass; budgets stay **149/160 KiB gzip** entry/eager and **28 chunks**. Each browser selection has a separate owning container, **1 GiB shared memory** and `--workers=1 --retries=0 --update-snapshots=none`:

| Owning selection | Result | Duration |
|---|---:|---:|
| Fourteen standard Settings/provider/model/resource/navigation/accessibility files | 170/170 PASS | 7.0m |
| Seven native provider/Code mode/skill/administration files | Launcher exit 139; 28 planned cases unstarted | — |
| Skills/model/provider catalogue visuals | 17 PASS / 1 FAIL of 18 | 32.8s |
| Pane lifetime | 18/18 PASS | 23.2s |
| Workspace assets | 17/17 PASS | 17.2s |
| Settings locale assets | 8/8 PASS | 14.7s |
| **Distinct campaign accounting** | **230 PASS / 1 FAIL / 28 unstarted of 259 planned** | — |

The native log contains only `exit=139`, before any case listing/execution report. Its inner stage and cause are not established; development native passes do not complete that frozen selection. The visual failure is tablet-light provider/custom-model presentation at `e2e/visual.spec.ts:398`: **`Error: locator.click: Target crashed`**, waiting for `Create or edit a compatible provider`, before image comparison. Its cause is not established. Neither failure is rerun unchanged, and this is explicitly **not a passing complete campaign**.

Standard files are `codemode`, `settings`, `settings-navigation`, `provider-settings`, `model-batches`, `accessibility`, `resource-batches`, `mcp-selection`, `settings-administration`, `workspaces`, `subagent-lifetime`, `mobile-keyboard`, `keyboard-responsive` and `i18n` under `e2e/*.spec.ts`. The planned native selection is `settings-administration-live`, `codemode-live`, `skill-content-live`, `skill-batches-live`, `native-dialects-live`, `codex-subscription-live` and `copilot-subscription-live`. Visuals use `visual.spec.ts --grep 'catalogue de skills|catalogue de modèles|providers et modèles personnalisés'`; pane/workspace/locale retain their dedicated configs. Unselected campaigns and earlier-source passes are not promoted to current qualification.

All seven containers are stopped with `OOMKilled:false`; this does not diagnose either failure. They preserve **1,979 immutable inputs** from **2,631 exported entries**, including nested documentation, modes and symlink targets; **652 regenerated inputs** remain separately classified, with zero mismatches. All **eight changed sources**, **322 E2E PNGs** and **352 context-included repository PNGs** equal the freeze. The other **20 repository PNGs** are Docker-excluded and unchanged against HEAD. All four new captures and twelve frozen credential-view attachments match their reviewed hashes. Root documentation is excluded and hashed separately. Documentation lint passes **110 Markdown files / 1,621 links**; sixteen unique criteria, twenty-four topic entries/line estimates and whitespace checks reconcile. Logs, retained failures, manifests and equality checks remain under `/tmp/aih-web-design-settings-provider-credentials-*`.

No additional criterion closes: **11/16 DONE (68.75%)**, PREF-01–03/VIS-04 **PARTIAL**, QA-01 **IN PROGRESS**. This is validated partial credential presentation, not complete Models/Settings or native/global acceptance. Remaining connection/model/registry layouts, legacy forms, dirty-close/context-change protection, retirement acceptance and final visual/global qualification stay open alongside both current failures and the retained historical campaigns.

## 28. Provider Connection Contextual Detail — Partial Models Foundation

This increment starts from `35310217e0be7ec128f685ccea38fd08446c63fd`. Within historical `provider-lifecycle`, `ProviderLifecycleSettings` in `EcosystemSettings.tsx` gives the existing built-in/custom descriptors named contextual navigation and selected detail. Desktop pairs both columns; mobile separates overview/detail with explicit Back. Existing bounded positions store only the original `builtin`/`custom` group and public ID. An explicit choice must match exactly one current descriptor in that namespace; an unavailable choice never borrows another group's matching ID. Current/expanded/control/description relationships, 3px selection markers, 44px navigation/Back/card actions, inset button outlines and wrapped names preserve native interaction. Global Prompt cache and the create/edit disclosure remain shared.

Metadata selection never changes the actual active provider, starts OAuth/Test, imports models, saves credentials or deletes a definition. Still-listed rows remain mounted when hidden. The shared editor keeps its original target and volatile fields independently of the displayed descriptor; browsing B while editing A still explicitly PUTs A. An OAuth callback draft remains bound to its captured operation's group/ID and hidden, not replaced, while another descriptor is inspected. Existing start/poll/paste/cancel guards, rename capability/revision/canonical reconciliation, import and confirmed-delete handlers remain authoritative. Canonical save/rename follows a fresh descriptor only without newer connection-navigation intent; Back also retires that follow-up. No provider, account, API, scope, navigation schema, permission or universal Save is added. New EN/FR copy stays lazy in `provider-context-messages.ts`.

### Focused evidence, retained failures and reviewed captures

Existing tests protected original operations and cross-section drafts, not independent connection metadata, cross-descriptor editor/OAuth retention or newer navigation during canonical rename. Two initial cases are RED for absent named navigation; the first implementation passes **2/2** (11.7s), Docker build/types and Web **71 files / 619 tests**. Four EN/Light and FR/Dark 1280px/390px cases initially pass **4/4** (26.4s); original operation scenarios pass **14/14** (1.5m) on their earlier copied inputs. Strengthened long names then produce **4 RED** actual `.settings-view` containment failures. Scoped strong-name wrapping fixes the source, without overflow masking or relaxed assertions. Held rename preserves a newer desktop choice, but mobile Back is RED (**1 PASS / 1 FAIL**, 14.9s): canonical completion reopens detail after overview intent. Incrementing the metadata generation on Back fixes that presentation race, without changing mutation authority. Ready build/types/Web 619 and six controls pass **6/6** (34.1s).

The final editor-target scenario first retains **6 PASS / 1 FAIL of 7** (41.0s): its new assertion incorrectly expects a creation POST although the original editor correctly sends PUT. The corrected test inspects all custom-registry non-GET requests and requires exactly `PUT /api/provider-registry/custom/acme`, the original ID/name/synthetic key, and unchanged Other detail. Final focused checks pass **7/7** (36.0s). They also preserve exact metadata/reload, no implicit writes/active-provider changes, no browser secret/callback storage, group-safe unavailable recovery, category-returned drafts, actual keyboard outline clearance at the unchanged −0.1px tolerance, contrast, 44px targets, axe and horizontal containment. The built-pane journey adds distinct connection choices across two real workspace-picker transitions while retaining original model/tool/skill/credential and no-write checks.

The ready copied selection records **170 PASS / 5 FAIL of 175** (7.4m): four expected provider-rename image deltas plus **`Error: worker process exited unexpectedly (code=null, signal=SIGSEGV)`** in `desktop-dark Code mode saves scoped settings, displays limits and disabled reasons`, `e2e/codemode.spec.ts:183`. Cause and inner stage are unknown. Native checks pass **28/28** (7.4m); six provider/custom-model visual cases fail at their changed provider image; pane **18/18** (23.5s), workspace assets **17/17** (16.1s) and locale assets **8/8** (14.8s) pass. The ready input hashes are retained; later editor-target and unavailable-view assertions, and the explicit built-in usage journey, are not retroactively attributed to that copied selection. Overlapping development selections are not summed.

Separate snapshot generation passes rename **4/4** (15.7s) and provider/custom-model **6/6** (16.8s). Ten reviewed replacements are copied byte-for-byte from Docker: four rename cards change desktop 920×300 → 647×341 and mobile 302×483 → 302×527; six contextual provider pages retain their viewport dimensions. Original target/ID, SINGLE-WRITER restrictions, input, Confirm/Cancel and operation labels remain present. Built-in usage is now inspected in its own selected detail, not discarded when custom detail is chosen: six strengthened visual journeys pass **6/6** (16.9s), with no updates against development-generated references, retaining **24 requests / 14,500 tokens / $0.1432**, Reconnect/Test/Disconnect and no mutation assertions. Four generated Custom models images differ only at category-picker corners (11 pixels Dark, 13 Light); they are not adopted or attributed to this provider layout, and existing references remain unchanged. Other generated images are byte-identical.

Eighteen final viewport attachments are individually reviewed: four ordinary custom details, four unavailable namespace choices, four long names and six built-in usage/action details. Mobile long-name views are scrolled; cropped forms/cards are not proof of simultaneous whole-form viewport fit. Keyboard/viewport signals are emulated, not physical-device/account certification.

### Frozen selected campaign — failures remain open

Image `sha256:8622f9f8735eeb3678409b4ff383d1fe6fe5edd9d6a5d3572e58127d4df33e33` comes from the complete Docker-filtered export. Build, workspace/parity types and Web **71 files / 619 tests** pass; budgets remain **149/160 KiB gzip** entry/eager and **28 chunks**. Separate owning containers retain **1 GiB shared memory** and `--workers=1 --retries=0 --update-snapshots=none`.

The standard selection deliberately excludes only the exact unchanged failed Code mode case above using `--grep-invert 'desktop-dark Code mode saves scoped settings, displays limits and disabled reasons$'`. Its source assertion and official suite remain unchanged; it is not rerun to manufacture success, counted as a pass, or accepted as a gap. The table covers **264 selected cases**, not the full 265-case owning universe.

| Owning selection | Result | Duration |
|---|---:|---:|
| Fourteen standard files, excluding the one retained Code mode failure | 174 PASS / 1 FAIL of 175 | 7.5m |
| Seven native provider/Code mode/skill/administration files | 28/28 PASS | 7.3m |
| Skills/model/provider catalogue visuals | 18/18 PASS | 31.1s |
| Pane lifetime | 18/18 PASS | 23.4s |
| Workspace assets | 17/17 PASS | 16.5s |
| Settings locale assets | 8/8 PASS | 15.5s |
| **Distinct selected accounting** | **263 PASS / 1 FAIL of 264 selected** | — |

The frozen failure is `Models contextual sections preserve drafts and explicit navigation: 1280px en`, `e2e/settings-navigation.spec.ts:215`, waiting for `#custom-models` after reload: **`Protocol error (Runtime.callFunctionOn): Page crashed.`** The retained artifact shows only Loading. Cause and precise inner stage are not established. It is not rerun unchanged. This failure and the deferred development Code mode SIGSEGV remain open independently; the selected campaign and complete qualification are both non-passing.

Standard files are `codemode`, `settings`, `settings-navigation`, `provider-settings`, `model-batches`, `accessibility`, `resource-batches`, `mcp-selection`, `settings-administration`, `workspaces`, `subagent-lifetime`, `mobile-keyboard`, `keyboard-responsive` and `i18n` under `e2e/*.spec.ts`. Native files are `settings-administration-live`, `codemode-live`, `skill-content-live`, `skill-batches-live`, `native-dialects-live`, `codex-subscription-live` and `copilot-subscription-live`. Visuals retain the three catalogue patterns from §27; pane/workspace/locale retain their dedicated owning configs. These current-input results do not diagnose or erase §27's older native-launcher/visual failures or earlier campaigns.

All seven containers are stopped with `OOMKilled:false`, not a causal diagnosis. Context checks retain **1,980 immutable inputs** from **2,632 exported entries**, including nested documentation, modes and symlink targets; **652 regenerated inputs** remain separately classified with zero mismatches. All **eleven changed sources**, **322 E2E PNGs** and **352 context-included repository PNGs** equal the freeze; the other **twenty repository PNGs** are Docker-excluded and unchanged against HEAD. Ten adopted replacements and all eighteen frozen viewport attachments equal their reviewed hashes. Root documentation is excluded from Docker and hashed separately. Documentation lint passes **110 Markdown files / 1,621 links**; sixteen unique criteria, twenty-four topic entries/line estimates, whitespace and the exact **24 owned paths** reconcile. Logs, retained failures, manifests and review notes remain under `/tmp/aih-web-design-settings-provider-context-*`.

No additional criterion closes: **11/16 DONE (68.75%)**, PREF-01–03/VIS-04 **PARTIAL**, QA-01 **IN PROGRESS**. This is partial connection presentation, not complete Models/Settings or global acceptance. Remaining model/registry layouts, legacy forms, dirty-close/context-change protection, retirement acceptance and final visual/global qualification remain open alongside the two current failures and retained historical campaigns.

## 29. Model Catalogue Contextual Detail — Partial Models Foundation

This increment starts from `3d710c4d3d949cea9e761a95e8ef3525be84c86c`. Within historical `model`, `SettingsView.tsx` gives the existing provider groups named metadata navigation and selected detail. Desktop pairs both columns; mobile separates overview/detail with Back. Existing bounded `positions.model` stores only provider/key. Explicit selection requires exactly one fresh filtered pair; missing, filtered or ambiguous choices remain unavailable without clearing the filter or borrowing another provider's same ID. Current/expanded/control relationships, 3px markers, 44px choices/Back/rows, inset focus and wrapped long names retain native access.

Metadata never changes the actual shared model select or enablement. Listed checkbox rows remain mounted while hidden; original one-key mutations, complete filtered provider/global batches, canonical pending/readback, refresh, scope/date and outcome handling remain unchanged. Back remains usable while choices are disabled and focuses enabled-current choice or the named navigation; settlement does not reopen detail. Existing workspace/trust ownership and explicit saves remain authoritative. No API, model/provider capability, persistence schema, permission or universal Save is added. EN/FR copy stays lazy in `model-catalog-messages.ts`.

### Focused evidence, retained failures and reviewed captures

Existing batch/readback tests did not cover independent catalogue metadata, fresh-key withdrawal or mobile Back during pending writes. Two initial cases are RED for absent named navigation; implementation passes **2/2** (10.9s), Docker build/types and Web **71 files / 619 tests**. Expanded owning checks retain **5 PASS / 4 screenshot FAIL of 9** (31.0s), with original pre-capture payload/conservation assertions intact. Strengthened missing OpenAI key versus same-ID Azure recovery and long-name checks first retain **4 RED** from a broad locator matching hidden-mounted rows. Scoping to the actual long-key detail repairs inspection; all four pass (**23.4s**), without forced actions or product changes.

Held-save tests first retain **1 desktop PASS / 1 mobile FAIL** because pointer activation is not keyboard `:focus-visible` evidence. Native focus+Enter fixes the signal; the next run retains the old mobile New chat journey's hidden-Sidebar timeout. Explicit Toggle navigation → New chat → Settings preserves the original retired-publication proof; both cases pass (**10.5s**). The final synthetic fixture aligns configured provider descriptors so the actual model select is enabled/nonempty, not an inert empty control. Ready build/types/Web 619 and six metadata/pending controls pass **6/6** (27.7s). Four EN/Light and FR/Dark cases at 1280px/390px preserve actual model value, no writes, exact group/key persistence/reload, filter focus, explicit withdrawal/recovery, long names, current relationships, axe, 44px controls, contrast and actual outline clearance at the unchanged −0.1px tolerance.

The copied ready related selection retains **100 PASS / 5 FAIL of 105** (6.0m): two desktop restored-model image deltas, two mobile hidden-checkbox-focus journeys and one obsolete all-visible activation journey. Resource checks retain **2 PASS / 4 model-image FAIL of 6** (19.2s), visual **4 PASS / 2 mobile-image FAIL of 6** (15.7s), native **6 PASS / 4 old model-row/batch-journey FAIL of 10** (2.4m). Pane **18/18** (23.0s), workspace assets **17/17** (16.5s) and locale assets **8/8** (15.0s) pass. Later visible selections are not retroactively attributed to these copied inputs.

The corrected activation/chat journey passes **1/1** within a retained **1 PASS / 4 FAIL** five-case run (2.2m); its restored-model helper wrongly requests Mock instead of the actual Mock (Testing) group label. Correcting that label preserves all keyboard/history/draft assertions and reaches only four expected final image deltas. Native administration explicitly selects visible-a, hidden and restored visible-a around its unchanged exact batch, disk/global conservation and reload checks; all four EN/FR desktop/mobile cases pass (**21.6s**). No payload, timeout, browser flag, accessibility threshold or snapshot tolerance is relaxed. Overlapping development results are not summed into qualification.

Separate generation passes model batches **4/4** (16.1s), resource batches **4/4** (24.0s), restored navigation **4/4** (19.4s) and model visuals **6/6** (15.2s). Eighteen individually reviewed replacements are copied as exact Docker bytes: eight selected-model group crops change desktop 920×184 → 647×160 and mobile 302×250 → 302×175; four restored-model crops change desktop 968×497 → 968×522 and mobile 350×635 → 350×679; six catalogue viewport captures retain their dimensions. Full filtered group actions remain above selected detail, not reduced to that row. Four unrelated generated outcome images each differ by one pixel; one generated desktop-Dark Skills crop differs by eight corner pixels. All five are reviewed but not adopted or assigned a cause. Existing bytes stay unchanged.

Nine final metadata/long-name/pending viewport attachments are individually reviewed and hashed. All nine frozen standard views equal the reviewed ready-control bytes. Ordinary mobile/detail and restored element crops can be cropped by the actual viewport/sticky context header; long-name views are scrolled. They do not prove simultaneous whole-form fit, physical-device behavior or complete visual acceptance.

### Frozen selected campaign — startup failure retained

Image `sha256:17199f59671b918756ca254de03ee1f0ea0c45f14927b9f7750e690d07e6e1ae` comes from the complete Docker-filtered export. Docker build, workspace/parity types and Web **71 files / 619 tests** pass; budgets remain **149/160 KiB gzip** entry/eager and **28 chunks**. Each selection has a separate owning container, **1 GiB shared memory** and `--workers=1 --retries=0 --update-snapshots=none`.

As in §28, standard discovery deliberately excludes only the exact retained Code mode worker SIGSEGV with `--grep-invert 'desktop-dark Code mode saves scoped settings, displays limits and disabled reasons$'`. No relevant repair is claimed, no assertion or official suite is changed, and that case is not rerun, counted as passing or accepted as a gap. This selection plans **269 cases**, not the complete 270-case owning universe.

| Owning selection | Result | Duration |
|---|---:|---:|
| Fourteen standard files, excluding the retained Code mode failure | 180/180 PASS | 8.5m |
| Seven native provider/Code mode/skill/administration files | 28/28 PASS | 7.4m |
| Skills/model/provider catalogue visuals | 18/18 PASS | 32.1s |
| Pane lifetime | Server startup exit 139; 18 cases unstarted | — |
| Workspace assets | 17/17 PASS | 16.6s |
| Settings locale assets | 8/8 PASS | 14.6s |
| **Distinct selected accounting** | **251 PASS / 18 unstarted of 269 planned** | — |

The pane-lifetime owning launcher reports a failed Server `start` lifecycle with **code 139**, command **`sh -c tsx src/index.ts --port 3099`**, followed by **`Process from config.webServer was not able to start. Exit code: 139`**, before case listing/execution. No signal, precise inner stage or cause is established. It is not rerun unchanged. Zero executed case failures is not a passing campaign; earlier development pane passes do not fill these eighteen unstarted cases. Both `campaignPassed` and `qualificationComplete` remain false. The deferred Code mode SIGSEGV, §28's prior Models-reload crash and older campaigns remain unexplained/open, not erased or diagnosed by current-source passes.

Standard/native filenames and visual patterns remain those explicitly listed in §28; pane/workspace/locale retain their dedicated owning configs. The added metadata matrix and mobile retirement case account for five additional standard cases. Unselected campaigns are not claimed as fresh evidence.

All seven containers are stopped with `OOMKilled:false`, not a causal diagnosis. Context checks retain **1,981 immutable inputs** from **2,633 exported entries**, including nested documentation, modes and symlink targets; **652 regenerated inputs** remain separately classified with zero mismatches. All **eleven changed sources**, **322 E2E PNGs** and **352 context-included repository PNGs** equal the freeze; the other **twenty repository PNGs** are Docker-excluded and unchanged against HEAD. Eighteen adopted replacements and all nine frozen viewport attachments equal their reviewed hashes; the five unrelated generated deltas remain unadopted. Root documentation is Docker-excluded and hashed separately. Documentation lint passes **110 Markdown files / 1,621 links**; sixteen unique criteria, twenty-four topic entries/line estimates, whitespace and the exact **32 owned paths** reconcile. Logs, retained failures, manifests and review notes remain under `/tmp/aih-web-design-settings-model-context-*`.

No additional criterion closes: **11/16 DONE (68.75%)**, PREF-01–03/VIS-04 **PARTIAL**, QA-01 **IN PROGRESS**. This is validated partial catalogue presentation, not complete Models/Settings or global qualification. Custom-model/registry layouts, legacy forms, dirty-close/context-change protection, retirement acceptance and final visual/global qualification remain open alongside the startup failure, deferred Code mode failure and retained historical campaigns.

## 30. Custom Model Contextual Detail — Partial Models Foundation

This increment starts from `d6d2da927a1de61b37fb8e8a3515148b1b7abbd9`. `CustomModelSettings` in `EcosystemSettings.tsx` presents flat named navigation and selected detail, with desktop columns and mobile overview/Back. Existing bounded `positions['custom-models']` stores only the original provider-qualified definition key, not a new group or schema. Restore only a unique fresh key; a withdrawn or ambiguous explicit choice remains unavailable rather than borrowing another provider's same ID. Current/expanded/control relationships, 3px markers, 44px targets, inset outlines and long-name wrapping retain native access. Listed articles remain hidden-mounted; the original shared create/edit form stays separate and retains its original target and volatile fields.

Metadata browsing is not Edit, Test, Delete, Save or active-model/enablement intent. Original POST/PUT key ownership, capability/pricing/compatibility fields and validation, Test/Delete and catalogue hydration remain unchanged. New EN/FR copy stays lazy in `custom-model-messages.ts`; there is no new API, provider, account, permission, scope, confirmation or universal Save feature.

### Focused evidence, retained failures and reviewed captures

Existing CRUD/pricing/native-import/private-inference and cross-panel draft tests did not cover metadata-only selection or A-editor ownership after browsing B. Two initial desktop-EN/mobile-FR cases are RED for absent named navigation; the first implementation passes **2/2** (10.7s), Docker build/types and Web **71 files / 619 tests**. Four EN/Light and FR/Dark cases at 1280px/390px then pass **4/4** (21.4s): unchanged nonempty active-model value/no writes, exact selection/category/reload, shared synthetic draft/no local or session persistence, withdrawn OpenAI key versus Azure same-ID explicit recovery, long names, keyboard/44px/contrast, actual outline clearance at unchanged −0.1px tolerance, axe and overflow.

Two additional desktop/mobile ownership cases edit `openai:first`, browse `azure:shared`, then require exactly **`PUT /api/provider-registry/models/openai%3Afirst`** with the original provider/ID/capabilities/context/output/pricing/compatibility and changed synthetic name. Selected B remains B after canonical load. All six focused cases pass **6/6** (24.5s). Their shared fixture is reused only within this task's scope. Eight ordinary/long viewport views are individually opened and hashed; all eight ready-control and frozen-standard views equal those reviewed bytes. Closed-editor views do not prove expanded whole-form fit, physical devices or real accounts.

Three first integration failures remain retained: the old CRUD GPT E2E and desktop-Light visual Acme assertions become ambiguous with named list/detail duplication; real OpenAI import of 44 models times out at Edit on a hidden non-first row. `selectCustomModel` now enters the actual Models panel/mobile Back/named navigation by exact key. Original payload/readback/privacy assertions remain. Nine native imported-model families explicitly choose their definition before unchanged Edit/pricing/capability/private-inference checks. The built-pane journey adds separate custom-definition choices across actual workspace-picker transitions, retaining all older model/tool/skill/credential/connection/scope and no-write checks.

Ready build/types/Web **71/619** pass, but controls retain **6 PASS / 1 FAIL of 7** (27.9s). The original corrected CRUD case, `administre modèles personnalisés, valeurs par défaut, outils et registre de skills`, at `e2e/settings.spec.ts:158`, reports **`Error: worker process exited unexpectedly (code=null, signal=SIGSEGV)`**. Cause and inner stage are unknown. The preplanned overlapping related selection had already started when this failure was inspected and later passes **111/111** (4.9m). This is not a failure-specific retry, diagnosis, repair or passing union; that controls failure remains open independently.

Ready native checks retain **10 PASS / 1 FAIL of 11** (1.2m): the second CN Moonshot case addresses hidden connection Edit after reload at line 126, before custom-model presentation. Its artifact shows OpenAI selected instead of the custom descriptor. Explicit `selectProviderConnection(page, 'custom', id)` after reload preserves original regional URL/import/key replacement/readback/privacy checks; the corrected case passes **1/1** (10.4s), without a product change. Ready visual **6/6** (17.0s), pane **18/18** (23.3s), workspace assets **17/17** (18.1s) and locale assets **8/8** (14.3s) pass. The later Moonshot journey edit is not retroactively attributed to copied ready hashes. No payload, timeout, assertion, flag, accessibility threshold or snapshot tolerance is relaxed.

Separate generation passes **6/6** (18.3s). Exactly six changed Custom models viewports are individually reviewed and adopted as exact Docker bytes: desktop 1440×900, tablet 820×1180 and mobile 390×844 in Light/Dark. Names/keys, context/output and original Edit/Test/Delete remain, with contextual list/Back and 44px actions. Provider references and every other copied visual PNG are byte-identical; there is no unrelated adoption or manual pixel editing. Passing old comparisons within tolerance was not treated as byte identity or review of the new arrangement.

### Frozen selected campaign — two failures remain deferred

Image `sha256:9b5791357741a3c9a9094de61c936e39432a15907a679ac1900407d93dce1d1f` comes from a complete Docker-filtered export. Docker build, workspace/parity types and Web **71 files / 619 tests** pass; budgets remain **149/160 KiB gzip** entry/eager and **28 chunks**. Each selection has a separate owning container, **1 GiB shared memory** and `--workers=1 --retries=0 --update-snapshots=none`.

The standard selection excludes only the exact unchanged failed Code mode case retained in §28 and the CRUD SIGSEGV above. Neither has a relevant repair or established cause; official suites/assertions remain unchanged, and neither is rerun for this selected aggregate, counted as passing or accepted as a gap. The table covers **285 selected cases**, not the full **287-case bounded owning universe**.

| Owning selection | Result | Duration |
|---|---:|---:|
| Fourteen standard files, excluding the two retained SIGSEGV cases | 185/185 PASS | 7.8m |
| Sixteen native provider/Code mode/skill/administration files | 39/39 PASS | 6.5m |
| Skills/model/provider catalogue visuals | 18/18 PASS | 32.8s |
| Pane lifetime | 18/18 PASS | 23.5s |
| Workspace assets | 17/17 PASS | 16.2s |
| Settings locale assets | 8/8 PASS | 14.6s |
| **Distinct selected accounting** | **285/285 PASS** | — |

Standard filenames and visual patterns remain those in §28. Native files additionally include `openai-live`, `deepseek-live`, `cloudflare-live`, `zai-live`, `moonshot-live`, `groq-live`, `cerebras-live`, `nvidia-live` and `openrouter-live` under `e2e/*.spec.ts`; pane/workspace/locale keep their dedicated configs. Six new standard cases minus the additionally deferred CRUD case give 185 selected standard cases; the nine added native files contribute eleven cases. These are distinct selected results, not a development/generation union. `campaignPassed:true` describes this selection only; `qualificationComplete:false` retains both deferred failures. Current changed-source pane success does not diagnose or erase §29's Server-startup139, §28's Models-reload crash or older campaigns.

All seven containers are stopped with `OOMKilled:false`, not a causal diagnosis. Context checks retain **1,982 immutable inputs** from **2,634 exported entries**, including nested documentation, modes and symlink targets; **652 regenerated inputs** remain separately classified with zero mismatches. All **seventeen changed sources**, **322 E2E PNGs** and **352 context-included repository PNGs** equal the freeze; the other **twenty repository PNGs** are Docker-excluded and unchanged against HEAD. Six adopted replacements and all eight frozen viewport attachments equal reviewed hashes. Root documentation is Docker-excluded and hashed separately. Documentation lint passes **110 Markdown files / 1,621 links**; sixteen unique criteria, twenty-four topic entries/line estimates, whitespace and exact **26 owned paths** reconcile. Logs, failures, source boundaries, manifests and review notes remain under `/tmp/aih-web-design-settings-custom-model-context-*`.

No additional criterion closes: **11/16 DONE (68.75%)**, PREF-01–03/VIS-04 **PARTIAL**, QA-01 **IN PROGRESS**. This is validated partial custom-definition presentation, not complete Settings or global qualification. Registry layouts, legacy forms, dirty-close/context-change protection, retirement acceptance and final visual/global qualification remain open alongside both deferred SIGSEGVs and retained historical failures.
