# QUA-01 — native Docker campaign, 2026-11-16

**Status: PARTIAL / qualification failed.** No global green, incident waiver, remote CI success or goal completion is claimed. Audit closure remains **39/43**; MOD-01/MOD-03 remain DONE, CLI-04/QUA-02/QUA-03 remain separate.

## Authority and frozen inputs

The current user request explicitly authorizes a fresh native campaign, not resumption of stopped Node/V8 experiments or historical diagnostic replays. The [AUDIT-5 native boundary](../AUDIT-5.md#qua-01-native-qualification-boundary) remains authoritative. The previous [capture campaign](./QUA-01.capture-reference-20261102.json), [final unsuccessful intervention](./QUA-01.final-local-20261102.json), [compiler commit validation](./QUA-compiler-tier-commit-validation.json) and recent [MOD-01](./MOD-01-closure.json)/[MOD-03](./MOD-03-closure.json) closures were consulted without transferring their passes.

- Initial Git HEAD: `ec310ef9331bb65b7b88938eb2129832a6d91080`; tree `e674c5d257b53d96a6ed3e4b04c53cbf29c92848`. Worktree/index initially clean.
- **S0:** clean `git archive HEAD`, extracted outside the working checkout at `/tmp/aih-qua01-native-20261116/source`. Archive SHA-256: `2c9daf9882efb154248f8e9de1c677e69093043eb7a8bc6fce4e563cf579094a`.
- **S1:** separate `/tmp/aih-qua01-native-20261116/candidate`, S0 plus [four-fixture patch](./QUA-01.native-20261116/fixture-corrections.patch.gz), uncompressed SHA-256 `f503b48efa1f760cc9dfb5dec66e105b8e2cc0b5878d3e28c460961400b332fd`. Every complete candidate gate below used S1; build logs confirm the same test-image manifest each time.
- **S2, first delivery (`765116d4`):** S1 plus two E2E locator repairs. [Complete delivery patch](./QUA-01.native-20261116/delivery.patch.gz), uncompressed SHA-256 `00fa95bb53b83923f49469f3061ad78b1accf4736927bb12cabb429a2045d125`. Only the four owning browser cases qualify this later overlay; **S2 has no complete integrated qualification**. Documentary receipt/audit additions are outside Docker's context.
- [Source verification](./QUA-01.native-20261116/source-verification.json.gz) checks all 2,310 tracked Git blobs and executable/symlink modes, including nested package documentation. S0 has no difference; S1 has exactly its four intended test changes, no baseline changes. Plain tar comparison also reports extraction UID/GID/group-write metadata differences; these are not source drift or a successful byte-and-full-mode archive comparison. Both raw comparisons are retained.
- Product, package manifests/lock, Dockerfiles/configurations, runtime/compiler flags, assertions' deadlines/tolerances, test discovery and visual baselines are unchanged. No new scenarios or framework were added.

| Image | Immutable ID | Runtime/base |
|---|---|---|
| S0 `aih-qua01:native-20261116` | `sha256:70def574f4d35765822c406d0dc486ff582a8a67bf9663d2cf3c752202d9f46a` | Node 24.15.0, Linux amd64 |
| S1 `aih-qua01:native-final-20261116` | `sha256:3c629dbbed96414917c1b9b6b8a9ab04bc6b1582da3df3882d3392818207f291` | Node 24.15.0, Linux amd64 |
| S1 `aih-qua01:native-prod-20261116` | `sha256:eb59752ee5571a7dd46696262011d688aa4e8724b2b8f366bca2174363e727cb` | Node 26.13.1, Linux amd64, UID 999 smoke |

Test base: `node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d`. Production's official floating Node 26 resolved to `sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1`. npm remains the Dockerfiles' 12.1.0. Image inspections and complete build logs are archived.

## Requirement → command → applicable evidence

Exact commands, source-directory/image overrides, exit codes and start/end times are in [commands](./QUA-01.native-20261116/commands.json.gz). Each named log below is stored in the adjacent evidence directory with `.gz`; no command is counted twice under different gate labels. Parity and root are separately required official targets, despite overlapping discovery.

| Requirement | Official command/control | Historical starting proof | Current result |
|---|---|---|---|
| Complete workspace/public types | `make typecheck` | Source-local passes, not current integration | S0 `typecheck` PASS; S1 `final-typecheck` PASS, including `typecheck:parity` |
| Public CLI/SDK, including installed consumers | `make test-parity` | Earlier source-local passes/failures | S0 `parity`: **434 PASS / 1 FAIL**; S1 `final-parity`: **435 PASS**, four files |
| Complete root | `make test` | Earlier failed campaigns remain failed | S0 `root`: **11,689 PASS / 7 FAIL**, 659 files; S1 `final-root`: **11,694 PASS / 2 FAIL**, 659 files |
| All nine browser suites | `make test-e2e E2E_ARGS='--all-suites --reporter=line,json'` | Old 743/743 does not transfer | S1 `browser`: **754 PASS / 12 FAIL**, zero skipped/flaky, every attempt retry 0 |
| Production build | `make build-prod` | Older image only | S1 `production` PASS, official defaults/bundle budgets/native install |
| Native operation/startup | Existing production smoke, Docker `--network none`, non-root | Reused unchanged capture-campaign probe | S1 `smoke` PASS: eight controls below |
| Artifact/font controls | `docker run … node --test .docker/baseline-artifacts.test.mjs .docker/test-fonts.test.mjs` | Existing QUA controls | S1 `controls`: **5 PASS**; image build also executes build/E2E ownership controls |
| Remote CI | Existing `.github/workflows/ci.yml` | No matching current run inspected | **OUTSTANDING / NOT CREDITED**. No push, dispatch, hosting change or remote success claim |

The smoke source is [preserved unchanged](./QUA-01.native-20261116/production-smoke.mjs.gz), SHA-256 `80068abef7f7aa79feb53189db5113833d38414f22c26e6410f8b533f734205b`: non-root; CLI help outside checkout; mock CLI turn; public SDK completed turn/disposal; production QuickJS worker; native PTY UTF-8/exit; PATH Web launcher plus actual HTTP health/index/JavaScript; graceful SIGTERM. This is local native operation, not publication or a physical-platform matrix.

| Browser suite | PASS | FAIL |
|---|---:|---:|
| standard | 556 | 11 |
| interactions | 68 | 1 |
| locale | 8 | 0 |
| workspace | 17 | 0 |
| pane | 18 | 0 |
| linked | 43 | 0 |
| title | 2 | 0 |
| progress | 34 | 0 |
| demo | 8 | 0 |

The dispatcher [receipt](./QUA-01.native-20261116/browser-suites.json.gz) records raw code/signal for every suite: standard/interactions code 1, seven siblings code 0, all signals null. The nine complete JSON reports are retained, not just the aggregate.

## Demonstrated fixture repairs

Existing scenarios already cover these boundaries; no new test was needed.

1. **Installed Ant Ling:** the generated consumer still expected `ProviderDialect = 'ant-ling'` to fail. Commit `2256087f` explicitly added that public custom-host dialect. Replace the obsolete negative with positive admission plus a negative undeclared `ant-ling-compat` alias. Keep immutability, factory nonregistration, wire/replay and runtime assertions.
2. **Public SDK consumer:** its hand-selected dependency links omitted declared `saxes` (and other later Core dependencies); both actual emitted consumers failed `ERR_MODULE_NOT_FOUND` before execution. Seed links from Core's real declared dependencies, retaining outside-checkout Core copy/public resolution and existing assertions. This is not a product packaging fix; the separate installed suite passes.
3. **Codex login:** the old fixture expected explicit WebSocket composition to be refused. The current constructor supports WebSocket. Assert exact forwarded network settings, unchanged selected mock provider, exactly three issuer calls and encrypted credential readback instead of obsolete nonpublication. No transport/auth behavior changed.
4. **Settings locale:** retain the original 228-entry inventory and byte-for-byte checks; explicitly project the three already-delivered Vertex key-mode EN/FR literals after their owning label. No inventory regeneration, translation change or comparison weakening.
5. **E2E locators (S2):** the new Vertex selector made broad `select` ambiguous; a dialect option also made fuzzy `API key` ambiguous. Select the exact existing accessible labels in `e2e/{chat,settings}.spec.ts`; preserve all actions/assertions.

`targeted`: **26 PASS** across the three owning unit/SDK files, then **1 installed Ant Ling PASS / 399 unselected**. S1 complete types/parity/root independently confirm the five formerly failing cases now pass.

`browser-locators`: **3 PASS / 1 FAIL** under an inappropriate `--network none` targeted container: Chat's click was intercepted by the genuine offline PWA banner. This environment mismatch is retained, not fixed by hiding the banner/forcing clicks. Restoring the official Makefile's default bridge network is the explicit changed input for `browser-locators-bridge`: **4 PASS**, zero retries. These scoped passes do not replace the failed complete browser gate or qualify S2 globally.

## Unresolved failures and bounded observations

### Root: execution problem, cause unknown

All four uninstrumented failures are whole-case **5,000 ms timeouts** in `packages/core/src/providers/openrouter-completions.test.ts:45`, not proved model-policy defects or native crashes:

- S0: `nvidia/nemotron-3.5-lightning`, `qwen/qwen-2.5-7b-instruct`.
- S1: `nvidia/nemotron-3-super-120b-a12b:free`, `poolside/laguna-xs-2.1`.

The single `openrouter-observation` used S1 plus a temporary phase-marker overlay, not delivered source. Hypothesis: distinguish loopback transport work from journal setup/replay and retain the complete owning file's lifetime. **384 PASS / 2 FAIL**, on `moonshotai/kimi-k2.6` and `openai/o4-mini-high`. Failure callbacks last observed direct-chat journal setup and mixed-chat journal/tool-loop respectively, following fast prior stages. This establishes neither the exact blocked operation nor the original failures' cause; callbacks may observe work after timeout. It does not diagnose filesystem, scheduling, Node/V8 or a common cause. Overlay/log retained; no second observation, deadline adjustment, optimization or additional full-root attempt follows.

### Browser import: initial unknown attribution, subsequent fixture repair

At the first delivery, the complete interactions gate observed **two** requests where `failed imports stay cached on reopen…` requires one. The source loader retains one rejected module promise. One observation-only owning case, under network-none with request/pre-cancel/post-reopen markers, reports **1 PASS**, one request before cancellation and still one after reopen. Different environment and instrumentation prevent transfer to the failed integrated case. No source repair or non-reproduction acceptance was claimed by that first observation.

**Continuation after `765116d4`:** a distinct, source-derived hypothesis now demonstrates a fixture defect. The [unchanged emitted bundle excerpt](./QUA-01.native-20261116/bundle-review.txt.gz) shows Vite preloading the dialog JS, awaiting CSS, then calling `import()`. The previous counter incorrectly assumes that a failed preload and the initial import always share one fetch.

- `preload-order`: one temporary observation overlay holds CSS until the first JS `requestfailed` event; no sleeps, assertion/deadline changes, product edits or runtime flags. The existing case **FAILS 1 vs 2**. Its markers show request 1 → failed preload → CSS released → request 2 → error UI, all **before cancellation**; after reopening the count remains 2. This proves the fixture assumption is invalid under an admitted asset ordering; it is not retroactive tracing of the original integrated failure. [Original log](./QUA-01.native-20261116/preload-order.log.gz) and full report/overlay retained.
- Minimal repair in `e2e/interaction-single-asset-load.spec.ts`: fulfill the requested JS with a synthetic module that throws during evaluation. Import still rejects, the French error/reload/cancel/reopen assertions and exact request count **1** remain unchanged. Separate existing JS/CSS network-refusal cases continue to abort their assets; no coverage was deleted, tolerance increased or new scenario added.
- `import-fixture`: the complete **existing owning file passes 32/32**, including normal one-demand JS/CSS loading, network refusals, delayed assets, cached rejection, explicit reload, focus and retirement. Official `.docker/run-e2e.mjs`, zero retries, default Docker bridge network, same immutable S1 test image plus **only this one-file overlay**. [Commands/exits/times](./QUA-01.native-20261116/import-followup-commands.json.gz) and full original reports/logs retained.
- Source starts at `765116d4`; the [additional patch](./QUA-01.native-20261116/import-fixture.patch.gz) SHA-256 is `3cbc9fba84cc808e05526fabee53ccd03cc3d49541dc72a1de7ef3724fc60cbc`. The delivered source now has seven test-only corrections relative to S0. The targeted image does not contain S2's two unrelated locator overlays; **no complete integrated result is assigned to this combined delivery**.

The historical interactions gate remains **68 PASS / 1 FAIL**, and the nine-suite result remains **754 PASS / 12 FAIL**. A scoped fixture repair does not erase those results or satisfy the final gate. No root, full-browser, production or native-smoke campaign was repeated for this continuation; root timeouts and seven visual mismatches still block qualification.

### Browser visuals: seven failures retained, no baseline changes

Actual/diff PNGs are preserved under [visual artifacts](./QUA-01.native-20261116/artifacts.json); expected images remain the unchanged S0 Git baselines. All seven actual/expected pairs were inspected individually:

| Reference | Reported differing pixels | Review and disposition |
|---|---:|---|
| `settings-readback-en-light-1280` | 355 | Same labels, uncertain-store refusal, values and disabled controls; small vertical/control-edge offsets. Cause unproved; retain strict failure |
| `settings-readback-en-dark-390` | 1,921 | Same content/refusal; approximately pixel-scale vertical shifts around budget/help/actions. No rendering-cause claim; retain |
| `settings-readback-fr-light-390` | 9,649 | Same wrapped French content/refusal; distributed small vertical offsets. No reference regeneration; retain |
| `settings-readback-fr-dark-1280` | 7,376 | Same French content/refusal with distributed vertical offsets. No CSS or tolerance change; retain |
| `history-minimap-desktop-dark` | 34,665 | Reference predates visible linked-directory/navigation/child controls and current composer/read-position presentation. Actual controls/text remain visible; full viewing-state equivalence not established, no blanket acceptance |
| `history-minimap-tablet-dark` | 24,637 | Current child control/composer/return-to-bottom presentation and transcript position differ. Individual capture-state/reference reconciliation remains open |
| `history-minimap-mobile-light` | 9,287 | Current child/composer controls, transcript position and return-to-bottom presentation differ. Preserve failure; do not hide controls or regenerate globally |

**Geometry observation after `5e66f061`, no repair:** the reference for all four Settings images originates at `69100d29`. A [source comparison](./QUA-01.native-20261116/settings-review-source-comparison.json.gz) verifies that `DefaultModelSettings` and `index.css`, `agent.css`, `settings.css` are byte-identical to that commit. This does not establish equivalence of ancestors, browser rendering or the whole application.

One distinct hypothesis was tested on **fr/dark/1280 only**: fractional section positioning can change the rasterized crop despite unchanged internal layout. The S1 image received only a temporary copy of the existing scenario. It records geometry and two captures, briefly translates the section onto an integer pixel, restores its original style, then retains the original screenshot assertion. No screenshot tolerance/deadline, product source or baseline was changed. [Commands/exits](./QUA-01.native-20261116/settings-review-commands.json.gz):

- `settings-geometry`: authoring error in the temporary overlay (`before` duplicated an existing variable), **no tests executed**. Failed log/report and erroneous source retained, not product failure or a test skip.
- `settings-geometry-fixed`: that variable was renamed, the sole reason for another attempt. **One case FAILS**, again 7,376 differing pixels. The unaligned and restored actual PNGs are byte-identical to the original campaign image (`00bf4980464690b3dcc11912d4dc7159edc0c53d2c0133d79644bb5c108ae302`).
- [Geometry](./QUA-01.native-20261116/settings-review-geometry.json.gz): section height `579.125`, initial y `-0.3125`, aligned y `0`, restored y `0.6875` after screenshot scrolling. Internal child offsets/sizes remain identical. The [aligned observation image](./QUA-01.native-20261116/settings-review-pixel-aligned.png) still differs from the reference.
- Read-only PNG comparison in Docker with the image's existing `sharp`: exact differing RGB pixels drop from **32,777 to 14,852**, summed absolute RGB error from **5,660,494 to 993,530**. These are raw analysis measures, **not Playwright's perceptual comparator or a passing assertion**. Fractional placement contributes, but the full discrepancy and a safe permanent capture/reference correction are not established. No inference transfers to the other six visual failures. The temporary transform is not delivered.

These are in-scope regression gates, not waived as QUA-02. Later assertions after each failed screenshot were not reached and receive no credit.

## Completion audit and stopping boundary

| Explicit requirement | Evidence/disposition |
|---|---|
| Read governing instructions, validation, QUA line/§5 and applicable closures | `AGENTS.md`, project-map validation, AUDIT-5 §§3–5 and the linked receipts reviewed; native scope unchanged |
| Preserve existing work/freeze sources/config/images | Clean starting tree; isolated Git archive + identified patches; immutable image IDs and post-run Git blob/exec-mode check |
| Execute official gates and immediately retain failures | All six native requirements attempted on S1; raw logs/commands/exits and nine reports retained; root/browser **FAIL** |
| Only demonstrated minimal repairs, targeted first | Initial six test-only files/five fixture issues: 27 unit/installed and four browser cases. Follow-up adds one fixture repair/32 existing owning browser cases; no new scenarios/product feature |
| Coherent final integrated evidence | **NOT SATISFIED**: S1 root/browser fail; later S2 has scoped browser evidence only. No assembled green from different inputs |
| Respect runtime/security/incident constraints | Tests/types exclusively Docker, disposable container HOME/stores and synthetic accounts/local mocks; no personal mounts/services, pi/qwen-moe intervention, dependency/generated-output editing, deadline/flag/retry changes, historical native replay or Node/V8 investigation |
| Preserve history and exactly three existing incident acceptances | All prior receipts unchanged; [three-incident acceptance](./QUA-compiler-tier-repair-user-acceptance.json) SHA-256 remains `b01fbb91a366a002d0c33934d0db7ea633d9e1a36ae43a3ee7249aa150710dc9`; no new waiver |
| CI and exclusions | Remote CI explicitly outstanding under existing closure contract, not a new hosting prerequisite. No real-account, differential, physical-platform, performance-matrix, release or distribution work |
| Durable receipt, audit synchronization, links/diffs/commit | This receipt + AUDIT-5 update and indexed raw artifacts; documentation checks recorded with the delivery commit |
| All mandatory gates green / DONE | **NOT SATISFIED. Goal remains incomplete** |

No demonstrated product fix currently justifies another integrated attempt. Stop the repetition here. Remaining decisions/work are bounded attribution of journal-phase timeouts, plus capture-state/individual-reference reconciliation for the seven visuals; the import fixture now has the separate scoped repair above; any expansion into runtime/environment/Node diagnosis requires separate scope approval. Do not schedule another complete campaign merely to obtain a green run. No newly accepted gap is proposed by this receipt.

## Evidence retention

First-delivery documentation validation: `make lint-docs` passes (121 Markdown files, 3,373 local links); working and staged `git diff --check` pass. The artifact index is byte/hash-checked after compression. No failed native gate is discarded as out of scope. The import follow-up separately repeats documentation/diff and artifact-integrity checks, not native qualification gates.

[Artifact index](./QUA-01.native-20261116/artifacts.json) hashes the compressed full logs, exact reports, input patches, image inspections, helper/observation source and reviewed visual differences. The first network-none locator helper is reconstructed from its recorded command before the bridge adjustment; its failed report/log are original. Full local browser artifacts remain at `/tmp/aih-qua01-native-20261116/evidence/browser-artifacts`, with no indefinite local availability guarantee. Git commit + patches are the reproducible source authority; the large local source archive is not duplicated in Git. This bounded receipt adds no exhaustive source inventory or qualification infrastructure.
