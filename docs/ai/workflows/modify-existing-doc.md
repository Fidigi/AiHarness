# Workflow 2: Modifying an Existing Topic File

**When to use:** Updating documentation for a domain you're currently working on in the code.

## Step 1 — Identify the Correct File

| Domain | File to Modify |
|---|---|
| AI providers, models, OAuth | `topics/providers.md` |
| Sessions, JSONL, compaction | `topics/sessions.md` |
| Extensions, hooks, plugins | `topics/extensions.md` |
| CLI commands, TUI modes | `topics/cli-reference.md` |
| Server API endpoints | `topics/server-api.md` |
| React components, stores | `topics/web-app-architecture.md` |
| Security, trust, auth | `topics/security.md` |

## Step 2 — Read Current Content First

**Never modify documentation based on intuition alone.** Always:
1. Read the current file completely
2. Cross-reference with actual source code
3. Identify what's outdated vs. what needs expansion

## Step 3 — Apply Changes Within Domain Scope

- Update only sections relevant to your change
- If you discover a related domain is also affected, note it but don't modify that file in this commit (unless part of the same logical change)
- Add new entry points or interfaces as they actually exist in code

## Step 4 — Update Related Domains

If your change affects how another domain interacts with this one:
1. Update the "Related Domains" section at the end of your file
2. Consider whether related files need updates (plan them for a follow-up commit if scope is large)

## Step 5 — Validate Before Committing

- [ ] Changes match actual code behavior (verify with source)
- [ ] No unrelated domain content added
- [ ] Line count still reasonable (<150 lines target, <200 hard limit)
- [ ] `make lint-docs` confirms all local links and versioning boundaries
- [ ] Associated tests section updated if new test files were added

## Related Rules

- [`../acceptance/documentation-rules.md`](../acceptance/documentation-rules.md) — U-06 to U-10
- [`../AGENTS.md`](../AGENTS.md) — maintenance conventions
- [`../project-map.md`](../project-map.md) — package boundaries and validation
