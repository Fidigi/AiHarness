# A3-CLI-09 — Credential-Aware Resolution and Plural Scopes

> **Status: QUALIFIED — A3-CLI-09 DONE — 2026-10-18.** The later genuine summary-projection delivery after `4a77e57` passes complete frozen qualification and whole-clause reconciliation. The original candidate after `13c1aa1` and subsequent failed aggregates below remain failed historical evidence, not reruns or diagnoses. Active mandate: **4/10 additional closures**, not complete.

## Whole-criterion checklist

| Existing clause | Candidate evidence |
|---|---|
| Single `--model` prefers the sole provider with credentials, otherwise ambiguity | Core `providers/model-resolution-ambiguity.test.ts`: all six permutations of three providers × exact ID/exact display name/fuzzy reference, plus sole/zero available controls. Provider-local alias/date preference no longer silently chooses between providers. CLI startup rejects ambiguity before its custom-model/default-provider fallback. |
| Bare/exact/fuzzy, full IDs and native colons | Complete-ID-first and provider constraints are conserved. Core tests retain explicit qualification, routed IDs and native `:high` versus a separate thinking suffix. Real processes test exact sole-credential, fuzzy ambiguous/no-credential, qualified, native-colon and pinned selections without provider effects on refusal. |
| `--models` and scope cover every provider | Non-glob entries resolve independently within each provider; qualified references and existing glob semantics stay unchanged. Ordered deduplication retains the first thinking pin. Core alias controls and actual RPC startup/cycling reach both configured fixture providers with the original pin. |
| Warnings | Each returned nonfatal unresolved-scope diagnostic produces the fixed stderr line `Warning: A model scope entry could not be resolved.`; no raw pattern or new stdout protocol record. Warnings remain when explicit `--model` overrides startup scope selection. Unusable startup scopes still fail. Interactive reload uses the same diagnostic result. |
| Trailing comma | Actual emitted/installed scope arguments end with a comma and still succeed with exactly the one nonempty missing-entry warning. Empty entries do not warn. Core retains empty-pattern/deduplication controls. |
| CLI/RPC and installed boundaries | 30 actual print/JSON/RPC scenarios and 30 matching genuinely outside-checkout installed PATH-bin scenarios check disposable credential sources, no silent saved-default fallback, exact exits/channels, native IDs, pins, plural RPC cycling and diagnostic-only stderr. Installed result shape and existing test-runner deadlines remain unchanged. |

## Scope and compatibility

Four product files change: Core `providers/model-catalog.ts`; CLI `providers/configured-providers.ts`, `index.ts` and `rpc/rpc-server.ts`. No public Core signature/export, provider wire format, persisted settings/session schema, JSON/RPC record, credential precedence, discovery/retry budget or runtime flag changes. A private CLI result optionally carries existing Core scope diagnostics; adapters write only a fixed warning. Exact and fuzzy single-model ambiguity is distinct from intentionally plural scope expansion. Explicit `--provider` keeps its prior constraint and explicit `--model` retains startup precedence over the cycling scope.

Availability uses the existing provider `validateConfig()` signal, not speculative remote login verification. Process fixtures register two ordinary native extension providers and use disposable environment credentials; their stream calls append private test receipts. They do not contact vendor services. This does not qualify a durable catalogue/cache, additional model dialects, Web model administration or inherited whole-provider criteria.

## Differential history

- Initial isolated Docker review on `784a7ba`: **26 failed / 45 controls**, 6 files / 71 cases; candidate **71/71**, 7.59 s. Logs `/tmp/aih-a3-model-review-{red,green}.log`. No failed new-fixture correction was needed.
- Full-clause review then added explicit-model-plus-scope-warning coverage and moved scope diagnostic collection outside the startup-scope-only branch. These are additional pre-freeze implementation/tests, not a claim the initial 71 cases covered that branch. Two new leaves were renamed from temporary review names before final qualification.
- Final frozen differential against actual parent home image: **30 failed / 45 controls**, 75 cases, 26.03 s; candidate **6 files / 75 passed**, 8.05 s. Logs `/tmp/aih-a3-model-final-{red,green}.{log,exit}`. Existing 14 catalogue/startup/list controls are retained. This comparison causally covers the final 61 new Core/startup/emitted cases; at that checkpoint installed cases still awaited the genuine package gate recorded below.

## Frozen qualification

Nine source/test inputs and included SDK README are separately frozen in `/tmp/aih-a3-model-{sources,included-docs}.sha256`. `/tmp/aih-a3-model-qualification.sh` checks them before/after each gate. No executable edits follow that freeze; other candidate code remains in detached worktrees outside this checkout.

| Gate | Observed result |
|---|---|
| `make typecheck IMAGE_TYPECHECK=aih-a3-model:test` | Passed, Make 0; workspace/parity types, image packaging **4/4**, dispatcher **19/19**. |
| Fresh focused leaves | Passed, **6 files / 75 tests**, 8.31 s; no aggregate replacement. |
| `make test-parity IMAGE_TEST_RUN=aih-a3-model:parity` | Passed, **3 files / 211 tests**, 230.15 s, Make/runner 0; all 30 new installed scenarios pass. |
| `make test IMAGE_TEST_RUN=aih-a3-model:full` | **FAILED**, 352 files / 5,461 tests passed; 1 file / 1 test failed, 1036.05 s. Make 2 / runner 1. All 30 new installed model scenarios pass; this does not replace the failed aggregate. |

All three test-image tags (`:test`, `:parity`, `:full`) resolve to **`sha256:bc1a2fce9bc292cbdaebb3d0870967869cdb7d1adc11da796d709f5887d52758`**. Actual inspected image files match all nine source hashes and the separately unchanged SDK README (`c34253aae578f995a8a1b9b62387deb8e65750b769b3db388524bab888935687`); `lstat` proves `.git` absent. Runtime: Node **v24.15.0**, V8 **13.6.233.17-node.48**, Linux x64. Receipts: `/tmp/aih-a3-model-{all-image-ids.txt,image-source-check.log}`.

```text
b371fd11d944896ee546c87dc3c7d9e40d844f87a667509f93310cfefedc222a  packages/core/src/providers/model-catalog.ts
4d21cbc6800cda04f82096d77c31f4157357960760d0df8fa8e916d0088cbebb  packages/cli/src/providers/configured-providers.ts
f71aff7b660293c0648edb22d9486bfe4c9298128b5c7980f58c15e9e24376de  packages/cli/src/index.ts
83b543c8a53fb46d0ef2a256564c41a783479ba8c9cdb842a9a9166cbe2b9dc4  packages/cli/src/rpc/rpc-server.ts
0a323b4355b2e738ffdc9af2bb071ee93ee03e1c2625956980e7c9e3aac3be9b  packages/core/src/providers/model-resolution-ambiguity.test.ts
75745abb041ed7d993b5e8e2aefec2e6300a08adf34835934ad7367760b06967  packages/cli/src/providers/startup-model-resolution.test.ts
bf782fd7e55817679b3c62d95934089c6639d5bad87596056e68d650e71da42c  packages/cli/src/cli/model-resolution-process.test.ts
ace516a7eb94633e846ddb8851ebac283517a43415698582eeb27a4b0bbbe31b  packages/cli/src/cli/fixtures/model-resolution-probe.mjs
db1c1c3d2df8db80f2d5be9e5175a6070c447ed91fc79130da25c29b60409988  tests/functional-parity/installed-executable.test.ts
```

## Failed aggregate retained

The existing installed test `preserves scoped Markdown selectors through installed readonly declarations, runtime and PATH bin` fails at `tests/functional-parity/installed-executable.test.ts:828:19`, through the unchanged assertion at line 112. Its child `/usr/local/bin/node /app/node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --types node resource-public.ts` closes with **code `null`, signal `SIGSEGV`**, empty stdout/stderr. The private installed runner prints `[installed-process] Native child termination.` with that receipt. Log: `/tmp/aih-a3-model-full.log`; the settled launcher records `/tmp/aih-a3-model-full.exit` as 2. No native cause is established. No failed-case rerun, changed budget, compiler/runtime flag or workaround replaces this result.

All nine source/test and separate included-SDK hashes still pass after the full gate. Focused/parity success does not qualify the whole criterion while this required aggregate is red. No fresh E2E/production result is claimed for this model-selection increment. Historical native/compiler/browser/context failures, failed aggregates and all five product decisions remain intact. A later genuine delivery requires a fresh frozen qualification and explicit reconciliation, never retroactive replacement of this failed gate.

## Subsequent genuine guest-bootstrap increment

The [code-mode delivery](./codemode-intrinsics-and-worker-lifetime.md), after `d1ba9cb`, preserves all eight model product/focused/probe hashes exactly and appends only its 26 installed cases to the shared installed leaf. Thirteen source/test inputs, unchanged included SDK README and 1,154 checkout inputs remain frozen; all three tags share `sha256:7d65eaf0feb001b6e5c5b73391fa69502bc780258c015c492819c3ba34174d23`. Fresh types, combined focused **198/198** and genuine parity **237/237** pass. Required full root again **FAILS: 354 files / 5,571 tests passed; 1 file / 1 test failed**, 1072.09 s, Make 2 / runner 1: existing module-entry `rpc: direct .jsx entry to .tsx with exact-source deduplication`, child null/SIGSEGV. This new delivery is not a rerun/waiver of the original compiler failure and does not qualify A3-CLI-09. Both native receipts remain unexplained; the mandate stays 1/10.

The subsequent real QuickJS-specific InternalError correction after `ed3e89c` also preserves every model input. Its fresh types and **199/199** focused checks pass, but installed parity **236 passed / 1 failed** and full root **5,570 passed / 3 failed** are both nonzero (Make 2 / runner 1). The full root now includes a direct **`rpc/scope` actual CLI null/SIGSEGV** receipt with empty channels (`model-resolution-probe.mjs:73`, outer process test line 16), besides an installed golden-loop null/SIGSEGV and the unchanged grep deadline assertion observing 7,077 ms against <7,000 ms. The [code-mode receipt](./codemode-intrinsics-and-worker-lifetime.md#subsequent-genuine-correction--engine-specific-internalerror) retains every failure, identical inspected test/parity/full image and frozen inputs. No partial success at that checkpoint qualifies A3-CLI-09 or diagnoses any native/deadline failure.

## Later genuine summary-projection delivery — whole criterion qualified

The [summary delivery and combined executable manifest](./summary-provider-projection.md) makes a real provider-input/ownership change after `4a77e57`; it does not rerun an unchanged failed candidate. Seven model-specific product/test/probe files retain their hashes. The shared CLI index changes only its summary import/automatic adapter, and the shared installed leaf adds 19 summary cases without changing the existing 30 model scenarios.

Fresh frozen **types**, combined focused **23 files / 388**, complete installed parity **3 files / 256** (269.59 s), full root **361 files / 5,641** (1134.28 s) and complete E2E **571/571** all pass, Make/runner 0. Packaging 4/dispatcher 19 controls remain included. All four gate-image identities are exactly **`sha256:caee8b36bd7f89b6921e8a009936c5b57d134da4c914d8b87dbfef1e10688494`**; actual inspected files match all 28 source/test hashes plus the unchanged separately hashed SDK README, Git is absent, and all before/after **1,162-input** snapshots pass. Runtime remains Node 24.15.0 / V8 13.6.233.17-node.48 / Linux x64. The settled completion audit checks these exact receipts.

Closing audit maps every checklist row to this complete run: sole-credential preference or explicit ambiguity; exact/fuzzy/qualified/native-colon selection without catalogue/default shortcuts; plural provider scopes and first thinking pins; fixed nonfatal stderr warnings even beside an explicit selection; trailing-comma controls; all print/JSON/RPC and genuinely installed channels/exits/refusal-effect checks. **A3-CLI-09 is DONE.** No broader provider, remote credential verification, durable catalogue or Web-model criterion is implied.

Every historical compiler/native/deadline failure above remains undiagnosed and nonzero. Current success is independent evidence, not a failed-aggregate waiver. The user mandate remains incomplete at **4/10**; no production/release or unanswered product decision is approved.
