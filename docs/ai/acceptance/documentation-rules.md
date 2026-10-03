# Acceptance Rules for AI Documentation

Apply these rules to every file in `docs/ai/`. Audit reports additionally follow [`audit-file-rules.md`](./audit-file-rules.md).

## Document Types

| Type | Location | Purpose | Target size |
|---|---|---|---:|
| Topic | `topics/*.md` | One implementation domain | About 150 lines; review before 200 |
| Navigation | `index.md`, `project-map.md` | Context routing and repository authority | About 500 lines |
| Conventions | `AGENTS.md` | Actionable maintenance rules | About 150 lines |
| Acceptance/workflow | `acceptance/`, `workflows/` | Executable criteria and procedures | No fixed limit |

Targets guide context management; do not split a coherent document solely to satisfy a number.

## Universal Rules

### U-01 — Language

Write every `docs/ai/` file entirely in English. Paths and references to French human documentation may retain their literal names. Audit reports are also English.

### U-02 — Local links

Use paths relative to the containing Markdown file. Every local file target and Markdown heading anchor must resolve. Do not confuse `git diff --check` (whitespace) with link validation.

**Validation:** run `make lint-docs` and `git diff --check`.

### U-03 — Placeholders

Leave no unresolved task placeholders such as `[TODO]`, `[nb]`, fake counts, or template labels in a completed document. Reusable templates may contain clearly identified placeholders.

### U-04 — Formatting

- Use tables for inventories and comparisons.
- Prefix critical warnings with `[IMPORTANT]` or `[WARNING]`.
- Keep code examples contextualized and no longer than 20 lines.
- Use fenced blocks only for actual multiline code or diagrams.
- Use exact code paths and identifiers in backticks.

### U-05 — Cross-reference integrity

- Start each topic with a link to `../project-map.md`.
- End each topic with at least two linked related domains.
- Add inline links where a cross-domain contract affects the described flow.
- Link instead of duplicating another topic’s details.

### U-06 — Domain isolation

Keep the implementation domain coherent. A topic may describe required cross-package integration for that domain; it must not become a general guide to unrelated subsystems.

Examples:

| Topic | Owns | May reference, not absorb |
|---|---|---|
| Providers | Provider execution, catalogue, registry, OAuth | Session persistence and UI architecture |
| Sessions | JSONL, serialization, compaction, branches, pagination | Provider implementation details |
| Extensions | JavaScript API/loader, packages, reload, interactions | Provider internals and session schema |
| Server API | HTTP/streaming contracts and middleware | Component implementation details |

### U-07 — Self-containment

A topic plus `project-map.md` must be enough to begin safe work. Include:

1. owning entry points and responsibilities;
2. concrete public contracts and invariants;
3. critical execution flows;
4. exact associated tests;
5. common change guidance.

Self-containment does not justify duplicating complete related-domain documentation.

### U-08 — Test association

Name existing test files and state what they prove. Do not use vague labels such as “provider tests” or invent a path. Include browser/live tests only when they exercise the documented contract.

### U-09 — Change guidance

Mutable topic documents must contain `## Common Changes` with two or more actionable scenarios and owning paths/contracts.

### U-10 — Living status

Audits, roadmaps, and state trackers require a dated status banner. Static topics and conventions do not.

```markdown
> **Status: IN PROGRESS** (2026-10-02)
>
> Brief current-state statement.
```

### U-11 — Audit naming

Store audits at `docs/audit/<subject>/AUDIT-N.md`, numbering sequentially from 1 within each subject. Do not use descriptive filenames at the audit root.

### U-12 — Audit dates

Replace all date placeholders in an instantiated audit with real ISO dates. A reusable template may retain `YYYY-MM-DD`.

### U-13 — Versioning isolation

A versioned document may actively link only to content that is tracked or is a nonignored file intended in the same change. Never link to gitignored local evidence. Navigation files may list a local-only audit as plain code text without a Markdown link.

**Validation:** `make lint-docs` checks current local targets, heading anchors, and versioning boundaries in predictive mode.

## Topic Acceptance

A valid `topics/*.md` file contains:

```markdown
# Domain Title
> **Navigation:** See [`project-map.md`](../project-map.md) ...
## Overview
## Architecture or Main Entry Points
## Public Contracts / Invariants
## Critical Flows
## Associated Tests
## Common Changes
## Related Domains
```

Combine headings when that improves clarity, but preserve all information.

Checklist:

- [ ] Overview is concise and defines ownership.
- [ ] Main entry points use repository-root paths.
- [ ] Contracts match exported types and runtime behavior.
- [ ] Flows identify persistence, cancellation, security, and package boundaries where relevant.
- [ ] Every named test path exists.
- [ ] Related-domain links resolve.
- [ ] The file remains near the context target.

## Navigation Acceptance

### `index.md`

- List every topic exactly once.
- Give line-count estimates within 10%.
- Provide task-oriented loading paths.
- Keep local-only audits as plain paths.

### `project-map.md`

- Keep package ownership, runtime entry points, persistence locations, transport contracts, and validation commands authoritative.
- Update it only when those cross-repository facts change.
- Do not copy detailed topic content or stale planning claims into the map.

## Convention Acceptance

`AGENTS.md` must:

- use imperative rules;
- define audience/language/link boundaries;
- route agents to task-specific workflows;
- include a concise final validation checklist;
- avoid duplicating full acceptance and audit rules.

## Validation Procedure

1. Read the target document completely.
2. Verify every behavioral claim against implementation and tests.
3. Run `make lint-docs`.
4. Check topic inventory and measured line counts.
5. Search changed non-template files for unresolved placeholders.
6. Run `git diff --check`.
7. Run Docker tests required by `project-map.md` if behavior or build tooling changed.
8. Review the final diff for accidental human-doc, generated-file, or unrelated changes.

## Common Failures

| Failure | Correction |
|---|---|
| French text in `docs/ai/` | Translate it; keep French only in literal human-doc paths/titles when necessary. |
| A source/test path does not exist | Inspect the repository and use the exact owning path. |
| A topic lists categories instead of tests | Name concrete test files and coverage. |
| `git diff --check` is treated as a link checker | Run `make lint-docs` as well. |
| A new topic is omitted from navigation | Update `index.md`, related topics, and `project-map.md` when boundaries changed. |
| An audit is marked done with open states | Keep it `IN PROGRESS` until only `DONE`/`GAP ACCEPTED` remain. |

## Related Files

- [`../AGENTS.md`](../AGENTS.md) — concise maintenance rules
- [`./AGENTS.md`](./AGENTS.md) — workflow router
- [`./audit-file-rules.md`](./audit-file-rules.md) — audit-specific acceptance
- [`../workflows/validate-document.md`](../workflows/validate-document.md) — validation procedure
