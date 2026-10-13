# Detached Web acceptance checklist — 2026-10-13

Scope: the eight native contracts tracked by [AUDIT-2](../AUDIT-2.md), DEC-67. **Final scoped integration gates pass.** This document is not complete Pi parity or release acceptance. The main matrix still has 64 open criteria; in particular crash-durable running progress (CLI-TOOL-10), physical mobile behavior and remote Pages publication are not delivered by this lot.

## Requirement-to-artifact checklist

| Criterion / requirement | Product owners | Concrete evidence inspected |
|---|---|---|
| WEB-BASE-04 / native server-client normalization | `packages/web/src/store/session-store.ts` | `server-client-normalization.test.ts`: real Core serialization, Date hydration, rich messages/commands, nested usage, queued prompts and ordered interaction schemas; caller mutation cannot alter admitted state; stale sequences remain refused |
| WEB-TOOL-06 / ordered declarative requests, same-ID updates, close/revocation | Existing Core interaction host and Chat queue | `e2e/tool-progress.spec.ts`: actual disk extension and HTTP at desktop/mobile widths, three concurrent requests, schema replacement, stale response 400, individual close, Stop/rebuild and old-handle negatives; existing interaction suites preserve local admission/focus/IME guards |
| WEB-TOOL-07 / phase, outer progress and replay | Core `agent/runtime.ts`, Server `agent-event-policy.ts` | `reply-checkpoints.test.ts`: cold compaction phase/watermark, reentrant publication, cancellation; genuine live/GET/terminal/reload, nested cards and ready-watermark gap browser journeys |
| WEB-CHAT-06 / Chat queue, waiting count and attention | `ChatView.tsx` and conserved interaction boundary | Real concurrent-approval journey requires waiting counts, once-per-new-display sound, no replay/reload sound, latest schema, inert hostile text and independent ordered results |
| WEB-CHAT-07 / bounded slow-client SSE | `sse-channel.ts`, `agent-event-policy.ts`, `agent-routes.ts` | Seven `agent-event-backpressure.test.ts` cases plus existing channel cases: real sequence position; exact session/run/message/tool replacement; nested/start/end/UI preservation; malformed/legacy/foreign checkpoints; 256-frame, 1/4 MiB and 30-second bounds; credential filtering and cleanup |
| WEB-CHAT-08 / rich records, authoritative checkpoints and no duplicate child billing | Core `agent/runtime.ts`, owned Web normalization and Chat consumption | Intermediate/final text/reasoning checkpoints have distinct identified starts, exact durable message order and unchanged usage; normalization preserves native nested IDs/usage without promotion; real nested/live/reload journeys |
| WEB-CHAT-09 / explicit length and failed-reply evidence, reachable compaction/cancel | Core providers, tool loop, runtime; `reply-messages.ts`, Chat | Ten actual local HTTP chat/stream dialect cases; real JSONL empty/nonempty length, bounded scrubbed failed text/reasoning, no invented usage or successful completion; genuine length/empty-length/error and cold automatic-compaction browser journeys. Additional failure-time compaction regression fails the preceding candidate and passes the explicit failure-only skip |
| WEB-CHAT-13 / loaded process groups and stable optional presentation | `process-turns.ts`, `ProcessBlockBoundary.tsx`, `ProcessBlock.tsx`, `AnsiOutput.tsx`, `CodemodeCard.tsx`, Chat/CSS | Six projection cases cover mid-turn heads, gaps, user/system/final boundaries and conserved inputs/accounting. Genuine process grouping, delayed/cached-failed optional chunk journeys preserve native disclosure/focus/full text and Stop |
| Adjacent reading-position conservation, not a broader new criterion | `scroll-restoration.ts`, `history-reading.ts`, Chat | Nine bounded lease/retirement cases, five unread-tail cases, unchanged session navigation/reload journey; six-viewport visual history journey adds strict 3px anchor and no-false-unread assertions, without changing existing captures or tolerances |
| User/operator documentation | EN/FR `docs/users/*/web-replies.md`; AI `topics/detached-streams.md`, owning API/Web/security/navigation updates | Reviewed against actual process-local replay, plain-text rendering, current-schema authority, provider evidence and compaction behavior; no crash durability or draft-reload durability promised |

## Causal controls and failures retained

- Original RPC/Web restoration controls and earlier failed browser/unit/compiler runs remain recorded in AUDIT-2, not converted to successful gates.
- Current history instrumentation reproduces 16px movement **before pointerdown**, also present in the handler's captured offset. Two controlled repetitions fail 1/18 and 2/18. A single native reveal plus real pointer click preserves the original 3px assertion and all six original captures in 18/18 repeated cases. The input-sequencing repair does not add a new product scroll algorithm or relax a screenshot.
- Failed-output persistence previously initiated automatic compaction: a real JSONL test fails on the previous candidate, eight other cases pass. With failure-only `skipAutoCompaction: true`, all nine cases pass; error evidence remains durable and retained context is unchanged.
- Prior complete matrix on image `47acd649…` is 531/533, with one strict history-position failure and a native progress worker SIGSEGV. Full default units on that image are 214 files/2,132 tests green, but it predates the final failure-time compaction correction. These are not final-source qualification.

Local evidence: `/tmp/aih-cont-scroll*`, `/tmp/aih-cont-history-pointer*`, `/tmp/aih-cont-failure-{red,green}.*`; original complete browser artifacts in `/tmp/aih-cont-prior-browsers.tar.gz`. Temporary evidence is not a published CI run.

## Final gate ledger

The final product image is `sha256:a414321d146630fbaf335f9b04198eaf0ff5342d524e3a7aeee9ba6029ac380f`. All 38 current product/test hashes match its source bytes (`/tmp/aih-cont-{owner,image}-hashes.txt`, exact comparison exit 0). Its complete retained-container browser matrix includes the failure-time correction; the separately running Make browser checkpoint started before that one-line correction and must not be confused with it.

| Gate | Current evidence |
|---|---|
| Workspace and public parity types | Passed: `/tmp/aih-cont-types.*` |
| Strict types of all twelve added test leaves | Passed: `/tmp/aih-cont-strict.*`; original strict root options conserved |
| Zero-warning ESLint of all 37 changed TypeScript/TSX owners since `93abf11` | Passed: `/tmp/aih-cont-lint.*` |
| Complete default unit suite | Passed: 214 files / 2,133 tests, `/tmp/aih-cont-units.*` |
| Complete standalone parity | Passed: 32 unchanged cases, `/tmp/aih-cont-parity.*` |
| Complete production image | Passed: `/tmp/aih-cont-prod.*`; image `sha256:e4c053886da0f925e0f177804ee1dfbfc3e75a15256a58b1d7aeb01e42fe7937`. Network-disabled actual Node 26.11.1 launcher smoke serves health, HTML and its emitted JS with HTTP 200 (`/tmp/aih-cont-prod-smoke.*`) |
| Complete nine-suite browser matrix, one worker / zero retries / no updates | Passed: 533 cases (354 standard, 69 interactions, 8 locale, 11 workspace, 14 pane, 43 linked, 2 title, 24 progress, 8 demo); actual container exit 0 / OOM false. `/tmp/aih-cont-integrated-browser.*`, all nine successful suite statuses and artifacts under `/tmp/aih-cont-integrated-browser-artifacts/`. All 38 browser-container source hashes match the current tree |
| Documentation links and whitespace | Passed after final evidence update: `make lint-docs`, `git diff --check` |

The final suite statuses, full command output, current source hashes and owning cases were inspected together. These gates qualify this lot, not the 64 unimplemented/unverified audit criteria. Historical native failures, the interrupted interaction checkpoint and its occupied-port failures remain retained and unexplained; current success is not a native-crash diagnosis.
