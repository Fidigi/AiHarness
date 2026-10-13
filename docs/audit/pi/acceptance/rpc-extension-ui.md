# RPC extension UI acceptance — 2026-10-13

Scope: [AUDIT-2](../AUDIT-2.md) CLI-AUT-07, not the broader TUI contract CLI-EXT-06 or complete audit/release acceptance.

## Requirement-to-artifact checklist

| Required contract | Implementation | Inspected executable evidence |
|---|---|---|
| Correlated select/confirm/input/editor requests and notifications | `packages/cli/src/rpc/rpc-extension-ui.ts` | Existing four `rpc-extension-ui.test.ts` cases; new state/process tests retain valid envelopes |
| Explicit mode limitations and plain-text presentation | Core `extensions/extension-registry.ts`, re-exported by `extensions/index.ts`; immutable bridge `ui` | State tests cover all four presentation methods, clear, copied widget lines and immutable capabilities; public consumer checks optional command/tool context and rejects custom rendering/invalid types |
| Replay, IDs and ordering | `snapshot()`, `get_extension_ui` in `rpc-server.ts` | State test requires admission order, detached copies, no notification replay; emitted process tests exact snapshot, correlation and unknown-field rejection |
| Same-ID replacement and individual close | Host-owned Promise controls, current-schema validation | Old selection cannot settle replacement; controls become inert after settlement; original deadline and real AbortSignal survive redaction/update |
| Cancellation and lifecycle | `cancelPending`, `close`, RPC Abort/session-success/EOF/signal paths | State tests verify cleanup, recovery, closed admission and exact closure; real executable exercises Abort, new-session and EOF before command joins |
| Bounded state and slow-sink behavior | 16 dialogs, 100 keys/options/lines, 128,000-byte records, 512,000-byte state, 256 pending deliveries | State negatives require overflow to conserve old state, undeliverable dialog cancellation and recoverable latest presentation |
| Public package contract and documentation | Emitted Core declarations, EN/FR `rpc-extension-ui.md`, contributor indexes and AI CLI/extensions topics | Genuine external strict NodeNext consumer, `@ts-expect-error` negatives, actual emitted RPC subprocess outside checkout; unchanged parity goldens |

## Validation and provenance

Seven product/test owners match the originally qualified image `sha256:d4eb4cb85c2bb066cc76ecf31326062323d9a237550bbf6eed85c640479ece94` and the integrated final image `sha256:47acd649b26029739fb6a77249f97b4951ffad011e3ca92b67e305a7eece2a9c`. The latter also contains pending detached-Web changes and the MCP lock repair; this is integrated proof, not a new isolated RPC-only build.

- Docker workspace/parity types, strict three new-test types and zero-warning owning lint pass.
- 34 focused tests pass: 19 new state cases, one external declaration test, one emitted process test, four existing bridge cases and nine adjacent Server cases.
- Original two RPC sources restored and CLI rebuilt in a disposable container: 15 new failures/eight passes, including all four preceding bridge cases; actual exit 1, OOM false. The tests distinguish the delivery from its original implementation.
- Current complete default `make test`: 214 files/2,132 tests pass, including all RPC leaves (`/tmp/aih-ready-full-4.*`).
- Current standalone parity first fails in a fresh CLI compiler (SIGSEGV/139); a separately recorded complete `make test-parity` reproduction passes all 32 unchanged cases (`/tmp/aih-ready-parity-{4,reproduction-4}.*`). Both results are retained, not a diagnosed runtime repair.
- `make lint-docs` and `git diff --check` pass.

Original RPC validation and controls remain under `/tmp/aih-rpc-ui-*`; current image hash admission is `/tmp/aih-ready-owner-{hashes,hashes-image}-4.txt`. Earlier codemode/installed/compiler native failures are not erased by the successful integrated unit run. Browser/native runtime failures and other open audit criteria remain outside this commit. Temporary logs are retained locally, not published CI results. Replay remains process-local; no custom/terminal renderer, crash-durable UI, physical terminal or complete parity claim is made.
