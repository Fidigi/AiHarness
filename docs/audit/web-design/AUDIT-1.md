# Audit Report — AiHarness Web Design and UX

> **Status: IN PROGRESS** (2026-11-18)
>
> Six implementation decisions approved. Semantic colors and decorative icons have bounded qualification; FILE-01–04 are verified. Explorer placement/chrome, category Settings, remaining input polish and final cross-surface qualification remain open.

## 1. Audit Reference

| Element | Value |
|---|---|
| Target observed | `@ai-harness/web` 0.1.0: themes, visual hierarchy, action controls, workspace explorer and Settings information architecture |
| Audited instance | Local commit `b98572c6354ec4996cd4121f33c1ac8697a68047`; initial dirty tree contains only `packages/core/src/providers/anthropic-federation.test.ts`, outside this audit and left untouched |
| Audit date | 2026-11-18 |
| Pinned source | `https://github.com/Fidigi/AiHarness.git`, commit `b98572c6354ec4996cd4121f33c1ac8697a68047`; Web source and E2E files have no local diff against that commit at inspection |
| Detailed references | Source inventory in §8, inspected versioned images in §9, calculated color pairs in §8.1 and existing coverage in §10 |
| Method | AiHarness source/test inspection, eight existing baseline images and standalone sRGB contrast arithmetic; user screenshot U1 (§9.1) followed by bounded live browsing of the preferred external UX reference U2 (§9.2). No AiHarness application/browser test executed in the initial assessment; subsequent implementation evidence is journaled in §6 and §11–14 |

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

These states describe **redesign acceptance criteria**, not whether the assessment document has been written. Four functional explorer criteria are verified; twelve criteria remain open and no gap is accepted.

| Status | Count | Details |
|---|---:|---|
| `DONE` | 4 | FILE-01–04: selection/path, native disclosures, nested refresh and search feedback |
| `PARTIAL` | 6 | Implementation foundations or approved design direction exist, but completion evidence remains missing |
| `ABSENT` | 1 | Category-tab Settings presentation |
| `TO BE DEFINED` | 0 | Six starting decisions approved; visual refinement follows the first render |
| `BLOCKED` | 0 | No audit-wide external blocker |
| `IN PROGRESS` | 5 | VIS-01–03, ACT-02 and QA-01: reader palette/input implementation and focused qualification underway |
| `GAP ACCEPTED` | 0 | No waiver requested or granted |
| **Total** | **16** | **25.0% closed: (4 + 0) / 16 × 100** |

### Summary by Surface

| Surface | Done | Partial | Absent | To define | Blocked | In progress | Gap accepted | Total |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Visual system | 0 | 1 | 0 | 0 | 0 | 3 | 0 | 4 |
| Actions and input | 0 | 1 | 0 | 0 | 0 | 1 | 0 | 2 |
| File explorer | 4 | 1 | 0 | 0 | 0 | 0 | 0 | 5 |
| Settings | 0 | 3 | 1 | 0 | 0 | 0 | 0 | 4 |
| Qualification | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 1 |
| **Total** | **4** | **6** | **1** | **0** | **0** | **5** | **0** | **16** |

## 3. Traceability by Surface

Priority: **P1** = accessibility/task-orientation problem to address first; **P2** = consistency, density or organization improvement. These are implementation priorities, not security severities. Evidence keys resolve to exact files in §8–10.

### Visual system

| ID | Status | Priority | Finding and criterion for DONE |
|---|---|---|---|
| VIS-01 | IN PROGRESS | P1 | Colors are mostly literal values across several stylesheets; variables cover focus/layout but not a semantic palette (S1–S4). Introduce shared surface/text/border/action/status tokens, used by audited chrome and states. DONE requires a reviewed token inventory and browser-computed checks showing those surfaces consume theme-owned values rather than unrelated overrides. |
| VIS-02 | IN PROGRESS | P1 | Light file syntax, Git badges and frontmatter retain pale dark-theme colors; specific ratios are 1.58–2.04:1 (§8.1). Fix each identified pair; qualify normal text at ≥4.5:1, large text at ≥3:1 and essential non-text controls/state indicators at ≥3:1 against adjacent colors. Decorative separators need not all reach 3:1. DONE requires computed-color and visible-state evidence, including hover/focus/selected states. |
| VIS-03 | IN PROGRESS | P2 | Mist/Rose/Pine recolor only body/main/sidebar/chat-toolbar/input-container backgrounds (S2), leaving Settings, file viewer and most controls on the default navy palette. Give every selectable theme complete audited-surface coverage. DONE requires chat, Settings and explorer captures plus contrast checks for all five explicit themes and both System resolutions, without silently deleting saved theme choices. |
| VIS-04 | PARTIAL | P2 | The user approved the six starting decisions in §5 on 2026-11-18, using U1/U2 as the preferred reference: neutral surfaces/blue accent, thin icons, horizontal category tabs, desktop modal/mobile full-screen Settings, left explorer/right reader and retained alternate themes. No starting design arbitration remains. Exact colors, spacing and responsive details may be refined after the first render. DONE still requires reviewed desktop/mobile Light/Dark visuals covering surface separation, typography and icon weight; approval of direction alone is not visual qualification. |

### Actions and input

| ID | Status | Priority | Finding and criterion for DONE |
|---|---|---|---|
| ACT-01 | PARTIAL | P2 | Textual toolbar buttons coexist with emoji and Unicode glyphs (`📁`, `📄`, `⌘`, arrows) of inconsistent appearance (S5, V1–V8). Use one consistent SVG icon style for frequent utilities and an overflow menu for secondary actions; retain text for ambiguous/destructive/consent actions. DONE requires translated accessible names, decorative icon hiding, keyboard-visible tooltips and clear hover/pressed/disabled states, with no removed capability or larger eager bundle beyond its existing budget. |
| ACT-02 | IN PROGRESS | P1 | Upload relies on a non-focusable label whose file input is `display: none`; the resizer has a separator role but no keyboard focus/handler/value model. File mention buttons have opacity zero unless a row is hovered (S3, S5). Make upload keyboard-operable, resizing keyboard-operable or provide an equivalent accessible width control, and show row actions on focus as well as touch. DONE requires real Tab/Enter/Space/arrow and coarse-pointer journeys. Small visual icons must not imply tiny targets: use ≥24×24 CSS-pixel targets as a baseline, with a preferred 44×44 touch target, visible focus and no overlap. |

### File explorer

FILE-01–04 are verified by §14. The findings below retain the pinned baseline and its acceptance contract.

| ID | Status | Priority | Finding and criterion for DONE |
|---|---|---|---|
| FILE-01 | DONE | P1 | `activePath` drives file tabs, but is never passed into recursive `FileNode`; tree rows have no active-file indication (S5). Keep file selection visible independently from hover/focus and expose its semantics; show the current full path without depending only on a tooltip. DONE requires opening from tree, search and message link to locate the same file, reveal ancestors where necessary and distinguish duplicate basenames without changing workspace authority. |
| FILE-02 | DONE | P1 | Directory expansion is a button inside nested lists, without `aria-expanded`, explicit chevron or pending state; only directory emoji changes. Each row/action joins the normal Tab order (S5). Add an accessible disclosure or a complete tree pattern, not incomplete ARIA roles. DONE requires announced expanded/collapsed/loading state and predictable keyboard traversal on a three-level fixture. If using tree semantics, implement roving focus, arrows, Home/End and typeahead; preserve distinct open-file and mention actions. |
| FILE-03 | DONE | P1 | Each `FileNode` caches `children`; Refresh fetches only the root and Git status. Same-key nodes retain the old child cache, so a nested addition/removal can remain invisible after Refresh (S5). Refresh expanded directories or invalidate their caches while keeping useful expansion/selection. DONE requires an actual nested add/remove followed by Refresh and canonical rows, including safe handling of a delayed older expansion response. |
| FILE-04 | DONE | P1 | Search renders a bare list for any truthy `query`, while requests require trimmed nonempty input. Loading, no-match and request failure all look like an empty region; JSX supplies no explicit labeled reset control, leaving native search-clearing affordances browser-dependent (S5). Distinguish those states, normalize whitespace consistently and provide reliable reset. DONE requires delayed/failed/zero-result/superseded searches and a whitespace query to give explicit, localized feedback without opening or mentioning a stale result. |
| FILE-05 | PARTIAL | P2 | Linked-directory, search, upload collision and hidden-file controls occupy permanent rows; viewer and explorer share a vertical stack whose tree shrinks to a 140px flex basis when a viewer opens (S3, V1, V3). Put uncommon options in an accessible menu/upload flow, retain Files/Changes discovery and prioritize the file list. DONE requires a many-file/long-path fixture at 1440×900 and 390×844 plus short-mobile checks; source/preview/diff, upload collision policy, trust and maximize/restore must remain reachable. Existing maximize already hides tree/chrome; do not report it as missing. |

### Settings

| ID | Status | Priority | Finding and criterion for DONE |
|---|---|---|---|
| PREF-01 | ABSENT | P1 | There is no visible category-tab navigation: `SettingsView` renders all sections sequentially and the boundary restores a scroll target (S6–S8). Introduce horizontal icon-and-label category tabs on desktop, with contextual left navigation where needed and only the selected category presented as active content, following U1 and the preferred live reference U2. DONE requires visible labels/current state, direct category addressing, Back/Forward/reload, keyboard navigation, accessible panel dismissal and mobile access; adding anchor buttons to the same long form alone does not meet this request. |
| PREF-02 | PARTIAL | P1 | Existing per-cwd section/group/row/scope memory, hash entry and guarded focus return are valuable, but assume all sections are mounted (S7–S8, T3). Adapt them to category ownership, preserving `#mcp`, `#model`, other existing section links and per-workspace intent. DONE requires no-project, two-workspace, trust-change, delayed-content and unsaved-form retirement evidence without navigation writes triggering configuration mutations. |
| PREF-03 | PARTIAL | P2 | Appearance saves browser preferences immediately; API-key/default forms require explicit saves; scoped tools/resources have their own writes (S6, S9). Those distinctions are real and should not be flattened into a misleading universal Save. Add consistent local/global/project/effective-source labeling and local save/pending/error/override feedback. DONE requires scoped readback and an explicit rule for dirty edits on category change, with no autosave of secrets or loss concealed as a successful save. |
| PREF-04 | PARTIAL | P2 | Appearance also contains send behavior, reasoning visibility, sound, browser notifications and Push settings (S6, V4–V5). Separate visual appearance from behavior and notifications; align checkbox/switch labels horizontally rather than the current grid placing the input above the text. DONE requires EN/FR desktop/mobile review and unchanged browser permission/Push consent behavior. |

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
- Independent terminal content/theme selection, generated diagram artwork and document canvases are retained; this is not a terminal emulator or diagram-renderer redesign. Remaining literal colors outside the palette are these content-specific surfaces, shadows and backdrops, not competing Settings/explorer control palettes.

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
