# MOD-03 Subscription Acceptance Checkpoint

> **2026-11-13 · PARTIAL · goal remains active.** Reconciliation through `ae6e582`, not a new runtime campaign, real-account acceptance or MOD-03 closure. MOD-01 remains IN PROGRESS; AUDIT-5 remains37/43.

## Scope and Evidence Rules

This checkpoint maps the active subscription objective: GitHub Copilot first, then independent ChatGPT/Codex. The user separately authorized Codex work while Copilot real-account/global acceptance remains open; that sequencing decision does not accept failed gates.

The [subscription contract](../../ai/topics/subscription-providers.md) owns current behavior. Receipts below retain their original source, overlays, failures and campaign boundaries. Their historical `remaining`/`limits` arrays describe those checkpoints: later delivery is recorded here, not rewritten into earlier evidence. In particular, Server/Settings OAuth, interactive CLI, private host continuation and Codex Server/Settings PKCE are no longer unimplemented work.

**Locally evidenced** means the named bounded source/fixture campaign passed, not universal acceptance. Do not add campaign counts or promote selected/unexecuted tests to passes. Bounded source/emitted hashes are not whole-context, clean-commit, installed-dependency or distribution attestations; the tested snapshots include unrelated dirty compiler work excluded from the subscription commits.

## Objective-to-Evidence Map

| Explicit requirement | Implementation and concrete evidence | Disposition / boundary |
|---|---|---|
| Copilot native Server OAuth | `runtime/provider-oauth.ts`, reserved `provider-registry-routes.ts` endpoint and encrypted one-shot publication; [Server receipt](./evidence/MOD-03-copilot-server-web.json), [publication-return guard](./evidence/MOD-03-copilot-publication.json) | Locally evidenced. Native device issuer, not generic OAuth configuration; committed credentials survive host retirement without mounting a retired proxy. |
| Copilot Web Settings login | Operation-owned `EcosystemSettings.tsx` start/poll/cancel/readback; actual emitted Server/static Web EN/FR journeys in [browser receipt](./evidence/MOD-03-copilot-web-private.json) | Locally evidenced. Browser cancellation, reload and delayed-connected-poll versus Disconnect; synthetic outbound authorization only. |
| Copilot interactive CLI | Explicit slash issuer, regular/fullscreen foreground cancellation, native rebind and runtime retirement; [interactive receipt](./evidence/MOD-03-copilot-interactive-cli.json) | Locally evidenced. Emitted and genuinely installed terminal controls are distinct; their public Responses journey is not private A/C/R terminal qualification. |
| Issuer, storage label, grant, token, catalogue and endpoint authority stay distinct | `providers/{credentials,github-copilot-oauth,github-copilot}.ts`; `credential-lifecycle.test.ts` issuer/storage/refusal controls; [original receipt](./evidence/MOD-03-copilot-subscription.json), [HTTP refresh receipt](./evidence/MOD-03-copilot-http-refresh.json) | Locally evidenced. Canonical labels compose native providers; foreign labels are passive. GitHub grant is reused for exchange; tier-bound inference tokens and account availability are not interchangeable. |
| Login/refresh cannot resurrect credentials after logout, replacement, cancellation or shutdown | Generation/document-revision checks and exact-value rollback in `credentials.ts`/`security/credential-store.ts`; CLI/runtime and Server owner checks; [late-body](./evidence/MOD-03-copilot-late-body.json), [publication-return](./evidence/MOD-03-copilot-publication.json), [Codex OAuth](./evidence/MOD-03-codex-oauth-core.json) and [Server PKCE](./evidence/MOD-03-codex-server-browser.json) receipts | Locally evidenced at named race boundaries. Retiring an operation does not revoke a previously committed login or undo remote refresh rotation. No exhaustive scheduling/account-switch certificate. |
| No implicit provider/model selection, subscription purchase or policy enablement | Native configured-provider composition, reserved routes and operation-owned Settings readback; [Copilot Server/browser](./evidence/MOD-03-copilot-web-private.json) and [Codex Server/Settings](./evidence/MOD-03-codex-server-web.json) invariant checks | Locally evidenced. Availability is not selection. Fixture trust/default/tool setup occurs explicitly after the login invariant check. |
| Copilot refresh and account-model withdrawal | Existing three-start authenticated `api/github-copilot-http.test.ts`; [refresh receipt](./evidence/MOD-03-copilot-http-refresh.json): two refreshes, Individual→Business rotation, removed R refused while C remains usable | Locally evidenced through source-Server HTTP. Cold start and denied401 catalogue access perform no exchange; first authorized admission initializes credentials. Remote removal is observed on forced expiry/refresh, not promised before every prompt. |
| Copilot private lifecycle qualification | Existing A/C/R tool/final/redaction/journal/restart/export/logout scenarios: [HTTP](./evidence/MOD-03-copilot-http-refresh.json), [browser](./evidence/MOD-03-copilot-web-private.json), [emitted/installed CLI](./evidence/MOD-03-copilot-cli-private.json), [production CLI](./evidence/MOD-03-copilot-cli-production.json) | Bounded three-profile evidence, not all35 profiles/lanes/media/context/error/compaction/fork/terminal lifecycles. Comparison exclusions/host cache annotations and derived final SSE remain explicit in the contract. |
| Independent ChatGPT/Codex OAuth, account and refresh | Public `openai-codex-oauth.ts`, issuer-branded account metadata and same-account rotating refresh; [Core OAuth](./evidence/MOD-03-codex-oauth-core.json), [Core/CLI PKCE](./evidence/MOD-03-codex-browser.json), [Server/Settings PKCE](./evidence/MOD-03-codex-server-browser.json) | Locally evidenced. Fixed OpenAI public client/device/authorization/token authority; no API-key or Copilot-grant substitution. Account claim decoding is not JWT signature or entitlement verification. |
| Independent Codex account catalogue and dedicated `openai-codex-responses` transport | Public `OpenAICodexProvider`, nine immutable declarations, fixed ChatGPT account models/Responses endpoints; [transport receipt](./evidence/MOD-03-codex-transport.json), independent [replay receipt](./evidence/MOD-03-codex-replay.json) | Locally evidenced SSE and authenticated pinned intersection without fallback. Not API-key OpenAI or a Copilot model named “codex”; explicit WebSocket is refused. |
| Codex host/lifecycle integration | Canonical CLI/runtime and reserved Server/Settings device plus opt-in browser login; [CLI](./evidence/MOD-03-codex-cli.json), [HTTP private](./evidence/MOD-03-codex-http-private.json), [emitted/installed CLI private](./evidence/MOD-03-codex-cli-private.json), [browser private](./evidence/MOD-03-codex-web-private.json), [Server PKCE](./evidence/MOD-03-codex-server-browser.json) | Locally evidenced bounded CX histories and host retirement. CLI owns the fixed loopback listener; Server owns no listener and accepts only the validated full return URL. No complete nine-profile/private-terminal/account-switch or Codex production certificate. |
| Real subscription consent, entitlement, refresh and inference | No explicitly authorized account campaign in these receipts | **BLOCKED / UNVERIFIED for both providers.** Synthetic tokens, catalogues, signatures and SSE cannot satisfy this requirement. |
| Preserve the three accepted historical incidents | [User acceptance](./evidence/QUA-compiler-tier-repair-user-acceptance.json): `QUA-REPAIR-CLI-SIGSEGV`, `QUA-REPAIR-COMPILER-SIGSEGV`, `QUA-REPAIR-OAUTH-EXIT` | Accepted gaps, not successful tests. No reopening, diagnosis, corrective requirement or extension to later incidents. |
| Docker-only validation, independent boundaries and preserved work | Source-bound receipts; Git history through `ae6e582`; unrelated eight-file compiler repair and two untracked receipts remain outside subscription staging | Evidence reviewed, not rerun by this documentation checkpoint. Protected `pi`/`qwen-moe` containers are not used for qualification. |

## Evidence Boundaries That Must Not Be Merged

- **SDK:** Copilot routing/continuation fixtures and Codex normalized transport/PKCE/private continuation acquisitions bind independent reference behavior. Later host campaigns reuse those fixtures, not fresh SDK executions or real service responses.
- **Core:** Emitted/installed public-Core replay is distinct from running the CLI with native login and private journals.
- **HTTP:** Copilot refresh/tier/removal is qualified through the source Server composition root. It does not transfer to browser, installed CLI or production refresh acceptance.
- **Browser:** EN/FR journeys use genuine emitted Server/static Web with synthetic outbound providers. Rich snapshots/view cache may retain authorized opaque data; credentials must be absent and opaque carriers are not displayed. This is not an opaque-free storage certificate.
- **CLI:** Copilot fourteen selected installed journeys and Codex eight selected installed public/private journeys retain separate receipts/inventories. Codex five installed browser-method selectors are a separate campaign. None is a full installed parity pass.
- **Production:** Copilot nine private A/C/R print/JSON/RPC paths pass on Node26.13.1, UID/GID999, network-none through `/app/packages/cli/dist/index.js`. This is neither an installed PATH-bin nor Web-launcher/distribution certificate; no runtime test dependency or TLS bypass was added.

## Open Acceptance, Not New Implementation Claims

### 1. Account-owner decision required

The next real-account milestone is Copilot, preserving the requested priority. An operator must explicitly authorize a particular account, host and bounded action/cost scope. Authentication must happen through the native local login/Settings flow; never paste access/refresh tokens, device secrets or an encrypted credential store into a conversation or receipt. No account was contacted by this checkpoint.

A bounded account campaign must record, without secrets: actual consent outcome and account-authorized catalogue; explicit selection of an entitled model and successful inference; genuine refresh/expiry behavior and subsequent inference; logout/withdrawal refusal; host/toolchain identity, failures and privacy checks. Real model-policy changes, extra purchases or remote revocation are not implicitly authorized. If refresh cannot be observed safely, keep that item unverified rather than manufacture vendor evidence with fixture expiry/token edits. A single account/profile does not establish all tiers, all models or account-switch private replay. Codex needs its own independently authorized campaign afterward.

### 2. Local scope remains bounded

Complete profile/context/media/default/error/overflow/compaction/fork/cross-account/private-terminal lifecycle acceptance remains open. Codex WebSocket/cached delta, compression, grammar/strict tools, tool search, mid-conversation system instructions and complete image preparation are not delivered by the SSE subset. These limits must remain visible; they are not a reason to repeat already qualified device/PKCE/login/restart scenarios or silently add the full host×model×feature cross-product to this objective. Further work should name one missing behavior or host boundary and its acceptance before adding tests.

### 3. Non-waived qualification holds remain separate

The [current contract's retained gate history](../../ai/topics/subscription-providers.md#associated-tests-and-evidence) records:

- Root **10,447 PASS/2 FAIL/535 files**: installed tool-selection native termination and the OpenRouter C5000ms timeout. Focused later passes do not qualify that root.
- Wider Settings **64 PASS/1 FAIL**, worker SIGSEGV at `e2e/settings.spec.ts:608`.
- [Codex CLI fresh rebuild](./evidence/MOD-03-codex-cli.json): Core TypeScript compiler SIGSEGV, outside the three-incident waiver. Later independent builds are not retroactive repairs.
- Thirteen strict diagnostics in unchanged `providers/openai-responses.test.ts`, and `commands/handler.test.ts(28,32)` TS2503 (`jest` namespace). Runtime passes and narrower strict roots do not close those roots.

No wider compiler/provider repair is undertaken here: other MOD-03/MOD-01 work needs an indispensable dependency or explicit scope decision. Historical failures retain their source-bound results and unknown causes; this checkpoint adds no waiver or rerun.

## Closure Decision

**Do not mark the tracked goal complete. Do not close MOD-03 or change AUDIT-5's count.** Native subscription foundations and named local host/race subsets are delivered; real-account acceptance, complete qualification and non-waived holds are not. A future completion audit must map every then-agreed requirement to actual artifacts and resolve remaining uncertainty, rather than infer completion from this matrix or one green campaign.

This change is documentation only. Validation is `make lint-docs` in Docker and `git diff --check`; no new SDK, build/type, unit, CLI, HTTP, browser, production or account execution is claimed.
