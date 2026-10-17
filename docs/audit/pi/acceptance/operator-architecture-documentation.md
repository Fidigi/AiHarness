# WEB-OPS-05 — Operator procedures and architecture decisions

Date: **2026-10-17**. Decision: **DEC-98 / E-AH-OPS-DOCS-01**. Parent: `69031454fa4709003799555641ffd6fe2cd55864`.

## Scope and acceptance boundary

Close **only WEB-OPS-05**, whose unchanged requirement is:

> Add operator/developer documentation and architectural decisions for MCP/code mode, files/access, sessions, models, tools, settings, and changed security/environment controls.

This is a documentation-only delivery: four new bilingual public pages, their four language indexes, two existing extension guides, the owning AI project/security navigation, and three audit/acceptance files. All fifteen candidate paths are Markdown under `docs/`. Product code, tests, dependencies, lockfiles, build tooling, generated outputs and runtime contracts do not change. No new runtime, browser, vendor, deployment or physical-device execution is claimed.

## Complete requirement reconciliation

The [English runbook](../../../users/en/operations.md) and [French runbook](../../../users/fr/operations.md) provide operator actions and recovery boundaries. The [English ADR register](../../../contributors/en/architecture-decisions.md) and [French ADR register](../../../contributors/fr/architecture-decisions.md) provide context, decision, consequences, exact source owners and existing tests. ADR-01 and ADR-09 additionally cover shared-host ownership and optional Web asset lifetimes.

| Required domain | Operator procedure, present in EN and FR | Developer decision, present in EN and FR | Coverage/limit checked |
|---|---|---|---|
| MCP | §2: exact scoped row, original-text preview, full-entry edit, canonical readback, explicit Test, OAuth/login/logout, exposure | ADR-02 | Metadata ≠ execution; Test ≠ persistent host/login; current trust/configuration and local-vs-issuer revocation |
| Code mode | §3: health/policy, eligible nested tools, result/progress/cost inspection | ADR-03 | Guest budgets/no ambient Node; privileged host calls are real; no rollback/refund of completed side effects |
| Files/access | §4: canonical cwd, explicit unavailable-default recovery, trust/refusal, folder/upload, linked consent, command/PTY, download privacy | ADR-04 | Path reach ≠ trust ≠ request capability; consent is bounded read, not write/execute/root widening |
| Sessions | §5: first persistence, detached Stop/reconnect, ancestry/compaction, coherent stopped-writer backup/restore, exports | ADR-05 | Raw journal ≠ projection/accounting/export; admitted save may finish; volatile work is not crash-resumed |
| Models | §6 and §5: availability/refresh, unknown limits/prices, impossible request recovery | ADR-06 | Known heuristic ≠ vendor tokenizer; unknown model/media/settlement and broader overflow remain explicit limits |
| Tools | §3 plus MCP §2: presets/current allowlists, deferred/hidden/script-only exposure, unattended execution | ADR-03 | Search/discovery is not authorization; current nested read-only/selection checks; no host OS sandbox claim |
| Settings | §6: global/project/session/environment provenance and host-specific restart/reload/recovery table | ADR-07 | Auto removes override; passive catalogs/install/activation ≠ executable generation; no universal reload/broadcast |
| Changed security/environment controls | §1 environment table and host setup; §7 safe incident checklist | ADR-04/ADR-08 | Dedicated host account, private roots, master key, user/admin/Origin, loopback/HTTPS/proxy, offline-not-firewall, redacted evidence |

The runbooks link existing detailed user procedures instead of duplicating complete protocol/endpoint inventories. The ADRs link implementation topics and named tests instead of inventing new mandatory APIs. Both language indexes and the canonical AI project map make the pages discoverable.

Two known documentation contradictions are corrected within this scope: `/reload` is not described as extension-only, and the old generic-progress WIP block is explicitly historical, not current acceptance. Its original failing observations remain literally retained. The security topic now describes the already-delivered classifier/image helper boundary instead of calling that execution unsupported. These are documentation corrections, not new runtime qualifications.

## Validation and evidence

Prefix: `/tmp/aih-ops-docs-v1`.

- Initial actual `make lint-docs`: **exit0, 123 Markdown files / 977 local links**, predictive mode, before the new receipt/audit reconciliation. Initial `git diff --check`: exit0.
- The source-reference authoring check initially found two occurrences of one nonexistent owner, `packages/core/src/tools/tool-loadout.ts` (132 references, two missing). Both were removed in favor of the actual `tools/tool-search.ts` owner. Corrected check: **130 references / 64 unique existing source/test paths**, not 130 tests or newly executed tests. The initial observation is recorded here, not promoted into a product failure or erased by the corrected check.
- A host-side metadata admission checks the eight-domain/EN–FR structures, named references and source hashes, exact fifteen-path allowlist, candidate/index/tree equality, unchanged first-sentence requirements/order and all other 151 complete criterion rows, actual counts/surface totals, the 54 remaining IDs and the fourteen-topic/fifteen-estimate navigation inventory.
- Final staged and postcommit `make lint-docs`, live tracked-link/versioning checks and whitespace checks are retained as `-staged-*` / `-postcommit-*` logs and exits. The exact candidate manifest/tree and final admission JSONs bind their document bytes. Acceptance requires all these checks to pass and the committed tree to match the admitted index.
- Referenced product tests and DEC-97 runtime/browser results are **existing evidence only**. No product suite is rerun for this documentation-only change. Git metadata changes are not claimed equal to an earlier Docker COPY context.

## Audit effect and nonclaims

Only WEB-OPS-05 changes `PARTIAL → DONE`: **98 DONE / 54 PARTIAL / 152**, CLI **46/41**, Web **52/13**, **64.5% closed**. No requirement is removed, shortened or accepted as a gap. Previous decision, evidence and journal rows remain historical evidence; current-status summaries are updated separately.

Documentation of an unimplemented capability is not its implementation. General settings primitives/rename/localization, richer CLI/TUI/extension contracts, full compaction/model/media/overflow/actual-settled accounting, crash-durable progress, physical mobile equivalence, remote Pages publication and remaining regression coverage stay open under their own IDs. The prior production watchdog observation remains unhealthy, not diagnosed or superseded by documentation checks. **The full goal and audit remain incomplete.**
