# Workflow 5: Updating Navigation Files (index.md, project-map.md)

**When to use:** Changes that affect the structure of `docs/ai/` — adding/removing topic files, changing package boundaries, updating validation commands.

## Step 1 — Identify What Changed

| Change Type | What to Update in index.md | What to Update in project-map.md |
|---|---|---|
| New topic file added | Add row to navigation table with line count | §3 package boundaries if relevant |
| Topic file removed/merged | Remove or update row, adjust related links | §3 package boundaries if relevant |
| Entry points changed | Update domain descriptions | §3 files and responsibilities |
| Validation commands changed | N/A (index doesn't list these) | §8 Validation section |

## Step 2 — Verify Line Counts Are Accurate

```bash
wc -l docs/ai/topics/*.md
```

Update line counts in `index.md` within 10% tolerance. If a file has grown significantly, consider whether it needs splitting (see Workflow 1).

## Step 3 — Ensure All Files Are Listed

Verify every `.md` file in `docs/ai/topics/` appears in the navigation table:

```bash
ls docs/ai/topics/*.md | xargs -n1 basename
# Compare against index.md table rows
```

Also verify that acceptance rules and workflow files are referenced.

## Step 4 — Validate Before Committing

- [ ] All topic files listed with accurate line counts
- [ ] Documents grouped by category (Agent Docs, User Docs, etc.)
- [ ] `make lint-docs` reports no broken links or versioning violations
- [ ] `project-map.md` §3 package boundaries match actual code structure
- [ ] Related domain cross-references updated in affected topic files

## Common Mistakes to Avoid

| Mistake | Impact | Prevention |
|---|---|---|
| Forgetting to update line counts | Misleads agents about context load | Run `wc -l` before committing |
| Not updating project-map.md when structure changes | Broken navigation, stale references | Update in same change as structural modifications |
| Leaving orphaned links after file removal | Agents follow dead ends | Search for references before deleting files |

## Related Rules

- [`../acceptance/documentation-rules.md`](../acceptance/documentation-rules.md) — navigation acceptance
- [`../index.md`](../index.md) — agent navigation index
- [`../project-map.md`](../project-map.md) — package boundaries and validation workflow
