# AI Documentation Maintenance Rules

Use these rules whenever you create, review, or modify documentation in `docs/ai/`.

## 1. Keep Domains Isolated

- Keep one conceptual domain per topic file.
- Keep topic files near 150 lines and below 200 lines unless splitting would harm navigation.
- Put shared repository navigation and validation guidance in `project-map.md`; do not duplicate it in every topic.
- Create a topic only when behavior does not fit an existing domain or an existing topic becomes difficult to navigate.
- Put end-user material in `docs/users/` and contributor guidance in `docs/contributors/`, not in `docs/ai/`.

Use this topic structure where applicable:

```markdown
# Domain Title
> **Navigation:** See [`project-map.md`](../project-map.md) ...
## Overview
## Architecture
## Main Entry Points
## Public Contracts
## Critical Flows
## Associated Tests
## Common Changes
## Related Domains
```

## 2. Verify Before Editing

1. Read `project-map.md` and the complete target document.
2. Inspect the owning implementation and colocated tests; never infer behavior from filenames or changelog notes.
3. Update only the owning domain. Link to a related topic instead of copying its content.
4. Update `index.md` and `project-map.md` when topics, package boundaries, entry points, persistence formats, or validation commands change.
5. Preserve unrelated work in the working tree.

## 3. Respect Audience Boundaries

| Location | Audience | Agent rule |
|---|---|---|
| `docs/ai/` | AI agents | Load the relevant topic and this rule set. |
| `docs/audit/` | Agents and humans | Load when creating, validating, or implementing an audit. |
| `docs/users/` | End users | Do not load unless the user explicitly asks to audit or update user documentation. |
| `docs/contributors/` | Human contributors | Do not load unless the user explicitly asks to audit or update contributor documentation. |
| `docs/screenshots/` | Humans | Inspect image metadata or source scenarios; use visual inspection only when required. |

Keep all files in `docs/ai/` entirely in English. Human-facing language directories retain their declared language.

## 4. Write Actionable Documentation

- Use imperative wording for rules and concrete file paths for implementation guidance.
- Use tables for comparisons and inventories.
- Prefix critical warnings with `[IMPORTANT]` or `[WARNING]`.
- Keep code examples contextualized and no longer than 20 lines.
- Name exact test files instead of vague test categories.
- Describe public contracts precisely; do not use empty interface placeholders.
- Use relative Markdown links and verify that every file target and heading anchor exists.

## 5. Preserve Versioning Boundaries

A tracked document may link only to content that will be tracked in the same repository state. Never link from versioned documentation to gitignored local audit evidence.

- Use `git ls-files <path>` to check current tracking.
- Use `git check-ignore -v <path>` to identify ignored content.
- Run `make lint-docs`; predictive mode treats nonignored new files as intended additions.
- Navigation files may list a local-only audit as plain code text, without an active Markdown link.

## 6. Use the Relevant Workflow

Read `acceptance/AGENTS.md`, then load only the workflow required for the task:

| Task | Workflow |
|---|---|
| Create a topic | `workflows/create-topic-file.md` |
| Modify a topic | `workflows/modify-existing-doc.md` |
| Create an audit | `workflows/create-audit-report.md` |
| Validate documentation | `workflows/validate-document.md` |
| Update navigation | `workflows/update-navigation-files.md` |
| Add acceptance rules | `workflows/add-new-rules.md` |

For a new audit, copy `docs/audit/AUDIT-template.md` to `docs/audit/<subject>/AUDIT-N.md`, where `N` is the next number in that subject directory. Apply `acceptance/audit-file-rules.md`; never edit the template as part of creating a report.

## Validation Checklist

Before finishing any documentation change:

- [ ] Match claims against source and tests.
- [ ] Keep `docs/ai/` content in English and within its domain.
- [ ] Remove unresolved placeholders outside reusable templates.
- [ ] Confirm topic navigation, associated tests, common changes, and related domains.
- [ ] Update navigation inventories and measured line counts when needed.
- [ ] Run `make lint-docs` and `git diff --check`.
- [ ] Run the Docker validation required by `project-map.md` when code or runtime behavior changed.
- [ ] Review only the files you changed and report any validation that could not run.

See `acceptance/documentation-rules.md` for rule IDs and document-specific acceptance criteria.
