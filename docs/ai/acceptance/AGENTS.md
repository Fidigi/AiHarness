# Documentation Workflow Router

Read [`documentation-rules.md`](./documentation-rules.md) for every `docs/ai/` change, then load only the workflow needed for the task.

## Workflow Selection

| Task | Workflow | Additional rules |
|---|---|---|
| Create a topic | [`create-topic-file.md`](../workflows/create-topic-file.md) | Topic acceptance |
| Modify a topic | [`modify-existing-doc.md`](../workflows/modify-existing-doc.md) | Owning topic and source/tests |
| Create or overhaul an audit | [`create-audit-report.md`](../workflows/create-audit-report.md) | [`audit-file-rules.md`](./audit-file-rules.md) and template |
| Validate documentation | [`validate-document.md`](../workflows/validate-document.md) | Document-type checklist |
| Update navigation | [`update-navigation-files.md`](../workflows/update-navigation-files.md) | All topic names/counts and package boundaries |
| Add acceptance criteria | [`add-new-rules.md`](../workflows/add-new-rules.md) | Existing rule IDs and affected workflows |

## Universal Checks

Before finishing any documentation task:

- [ ] Verify behavioral claims against implementation and tests.
- [ ] Keep `docs/ai/` entirely in English.
- [ ] Keep content within the declared domain.
- [ ] Name exact entry points, contracts, and associated tests.
- [ ] Remove unresolved placeholders outside reusable templates.
- [ ] Update topic/navigation cross-references where required.
- [ ] Run `make lint-docs` for links and versioning boundaries.
- [ ] Run `git diff --check` for whitespace errors.
- [ ] Run Docker validation from `project-map.md` if behavior/build code changed.

## Audit Checks

For an instantiated audit:

- Use `docs/audit/<subject>/AUDIT-N.md` with the next sequential number.
- Use real current dates and all seven item states.
- Calculate closure from `DONE + GAP ACCEPTED` only.
- Give every ID journal evidence and commands actually run.
- Keep status, traceability, detailed findings, recommendations, and inventory consistent.
- Do not mark the audit `DONE` while any open state remains.

## Common Failures

| Failure | Prevention |
|---|---|
| Loading every workflow | Select only the row matching the task. |
| Treating `git diff --check` as link validation | Run `make lint-docs` too. |
| Copying stale counts or routes | Recalculate and inspect owning source. |
| Adding a topic without navigation | Update `index.md`, related topics, and package map when needed. |
| Recording planned validation as passed | Journal only commands actually executed. |
| Modifying the audit template for one report | Copy it, then edit the numbered report. |

## Related Documentation

- [`../AGENTS.md`](../AGENTS.md) — maintenance and audience rules
- [`../project-map.md`](../project-map.md) — repository authority and validation matrix
- [`documentation-rules.md`](./documentation-rules.md) — universal/document-type criteria
- [`audit-file-rules.md`](./audit-file-rules.md) — instantiated audit criteria
