# AiHarness Audit Reports

This directory contains versioned audit reports shared by agents and humans. Each report records a pinned target, testable criteria, evidence, decisions, and validation results.

## Structure

```text
docs/audit/
├── README.md
├── AUDIT-template.md
└── <subject>/
    ├── AUDIT-1.md
    └── AUDIT-2.md
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
| `docs/audit/documentation/AUDIT-1` | Documentation structure, accuracy, screenshots, bilingual coverage and validation | DONE |

Paths are plain code text and intentionally omit `.md`, matching navigation conventions.

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
