# Workflow 1: Creating a New Topic File

**When to use:** Adding documentation for a new functional domain (providers, sessions, CLI commands, etc.)

## Step 1 — Determine if a New File is Needed

### ✅ Create a new file in `docs/ai/topics/` when:
- The existing topic file approaches **~200 lines**
- A new subject has emerged that doesn't fit existing files
- Documentation for a domain has become difficult to navigate

### ❌ Do NOT create a new file when:
- It's a minor update (modify the existing file instead)
- The topic significantly overlaps with another domain
- It is end-user or contributor documentation (use the matching language folder under `docs/users/` or `docs/contributors/`).

## Step 2 — Copy the Topic Structure

Use this as your starting structure:

```markdown
# [Domain Title]

> **Navigation:** See [`project-map.md`](../project-map.md) for the complete project overview, package structure, and validation workflow.

## Overview
[1-2 paragraphs on this module's role]

## Architecture
[Relevant code diagram or description — only what's needed to work in this domain]

## Main Entry Points
| File | Responsibility |
|---|---|
| `path/to/main.ts` | Primary entry point |
| `path/supporting.ts` | Supporting implementation |

## Public Contracts and Interfaces
[Key types, functions, interfaces with brief descriptions — not just file paths]

## Critical Flows
[1-3 most important execution sequences with step-by-step detail]

## Associated Tests
[Test files relevant to this domain — be specific about what they cover]

## Common Changes
[2-3 typical modification scenarios with exact file paths and steps]

## Related Domains
- [`other-topic.md`](./other-topic.md) — Brief description of relationship
```

## Step 3 — Populate from Source Code

1. Read the actual implementation files listed in `project-map.md` §3 for this domain
2. Extract entry points, types, and interfaces directly from code (not intuition)
3. Identify test files by searching for `*.test.ts` or `*.spec.ts` next to source
4. Document only what's necessary for an agent to modify this domain

**Validation:** Can another agent understand and safely modify code in this domain by reading ONLY this file + project-map.md? If not, add missing context.

## Step 4 — Add Cross-References

1. Update `docs/ai/index.md` — Add the new topic to the navigation table
2. Update `docs/ai/project-map.md` §3 — Ensure package boundaries are accurate
3. In related domain files, add a link to your new file in their "Related Domains" section

## Step 5 — Validate Before Committing

Run through these checks:
- [ ] File is under ~150 lines (split if approaching limit)
- [ ] Navigation banner links correctly to project-map.md
- [ ] Entry points table includes at least main file + supporting files
- [ ] Related domains section lists 2+ connected topics
- [ ] All relative links resolve (`make lint-docs`)
- [ ] No whitespace errors remain (`git diff --check`)
- [ ] Prose is entirely English (review language scans manually)

## Related Rules

- [`../acceptance/documentation-rules.md`](../acceptance/documentation-rules.md) — topic acceptance
- [`../AGENTS.md`](../AGENTS.md) — language and maintenance conventions
- [`../project-map.md`](../project-map.md) — package boundaries and entry points
