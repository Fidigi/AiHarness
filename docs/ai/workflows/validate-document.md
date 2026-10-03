# Workflow 4: Validate Documentation

**Use when:** Reviewing an existing AI document or audit for correctness and merge readiness.

## Step 1 — Classify the Document

| Document | Rules to apply |
|---|---|
| `docs/ai/topics/*.md` | Universal + topic acceptance |
| `docs/ai/index.md`, `project-map.md` | Universal + navigation acceptance |
| `docs/ai/AGENTS.md` | Universal + convention acceptance |
| `docs/ai/acceptance/`, `workflows/` | Universal + internal consistency |
| `docs/audit/<subject>/AUDIT-N.md` | Universal + `audit-file-rules.md` |

## Step 2 — Verify Source Accuracy

1. Read the document completely.
2. Open every named implementation and test path.
3. Check numeric limits, route methods/paths, persistence locations, type fields, state transitions, and validation commands.
4. Distinguish current behavior from recommendations and historical findings.
5. Report unsupported claims even when formatting passes.

## Step 3 — Run Mechanical Checks

```bash
make lint-docs
git diff --check
wc -l docs/ai/topics/*.md
```

Scan changed non-template files for unresolved placeholders. Language scans are hints only; manually distinguish technical words and literal paths from prose.

## Step 4 — Apply Type-Specific Checks

### Topics

- Navigation banner resolves to `../project-map.md`.
- Ownership and entry points are concrete.
- Critical flows match code and security/cancellation/persistence boundaries.
- Associated test paths exist.
- `Common Changes` and linked `Related Domains` sections exist.
- Line count remains near target.

### Navigation

- Every topic appears once in `index.md`.
- Context estimates are within 10% of measured counts.
- `project-map.md` matches package boundaries, entry points, persistence, transport, and Make targets.
- Local-only audits are plain paths, not active links.

### Conventions and Rules

- Rules are imperative, non-contradictory, and executable.
- Examples use paths relative to their containing document.
- The documented command actually verifies the claimed property.
- Workflow and acceptance terminology agree.

### Audits

- All current sections agree on status.
- All seven states appear and arithmetic is correct.
- Every ID has journal evidence and actual validation results.
- Dates are real; closure excludes `PARTIAL` and every other open state.
- Historical snapshots are clearly labeled as historical.

## Step 5 — Report Failures

Use:

```markdown
**Validation failed:** U-08 — named test path does not exist
**Location:** docs/ai/topics/example.md:72
**Evidence:** repository search found the owning test at another path
**Fix:** replace the path and describe the actual coverage
```

Include rule ID, exact location, source evidence, and a concrete fix.

## Related Rules

- [`../acceptance/documentation-rules.md`](../acceptance/documentation-rules.md)
- [`../acceptance/audit-file-rules.md`](../acceptance/audit-file-rules.md)
- [`../AGENTS.md`](../AGENTS.md)
