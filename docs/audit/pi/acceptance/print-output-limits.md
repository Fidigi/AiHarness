# Model Output-Limit Reporting — A3-CLI-13

> **Status: DONE for A3-CLI-13 — 2026-10-18.** The requirement-to-artifact checklist and complete CLI gates below pass. This record does not close the AUDIT-3 backlog or its broader inherited automation criteria.

## Scope and Contract

Implement only the explicit output-limit/false-success review `A3-CLI-13` from `docs/audit/pi/AUDIT-3.md`. Existing Core provider normalization and journal retention are reused, not replaced. No provider calls leave local test fixtures; no retry, output-limit setting, session schema or new protocol record is introduced.

- Explicit provider `stopReason: length`, not a string search, marks an incomplete response.
- Print retains the existing final-text-only stdout behavior, including empty output and its terminating LF. Print/JSON emit one fixed warning on stderr and exit 1 after the supplied prompts if any ordinary response reached the output limit. A later complete prompt cannot reset that failure.
- JSON and RPC authoritative assistant messages expose `stopReason: "length"`; turn/agent records reuse that message. Persisted RPC history uses the existing `metadata.stopReason` evidence. An error still takes precedence in persisted message projection.
- JSON header v3, LF framing, lifecycle ordering, text, usage, persistence and normal completion remain intact. RPC remains available after a capped response; prompt acknowledgement reports command admission, not model completeness.
- Tool-result truncation is not a model output-limit signal. This change does not qualify malformed tool arguments, overflow recovery, interruption, new prestart authority or the rest of `CLI-AUT-01` / `CLI-SES-07`.

## Requirement → Artifact Checklist

| Explicit review clause | Concrete artifact / check |
|---|---|
| Preserve truncated text; no false success | `packages/cli/src/index.ts`: headless response evidence retained across all supplied prompts; final stdout precedes fixed stderr warning and exit 1 |
| Real `-p`, JSON, RPC processes | `packages/cli/src/cli/length-stop-process.test.ts` invokes `fixtures/length-stop-probe.mjs`, which starts the emitted CLI against a local HTTP/SSE provider |
| Empty and partial responses | All three modes cover empty/partial explicit length and ordinary controls; Unicode text is compared exactly |
| Exit code / stderr / stdout | Print/JSON capped exit 1 with exact warning; ordinary exit 0 with empty stderr; RPC exit 0 only after a subsequent request completes |
| Do not break JSON grammar | Complete stdout parsed as LF JSONL; v3 header, one end/settled pair per prompt, authoritative message/usage, RPC correlated history/second prompt |
| Reload continuity and actual usage | Probe opens a fresh Core manager over the written JSONL and checks retained text, `metadata.stopReason` and measured usage |
| Installed public contract | Nine cases in `tests/functional-parity/installed-executable.test.ts` copy the same public probe into a genuinely packed/installed consumer and launch `ai-harness` through its PATH |
| Negative projections | `packages/cli/src/cli/json-output.test.ts`: normal tool use, ordinary “length” text/tool truncation, error precedence and live/persisted empty/partial length |
| User and maintainer contract | `docs/users/{en,fr}/user-guide.md`, `docs/ai/topics/cli-reference.md` |

The reusable fixture imports only AiHarness's public Core package. It creates disposable directories, sessions and a loopback server, closes them on completion and uses no credentials or reference-product imports. Existing installed-consumer offline dependency-seeding limits remain unchanged.

## Causal Evidence and Validation

- RED: Docker image `aih-settings-navigation-root-v20:test-typecheck-types` (pre-change emitted code), with only the new process test/probe copied in: **8 failures / 6 passing controls**. Print/JSON report exit 0 instead of 1; RPC projects `stop` instead of `length`. An initial fixture run had a ninth failure from assuming empty normal responses were persisted; that test-only mistake was corrected before the authoritative RED run. No product defect is inferred from it.
- GREEN focused: Docker image `ai-harness:test-latest-typecheck-1792302690929628342`, actual build of changed source: `npx vitest run packages/cli/src/cli/length-stop-process.test.ts packages/cli/src/cli/json-output.test.ts` — **24/24 passed** (14 process + 10 encoder tests).
- `make typecheck`: workspace checks plus parity TypeScript check completed on pinned Node 24.15.0.
- `make test-parity`: **81/81 passed**, two files, including all nine new installed PATH-bin cases and unchanged existing goldens; command exit 0.
- `make test`: **335 files / 4,898 tests passed**, command exit 0, 803.99 seconds on pinned Node 24.15.0. Includes the process/encoder leaves, installed consumers and existing public goldens, not a filtered selection. The six changed/new executable source/test files have identical SHA-256 values in the working tree and this test image (`ai-harness:test-latest-run-1792302848573139815`).
- `make lint-docs`: **136 Markdown files / 1,110 local links**, no link or versioning-boundary violations. `git diff --check`: passed.

Completion review: every explicit A3-CLI-13 clause has a direct checklist artifact above, including actual emitted and installed empty/partial/ordinary cases, exact channels/exits, RPC reuse/history and JSON framing. The causal RED failures disappear without changing assertions, golden files, timeout limits or unrelated behavior. Existing draft changes to AUDIT-2 and AUDIT-3 are preserved and excluded from this implementation commit; this evidence record carries the new result without rewriting their historical/editorial content.

No E2E, production build, external service or physical-device qualification is claimed by this CLI-only change. Those gates are not required for this non-asset CLI behavior by the project-map matrix; no changed browser/server surface is accepted here. All remaining AUDIT-3 entries and pending product/security decisions stay open.
