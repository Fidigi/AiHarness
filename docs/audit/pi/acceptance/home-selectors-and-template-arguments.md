# A3-CLI-16 — Home Selectors and Template Arguments

> **Status: QUALIFIED — 2026-10-18.** A3-CLI-16 closes in this delivery (parent `784a7ba`), after the complete clause review and frozen Docker gates below. First additional closure against the ten-closure baseline.

## Requirement-to-evidence map

| Existing clause | Evidence |
|---|---|
| `~` after plain/`+`/`-`/`!` | `packages/core/src/resources/resource-manager.ts` normalizes legacy strings into literal-home scoped selectors; the settings resolver already did this. New `resource-home-selectors.test.ts` covers every six legacy path layers, exclusion/reinclusion order, bare home and literal non-prefix tildes. |
| Empty quoted arguments | Existing `parseResourceCommandLine` already preserves `""` and `''`. New `resource-template-arguments.test.ts` checks empty positions, concatenated quotes, escaping, Unicode, literal shell-like data and negative unterminated/count/byte controls. No parser fix is claimed. |
| Positional defaults | The same test qualifies existing AiHarness missing-only defaults: `${1:-fallback}` retains an explicit empty value; joined-argument defaults and slices retain their prior behavior. Replacement is nonrecursive. No upstream API/semantics import. |
| Declaring sources / exclusions | `packages/cli/src/cli/resource-home-process.test.ts` invokes a real probe across Core, SDK resource loader, print, JSON and RPC, global/project/explicit sources and allow/refuse policy (30 cases). It uses home and declaring roots with brackets, wrong-root decoys, exact body-open receipts and source/scope provenance. |
| Project trust | 24 Core matrix cases include home inside a refused workspace; no selector grants admission. Public probes refuse project settings even when they refer to an outside-home resource. Existing selector trust/race/ABI controls remain unchanged. |
| CLI/RPC/SDK and legacy ABI | RPC actually expands empty positional input; print/JSON retain their native literal slash semantics and exact framing/channels. Public SDK loader expands parsed arrays. Legacy `resolveAgentResourcePaths` returns mutable strings with unchanged resolved values. Thirty matching genuine outside-checkout installed public Core/SDK/PATH-bin cases are added to `tests/functional-parity/installed-executable.test.ts`. |

## Change boundary

Only legacy Markdown string normalization changes: detect a leading home prefix **after** an optional modifier, remove that prefix from the pattern and retain home as the literal declaring base. The existing selector, regular-file, bounds and project-trust pipeline remains authoritative. Usernames and interior tildes remain literal. Explicit negative CLI values use the existing `--option=value` form; strict argument parsing is unchanged. No new public API, protocol/session schema, default, provider behavior, retry, runtime flag, snapshot or existing test deadline changes.

Scoped selector records retain caller-supplied declaring-directory semantics. Settings already normalize their home prefixes. Resource discovery/all-loading switches remain unchanged. This does not qualify new terminal gestures, all resource families or any broader inherited criterion.

## Differential and fixture history

- Initial Docker parent run: **10 failed / 32 passed**, 2 files. Four Core/SDK explicit cases load no resources. Six CLI explicit cases stop at strict negative-value parsing; these are new-fixture syntax failures, not six proven product regressions.
- Corrected new fixture uses `--prompt-template=<value>`/`--skill=<value>`. Identical parent still has **10 failed / 32 controls**: absent resources or wrong literal-tilde-root bodies now demonstrate the home-prefix defect. Logs `/tmp/aih-a3-home-corrected-red.{log,exit}`. Initial failure remains in `/tmp/aih-a3-home-red.{log,exit}`.
- Candidate overlay: **6 files / 182 passed**, 16.01 s. Includes the 42 new template/public cases and 140 pre-existing resource controls. Log `/tmp/aih-a3-home-green.log`. This is not a fresh aggregate gate.
- Final pre-freeze additions: 25 Core home/trust cases, 30 installed cases, and provenance assertions separating global/project sources in the public probe. No passing parent claim for the final extra assertions; the corrected differential establishes the specific reproduced defect.

## Frozen qualification

Six executable/test inputs are frozen in `/tmp/aih-a3-home-sources.sha256`; included `packages/core/src/sdk/README.md` is separately hashed in `/tmp/aih-a3-home-included-docs.sha256`. The launcher `/tmp/aih-a3-home-qualification.sh` checks both manifests before/after every gate. Actual test-image files match both manifests and `.git` is absent (`/tmp/aih-a3-home-image-source-check.log`).

| Gate | Observed result |
|---|---|
| `make typecheck IMAGE_TYPECHECK=aih-a3-home:test` | Passed, Make 0; packaging 4/4 and dispatcher 19/19; workspace/parity types. |
| Fresh focused resource leaves | Passed, **7 files / 207 tests**, 15.85 s; 67 new + 140 existing cases. |
| `make test-parity IMAGE_TEST_RUN=aih-a3-home:parity` | Passed, **3 files / 181 tests**, 224.88 s, Make/runner 0; includes all 30 new installed scenarios. |
| `make test IMAGE_TEST_RUN=aih-a3-home:full` | Passed, **350 files / 5,371 tests**, 1033.86 s, Make/runner 0; all frozen before/after checks pass. |

All three test-image tags (`:test`, `:parity`, `:full`) resolve to **`sha256:7a148b95739782dedf1c0dcbc6307e2378052173726b4c00c7fefa5a9076d4d1`**. The actual inspected image matches these frozen inputs; Node **v24.15.0**, V8 **13.6.233.17-node.48**, Linux x64. SDK documentation is unchanged and independently matches `c34253aae578f995a8a1b9b62387deb8e65750b769b3db388524bab888935687`.

```text
09bb0af12d25ab4508a19fb38fca5fbca616bc192ca1aaa0ac9fcf33645758dd  packages/core/src/resources/resource-manager.ts
03e5029e1888d45ae3bcce53aec28e1b2ce9330fd3297ee4cb208b5344285fe3  packages/core/src/resources/resource-home-selectors.test.ts
5eaadbde38c91778994ed8dbdede5bd49cf3d4f70f76e3a6a808ba0e6a9d4a8f  packages/core/src/resources/resource-template-arguments.test.ts
cfba8aa25fc0a74530a807cd67941004004b26d68cbd562f36115629610f25f6  packages/cli/src/cli/resource-home-process.test.ts
8aa1219310d36ccaf835fbc120e3d6aa064f61d5df364367f1a86a99669aef08  packages/cli/src/cli/fixtures/resource-home-probe.mjs
a79c990f2d29c14c0ebc7c8d83c12e02779e935c645d995e02506b38b08948c6  tests/functional-parity/installed-executable.test.ts
```

## Supplemental minus comparison and closing review

The original probe reincludes `drop` after removing it. To prove the minus operation independently, a supplemental Docker comparison derives the same probe with exactly three changes: `'+~/kit/drop.md'` → `'+~/kit/review.md'`, `'+~/kit-skills/drop'` → `'+~/kit-skills/review'`, and `const selected = ['drop', 'review'];` → `const selected = ['review'];`. Every other assertion, exact body-open receipt, provenance check and inner deadline is retained. It runs against the **same frozen full image**, not a modified product image or a rerun of a failed aggregate. All **30 Core/SDK/emitted print/JSON/RPC × global/project/explicit × allow/refuse comparisons pass**, driver 0, with original source/SDK manifests still matching. This is supplemental emitted evidence, not 30 additional installed tests.

The driver `/tmp/aih-a3-home-minus-proof.mjs` is executed using `docker run --rm -i --entrypoint node aih-a3-home:full --input-type=module < /tmp/aih-a3-home-minus-proof.mjs`; log/exit `/tmp/aih-a3-home-minus-proof.{log,exit}`. It replaces each exact fragment once, writes only a disposable runtime fixture under `/app/.qualification-home-minus`, invokes each case with the existing 20-second public-probe watchdog and explicit emitted CLI command, checks `{code:0, signal:null, stdout:'resource home/arguments OK\\n', stderr:''}`, and removes the fixture. No frozen repository or included documentation input changes.

**Closing audit:** every original A3-CLI-16 clause maps to the first table; home normalization is the sole product change, while quoted empties/defaults remain conserved controls. Types, focused, installed parity and full root all pass on one actual image. Fresh E2E/production are not required by the repository matrix for this Markdown-resource-only increment and are not claimed. No remaining clause or product decision blocks this criterion: **A3-CLI-16 DONE; 1/10 additional closures**. The other nine closures remain required.

Final documentation/tracker checks pass: **144 Markdown files / 1,138 links**, all 99 IDs/counts/order, 16 owners, 224 expanded paths, six-column journals and unchanged AUDIT-2 historical body. Working/staged whitespace checks pass.

The latest complete SSE E2E/production outcomes and every earlier native/full/E2E/context failure remain in AUDIT-3. This later success is neither diagnosis nor retrospective waiver, and grants no release, remote-provider or cross-platform certification.
