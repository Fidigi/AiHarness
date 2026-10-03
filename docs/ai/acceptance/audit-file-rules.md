# Acceptance Rules for Audit Reports

Apply these rules to instantiated reports under `docs/audit/<subject>/`. The reusable `docs/audit/AUDIT-template.md` may contain explicit placeholders.

## 1. File and Date Rules

### FN-01 — Name and location

Use `docs/audit/<subject>/AUDIT-N.md`, where `N` starts at 1 and increments without gaps inside that subject directory.

```bash
find docs/audit/<subject> -maxdepth 1 -name 'AUDIT-*.md' -print
```

Do not use descriptive audit filenames or place reports at `docs/audit/` root.

### D-01 — Real dates

Use real ISO calendar dates in the status banner, Audit Reference, and every journal row. Do not predate/future-date work or copy a date from an unexecuted plan.

```bash
grep -nE 'YYYY|MM([^0-9]|$)|DD([^0-9]|$)' docs/audit/<subject>/AUDIT-N.md
# Expected: no output
```

## 2. Required Structure

| ID | Section | Requirement |
|---|---|---|
| S-01 | Title | Identify the audited target and project/surface. |
| S-02 | Status banner | Use `IN PROGRESS`, `DONE`, `BLOCKED`, or `TO BE DEFINED` plus last-update date. |
| S-03 | §1 Audit Reference | Identify target, exact audited repository state/environment, date, sources, and limitations. |
| S-04 | §2 Result | Count every allowed status and calculate closure correctly. |
| S-05 | §3 Traceability | Map stable IDs to findings/criteria by surface. |
| S-06 | §4 Convention | Define states and closure for the first audit in a subject; later audits may link to it. |
| S-07 | §5 Decisions | Required when any item is `GAP ACCEPTED`. |
| S-08 | §6 Delivery Journal | Record evidence and validation for each item or explicit ID range. |

Additional findings, recommendations, axes, inventories, and annexes are optional. They must not contradict §§1–6.

## 3. Status Banner

Use:

```markdown
> **Status: IN PROGRESS** (2026-10-02)
>
> One sentence describing the remaining work.
```

- `DONE` is valid only when every item is `DONE` or `GAP ACCEPTED`.
- `BLOCKED` identifies an audit-wide blocker; item-level blockers still appear in §2/§3.
- `TO BE DEFINED` means the audit scope itself needs a decision.
- Add a closing note in §5 or an annex when moving to `DONE`.

## 4. Audit Reference

Include:

| Field | Rule |
|---|---|
| Target observed | Name and version/scope of the audited target |
| Audited instance | Exact repository commit plus dirty-tree scope, deployment, or URL |
| Audit date | Actual ISO date |
| Pinned source | Exact commit/tag and repository URL when upstream exists; for an internal audit, the local commit plus origin URL |
| Detailed references | Evidence matrix, source/test paths, or `None` with justification |

Do not claim `HEAD` alone is a pinned source when the audit covers uncommitted changes. State static/runtime limitations precisely.

## 5. Result Table

List all states, including zero counts:

| Status | Closure contribution |
|---|---:|
| `DONE` | Closed |
| `PARTIAL` | Open |
| `ABSENT` | Open |
| `TO BE DEFINED` | Open |
| `BLOCKED` | Open |
| `IN PROGRESS` | Open |
| `GAP ACCEPTED` | Closed |

Rules:

- Counts must equal the IDs in §3.
- Total must equal the sum of status rows.
- Closure is `(DONE + GAP ACCEPTED) / Total × 100`.
- Never count `PARTIAL` as closed.
- Category summaries must reconcile with the main table.

## 6. Traceability

- Assign each criterion one stable ID and one current status.
- Group IDs by functional surface.
- Define any audit-specific prefix in the glossary.
- Make descriptions testable: state what evidence proves completion.
- Ensure every ID appears in at least one journal row, either explicitly or through an unambiguous inclusive range.
- Include an API-family mapping only when routes/contracts are part of the audit.

Suggested standard prefixes include `RUN-*`, `DATA-*`, `SEC-*`, `SES-*`, `CHAT-*`, `FILE-*`, `TERM-*`, `MOD-*`, `TOOL-*`, `EXT-*`, `PLG-*`, `SUB-*`, and `PREF-*`. Specialized audits may define another prefix.

## 7. State Convention and Transitions

| State | Meaning |
|---|---|
| `ABSENT` | Required deliverable/evidence does not exist. |
| `PARTIAL` | A foundation exists, but completion criteria are unmet. |
| `TO BE DEFINED` | A product/security/scope decision is required. |
| `IN PROGRESS` | Implementation or verification is actively underway. |
| `BLOCKED` | An external blocker and owner/trigger are documented. |
| `DONE` | Every criterion is verified and evidence recorded. |
| `GAP ACCEPTED` | A dated final decision intentionally declines the criterion. |

Record real transitions (`ABSENT` → `PARTIAL`, `PARTIAL` → `DONE`). `GAP ACCEPTED` is final unless a later audit creates a new criterion; do not silently transition it back.

## 8. Accepted Gaps

For every `GAP ACCEPTED`, record:

1. ID and dated decision;
2. exact behavior not delivered;
3. product, security, or compatibility justification;
4. owner/decision source when known;
5. re-examination trigger.

## 9. Delivery Journal

Use six columns:

```markdown
| Date | ID(s) | Old → New | Evidence | Validation | Notes/decision |
```

- Evidence names concrete changed/source/test/document paths.
- Validation lists commands actually executed and results, not intended future commands.
- Use `make lint-docs` and `git diff --check` for documentation-only work.
- Record Docker targets from `project-map.md` when code/runtime/build behavior changed.
- Do not invent passing test counts or validations.
- One row may cover multiple IDs; journal row count does not need to equal item count.

## 10. Language and Consistency

- Write the entire report in English.
- Keep technical IDs, paths, commands, and source-language quotations unchanged where needed.
- Historical findings may remain as an explicitly labeled snapshot, but current status/summary/recommendations must agree.
- Avoid emoji-only severity indicators; always include text status.
- Recalculate line counts and inventories rather than copying estimates.

## 11. Closure

Mark an audit `DONE` only when:

- [ ] all IDs are `DONE` or `GAP ACCEPTED`;
- [ ] summary/category counts reconcile with §3;
- [ ] every ID has journal evidence;
- [ ] validation commands actually ran and are recorded;
- [ ] applicable visual evidence exists and is referenced;
- [ ] navigation/user documentation changed when the implementation boundary changed;
- [ ] accepted gaps have decisions and triggers;
- [ ] no contradictory historical section is presented as current state.

## 12. Validation Checklist

```markdown
- [ ] Filename is the next docs/audit/<subject>/AUDIT-N.md
- [ ] Status and every date are real and current
- [ ] Mandatory sections S-01 through S-08 are present
- [ ] All seven result states appear, including zero counts
- [ ] Total and closure percentage are arithmetically correct
- [ ] Every §3 ID appears in the journal
- [ ] Evidence paths exist and claims match source/tests
- [ ] Validation column contains commands actually run
- [ ] GAP ACCEPTED decisions include justification and trigger
- [ ] Report is entirely English
- [ ] make lint-docs passes
- [ ] git diff --check passes
```
