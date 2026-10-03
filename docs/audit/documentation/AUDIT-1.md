# Documentation Audit — AiHarness / `docs/`

> **Status: DONE** (2026-10-02)
>
> Twenty-five criteria are `DONE`; DOC-25 is closed as `GAP ACCEPTED` following the explicit decision not to add a root `SKILLS.md`.

## 1. Audit Reference

| Element | Value |
|---|---|
| Target observed | AiHarness versioned documentation and documentation-validation tooling |
| Audited instance | Commit `44d425e5cf959b1b30dea48df023ed37df888459` plus the documentation worktree listed by `git status --short` on 2026-10-02 |
| Audit date | 2026-10-02 |
| Pinned source | `https://github.com/Fidigi/AiHarness/tree/44d425e5cf959b1b30dea48df023ed37df888459` plus this report’s journaled worktree files |
| Detailed references | Source/tests named in `docs/ai/topics/*.md`; screenshot provenance in `docs/screenshots/README.md` |

**Objective:** Verify the new agent/human documentation structure against implementation and tests, correct inaccurate completion claims, finish the improvement axes, and record the agent-method packaging decision.

### Known limitations

- This was a documentation/source review. No runtime behavior or external provider was exercised because no application behavior changed.
- Documentation captures reuse already-versioned deterministic Playwright baselines; this pass synchronized but did not regenerate those baselines.
- FR/EN parity was checked structurally and by targeted semantic review; it was not certified by an independent professional translator.

## 2. Result

| Status | Count | Details |
|---|---:|---|
| `DONE` | 25 | Verified against repository files and corrected where necessary |
| `PARTIAL` | 0 | — |
| `ABSENT` | 0 | — |
| `TO BE DEFINED` | 0 | — |
| `BLOCKED` | 0 | — |
| `IN PROGRESS` | 0 | — |
| `GAP ACCEPTED` | 1 | DOC-25: no root `SKILLS.md`; existing workflows remain canonical |
| **Total** | **26** | **100% closed: 26 / 26** |

### Summary by Category

| Category | Done | Partial | Absent | To define | Blocked | In progress | Gap accepted | Total |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| AI documentation structure | 7 | 0 | 0 | 0 | 0 | 0 | 0 | 7 |
| AI completeness and accuracy | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 6 |
| Screenshot integration | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 4 |
| Bilingual coverage | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 5 |
| Context optimization | 3 | 0 | 0 | 0 | 0 | 0 | 1 | 4 |

## 3. Traceability by Surface

### AI Documentation Structure (`docs/ai/`)

| ID | Status | Criterion and evidence |
|---|---|---|
| DOC-01 | DONE | Eight topic files each own one implementation domain. |
| DOC-02 | DONE | Topic files are 101–120 lines, below the 150-line target. |
| DOC-03 | DONE | Agent documentation prose is English-only. |
| DOC-04 | DONE | Every topic has linked related domains and inline links at cross-domain contracts. |
| DOC-05 | DONE | `docs/ai/index.md` lists all eight topics with measured estimates within 10%. |
| DOC-06 | DONE | `project-map.md` is a single 408-line authority without the previous duplicate authority block or stale catalogue/extension claims. |
| DOC-07 | DONE | `docs/ai/AGENTS.md` is a 95-line imperative rule set with audience exceptions, workflow routing, and executable validation. |

### Completeness and Accuracy Against Source

| ID | Status | Criterion and evidence |
|---|---|---|
| DOC-08 | DONE | Provider topic places `AiProvider` in Core and the published catalogue in Server, with exact tests. |
| DOC-09 | DONE | Session topic distinguishes JSONL append/save from JSON wire serialization and legacy unversioned input. |
| DOC-10 | DONE | Extension topic distinguishes `ExtensionAPI` registrations, package resources, executable reload, rollback, and interactions. |
| DOC-11 | DONE | Child-agent topic matches profile count 50, concurrency 1–16, depth 1–3, exact routes, thinking type, events, persistence, and tests. |
| DOC-12 | DONE | Server topic uses actual session export, model activation, detached state/events, and child-run methods/paths. |
| DOC-13 | DONE | Security topic records `~/.ai-harness/trust.json`, real capabilities, cookie behavior, secret stores, and executable-code limits. |

### Screenshot Integration

| ID | Status | Criterion and evidence |
|---|---|---|
| DOC-14 | DONE | All eight thematic directories contain 11 PNG captures synchronized from tracked Playwright baselines. |
| DOC-15 | DONE | `docs/screenshots/README.md` is bilingual and records actual 1440×900/820×1180 viewports plus source provenance. |
| DOC-16 | DONE | Both user guides embed all 11 renderable captures and every target exists. |
| DOC-17 | DONE | Workspace, chat, sessions, files, settings, extensions, tablet, and keyboard-focus states are represented. |

### Bilingual Coverage

| ID | Status | Criterion and evidence |
|---|---|---|
| DOC-18 | DONE | French user guide/container guide and language index exist. |
| DOC-19 | DONE | English user guide restored omitted Web extension, child-agent, PWA, locale, workspace, detached-agent, and composer sections; FR/EN structures now match (55 headings, 82 fences, 102 table rows, 11 images). |
| DOC-20 | DONE | Six French contributor guides plus a language index exist. |
| DOC-21 | DONE | Six English contributor guides match headings/tables/fences; escaped Markdown backticks were corrected. |
| DOC-22 | DONE | Root and per-language user/contributor indexes now advertise the files that actually exist. |

### Context Optimization

| ID | Status | Criterion and evidence |
|---|---|---|
| DOC-23 | DONE | `index.md` gives task-oriented loading paths and corrected repository-root entry points. |
| DOC-24 | DONE | Six focused workflows route creation, modification, audit, validation, navigation, and rule tasks. |
| DOC-25 | GAP ACCEPTED | Do not create a root `SKILLS.md`: neither Pi nor AiHarness discovers that plural file automatically, and it would duplicate `AGENTS.md`, workflows, acceptance rules, and navigation. |
| DOC-26 | DONE | Acceptance rules, audit rules, template, README, and workflows now agree on links, statuses, closure arithmetic, dates, evidence, and validation. |

## 4. Convention for Future Audits

| State | Meaning |
|---|---|
| `ABSENT` | Required deliverable/evidence does not exist. |
| `PARTIAL` | A foundation exists, but completion criteria are unmet. |
| `TO BE DEFINED` | A product, security, compatibility, or scope decision is required. |
| `IN PROGRESS` | Implementation or verification is active. |
| `BLOCKED` | An external blocker and owner/trigger are documented. |
| `DONE` | Every criterion is verified and evidence recorded. |
| `GAP ACCEPTED` | A dated final decision intentionally declines the criterion. |

### Closure Rule

An item becomes `DONE` only when its full criterion is verified against source/tests, related documentation is consistent, applicable visual evidence exists, and the journal records commands actually run. The report becomes `DONE` only when every item is `DONE` or `GAP ACCEPTED`.

## 5. Decisions and Accepted Gaps

One gap is accepted after explicit discussion.

| ID | Dated decision | Justification | Re-examination trigger |
|---|---|---|---|
| DOC-25 | 2026-10-02 — Do not create a root `SKILLS.md` | The file has no automatic meaning for Pi or AiHarness and would duplicate the existing workflow/router hierarchy. If specialization becomes useful, prefer a portable `.agents/skills/<name>/SKILL.md`. | A method needs cross-repository reuse, bundled scripts/assets, explicit `/skill:*` invocation, or agents repeatedly fail to route to existing workflows. |

## 6. Delivery Journal

| Date | ID(s) | Old → New | Evidence | Validation | Notes/decision |
|---|---|---|---|---|---|
| 2026-10-02 | DOC-01–DOC-07 | mixed claims → `DONE` | `docs/ai/{AGENTS,index,project-map}.md`, all topic files | Topic inventory/path scripts; `make lint-docs` | Corrected line counts, package paths, duplicate authority text, links, and conventions. |
| 2026-10-02 | DOC-08–DOC-13 | claimed `DONE`/`PARTIAL` → `DONE` | `docs/ai/topics/*.md`; named Core/CLI/Server/Web source and tests | Literal source/test path check; `make lint-docs` | Rewrote unsupported provider, session, extension, route, subagent, and trust claims. |
| 2026-10-02 | DOC-14–DOC-17 | `PARTIAL` → `DONE` | `docs/screenshots/**/*.png`, `docs/screenshots/README.md`, `scripts/sync-doc-screenshots.sh`, both user guides | `scripts/sync-doc-screenshots.sh` (11 files); PNG dimension check; `make lint-docs` | Reused deterministic tracked visual baselines; no new UI baseline generated. |
| 2026-10-02 | DOC-18–DOC-22 | inaccurate `DONE`/`PARTIAL` → `DONE` | `docs/users/{fr,en}/`, `docs/contributors/{fr,en}/`, language indexes, root `README.md` links | FR/EN Markdown structure comparison; `make lint-docs` | Restored omitted English user sections and unescaped English contributor Markdown. |
| 2026-10-02 | DOC-23, DOC-24, DOC-26 | `PARTIAL` → `DONE` | `docs/ai/index.md`, `docs/ai/workflows/`, `docs/ai/acceptance/`, `docs/audit/{README,AUDIT-template}.md`, `scripts/check-doc-versioning.sh` | Missing-target/anchor negative tests; `make lint-docs`; `git diff --check` | Validation reports real file/link counts and fails for missing targets or heading anchors. |
| 2026-10-02 | DOC-25 | `TO BE DEFINED` → `GAP ACCEPTED` | No `SKILLS.md` created; existing `docs/ai/workflows/`, acceptance rules, and navigation retained | Explicit user confirmation | Root plural file rejected; use a portable `.agents/skills/<name>/SKILL.md` only if a re-examination trigger occurs. |

### Final Validation Snapshot

| Command/check | Outcome |
|---|---|
| `make lint-docs` | PASS — 47 Markdown files and 322 local targets/anchors checked in predictive mode |
| Missing-target and missing-anchor negative fixtures | PASS — both produced the expected validation failure |
| `scripts/sync-doc-screenshots.sh` | PASS — 11 documentation captures synchronized |
| PNG signature/dimension inventory | PASS — ten 1440×900 images and one 820×1180 image |
| Manual visual review of all 11 captures | PASS — each state is legible, deterministic, and contains no credential or personal data |
| FR/EN headings, fences, table rows, and image-count comparison | PASS — each paired guide has matching structure |
| `bash -n scripts/check-doc-versioning.sh scripts/sync-doc-screenshots.sh` | PASS |
| `git diff HEAD --check` | PASS |

## 7. Verification Findings and Completed Axes

| Axis | Result | Evidence |
|---|---|---|
| AXE-01 — Representative screenshots | DONE | 11 Playwright-derived PNGs across all eight directories, synchronized by script |
| AXE-02 — Child-agent topic | DONE | Source-correct 114-line topic with tests and change guidance |
| AXE-03 — English user documentation | DONE | Structural parity restored; omitted sections translated |
| AXE-04 — English contributor documentation | DONE | Six files present with valid Markdown formatting |
| AXE-05 — Bilingual screenshot guide | DONE | Matching inventory and refresh procedure |
| AXE-06 — Agent-method packaging | GAP ACCEPTED | Root `SKILLS.md` rejected after discussion; existing workflow routing is sufficient |
| AXE-07 — Cross-references | DONE | Linked related-domain sections and inline contract links in every topic |
| AXE-08 — Oversized conventions | DONE | `AGENTS.md` reduced from 218 to 95 lines without adding another layer |

## 8. Inventory Snapshot

### Agent Documentation

| Item | Count/status |
|---|---|
| Topic files | 8; 101–120 lines |
| Workflows | 6 |
| Acceptance files | 3 including workflow router |
| Navigation map | 408 lines |
| Convention file | 95 lines |

### Human Documentation

| Item | FR | EN |
|---|---:|---:|
| User guides | 2 + index | 2 + index |
| Contributor guides | 6 + index | 6 + index |
| User-guide headings/fences/tables/images | 55 / 82 / 102 / 11 | 55 / 82 / 102 / 11 |

### Screenshots

| Theme directory | PNG count |
|---|---:|
| `01-workspace` | 1 |
| `02-chat` | 2 |
| `03-sessions` | 2 |
| `04-files-git` | 1 |
| `05-settings` | 2 |
| `06-extensions` | 1 |
| `07-mobile` | 1 |
| `08-accessibility` | 1 |
| **Total** | **11** |

## 9. Glossary

| Prefix | Scope | Example |
|---|---|---|
| `DOC-*` | Documentation structure, accuracy, coverage, and maintenance tooling | `DOC-01` |
