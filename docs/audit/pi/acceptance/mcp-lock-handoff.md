# MCP lock handoff acceptance — 2026-10-13

Scope: maintenance of [AUDIT-2](../AUDIT-2.md) WEB-MCP-06/07. No additional criterion closes; this is not complete audit or release acceptance.

## Requirement-to-evidence checklist

| Requirement | Implementation and executable evidence |
|---|---|
| A cooperating owner can release between exclusive-open refusal and lock inspection | `packages/core/src/mcp/config-inventory.ts`, `acquireMcpConfigLock`: retry only `ENOENT` after `EEXIST`; `config-lock-race.test.ts` delegates real exclusive opens and removes the actual held file at that boundary |
| Preserve the existing acquisition deadline | The same deadline is checked before retry; the deadline case requires `lock-timeout` and no configuration file |
| Unsafe locks remain refused | Symlink, directory and unreadable cases require `unsafe-path`, no configuration and conserved external bytes |
| Fresh-project import still rechecks resources and rolls back its exact trust grant | The owner-handoff fixture creates `settings.json` after trust publication; import must return `folder-not-fresh`, remove the grant and leave configuration absent |
| Atomic mutation and cleanup still occur on success | The successful case reads the actual persisted server and requires the lock to be absent |

Owning sources: `packages/core/src/mcp/config-inventory.ts` SHA-256 `42512a85e150dad87599000d920054d9d0bf4d6ce51355837af901a213ec524d`; `packages/core/src/mcp/config-lock-race.test.ts` SHA-256 `93ca187f458eb5b0e3fef4838acb481cdc131f3e79d2b64c16e8e18ead92309d`.

## Inspected validation

Docker image `sha256:47acd649b26029739fb6a77249f97b4951ffad011e3ca92b67e305a7eece2a9c` contains both exact hashes. The image includes other pending RPC/Web work; results qualify this integrated composition, not an independently rebuilt two-file checkout.

- Workspace types, strict added-test types and zero-warning owning lint pass (`/tmp/aih-ready-{types,strict,lint}-4.*`).
- Focused twelve-file run: 80 tests pass, including all six handoff cases and unchanged import/mutation suites (22 cases); `/tmp/aih-ready-focused-4.*`.
- Complete default `make test`: 214 files, 2,132 tests pass; `/tmp/aih-ready-full-4.*`.
- Original owner restored in a disposable Docker control: three handoff cases fail, three unsafe-path cases pass; actual exit 1. `/tmp/aih-ready-mcp-control.*` retains the failures. No security assertion was relaxed.
- `make lint-docs` and `git diff --check` pass.

Earlier native failures remain failures. The same composition's standalone parity initially fails in a fresh CLI compiler with SIGSEGV/139; the recorded complete reproduction passes 32 cases. A CPU-affinity diagnostic fails in an unchanged child Zod import. Neither the successful full suite nor this lock repair diagnoses native failures. Browser history and runtime failures are separate unresolved acceptance work. Temporary logs are local retained evidence, not published CI artifacts; the tests and this checklist are versioned.
