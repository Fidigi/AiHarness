# Workflow 3: Create or Overhaul an Audit Report

**Use when:** Auditing a target, security posture, parity surface, or documentation system. For a small update to an already valid report, apply the same checks without copying a new file.

## Step 1 — Choose Subject and Number

Store the report at `docs/audit/<subject>/AUDIT-N.md`. Find the highest number in that subject and increment it; start at 1 when none exists.

```bash
find docs/audit/<subject> -maxdepth 1 -name 'AUDIT-*.md' -print | sort -V
mkdir -p docs/audit/<subject>
cp docs/audit/AUDIT-template.md docs/audit/<subject>/AUDIT-N.md
```

Never use a descriptive root-level filename, skip a number, reuse a number, or edit the template as the report.

## Step 2 — Pin the Audited State

Record:

- target name/version/scope;
- exact local commit and dirty-tree scope or deployed URL;
- actual audit date;
- origin/upstream URL and exact commit/tag when available;
- static/runtime limitations and detailed evidence references.

Do not call `HEAD` a pinned state if uncommitted files are part of the audit.

## Step 3 — Define Testable IDs

1. Group criteria by functional surface.
2. Give each criterion one stable ID and current state.
3. Define specialized prefixes in the report glossary.
4. State evidence required for `DONE`.
5. Include an API-family table only when routes/contracts are in scope.

Use standard prefixes such as `RUN-*`, `DATA-*`, `SEC-*`, `SES-*`, `CHAT-*`, `FILE-*`, `TERM-*`, `MOD-*`, `TOOL-*`, `EXT-*`, `PLG-*`, `SUB-*`, and `PREF-*` where they fit.

## Step 4 — Complete the Result Table

Include all states, even at zero:

- `DONE`
- `PARTIAL`
- `ABSENT`
- `TO BE DEFINED`
- `BLOCKED`
- `IN PROGRESS`
- `GAP ACCEPTED`

Verify:

```text
Total = sum of all state counts
Closure = (DONE + GAP ACCEPTED) / Total × 100
```

Category summaries must reconcile with the item table. Never count `PARTIAL` as closed.

## Step 5 — Maintain the Journal

Use one row per verified implementation/review batch:

```markdown
| Date | ID(s) | Old → New | Evidence | Validation | Notes/decision |
```

- Use the actual execution date.
- Name concrete source, test, documentation, and visual files.
- Record commands that actually ran and their result.
- For documentation-only work, include `make lint-docs` and `git diff --check`.
- For runtime/build changes, include the Docker targets required by `project-map.md`.
- One row may cover an explicit ID list/range; row count need not equal criterion count.

## Step 6 — Validate Consistency

Check the report from current summary to appendices:

- [ ] Status banner uses an allowed state and current date.
- [ ] Audit Reference identifies the exact audited state.
- [ ] Every §3 ID has one current status and appears in the journal.
- [ ] Detailed findings do not retain stale statuses as current facts.
- [ ] Recommendations and inventories match delivered files.
- [ ] Accepted gaps include justification and re-examination trigger.
- [ ] No future journal entries or unexecuted validations are recorded.
- [ ] Report is entirely English.

Run:

```bash
grep -nE 'YYYY|MM([^0-9]|$)|DD([^0-9]|$)' docs/audit/<subject>/AUDIT-N.md
make lint-docs
git diff --check
```

The placeholder scan must return no output for an instantiated report.

## Step 7 — Close or Leave Open Honestly

Use `DONE` only when every item is `DONE` or `GAP ACCEPTED`, applicable visual evidence exists, and all validation is recorded. Otherwise keep `IN PROGRESS` (or `BLOCKED` when the whole audit is blocked) and state the remaining IDs in the banner.

## Step 8 — Update Navigation

- List the audit as a plain extensionless path in `project-map.md` if agents need discoverability.
- Add it to `docs/audit/README.md`.
- Update user/contributor documentation only when the audited implementation or documentation actually changed.
- Re-run link/versioning checks after navigation edits.

## Related Rules

- [`../acceptance/audit-file-rules.md`](../acceptance/audit-file-rules.md)
- [`../acceptance/documentation-rules.md`](../acceptance/documentation-rules.md)
- `docs/audit/AUDIT-template.md` — repository-root path to the reusable template
