# QUA-01 — frozen integrated campaign and IME elapsed-time repair

**Status: PARTIAL.** All six required native controls were executed once on coherent frozen inputs; the browser gate fails one case. A subsequently demonstrated IME defect has an owning-file repair, not final integrated qualification. The [initial campaign](./QUA-01.native-20261116.md), its source-bound failures, [minimap maintenance](./QUA-01.minimap-references-20261116.md), [Settings maintenance](./QUA-01.settings-references-20261116.md), and exactly three historical incident acceptances remain unchanged. No remote CI or global green is claimed. The [subsequent post-IME campaign](./QUA-01.ime-integrated-20261116.md) is now the latest executed-input receipt: IME passes, but root and two other browser cases fail; production/smoke are not executed on that changed source. Results below remain bound to79cfb7a4.

## Frozen source and images

- Commit `79cfb7a432821ef596cf81c4e087df02a2b18582`, tree `4e85297e68bd510f2d3fd68ab9056022a39eec81`; worktree clean before freezing.
- Complete Git archive extracted to `/tmp/aih-qua01-native-20261116/integrated`, isolated from later edits. Archive SHA-256 `3b48103efe0a67ee75a1165f45d0c2878ae29817d60fbc203d1e7f192b3cbc27`.
- [Post-campaign verification](./QUA-01.integrated-20261116/integrated-source-verification.json.gz): all2,438 tracked Git blobs and executable/symlink modes match, **zero source drift**, including nested documentation and all references. No exhaustive inventory added; Git remains the source authority.
- Test image `aih-qua01:native-integrated-20261116`: `sha256:c5d1124e0d727840a83a54945d98ba839f6b3b45a978ae400bba90f2d6fc1c28`, Linux amd64/Node24.15.0. Typecheck, parity, root and E2E build logs all export this same immutable manifest.
- Production `aih-qua01:native-integrated-prod-20261116`: `sha256:eb59752ee5571a7dd46696262011d688aa4e8724b2b8f366bca2174363e727cb`, Node26.13.1. It is byte-identical to the prior production image: the accumulated E2E fixture/reference changes do not change its shipped output. Build and smoke were still explicitly executed for this frozen campaign, not double-counted as independent product coverage.
- Dockerfiles, dependencies, flags, deadlines, tolerances and discovery are unchanged. Disposable HOME/stores, synthetic authentication and simulated/local transports only; no personal stores, real-account services, pi/qwen-moe interventions or Node/V8 diagnosis.

## Requirement → command → result

[Commands, timestamps and exit codes](./QUA-01.integrated-20261116/commands.json.gz) retain exact image/source overrides. Each official target was selected explicitly and executed once, serially; no automatic retry or source change occurred between gates.

| Mandatory native control | Official entry | Result on frozen79cfb7a4 |
|---|---|---|
| Complete types, including public parity types | `make typecheck` | **PASS**, exit0 |
| Public CLI/SDK parity and installed consumers | `make test-parity` | **435/435 PASS**, four files, exit0 |
| Complete root | `make test` | **11,696/11,696 PASS**,659 files, exit0; no instrumentation. Earlier OpenRouter timeouts are not reproduced, not diagnosed or erased |
| All nine browsers | `make test-e2e E2E_ARGS='--all-suites --reporter=line,json'` | **765 PASS / 1 FAIL**, zero skipped/flaky/retries; Make exit2, dispatcher exit1 |
| Production build | `make build-prod` | **PASS**, exit0, official defaults/budgets |
| Native startup/operation | Unchanged production smoke, non-root/network-none Docker | **PASS**, exit0: eight controls below |
| Remote CI, separately tracked | Existing workflow; no dispatch/push | **NOT OBSERVED / NOT CREDITED**. Native scope and the existing closure contract are unchanged; no new hosting prerequisite |

The unchanged smoke script (SHA-256 `80068abef7f7aa79feb53189db5113833d38414f22c26e6410f8b533f734205b`) verifies UID999, CLI help outside checkout, mock CLI turn, public SDK turn/disposal, QuickJS worker, native PTY UTF-8/exit, PATH Web launcher with actual HTTP health/index/JavaScript and graceful SIGTERM. This is local native operation, not service/account/platform/release certification.

| Browser suite | PASS | FAIL |
|---|---:|---:|
| standard |566|1|
| interactions |69|0|
| locale |8|0|
| workspace |17|0|
| pane |18|0|
| linked |43|0|
| title |2|0|
| progress |34|0|
| demo |8|0|

All nine raw reports and the [dispatcher receipt](./QUA-01.integrated-20261116/browser-suites.json.gz) are archived. Every signal is null. The nine individually maintained references and prior locator/import repairs pass in this complete campaign; the remaining failure is distinct.

## New browser failure and demonstrated defect

`e2e/markdown.spec.ts:226`, “newline mode continues CJK lists at the caret while IME confirmation and sending never continue”, expected `- \n tail` after Enter, but retained `- selected tail` through the unchanged5s assertion. Original [error context](./QUA-01.integrated-20261116/ime-integrated-error-context.md.gz) and report are retained. Later send assertions were not reached in this failed execution.

Source review finds a concrete elapsed-time defect: `ChatView` records composition-end and tests the100ms settling guard with wall-clock `Date.now()`. A frozen/backward wall clock can extend that guard even after sufficient elapsed time. The original integrated failure did not record clock samples, so **its exact cause is not retrospectively proved**.

Existing coverage already checks composing/keyCode229 suppression, immediate post-composition Enter, selected-text newline insertion and explicit sending. Its precise gap is independence from wall-clock progress. Reuse and strengthen that same case with the repository's existing `page.clock.setFixedTime` API: Date is fixed, browser timers remain live, original150ms wait and every assertion remain unchanged. No new scenario, sleep increase, forced action or framework is added.

- `ime-wall-clock`: frozen79cfb7a4 image plus only the [strengthened fixture](./QUA-01.integrated-20261116/reproducer.patch.gz), SHA-256 `bc5a739e741eced63629700379535db00e35cee88f6d7ea1e1f38f9a4fdfd043`: **1 FAIL**, reproducing the same retained-selection symptom. This demonstrates a defect under the specified input, not original host-clock attribution.
- Minimal product repair: replace the two composition timestamps with monotonic `performance.now()` and initialize “no prior composition” to `-Infinity`. The **100ms policy is unchanged**; the sentinel prevents a new early-page guard before any composition. No other timestamp, timer, runtime flag or policy changes.
- `ime-monotonic`: same immutable image plus the [two-file correction](./QUA-01.integrated-20261116/correction.patch.gz), SHA-256 `0a7fb2e2fbe4a3c31e904092a376647b339e9b657bd08f87bb15ff75aca4183b`: **11/11 existing Markdown cases PASS**, zero retries, complete owning file. Includes the reinforced IME flow, four visual/axe scenes, caret/session ownership, bounded inert paste, list continuation, preview/minimap and executable-URL refusal. No visual reference changes in this repair.

Both targeted commands use the official Docker E2E runner, default bridge networking and disposable/synthetic boundaries. Their raw logs/reports and exact scripts are archived. The verified correction is the explicit reason for a subsequent fresh-source campaign; neither the earlier root pass nor the targeted11/11 can be transferred as qualification of the changed product.

## Completion audit

All required native gates were attempted on identified coherent inputs. Types/parity/root/production/smoke pass; **complete browser qualification is not satisfied**. The product now has a new verified three-line correction, so complete qualification must be repeated on that frozen delivered source rather than assembled from different versions. Historical failures, intermediate RED and the three existing acceptances remain, with no fourth waiver. No unrelated scope, platform, account, release, performance matrix or CI infrastructure work was introduced. Documentation/link/diff validation and the coherent correction/evidence commit accompany this receipt. Goal and QUA-01 remain incomplete, audit39/43.

[Artifact index](./QUA-01.integrated-20261116/artifacts.json) hashes full compressed logs, reports, exact patches and provenance. The large source archive and full browser output remain locally under `/tmp/aih-qua01-native-20261116`; Git plus the recorded commit/patches is durable source authority.
