# Optional built-in extension controls — acceptance

Date: 2026-10-13. Base: `f16d4b27959a30a5da80357da48f12971678316b`. Decision/evidence: DEC-71 / E-AH-BUILTIN-01.

## Scope and requirement reconciliation

**Historical closure, superseded 2026-10-14 by DEC-77:** [public Markdown controls](./theme-sources.md) reproduce exact `+path` being treated as a glob on both the accepted base and current images. CLI-CFG-09 is now PARTIAL again. Built-in controls and the following historical evidence remain accepted, but this mapping did not cover that cross-resource boundary. CLI-EXT-01's historical residual below is independently superseded by [DEC-75](./module-entry-resolution.md).

The DEC-71 reconciliation was:

| Requirement | Owning evidence |
|---|---|
| Merge global/trusted-project resource arrays and tool modifiers | Core `config/agent-settings.ts`; `agent-settings.test.ts` deep-merge/provenance/model-path/trust cases, rerun in the full suite |
| Resource glob exclusions and exact additions/removals | Core `resources/resource-manager.ts`, CLI `resources/resource-manager.test.ts` ordered selectors and trust; [discovered-file acceptance](./extension-selectors.md) and its 27 Core/14 emitted process cases rerun in this focused suite |
| Enabled package extensions/skills/prompts/themes, precedence and trust | Core `plugins/plugin-service.ts` and package inventory/filter/trust tests; CLI resource/package composition and tests, rerun in the full suite; the new six package-bait cases use a real installed local package, confirmed resource count and saved project trust |
| Built-in switches and explicit overrides | New Core `extensions/builtin-extensions.ts`, exports, CLI startup/main/RPC composition, new 26-case Core policy/loadout leaf and 29-case emitted CLI leaf |
| Actual effect, reload and lifecycle | Core `mcp/session-host.ts`, three new lifecycle cases, direct tool-search conservation, genuine four-prompt PTY reload, real stdio MCP children and PID cleanup; production compiled CLI and host smoke |
| Public invocation/types/documentation | Two new argument cases; exact installed-help golden updated only for additive syntax; strict external NodeNext Core consumer; AI and EN/FR contributor/user guides |

CLI-EXT-01 remains PARTIAL: TypeScript loading and complete module resolution are not implemented. WEB-BASE-02 remains PARTIAL: Server/Web settings composition is unchanged. No browser/device, live vendor, remote publication or complete release qualification is inferred.

## Behavior and limits

- Frozen `BUILTIN_EXTENSION_NAMES` identifies `codemode`, `tool-search` and `mcp`; readonly `BuiltinExtensionPolicy` and `resolveBuiltinExtensionPolicy` are shared Core exports. This is metadata policy, not module import, trust or tool activation.
- Default capabilities remain eligible. Global `!glob` applies before exact `+builtin:name`, then exact `-builtin:name`; removal wins regardless of list order. Trusted project modifiers apply sequentially, last match wins. Plain IDs do not undo exclusions. Explicit `-e builtin:name` wins last. Node POSIX glob semantics apply to the virtual identity.
- Refused project entries are not consulted. `--no-extensions` / `-ne` skips both settings selector lists, automatic global/project/environment/package executable discovery and optional built-ins; explicit files/directories and known IDs survive. Trust/stable-file rules remain. Unknown exact IDs fail without reflecting values. Input lists admit at most 200 nonempty NUL-free strings, each at most 32 KiB. Existing file-selection/import bounds remain independent.
- Discovery flags precede contributed flags; ordinary and contributed startup both apply policy before module imports. The existing contributed generation is reused, not reexecuted. Core loader `includeEnvironmentPaths` defaults true; opting out is additive.
- Mandatory workspace/security tools and independent skills/prompts/themes/providers/administration remain. Codemode still needs ordinary activation and selection. Disabling synthetic `tool_search` preserves earlier eligible activation and a third-party replacement. This is not an offline/no-tools/sandbox flag; admitted Node code remains privileged.
- `McpSessionHost.setEnabled(false)` synchronously retires all sessions before awaiting closes. Disabled prompts do not read MCP inventory, resolve values or connect. Captured calls and late discovery cannot revive retired sessions; reenablement is lazy. Abort and permanent shutdown remain authoritative. Already admitted remote effects cannot be undone.
- Interactive disk edits take effect on `/reload`, not the next prompt alone. RPC retains its startup snapshot. File-generation rollback remains separate from refreshed settings/capability policy. No persisted/session/wire schema or API-major change is needed for the additive fields/exports.

## Exact-source validation

Sixteen product/test owners match test/type/full-unit image `sha256:6ac80cc84aece2a36a17bce94fc35e5296e3fe785839884b7b3ae528fa32681a`. Thirteen original existing owners match base image `sha256:34ec4b799f58ebf91246afa94c4565dfe7dfa97efc322f621f4eb7d864fcaa5c`; the causal control adds only the new emitted-process test. Twenty-two emitted JS/declaration hashes match test and production image `sha256:01930c1a47a625b726f4f0ef4ec7e909debcaddc4bd705d830527e4dd71c1d6d`.

- Docker `make typecheck`: pass. Separate strict NodeNext check of all five owning test leaves: pass. Sixteen-owner ESLint with zero warnings: pass.
- **60 added cases**: 26 policy/search, 29 emitted CLI/public/PTY, three MCP lifecycle and two parser cases. Focused eight-file suite: **145 passed**. Full `make test`: **222 files / 2,313 passed**.
- Original-source emitted control: **23 failures / six passes**, exit 1, OOM false. Trusted enablement cases already work on the base; missing suppression/override/validation/reload/public contracts fail. Candidate 29-case file passes unchanged, including all six package suppression cases.
- Final unmodified `make test-parity`: **32 passed**, exit 0. Exact installed help includes the additive flag/virtual-ID syntax; protocol normalization/assertions were not relaxed. Earlier failures and diagnostic runs remain below.
- `make lint-docs`: **93 files / 637 local links**, pass. Whitespace checks pass. The matrix parser verifies 152 unique rows, 89 DONE/63 PARTIAL, and exact agreement with all 63 IDs in the remaining-work checklist.
- `make build-prod`: pass; entry **148 KiB**, eager **159 KiB gzip**, **17 chunks**, unchanged budgets. Network-disabled production **Node 26.11.1** smoke uses emitted Core policy/host and real CLI: lazy no-start, stale-call refusal, transport cleanup, default automatic/environment import positive control, no-extension suppression and explicit MCP restoration, ordinary `read` conservation. Health/HTML/JS each return HTTP 200; exit 0, OOM false.

The [completion review](./completion-review.md) retains all 152 requirements. Result: **89 DONE / 63 PARTIAL**, 58.6% closed. No other row closes in this batch.

## Retained failures and limits of diagnosis

1. Two exploratory overlays each had six package-fixture setup failures: first the package was outside the allowed workspace root, then installation lacked saved project trust. The fixture was moved inside the root and explicitly trusted before installation. Root/trust checks and assertions were not weakened. Exact rebuilt sources subsequently pass all six.
2. The expanded strict five-leaf check exposed four older typing errors in the MCP test adapter/context. The fixture now supplies a real `SessionManager`/notification context and typed optional discovery fallbacks; assertions remain unchanged. Initial strict exit 2 is retained.
3. The first full parity command aborted **before cases**: Rolldown/oxc native panic `Cannot pop all entries`, abort 134 (Make exit 2). A same-image isolated `RUST_BACKTRACE=1` run passed 32; this does not diagnose the original panic.
4. The next ordinary parity command passed 31 and failed one installed public-provider consumer because its TypeScript child returned **null exit status**, with no signal retained by that existing helper. Do not label this specific occurrence SIGSEGV without evidence. A separate diagnostic adds only a child-exit observer writing code/signal metadata outside stdout/stderr; all 32 passed. The final ordinary Make invocation, without observer or special runtime flags, also passed 32. Neither success establishes a root cause for the null exit or native failures; no retry configuration/deadline/assertion was changed.
5. Previous native/browser/shell failures remain historical evidence. No new browser matrix is claimed for this CLI/Core capability composition, and no remote CI/publication occurred.

## Local evidence inventory

These paths are local retained artifacts, not published CI links:

- `/tmp/aih-builtins-{initial,expanded}-focused.*`, `/tmp/aih-builtins-{types,final-types}.*`
- `/tmp/aih-builtins-strict-discovery.{log,state.json}`
- `/tmp/aih-builtins-qualified-{types,units,parity,prod,focused}.*`
- `/tmp/aih-builtins-{base-control,production-smoke}.*`
- `/tmp/aih-builtins-parity-{diagnostic,final,accepted}.*`, `/tmp/aih-builtins-exit-diagnostic.*`, `/tmp/aih-builtins-child-exits.jsonl`
- `/tmp/aih-builtins-{owner,image,base-owner,base-image,test-emitted,prod-emitted}-hashes.txt`, owner/base/emitted path lists
- `/tmp/aih-builtins-tests.tsconfig.json`, `/tmp/aih-builtins-production-smoke.mjs`, `/tmp/aih-child-exit-observer.mjs`
- `/tmp/aih-builtins-docs.*`, `/tmp/aih-builtins-matrix.log`
