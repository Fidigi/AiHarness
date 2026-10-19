# D01 — Final MCP inheritance and ordered exposure review

> **Status: DONE — bounded delivery review only** (2026-10-19)
>
> D01 in [AUDIT-4](../AUDIT-4.md#4-convention-and-delivery-queue) is satisfied. No runtime change, new test, default migration or whole-family acceptance is made. A4-MCP remains PARTIAL; Q01–Q03 remain open. The [V4/Main V5 receipt](./native-mcp-inheritance-browser.md) and its failed iterations are historical evidence, not a green qualification of the current application.

## Objective, baseline and precise missing proof

Review the delivered **three-control project inheritance and ordered tool-exposure slice**, including trust, both-source generations, raw writes/undo, public/installed/browser authority and unchanged defaults. The missing deliverable was the final source-to-clause reconciliation, not an uncovered runtime behavior. Existing Core, emitted CLI, HTTP, installed and real-browser witnesses already cover this slice; no duplicate test or general suite refactor is needed.

Reviewed checkout: `6eaef6528bf39dfb55d7bc0f634601d9e06de19b`, initially clean. Implementation commit: `a0e0834dadc996454c701e5eed8a008ef8af8a4a`. Pinned Pi CLI source `71023aec1546d6d677a65669c5665c0927ce0dd0` was reread: `packages/coding-agent/docs/mcp.md`, `src/extensions/mcp/config.ts` and `src/core/mcp-servers.ts` under that package. The applicable upstream clauses are three-control inheritance and exact-name-before-first-ordered-star matching; upstream's codemode default is **not** adopted. Original obligations remain in [AUDIT-3 §§3–4](../AUDIT-3.md#4-latest-changes-comparison-and-new-reviews).

All paths in the checklist are repository-relative. Symbols and named assertions identify the evidence, not merely a test-file inventory.

## Prompt-to-artifact checklist

| Requirement / outcome | Current source authority | Inspected executable evidence |
|---|---|---|
| Same-name inheritance of only `enabled`, `exposure`, `toolExposure` — satisfied | `packages/core/src/mcp/config-inventory.ts`: `isProjectOverride`, `describeEffectiveEntry`; own `command`/`url`/`type` excludes inheritance; valid readable global base required | `packages/core/src/mcp/config-inheritance.test.ts`: private HTTP target retained, seven forbidden fields, four orphan-base kinds, three explicit-target/type intent controls, invalid global/full project replacement; 23 cases pass in V4 and Main V5 |
| No credential/process redirection; value-free diagnostics — satisfied | Same resolver rejects targetless env/headers/OAuth/args/cwd/description/unknown; `override-fields`/`orphan-override`; optional `inheritsGlobal:true` only on valid inherited DTOs | Native assertions exclude global/project private values; `packages/server/src/api/mcp-inheritance-http.test.ts` refuses forbidden/orphan Test with no tool effects; real EN/FR browser diagnostics expose no transport actions or private values |
| Direct default and replacement semantics unchanged — satisfied | `mcpToolExposure` falls back to server exposure then `direct`; full project targets replace; explicit local tool map replaces, not merges, inherited map | Native empty-map/default/full-target controls; `packages/core/src/mcp/tool-exposure-patterns.test.ts` checks all four modes and omitted names. No migration or target flattening |
| Exact original name, then first ordered `*` pattern — satisfied | `mcpToolExposure` own-name check precedes property-order matching; only `*` is special; `packages/core/src/mcp/session-host.ts`: `buildToolSnapshot` passes `remote.remoteName`, not generated provider name | Pattern leaf 42 cases; `packages/core/src/mcp/tool-exposure-runtime.test.ts` five real-stdio cases cover first broad denial, exact grant, original-name matching, hidden and read-only filtering in both scopes; CLI pattern process ten cases |
| Fresh persisted project trust; passive pretrust inventory — satisfied | Core `inspectMcpConfig`/`readProjectFile`, `requirePersistedProjectTrust`, runtime target reread and mutation trust before read/publication; no pretrust project body read | Native trust-revocation read/write refusal; HTTP 401, nonadmin/foreign-Origin 403, pretrust `contentRead:false`, no invocation log; native browser fixture checks metadata-only inventory before saved trust. This does not close the separate stacked trust-dialog accessibility clause |
| Both-source generation and stale binding/status retirement — satisfied | Inherited HMAC uses `[base, value]`, not only merged controls. Inventory, `readMcpServerTestTarget` and mutations share `describeEffectiveEntry`. Host `syncSession` compares inventory/target keys, keys connections by scope/name/key/cwd and closes obsolete records; host/Test status decorators key by config generation | Native coincident-effective-controls test and public emitted generation probe each prove three distinct keys. Five-mode public probe's Core case refreshes configuration and refuses the old prepared binding; browser canonical write removes stale Test display. Generation is for the two **parsed entries**, not unrelated siblings/whitespace; file-byte revisions remain separate |
| Safe raw global/project writes and undo — satisfied | Core `mutateMcpConfig`: lock, revision comparison, fresh trust, raw-entry mutation; `atomicWriteMcpConfig`: exclusive sibling, fsync, identity checks/rename and directory sync. Inherited true/direct is explicit; per-tool write copies only effective control map. `removeMcpServer` stores raw entry; `restoreMcpServer` revalidates current global base | Native inherited writes keep global bytes, local controls, 0640/nlink1, unchanged-byte no-op and stale refusal; raw undo round-trip and missing-base restore refusal. Existing `config-mutation.test.ts` 11 cases and `config-lock-race.test.ts` six cover global 0600, format/unknown keys, stale/concurrent and unsafe writes; HTTP independently proves project-only persistence |
| Browser has no resolver/write/undo authority — satisfied | `packages/server/src/runtime/mcp-inventory-service.ts`: canonical workspace/Core calls; raw undo stays in bounded server-only token store. `packages/server/src/api/mcp-routes.ts`: capability and strict selectors; `packages/web/src/components/McpSettings.tsx` admits Test results only for matching config keys; `mcp-tool-exposure.ts` renders canonical Test results, no browser pattern engine | HTTP role/Origin/stale-revision checks; `e2e/fixtures/mcp-inheritance.ts` starts emitted Server/static Web, logs in normally and saves trust. Four `e2e/mcp-inheritance-live.spec.ts` journeys prove actual peer PID, zero Test/write tool effects, raw 0640 local writes/global conservation, canonical exposure/focus/stale-Test removal, EN/FR diagnostics, axe and overflow. No intercepted inheritance response |
| Public CLI/Core and genuine installed authority — satisfied | `packages/cli/src/cli/fixtures/mcp-inheritance-probe.mjs` imports public Core; `mcp-inheritance-process.test.ts` runs emitted CLI; `tests/functional-parity/installed-executable.test.ts` case “inherits only project MCP controls through installed public Core and the PATH bin” copies probe/peer outside checkout and compiles public NodeNext API-1 declarations | Five modes `command/core/print/json/rpc` pass in emitted and installed evidence; installed results code0/empty stderr for each, compiler code0/empty channels. Probe and native peer bytes match current sources. Print/JSON/RPC assert actual provider declarations and one real lookup effect, not only an inventory DTO |
| Final source/image review, delivery and validation recorded — satisfied within D01 | This receipt and AUDIT-4 task/journal; original implementation already committed in a0e0834. Documentation-only validation uses project-map §8, not a new product candidate | 152 source hashes + separate SDK README match V4, Main V5 and current checkout; freshly reread both immutable test images confirm all153 hashes/Git absence. Actual production/test asset evidence exposes MCP declarations/API1. Documentation lint and whitespace checks pass; this review is committed separately from runtime delivery |

## Evidence reconciliation, not a new test run

Historical Docker results were checked against raw logs, exit files, installed results and actual HTML report contents, not inferred from receipt prose or a manifest's green status:

| Candidate / command or gate | Observed outcome | D01 interpretation |
|---|---|---|
| Isolated V4 workspace types / strict eleven test sources / owning tests / public generation / Web build | 0 / 0 / 64 files, 954 pass / three distinct keys / 0 | Owning leaves above actually occur in passing logs |
| V4 native browser / genuine installed consumer / complete original `make test-parity` | 12 pass (four native + eight exposure controls), 25.5s / 1 pass, 230 not selected, five modes + strict declarations / 261 pass, 298.67s | Separate public, installed and browser boundaries are retained; focused installed evidence is not substituted for complete parity |
| Main V5 `make typecheck` / strict sources / focused tests | 0 / 0 / 98 files, 1,512 pass | Same 152 witnessed sources; not current whole-app qualification |
| Main V5 complete `make test-parity` / `make test` | **FAILED**, 260 pass/1 fail of261 / **FAILED**, 6,093 pass/1 fail of6,094; both Make2 | Q01 print/Anthropic/valid child null/SIGSEGV and Q02 global-broken-JSON adapter failure remain unexplained; no causal claim, waiver or unchanged rerun |
| Main V5 complete nine-suite `make test-e2e` | 633 pass: 449/69/8/11/18/43/2/25/8; zero skipped/flaky/unexpected; raw exits0 | All four native inheritance journeys independently found with one attempt/expected outcome in both V4 and Main HTML reports; not merely aggregate counts |
| Main V5 `make build-prod` / test+production asset probes | 0 / both0, API1/MCP declarations present, five identical native assets | Images inspected by immutable identity; complete Main aggregate still exit1 |

Immutable images still present and inspected:

- V4 test: `sha256:22e1cfee30608f9d67f676e7d0bc80d4abc8de0d9ac19492ba44e88d621d3c2d`.
- Main V5 test/parity/full/E2E: `sha256:8746226a960380914662ea38d008dfd7cfd2ac968b1e3783b41fd1aa13e89458`.
- Main V5 production: `sha256:94ff3e55b70fa5d2731f3fc8860f191dde912203e3da0d63dd367f9fa6cfbfeb`.

Current product changes after a0e0834 are exactly14 terminal-only paths (including four PNGs); of Main V5's frozen1,226 inputs only `TerminalPanel.tsx` and `terminal.css` changed, with12 new terminal paths. No MCP source/test drift, included SDK README change or dependency/build-policy change was found. This conservation supports reuse of the bounded MCP evidence; it **does not** make the later terminal candidate integrated-green.

### Supplementary artifact identity

Raw artifacts remain under `/tmp/aih-a3-mcp-inheritance-{v4,main-v5}-*`; this versioned checklist, results and source/test identities define acceptance even if temporary artifacts expire. SHA-256 values below bind inspected evidence, not completion by themselves.

| Artifact (prefix as above) | SHA-256 |
|---|---|
| V4 and Main V5 `sources.sha256` (identical152 entries) | `e54de864e9b7254066b5ed682d0f64956e5b73577de4fcfd795920147a902bf5` |
| V4 `owning.log` | `ea4ed6596f75c5f9691d3c7ecc411a88ae12e2ad27caaa51036ef4ed6f3b90d1` |
| V4 `browser.log` | `bd6b1c7af8f1ba06f2d2f92a95e34221418efbf825c0e60ef839b05c229ec256` |
| V4 `installed-evidence/inheritance-results.json` | `ac40fa47ec53b43fb9e631ac01bd065a1ab5fef9e5d4daa4b1fb2493867f2447` |
| V4 packed Core / CLI | `b33f1908d9dfa242d5c7ab5dc2c124d212f648341c5513d048796e0a07e0563d` / `57e70a2c9ff9b74c16a91643487ff178d0e7177d791efcceb4e45a604e84ad8f` |
| Main V5 `parity.log` | `eed23f68895520b6f67bb70e8ca5d5fb7286bab19a491fcd03aca900ac67fae4` |
| Main V5 `full.log` | `0e62ff39b8e771cc27df61780fafd2a8b14886dab81236019a1914b1584eee03` |
| Main V5 `settled-suites.json` | `7979692938bd8132353fff289afad92d0c67c7a7d28681ece7dbde8784cbfd59` |

New read-only reconciliation: `/tmp/aih-a4-d01-review.{mjs,json,exit}` records source/image conservation, five installed results, public three-key observation, real HTML cases and all nine report counts. Final exit0. Initial exit1 was a documentary audit path error (`playwright-report/index.html` instead of `playwright-report/focused/index.html`); corrected without rerunning or changing any test/product. Both outcomes are retained. The two new Docker invocations only read immutable source bytes (`--network none --read-only`); no product suite, compiler, provider, MCP transport or build was started during D01.

## Completion audit and explicit residuals

Every D01 requirement maps to source plus concrete native/public/installed/browser evidence above. No missing behavior or verification remains **within this review task**. `make lint-docs` and `git diff --check` validate this documentation-only delivery; no executable input, assertion, deadline, retry, screenshot, default or credential is changed. The initial lint correctly rejected links to the new, not-yet-tracked receipt under the audit directory's catch-all ignore rule; explicitly staging this receipt (as for existing audit receipts) resolves that publication issue without changing ignore or lint policy.

D01 DONE does **not** close A4-MCP, A3-CLI-02, A3-WEB-12 or Q03. Complete selected-current-candidate Main gates remain Q03; Q01/Q02 failures are preserved, not diagnosed here. Structured-content qualification is D11; extension MCP registration/aliases/reach/types, resources, Web built-in switches, stacked trust-dialog accessibility and broader owner/restoration behavior remain outside this slice. Physical-device, remote publication and release approval are not implied. No second delivery task is started.
