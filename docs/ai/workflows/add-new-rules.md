# Workflow 6: Adding New Acceptance Rules

**When to use:** The documentation system needs new validation criteria or rules that don't fit existing patterns.

## Step 1 — Identify the Gap

Document what's missing:

```markdown
**Gap:** No rule exists for validating [specific aspect]
**Affected documents:** [which doc types are impacted]
**Current consequence:** [what goes wrong without this rule]
```

## Step 2 — Draft Rules Using Existing Patterns

Follow the structure of existing rules:
- Use numbered prefixes (e.g., `NR-01`, `NR-02`) for new rule IDs
- Include validation steps that agents can execute
- Reference related rules from other sections where applicable

### Pattern Examples

**Universal Rule:**
```markdown
| NR-XX | [Rule ID] | [Description of what must be true] |
```

**Validation Step:**
```markdown
**Validation:** Run `[command or check]` to verify compliance.
```

## Step 3 — Add to documentation-rules.md or audit-file-rules.md

Place the new rules in the appropriate section:
- Universal requirements → Section "Universal Requirements (All Document Types)"
- Topic-specific → Append to relevant document-type subsection
- Audit-specific → Add to `docs/ai/acceptance/audit-file-rules.md` following existing patterns

## Step 4 — Update AGENTS.md Workflows

If the new rule affects any workflow, update the corresponding workflow section in `docs/ai/workflows/`.

### Where to Update:
- Workflow that creates/modifies documents → Add validation step for new rule
- Workflow that validates documents → Add checklist item for new rule
- Navigation updates → Reference new rule type if applicable

## Step 5 — Validate Against Existing Documents

Run the new rules against all current documents to ensure they don't break valid content (unless intentionally tightening standards).

```bash
# Example: Test a new language rule against existing files
grep -rni "[pattern]" docs/ai/ --include="*.md" | head -20
```

## Related Rules

- [`../acceptance/documentation-rules.md`](../acceptance/documentation-rules.md) — universal/topic rules
- [`../acceptance/audit-file-rules.md`](../acceptance/audit-file-rules.md) — audit-specific rules
- `docs/ai/workflows/` — update each affected workflow
