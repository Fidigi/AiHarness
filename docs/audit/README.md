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
| [Web design and UX audit 1](./web-design/AUDIT-1.md) | Theme contrast, icon-led minimalism, file-explorer usability and category-based Settings at commit `b98572c6`; source/existing-image assessment with a user-preferred live UX reference | IN PROGRESS — six starting decisions approved; bounded semantic-color/icon/input foundations and five verified explorer contracts (selection/path, disclosures, nested refresh, search, left explorer/right reader with compact controls); accessible icon controls now include translated keyboard hints and explicit states, with constrained chat fit and a reproduced explicit-jump scroll race corrected; non-overlapping composer terminal/minimap controls and simulated mobile-keyboard bounds are verified; corrected compact-action/cache-notice overrides and the reviewed inventory close VIS-01–03; the preceding palette increment passed 342/342 owning browser cases without updates/retries. Category-modal Settings now has bounded navigation/draft/focus/notice evidence and 100 reviewed captures, moving PREF-01 to PARTIAL; current frozen qualification retains functional/native failures and is not complete. General now has five contextual panels, seventeen whitelisted sections preserving all fifteen historical hashes, mobile Back/focus navigation and aligned preference labels. Its 33 reviewed capture changes and mapped preference/consent checks close PREF-04 (11/16 DONE); corrected owning checks retain 409 PASS / 2 native page-crash failures of 411, not global success. MCP now has flat contextual list/detail navigation, mobile Back/focus and retained OAuth drafts without new storage or authority; eighteen changed captures are reviewed, and frozen owning checks retain 421 PASS / 2 native worker SIGSEGV failures of 423. These failures remain unexplained; the MCP increment does not close another whole criterion. Child profiles now have contextual list/detail, filter-stable bounded selection and unclipped keyboard focus, with ten reviewed capture replacements. Corrected frozen checks retain 431 PASS / 1 native worker SIGSEGV failure of 432; older-source passes and development failures remain separate. Packages now have contextual list/detail, retained scoped batches and volatile drafts, with six reviewed captures and pending Back-focus repairs for packages/MCP/profiles. Frozen owning checks retain 290 PASS / 1 native worker SIGSEGV failure of 291; the system-light failure remains unexplained. Models now separates its four historical sections through contextual links and mobile Back, retaining volatile drafts and original operations; 36 captures and 18 native-view attachments are reviewed. The first frozen campaign retains 210 PASS / 1 obsolete accessibility-journey failure of 211; the corrected journey visits all four panels without weakening checks or its timeout. Corrected frozen owning qualification passes 211/211, with sixteen source files and all 318 E2E PNGs equal to the freeze; historical campaigns remain separate. Tools now has scoped list/detail, selected Code mode controls, pending focus and wrapped long names; complete allowlist writes and native Project-target readback are preserved. Eight replacements and fourteen viewport views are reviewed. Its first frozen campaign retains 168 passes and startup139 before seventeen asset cases; corrected-source qualification passes 185/185 with ten sources and all 318 E2E PNGs equal to the freeze. Earlier-source results, snapshot drift and failures remain separate. No additional criterion is closed. Models/Skills entity layouts, dirty-close confirmation, retirement acceptance, final visual-direction review and global qualification remain open |

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
