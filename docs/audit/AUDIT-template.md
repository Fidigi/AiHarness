# Audit Report — [Target] / [Project or Surface]

> **Status: IN PROGRESS** (YYYY-MM-DD)
>
> [State the remaining scope or blocker in one sentence.]

## 1. Audit Reference

| Element | Value |
|---|---|
| Target observed | [Name, version, or bounded scope] |
| Audited instance | [Exact commit and dirty-tree scope, deployment, or URL] |
| Audit date | YYYY-MM-DD |
| Pinned source | [Exact commit/tag and repository URL, or internal commit + origin] |
| Detailed references | [Evidence paths, matrix, or `None` with justification] |

**Objective:** [Describe the testable purpose of the audit.]

### Known limitations

- [State static/runtime, platform, credential, destructive-operation, or visual limitations.]
- Any target evolution requires a new audit or an explicitly journaled re-audit.

## 2. Result

| Status | Count | Details |
|---|---:|---|
| `DONE` | 0 | Verified criteria with recorded evidence |
| `PARTIAL` | 0 | Foundation exists; criteria remain unmet |
| `ABSENT` | 0 | Required deliverable/evidence is missing |
| `TO BE DEFINED` | 0 | Product/security/scope decision required |
| `BLOCKED` | 0 | External blocker documented |
| `IN PROGRESS` | 0 | Active implementation or verification |
| `GAP ACCEPTED` | 0 | Explicit final decision not to deliver |
| **Total** | **0** | **0.0% closed: (`DONE` + `GAP ACCEPTED`) / total** |

### Summary by Surface

| Surface | Done | Partial | Absent | To define | Blocked | In progress | Gap accepted | Total |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| [Surface] | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## 3. Traceability by Surface

### [Surface]

| ID | Status | Criterion and completion evidence |
|---|---|---|
| [PREFIX-01] | [STATE] | [Testable criterion and required evidence] |

### API Families (only when applicable)

| Target surface | Routes/contracts and evidence |
|---|---|
| [Surface] | [Exact methods/paths/types/tests] |

## 4. Convention for Future Audits

| State | Meaning |
|---|---|
| `ABSENT` | Required deliverable/evidence does not exist. |
| `PARTIAL` | A foundation exists, but completion criteria are unmet. |
| `TO BE DEFINED` | A product, security, compatibility, or scope decision is required. |
| `IN PROGRESS` | Implementation or verification is active. |
| `BLOCKED` | An external blocker and owner/trigger are documented. |
| `DONE` | Every criterion is verified and evidence recorded. |
| `GAP ACCEPTED` | A dated final decision intentionally declines the criterion. |

### Closure Rule

Move an item to `DONE` only after its complete criterion is verified, compatibility/migration is covered where relevant, applicable tests/visuals pass, documentation is updated, and the journal records evidence plus commands actually run. Mark the report `DONE` only when every item is `DONE` or `GAP ACCEPTED`.

## 5. Decisions and Accepted Gaps

| ID | Dated decision | Justification | Re-examination trigger |
|---|---|---|---|
| [ID or `None`] | [Decision and date] | [Product/security/compatibility reason] | [Concrete trigger] |

## 6. Delivery Journal

| Date | ID(s) | Old → New | Evidence | Validation | Notes/decision |
|---|---|---|---|---|---|
| YYYY-MM-DD | [ID(s)] | `[OLD]` → `[NEW]` | [Specific source/test/doc/visual paths] | [Commands actually run + result] | [Decision or limitation] |

## 7. Glossary and Prefixes

| Prefix/term | Scope/definition | Example |
|---|---|---|
| [PREFIX-*] | [Audited surface] | [PREFIX-01] |

## 8. Annexes (optional)

### Visual Evidence

| Capture | Viewport/theme | Criterion |
|---|---|---|
| [Path] | [Dimensions/theme] | [ID] |

### Detailed Matrix

[Link to versioned evidence or include the bounded matrix here.]
