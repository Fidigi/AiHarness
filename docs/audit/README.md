# AiHarness Audit Reports

This directory contains versioned audit reports shared by agents and humans. Each report records a pinned target, testable criteria, evidence, decisions, and validation results.

## Structure

```text
docs/audit/
├── README.md
├── AUDIT-template.md
└── <subject>/
    └── AUDIT-N.md
```

Use the next sequential `AUDIT-N.md` inside a subject directory. Local-only evidence may live in an ignored subject tree, but versioned documentation must not actively link to ignored content.

## Create a Report

```bash
find docs/audit/<subject> -maxdepth 1 -name 'AUDIT-*.md' -print | sort -V
mkdir -p docs/audit/<subject>
cp docs/audit/AUDIT-template.md docs/audit/<subject>/AUDIT-N.md
```

Then:

1. pin the exact commit/environment and actual date;
2. define stable, testable IDs by surface;
3. include all seven result states and reconcile counts;
4. journal concrete evidence and commands actually run;
5. document every accepted gap and re-examination trigger;
6. keep the report open until only `DONE`/`GAP ACCEPTED` remain.

See `docs/ai/acceptance/audit-file-rules.md` and `docs/ai/workflows/create-audit-report.md` for complete rules.

## States

| State | Meaning |
|---|---|
| `ABSENT` | Required deliverable/evidence does not exist. |
| `PARTIAL` | A foundation exists, but completion criteria are unmet. |
| `TO BE DEFINED` | A product/security/scope decision is required. |
| `IN PROGRESS` | Implementation or verification is active. |
| `BLOCKED` | An external blocker is documented. |
| `DONE` | Every criterion is verified and evidence recorded. |
| `GAP ACCEPTED` | A dated final decision intentionally declines the criterion. |

Closure is `(DONE + GAP ACCEPTED) / total`; `PARTIAL` is not closed.

## Existing Versioned Audits

| Audit | Scope | Status |
|---|---|---|
| [Documentation audit 1](./documentation/AUDIT-1.md) | Documentation structure, accuracy, screenshots, bilingual coverage and validation at the pinned 2026-10-02 state | DONE for that snapshot |
| [Application architecture audit 1](./architecture/AUDIT-1.md) | Package/module coupling, dead-code classification, measured performance opportunities and compatibility decisions at commit `120b4d46` | IN PROGRESS — legacy RPC/Web and public utility removals plus RPC input limits approved; implementation/validation remain open |
| [Web design and UX audit 1](./web-design/AUDIT-1.md) | Theme contrast, icon-led minimalism, file-explorer usability and category-based Settings at commit `b98572c6`; source/existing-image assessment with a user-preferred live UX reference | IN PROGRESS — six starting decisions approved; bounded semantic-color/icon/input foundations and five verified explorer contracts (selection/path, disclosures, nested refresh, search, left explorer/right reader with compact controls); accessible icon controls now include translated keyboard hints and explicit states, with constrained chat fit and a reproduced explicit-jump scroll race corrected; non-overlapping composer terminal/minimap controls and simulated mobile-keyboard bounds are verified; corrected compact-action/cache-notice overrides and the reviewed inventory close VIS-01–03; the preceding palette increment passed 342/342 owning browser cases without updates/retries. Category-modal Settings now has bounded navigation/draft/focus/notice evidence and 100 reviewed captures, moving PREF-01 to PARTIAL; current frozen qualification retains functional/native failures and is not complete. General now has five contextual panels, seventeen whitelisted sections preserving all fifteen historical hashes, mobile Back/focus navigation and aligned preference labels. Its 33 reviewed capture changes and mapped preference/consent checks close PREF-04 (11/16 DONE); corrected owning checks retain 409 PASS / 2 native page-crash failures of 411, not global success. MCP now has flat contextual list/detail navigation, mobile Back/focus and retained OAuth drafts without new storage or authority; eighteen changed captures are reviewed, and frozen owning checks retain 421 PASS / 2 native worker SIGSEGV failures of 423. These failures remain unexplained; the MCP increment does not close another whole criterion. Child profiles now have contextual list/detail, filter-stable bounded selection and unclipped keyboard focus, with ten reviewed capture replacements. Corrected frozen checks retain 431 PASS / 1 native worker SIGSEGV failure of 432; older-source passes and development failures remain separate. Packages now have contextual list/detail, retained scoped batches and volatile drafts, with six reviewed captures and pending Back-focus repairs for packages/MCP/profiles. Frozen owning checks retain 290 PASS / 1 native worker SIGSEGV failure of 291; the system-light failure remains unexplained. Models now separates its four historical sections through contextual links and mobile Back, retaining volatile drafts and original operations; 36 captures and 18 native-view attachments are reviewed. The first frozen campaign retains 210 PASS / 1 obsolete accessibility-journey failure of 211; the corrected journey visits all four panels without weakening checks or its timeout. Corrected frozen owning qualification passes 211/211, with sixteen source files and all 318 E2E PNGs equal to the freeze; historical campaigns remain separate. Tools now has scoped list/detail, selected Code mode controls, pending focus and wrapped long names; complete allowlist writes and native Project-target readback are preserved. Eight replacements and fourteen viewport views are reviewed. Its first frozen campaign retains 168 passes and startup139 before seventeen asset cases; corrected-source qualification passes 185/185 with ten sources and all 318 E2E PNGs equal to the freeze. Earlier-source results, snapshot drift and failures remain separate. Installed skills now have grouped contextual metadata list/detail, mobile Back and independent explicit instruction reads; original filtered-group writes and native reader/disk contracts remain. Ten replacements and eighteen viewport views are reviewed. Frozen owning qualification passes 214/214, with eleven sources and all 318 E2E PNGs equal to the freeze; retained development failures and separate generation are not summed into that result. Built-in credential rows now have contextual list/detail and mobile Back, without changing the active provider or original explicit saves; drafts and Vertex mode remain volatile across selections. Four new captures and twelve credential views are reviewed. Frozen accounting retains 230 PASS / 1 browser-crash FAIL / 28 unstarted of 259 planned: the native launcher exits 139 before its case listing, and tablet-light provider presentation reports `Target crashed` before image comparison. Neither cause is established or failure rerun unchanged; development native success is not a passing frozen union. Eight sources and all 322 E2E PNGs equal the freeze. Provider connections now have built-in/custom contextual list/detail and mobile Back; shared editor targeting and operation-owned OAuth drafts remain independent of metadata browsing. Ten replacements and eighteen viewport views are reviewed. Its frozen accounting retains 263 PASS / 1 Models-reload page-crash FAIL of 264 selected cases; the earlier unchanged Code mode worker SIGSEGV is deliberately not rerun or included in those totals. Both causes remain unknown/open, and neither the selected campaign nor complete qualification passes. Eleven sources and all 322 E2E PNGs retain frozen inputs. No additional criterion is closed. The model catalogue now has grouped contextual metadata list/detail and mobile Back, independent of active-model selection and enablement; full filtered batches and original canonical writes remain. Eighteen replacements and nine viewport views are reviewed. Its frozen accounting retains 251 PASS / 18 unstarted of 269 selected cases: the pane-lifetime Server startup exits 139 before its eighteen cases; the earlier Code mode SIGSEGV remains deliberately deferred outside those totals. No cause or complete qualification is claimed. Eleven sources, all 322 E2E PNGs and reviewed hashes equal frozen inputs. Custom-model definitions now have flat contextual list/detail and mobile Back; browsing never retargets the separate volatile editor, with exact A-targeted PUT after B selection preserved. Six replacements and eight viewport views are reviewed, and native imported-model journeys use visible definition selection. Current frozen selected checks pass 285/285; the complete bounded owning universe is 287, with the earlier Code mode and new CRUD worker SIGSEGV cases explicitly deferred/open, not accepted or counted as passing. Preplanned overlapping development passes do not erase the failed controls run. Seventeen sources, all 322 E2E PNGs and reviewed hashes equal frozen inputs. No additional criterion closes. Skills registry entries now also have metadata-only list/detail and mobile Back, retaining requested install scope, instruction/invocation separation and complete Update all payloads. Six replacements and nine viewport views are reviewed. Same-group focus, directly restored disclosures and Back after installed-skill browsing have test-first repairs. The older-source frozen selection passes 292/292 but predates the final Back repair; corrected accounting retains 291 PASS / 1 MCP navigation page-crash FAIL of 292 selected cases, with two exact Code mode/CRUD SIGSEGVs deferred/open outside those totals (294-case bounded universe). Ten sources, all 322 E2E PNGs and reviewed hashes equal corrected frozen inputs. Neither older passes nor deferred cases fill the failure; complete qualification remains false. Outer Settings dismissal now has nonblocking confirmation for registered built-in credential, Access and scoped Defaults drafts, with private baselines, independent save cleanup and immediate source-browser trust retirement while confirmation is open. Ten new controls and five existing administration cases pass on corrected source; four new modal references and four viewport views are reviewed. Other editors, scope/shared-editor replacement, history/unload and global navigation are not yet guarded. Older-source preparation retains a mobile batch browser Target crash and native skill-batch worker SIGSEGV, neither diagnosed nor rerun unchanged; five exact failures now remain deferred/open. Corrected frozen accounting retains 298 PASS / 1 Settings-reload page-crash FAIL of 299 selected cases, with five prior failures deferred/open outside the selection (304-case bounded universe). Eight sources, all 326 E2E PNGs, four new references and reviewed current viewport hashes reconcile; one four-pixel frozen corner deviation is separately opened/reviewed without updating a reference. Neither older-source preparation nor deferred cases fill the failure; complete qualification remains false. Shared provider/model editor and plugin-install drafts now also register for outer dismissal, using private empty/loaded baselines and original successful-save/reset behavior. Three new missing-confirmation reds become passes; loaded/reverted clean forms, A-targeted full PUTs after B browsing and held Project installation despite Global metadata remain covered. Thirteen draft cases plus five existing administration cases pass; no reference is changed or new Save/authority added. Separate frozen accounting retains 300 PASS / 1 worker-SIGSEGV FAIL of 301 selected cases; the existing provider-configuration-error case fails with unknown inner stage/cause. Six exact prior failures remain deferred/open outside selected totals (307-case bounded universe), not accepted or filled from other passes. Three sources, all 326 E2E PNGs and four reviewed runtime views equal frozen inputs; references remain unchanged. No additional criterion closes at that boundary. MCP import/completion, child-profile editor, preserved rename ID and OAuth-paste drafts now also register for outer dismissal, without changing local Cancel/Escape, scope, consent or original writes. Four missing-confirmation reds are retained; seventeen draft cases plus five administration cases pass 22/22, and two existing standalone paste/rename controls pass separately. Current frozen accounting retains **302 PASS / 2 native failures of 304 selected cases**, with seven exact prior failures deferred/open outside those totals (311-case bounded universe). Existing native Code mode success reports `Page crashed` during chat navigation; the existing desktop-dark provider visual reports worker SIGSEGV. Both causes remain unknown, failures retained and not rerun unchanged or filled from focused passes. Build/types/Web 71/619 pass; five sources and all 326 E2E PNGs equal frozen inputs, while four alertdialog runtime views equal reviewed hashes, with no reference change. No additional criterion or accepted gap at that boundary. Code mode's uncontrolled inline-budget field now also retains its unsaved value on outer Escape, with a boolean-only flag and narrowly suppressed confirmation-induced blur. Two missing-dialog reds and two unintended PATCH reds are retained; corrected width1280/390 cases preserve Keep/focus, normal full-payload blur save, invalid reset and discard without another write. Nineteen draft cases plus five administration cases pass 24/24. Current frozen accounting retains **287 PASS / 17 fixture failures of 304 selected cases**; the full bounded universe is 313 with nine exact previous failures deferred/open. The equal selected size with the prior campaign has different membership, not a passing union. Native Vite exits with segmentation fault/139 during the run after twenty passes; seventeen quota fixtures then fail ECONNRESET/ECONNREFUSED before their case bodies. Inner cause remains unknown, with no unchanged rerun or quota/timeout/retry relaxation. Build/types/Web 71/619 pass; two sources and all 326 E2E PNGs equal frozen inputs. Four current frozen modal views match reviewed hashes, including an individually reopened four-pixel EN-mobile focus-corner difference, without reference changes. No new criterion or accepted gap; complete draft inventory, local/context/history/global navigation, native-host reliability, retirement and final visual/global qualification remain open |

Historical results and inventories describe their pinned source/date, not the current checkout. Later documentation changes require fresh source checks. Use relative links for versioned reports; reserve plain paths for local-only evidence.

## Common Prefixes

| Prefix | Surface |
|---|---|
| `RUN-*` | Runtime/agent execution |
| `DATA-*` | Persistence/data |
| `SEC-*` | Security/trust |
| `SES-*` | Session lifecycle |
| `CHAT-*` | Chat/agent guidance |
| `FILE-*`, `TERM-*` | Files, Git and terminals |
| `MOD-*`, `TOOL-*` | Providers, models and tools |
| `EXT-*`, `PLG-*` | Extensions and packages |
| `SUB-*` | Child agents |
| `PREF-*` | Preferences/settings |

An audit may define a specialized prefix in its glossary.

## Validation

For documentation-only audits, record these actual results in the journal:

```bash
make lint-docs
git diff --check
```

Add Docker targets from `docs/ai/project-map.md` when code/runtime/build behavior changes. Never record a planned command as passed.
