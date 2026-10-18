# Summary-provider projection and useful public context

Date: 2026-10-18. Criterion: **A3-CLI-19**. Baseline: `4a77e57`.

**Status: QUALIFIED — A3-CLI-19 DONE.** The genuine candidate after `4a77e57` passes every required frozen main gate and the complete clause review below. Historical failed code-mode/model aggregates and the failed exploratory Server compiler are not waived. The separately reconciled A3-CLI-05/09 closures bring mandate progress to **4/10**, including A3-CLI-16; the ten-closure goal is not complete.

## Scope and clause map

| Clause | Implementation | Concrete evidence | Boundary |
|---|---|---|---|
| Omit thinking/private replay from summary-provider input | Core root `getSummaryModelMessages` clones and whitelists public fields; reasoning blocks, metadata, retained full outputs, tool/command download fields and unknown replay fields are excluded | `packages/core/src/sessions/summary-model-messages.test.ts`; actual CLI `/compact` provider-boundary captures in `packages/cli/src/commands/compaction-public-transcript.test.ts` | Canonical preparation and trusted custom callbacks still receive their existing canonical view; not every old native renderer leaked private data |
| Conserve useful text/tool/custom content | Preserve compatibility and rich text, including block-only/differing views; prefix-compatible views use the longer text. Public tool JSON retains literal `reasoning`, `signature` and non-callable `toJSON` data. Branch rendering consumes public text and existing tool traces | Core projection and `summary-branch-public-text.test.ts`; native marker/conservation assertions | No changes to public custom-message projection, source ancestry, atomic units or journal IDs |
| Qualify each actual host | Default CLI manual/automatic, print/JSON, RPC manual/automatic/navigation, Core branch adapter, explicit SDK callback integration, Server agent/manual/automatic and legacy compact transport | `packages/cli/src/cli/summary-transcript-process.test.ts` plus genuine installed consumer additions | SDK has no new implicit summary provider or facade method; caller-owned callbacks explicitly opt into the Core helper |
| Bug reports do not serialize thought/history or execute provider/tool/MCP work | Existing `/bug` outputs a URL using only explicit/default description plus Node/platform details | Two `bugreport-public-description.test.ts` controls capture exact URL/output, provider/stream/tool/MCP spies and unchanged raw journal | Already history-free behavior is conserved, not claimed as a repaired bug |
| Chars/token revision note | Existing Core `TokenEstimator.estimateTokens` already uses `ceil(text.length / 4)`, matching the inspected reference's four-character heuristic; no ratio defect is invented | Existing `packages/core/src/sessions/compaction.test.ts` (40 cases) passes in the complete root; native fixtures separately assert actual summary wire bytes against the stated ASCII reference | Rough English/ASCII heuristic only, not a conservative tokenizer for every language/media/model |
| Preserve bounds and honest estimates | Original canonical JSON admission precedes omission; projected and final appended manual requests are checked again. Existing generation/output limits, tool-free declarations and response evidence stay intact | Core original/projected bound controls; new `packages/server/src/api/summary-public-http.test.ts`; existing 128 preparation/navigation controls and 12 proxy generation controls | No global chars/token ratio, model-window policy, keep target, vendor tokenizer or CLI-SES-07 repair is introduced |
| Preserve ownership/public package contract | Readonly input, independent dates/arrays/tool input, mutable result; root export is additive under Core API 1 | Installed NodeNext declaration and outside-checkout runtime probe; raw-history/source conservation in every native scenario | No persistence schema, structural store, source lease, callback or facade requirement changes |

## Implementation and authority

- `packages/core/src/sessions/summary-model-messages.ts` is provider-only. `getCompactionModelMessages`, `prepareCompactionContext`, estimates, cut selection and raw history remain unchanged.
- Default hosts call the helper before their owning redactors/provider work. Original canonical admission remains 2,000,000 UTF-8 bytes / 65,536 nodes / depth 32. Post-projection admission still catches expansion of unrelated compatibility/rich views. Existing 4,096-token requests and 16,384-original-byte generated-text checks are conserved; branch generation keeps its separate conservative UTF-8 framing/reserve rules.
- Native OpenAI-compatible transport already ignores several canonical private fields. Do **not** infer a wire leak merely because shared preparation retains them. Provider-boundary captures demonstrate the actual old CLI input defect; native different-text/tool controls separately expose useful-public-context loss.
- The legacy compact route previously stripped everything except role/content, losing public tool traces. Its new summary-only path admits the original JSON, owns/normalizes synthetic IDs/dates, then applies the whitelist. Ordinary legacy chat retains its original role/content-only sanitizer. Typed historical data grants no tool execution, workspace access, replay or save authority.
- Branch callbacks still own privileged entry snapshots; only their bounded inert public transcript reaches the default provider. Public custom-message labels/content remain model-visible, including `display: false`; private custom state/details remain excluded.
- Core SDK callback ownership is unchanged. The native SDK case asserts canonical private data is still present in its trusted callback, then explicitly invokes the public helper before provider work. Parent failures for the absent new export are API-absence evidence, not a demonstrated old implicit SDK leak.

## Exploratory review history (all failures retained)

These are isolated copy/build reviews, **not** complete Make qualification. Their actual source snapshots/logs are retained separately; no failed aggregate is replaced by a subset.

1. Initial unit review: parent **4 failures / 131 controls** (135 cases); candidate **146 passed**. The 11 then-new helper cases are candidate-only, not invented parent controls.
2. Public v1: **20 failed / 6 passed** of 26. Two Bugreport controls and four Server agent/manual/automatic cases passed. New fixture errors were branch data exceeding the existing byte-derived branch budget (4), unsupported invented SDK subpath (2), incorrect retained-cut assumptions (10), fullscreen readiness observation (2); two legacy compact cases exposed actual public tool-input loss. No complete causal claim.
3. Public v2: **2 failed / 36 passed** of 38; both new fullscreen cases still waited for a detail suppressed by `quietStartup`. ANSI normalization and geometry alone did not fix that observation.
4. Public v3: **38/38 passed**, 17.05 s. Before freeze, the new PTY fixture uses the already documented presentation-only `--verbose`, matching existing terminal tests. No old flags, selector, deadline or retry changed.
5. Public v4: pure parent **20 failures / 156 controls** of 176; candidate **12 files / 189 passed**, 18.50 s. Additional candidate-only helper cases cover prefix-compatible text. Installed review **4 failed / 15 passed**, 207 deselected: the four new PTY drivers incorrectly tried to resolve root test dependency `node-pty` as an installed application dependency. Declaration/runtime ownership already passed. Those failures are fixture-bootstrap evidence, not product failures.
6. Public v5: parent again **20/156**; candidate **189 passed**, 19.77 s. Installed parent **11 failed / 8 controls**, 207 deselected. Correct only the new PTY harness bootstrap using existing `AIH_TEST_PTY_MODULE`/`require.resolve('node-pty')` precedent; application imports still use genuine outside-checkout installed packages/PATH bin. Candidate Server build then printed **`Segmentation fault (core dumped)`**, npm 139, before announcing any installed tests. Core/CLI builds completed; the corrected installed candidate was **not run**. No native cause is established and no flag/runtime workaround is used.
7. Public v6 is a separately frozen final exploratory iteration. Before qualification, reduce only new synthetic ASCII user/result/after-tool fields from 150,000 to 120,000 characters, retain every positive/negative assertion and add actual native-message byte/output assertions. The earlier oversized fake-transport data must not stand in for model-budget evidence. The reference is the CLI's 128k fallback minus requested 4,096 output, using unchanged four-char ASCII heuristics; this is not exact vendor tokenization/certification. Parent **20 failures / 156 controls** → candidate **12 files / 189 passed**, 17.90 s; genuine installed parent **11 failures / 8 controls** → candidate **19 passed**, 30.40 s, with 207 other cases deselected. The latter is not complete parity.

The 20-case parent failures comprise provider-boundary privacy/public-context/bound controls and native useful-public-context failures, including **two SDK API-absence failures**. Do not describe all 20 as native privacy leaks. Installed parent includes **three API-absence cases** (two SDK cases and the new declaration import), separately from semantic failures. Existing controls remain controls.

Artifacts:

- `/tmp/aih-a3-summary-review-{red,green}.log` and source manifest.
- `/tmp/aih-a3-summary-public-v{1,2,3,4,5,6}-*.log`, launchers, per-phase exits/manifests and included-document hashes.
- Earlier actual source snapshots are archived under `/tmp/aih-a3-summary-public-vN-sources/` with SHA checks, not overwritten by corrected fixtures; named Docker review containers are retained.
- Current parent is actual engine image `sha256:008f6d42711d043da169d79c720ee7594a3aff73eb5deaf4ad202af71e9e09bc`, matching baseline executable inputs; overlay reviews do not prove final complete image identity.

## Required main-checkout qualification

Main promotion matches all 17 final-v6 source/test hashes and preserves old home/model/code-mode installed cases. Qualification freezes **28 combined summary/code-mode/model paths**, the included SDK README separately (`c34253aae578f995a8a1b9b62387deb8e65750b769b3db388524bab888935687`) and **1,162 checkout inputs**, including paths/modes/link identities/bytes. No executable or included-document edit follows the freeze; other drafts remain in detached worktrees.

| Required gate | Observed result |
|---|---|
| `make typecheck IMAGE_TYPECHECK=aih-a3-summary:test` | Passed, Make 0; packaging **4/4**, dispatcher **19/19**, workspace/parity declarations |
| Fresh combined focused controls | Passed, **23 files / 388 tests**, 45.50 s |
| Complete `make test-parity IMAGE_TEST_RUN=aih-a3-summary:parity` | Passed, **3 files / 256 tests**, 269.59 s, Make/runner 0; all 19 new installed cases included |
| Complete `make test IMAGE_TEST_RUN=aih-a3-summary:full` | Passed, **361 files / 5,641 tests**, 1134.28 s, Make/runner 0 |
| Complete `make test-e2e IMAGE_TEST=aih-a3-summary-e2e` | Passed, **571/571**, Make/runner 0; all nine configurations: **388/69/8/11/18/43/2/24/8**, each raw status/code/signal **0/0/null** |

The inspected test image, complete parity/full tags and captured live E2E image all have identity **`sha256:caee8b36bd7f89b6921e8a009936c5b57d134da4c914d8b87dbfef1e10688494`**. Actual inspected files match all 28 hashes and the separate SDK README; `lstat` proves `/app/.git` absent. Node **24.15.0**, V8 **13.6.233.17-node.48**, Linux x64. All ten before/after source/SDK and checkout checks across the five gates pass. The settled `/tmp/aih-a3-summary-completion-audit.{mjs,log,exit}` independently checks exact exits/counts, all nine E2E command receipts, frozen inputs and image identities (exit 0).

Receipts: `/tmp/aih-a3-summary-qualification.sh`, `*-{typecheck,focused,parity,full,e2e}.{log,exit}`, `*-sources.sha256`, `*-included-docs.sha256`, `*-checkout-inputs.json`, per-gate source/checkout checks, `*-all-test-image-ids.txt`, `*-image-source-check.{log,exit}` and captured E2E container/image IDs. The first image-tag formatting command failed on Docker's `RepoTags` value type; JSON tag formatting then recorded the same IDs. This is inspection bookkeeping, not a product-test rerun. Initial docs lint also refused the ignored acceptance link before any gate launched; force-staging the new receipt corrected that bookkeeping.

## Closing clause review

Every clause in the checklist is supported by the completed gates: omitted typed thinking/private replay, conserved public data, all actual default hosts and explicit SDK ownership, unchanged history-free Bugreports, original/projected/final bounds, the already-existing four-character heuristic, and genuine readonly declaration/runtime ownership. No global ratio, canonical cut, keep target, callback/source/save authority, runtime flag, retry, existing deadline or snapshot changed. **A3-CLI-19 is DONE.** CLI-SES-07 and every unrelated incomplete criterion remain open.

The same genuine delivery also permits independent whole-clause reconciliation of [code mode](./codemode-intrinsics-and-worker-lifetime.md) and [model resolution](./model-resolution-and-scopes.md), not retroactive relabeling of their failed candidates. A supplementary file-launched public Core inventory in this exact image succeeds: only the eight script API helpers remain mutable; QuickJS InternalError is frozen, including its prototype. Its actual copied script matches the owned source (`*-engine-inventory*` receipts); it supplements, never replaces, the 111 current real-worker/emitted/installed controls and complete aggregates.

No production/release/publisher, remote vendor, browser deployment or physical-terminal certification is claimed. The mandate remains incomplete at **4/10 additional closures**; historical failures and all five unanswered product decisions remain intact.

## Final combined executable manifest

```text
b8bd9e7f834af75ce777a4902aa8eca361cba1e845d9a21c2c38ade64e98dabd  packages/core/src/sessions/summary-model-messages.ts
77864d8751cad32b023eb53b89fc3c07c84ee6216f580803b14523271b488489  packages/core/src/index.ts
058326472cd2b9cc1480e3f6c522d8d51a429f2b904adbe46d9c5a7b246c6175  packages/core/src/sessions/branch-summarization.ts
97fe8d450a00d60f07e659fc66f94dd06981d251eb0faed3a90b2b30e4f16b59  packages/cli/src/commands/handler.ts
7945f415de3a163d69d29c690fb6c6b80817083d88a9b569d0db5f1c289870cf  packages/cli/src/index.ts
2e556175e0df3fbdf4bceed7a2b9eac3d037c110f6fd0c07c0a0ce18f0ae8191  packages/cli/src/rpc/rpc-controller.ts
5abff75296307c1497fd9aaa52a1dee127d0f7224c43e20d86e8c2156ee33a37  packages/server/src/runtime/services.ts
41faaf34605214ed82ac742794052e9d96133352171f9ba7fd448f8cf1122f51  packages/server/src/api/agent-routes.ts
ab824ef79ee3a6b9a50315c1bb94b8876e031d8ade4482e403c1d774a6f66bf1  packages/server/src/api/proxy.ts
c9c7f2c09bbc35cabcbfbd31ce78729c7bf5023ab8505f07c32e27127483f3b3  packages/core/src/sessions/summary-model-messages.test.ts
816cebd1fc4a21ebacea2c0d29d4abce5280703c0774d6628e7ac6176fb8b638  packages/core/src/sessions/summary-branch-public-text.test.ts
50b7f83cdd9a469d77905a181e7fa198e46ac825c8a63e9217cf6989507bb24c  packages/cli/src/commands/compaction-public-transcript.test.ts
d906a097d85166dfabdc70ed5c9f02da3090fb492d09f8edcba4de07fd96bf02  packages/cli/src/commands/bugreport-public-description.test.ts
a0cfac9ed0fa0a574eeaaf1facf46bef150a91b22e1c5a2b4a5cde6238b7cc15  packages/cli/src/cli/summary-transcript-process.test.ts
3a31586b0c1cc7f1b925b58f57e5754bdc15d5775865b70c24a2315e242be0fa  packages/cli/src/cli/fixtures/summary-transcript-probe.mjs
acc87fed2a5b21cb7d7bb899928f05ad52e73fecebdfaac995e211d33e27742a  packages/server/src/api/summary-public-http.test.ts
79ac929027ea1ef479422e12d2e2a167a9f3338a806f803380000027fcf01d84  tests/functional-parity/installed-executable.test.ts
104da2e5f7eca9b47da4a82e017d9037914c477591ad139f938f66967ade8b51  packages/core/src/tools/codemode-worker.ts
ff2fb9ad7b161454510a3095bc8d40276ef934859f502b58418ac964e0874ddb  packages/core/src/tools/codemode-intrinsics.test.ts
2681007daf3e0b703840bb805e531604a7f424e595a7fcadd30c69351ddab797  packages/cli/src/cli/codemode-intrinsics-process.test.ts
6f631744a7d042f487bf7b789e41092a52d76bfddb185725f398fc33c2c8d1e5  packages/cli/src/cli/fixtures/codemode-intrinsics-probe.mjs
b371fd11d944896ee546c87dc3c7d9e40d844f87a667509f93310cfefedc222a  packages/core/src/providers/model-catalog.ts
4d21cbc6800cda04f82096d77c31f4157357960760d0df8fa8e916d0088cbebb  packages/cli/src/providers/configured-providers.ts
83b543c8a53fb46d0ef2a256564c41a783479ba8c9cdb842a9a9166cbe2b9dc4  packages/cli/src/rpc/rpc-server.ts
0a323b4355b2e738ffdc9af2bb071ee93ee03e1c2625956980e7c9e3aac3be9b  packages/core/src/providers/model-resolution-ambiguity.test.ts
75745abb041ed7d993b5e8e2aefec2e6300a08adf34835934ad7367760b06967  packages/cli/src/providers/startup-model-resolution.test.ts
bf782fd7e55817679b3c62d95934089c6639d5bad87596056e68d650e71da42c  packages/cli/src/cli/model-resolution-process.test.ts
ace516a7eb94633e846ddb8851ebac283517a43415698582eeb27a4b0bbbe31b  packages/cli/src/cli/fixtures/model-resolution-probe.mjs
```
