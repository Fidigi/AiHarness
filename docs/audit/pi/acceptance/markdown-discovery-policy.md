# Markdown discovery versus explicit loading — acceptance

Date: 2026-10-15 UTC. Base: `8fd6ef4fad414dc91d2806187045a61a51c6c51c`.
Decision/evidence: DEC-81 / E-AH-MARKDOWN-DISCOVERY-01 in [AUDIT-2](../AUDIT-2.md).

**Qualified bounded capability, not whole-audit completion.** Final-image workspace/strict types, six-code-owner zero-warning lint,344 focused,247 files/2,995 units,37 parity and production Core/SDK/CLI/PTY/HTTP pass. Seven source/context inputs and14 emitted artifacts are pinned. The initial full-run null-code failure/2,994 passes remains undetermined; documentary image drift is separately reconciled, not called a runtime fix. No criterion closes:89 DONE/63 PARTIAL/152 remain.

## Scope and preserved contracts

Three product owners separate a discovery choice from a preexisting all-loading denial:

- Core `ResourceManagerOptions.discoverSkills` / `discoverPrompts` are optional booleans, default true. False skips the corresponding automatic roots, supplied global/project legacy/scoped settings selectors and package paths. The manager does not inspect those suppressed option fields. Explicit `skillPaths` / `promptPaths` still use existing ordered selection, duplicate, frontmatter, stable-file, limit and trust rules.
- Existing `disableSkills` / `disablePrompts` continue disabling **all** loading, including explicit paths. The existing public CLI resource-manager conservation case remains unchanged. Legacy mutable string arrays, readonly scoped records, `resolveAgentResourcePaths`, Core API major1 and the passive SDK factory retain their contracts. The SDK's options type inherits the additive choices; no second loader/parser or implicit settings load is introduced.
- CLI/RPC `--no-skills` / `-ns` and `--no-prompt-templates` / `-np` now pass the discovery-only choices, preserving repeatable explicit requests. They never override project refusal, including a legitimate project child named `..private`. CLI reload retains the startup choice, reloads explicit bytes and does not admit newly configured automatic resources. RPC keeps its startup snapshot.
- Other settings/trust diagnostics, metadata inventory, instructions, tools, extensions and theme policies remain independent. This is not a sandbox, global filesystem prohibition or promise about arbitrary caller getters/SDK factory spreads. No setting/session/wire field, dependency, protocol banner, golden, deadline, retry, screenshot, bundle budget or compiler relaxation is added.
- Print/JSON positional slash text remains literal. Body admission is checked independently of model text; RPC and both genuine terminal renderers demonstrate actual skill/prompt expansion, including fresh contents after reload. The new policy does not silently add slash-command interpretation to print/JSON.

Pinned reference `resource-loader.ts:587–605,828–864` retains additional explicit skill/prompt paths when automatic discovery is suppressed. The implementation uses AiHarness-owned interfaces, not reference imports. Full startup/display and cross-resource reconciliation, including the already reproduced legacy flattened-glob ambiguity, remain open; this bounded repair cannot close CLI-RUN-07/CLI-CFG-09. Existing CLI-RES-01/02 retain their source/trust/expansion evidence.

## Requirement-to-evidence map

**63 added cases:**28 Core,34 emitted CLI processes and one genuine installed consumer/bin.

| Requirement | Concrete evidence |
|---|---|
| Default versus discovery-only selection, both kinds/trust decisions | Eight Core matrix cases observe actual stable regular-file opens and parsed catalogues/reloads across automatic, legacy/scoped settings, package-path and explicit candidates |
| Preserve stronger public disable options | Four new Core cases plus unchanged `packages/cli/src/resources/resource-manager.test.ts` all-loading control; installed Core runtime checks explicit paths remain disabled |
| Suppressed option fields stay unread | Twelve throwing-getter Core cases for global/project legacy/scoped/package fields; no getter execution or fake filesystem selection |
| Independent captured choices | Two Core cases mutate caller booleans after construction and verify independent resource-kind behavior |
| Explicit ordering/dedup/exclusion/reinclusion | Two Core cases retain exact selected-path removal/restoration without automatic discovery |
| All headless adapters and aliases |18 actual print/JSON/RPC cases:both kinds × default/long/short policies; exact body opens, real global/project package installations, exact RPC command inventory and conserved mode-specific user messages |
| Explicit user selection never grants project trust |12 actual all-headless cases override saved allow with process refusal:outside operator paths remain available, project `..private` bodies stay unread |
| Real terminal reload and fresh invocation | Four regular/fullscreen PTYs assert initial explicit body reads/catalogue, settings replacement, `/reload`, exact fresh reads, actual fresh provider input and clean exit |
| Genuine published interface path | Actual local Core/CLI archives installed outside checkout; strict NodeNext positive/negative boolean calls, retained mutable legacy path types, public ESM Core/SDK runtime and two PATH-bin calls with delegated exact selected-body observation |
| Prior contracts |16-file/344-case focused suite includes literal scoped selectors, exact/project/exclusion boundaries, settings, strict args, existing RPC/SDK/installed and offline policies; final whole/parity/production gates pass for their actual frozen inputs |

Filesystem observation delegates real `open`, `stat`, `realpath` and descriptor reads rather than replacing parsing, selection or admission. Child preloads observe `/proc/self/fd`; a trusted explicit extension records actual `before:provider` messages. Fixtures use disposable resources and an environment allowlist, not host credentials. Package installation is explicit fixture setup, distinct from observed startup reads.

## Causal controls and retained failures

- Final original-product control:accepted offline image `sha256:9a82067701b7f8b374010b1557bfcf6cedba881c382f1bef8eccc7d58171847d` plus **only the final Core/process leaves**, `aih-resource-discovery-final-base-control`:42fail/20pass on62 cases,exit1/OOMfalse,2026-10-15T19:14:43.381515323Z–19:15:01.376292233Z. Core contributes20fail/eight conservation passes; emitted CLI contributes22fail/12 conservation passes. Missing discovery-only options and old CLI all-loading mapping cause the failures; defaults/legacy denials/project refusal retain positive controls. Earlier corrected Core-only control independently records20fail/eight pass.
- Initial Core observer attempts `vi.spyOn` on a native ESM namespace and fails with `Cannot spy on export "open"` / `Cannot redefine property: open`. Replace it with delegated hoisted module mocking, not substituted file content. Preserve the failed observer source/hash/log/state (`initial-base-core`),exit1/OOMfalse,18:55:17.769365486Z–18:55:19.971723794Z. The corrected initial overlay passes three files/68 cases, including the unchanged legacy disable test.
- First process strict check exits2 with TS2550 (`findLast` unavailable under the existing target) and TS7006. Use `.filter(...).at(-1)` without changing target/strictness. `initial-process`,19:03:29.765085850Z–19:03:35.624750374Z,retains the source and five-owner hashes before that correction. Next build/strict check passes but zero-warning ESLint refuses one `consistent-type-imports` warning; use `typeof fs` instead of an inline import type. `compatible-process`,exit1/OOMfalse,19:04:22.549559786Z–19:04:27.183235910Z,retains its input and log. No process pass is inferred from either aborted command.
- First expanded run passes installed/public Core/SDK and28 Core cases, but16 new print/JSON assertions wrongly expect resource-command expansion:16fail/57pass on73 cases,exit1/OOMfalse,19:06:39.146852122Z–19:07:50.674801298Z. Existing print/JSON dispatch deliberately sends positional slash text literally; the new fixture must conserve those exact bytes, while RPC/PTY continue requiring exact expansion. Preserve the original failed source/hash/log; final assertions require exact mode-specific messages and exact body admission. Strengthen the installed bin with real descriptor observation and exact SDK skill text before final qualification. No golden or product dispatch behavior changes.
- First whole integration:`make test`,247 files/2,995 cases,start19:17:29,duration604.18s,Make exit2/Vitest exit1. One existing `rpc-state-purity` case returns code null with empty stderr;2,994 cases pass. The preexisting harness drops the `close` signal, so its exact signal/cause is **undetermined**. Preserve `initial-qualified-units.{log,exit}`, initial driver and immutable image identity; do not label this a product fix or retroactively infer SIGSEGV/OOM.
- Diagnostic fixed-count observations on accepted base and current immutable images each run the unchanged exact RPC case20 times,25 other cases deselected per run. Both pass all20,exit0/OOMfalse; the delegated child observer records40 zero-code/null-signal exits per image. Base:19:32:05.825981311Z–19:32:38.336757071Z;current:19:32:38.508940157Z–19:33:08.561516024Z. These40 case passes/80 observed exits do **not** diagnose or erase the original failure. The later full gate uses unchanged six code/test sources and assertions, not a case retry allowance or engine/deadline change. Its distinct documentation-inclusive image must be requalified as described below; it is not a native-runtime fix.
- Later full integration passes247 files/2,995 cases,start19:35:37,duration603.24s,Make exit0. The subsequent exact-image comparison fails:initial `c9b0118b…` versus final `ce8c5355…`. `.dockerignore` excludes root Markdown and `docs/`, **not** the nested package SDK README edited during the first run. Preserve `image-guard-driver.log`; do not claim that image unchanged. Recover the initial retained focused-container source/artifacts after its untagged image ID is no longer addressable. Across615 source/config entries only `packages/core/src/sdk/README.md` differs (`e13946682daebd1c9aac4e19fed8687724ac3bebaf2bccb2911ea5f53dcc44ce` → `bbe77eaa05a28d2899d1c5c002d24f835a10f952127d789fe1b372cf2bfccb64`); all14 emitted hashes match. The first attempted comparison cannot read that old image (`No such image`) and creates empty initial manifests:retain those invalid comparison outputs but never use them as proof. Correct comparison uses the retained container filesystem, with non-emitting types/non-fixing lint and temporary external consumer fixtures. Freeze the README as a seventh input; repeated final-image workspace/strict/lint/focused and subsequent parity/production all pass. No code/runtime repair explains the original null exit.
- Production dependency guard stops on the first failed unit marker. A premature restart sees the same still-unarchived marker and also stops before creating a product container. Preserve that guard output; restart only after the failed marker/log have been archived and the next full gate begins. No production acceptance follows a failed prerequisite. Two surviving waiters later observe the completed gates and compete for the same container name:one Docker create refuses the existing name before any second smoke runs. Preserve the mixed `duplicate-producer-driver.log` and empty overwritten `.id`; recover the genuine single container ID by Docker inspection, not by rerunning to clean the log. Its captured state/log and all14 artifact comparisons below are authoritative.
- Earlier native/compiler/null/SIGTRAP/Rolldown, public-consumer setup and watchdog histories remain in preceding receipts. Later success is not a causal explanation.

## Exact source and reference identity

Final test image:`sha256:ce8c5355bdf6f0e3cd008159b9c094bdde5197c4776fbbe3a0d0dff1b2d0004e`,Node24.15.0. Seven frozen inputs:six code/test owners plus included package documentation. Initial qualification/diagnostics use `sha256:c9b0118b1045aa4dadd17dfef09facd653a318e802c9eb2a8c52d0d4ef6230a4`; its six code/test hashes are identical, not its README/context identity.

```text
6bb9d9d0571611b8b79427249451404c9c0d565ecc41f05bb27ecf094f9ea206  packages/core/src/resources/resource-manager.ts
a668e371867870fb83cf2c7aecfaa821eb42da18aca20afdae286c320a5adfa8  packages/cli/src/index.ts
a3c1791b135130838b932072caf3dea4d2f731eee0e839ca1db5be99524f021b  packages/cli/src/rpc/rpc-server.ts
5ea92b83f421fa2c76411ef6511e6202f8dc4173ca6f179c2e87495a62c1cfb3  packages/core/src/resources/resource-discovery-policy.test.ts
fc5841d4967c9c901c37ba333fdebf24f2065b1ecb45e3dda35563398d7926dc  packages/cli/src/cli/resource-discovery-process.test.ts
37dcaab95d7daa58fb9608d08766f5a0f40c30262f857add76b65a790b21f6c0  tests/functional-parity/installed-executable.test.ts
bbe77eaa05a28d2899d1c5c002d24f835a10f952127d789fe1b372cf2bfccb64  packages/core/src/sdk/README.md
```

Four accepted-parent/control inputs:

```text
f98e4aaf372512fdbd0d55df6390a6a7dde350f302c59529f8d949049eea3dad  packages/core/src/resources/resource-manager.ts
3ed615ab750961deec3346051f6cd4cd1c23593818651f715a33e954b9b6c5d9  packages/cli/src/index.ts
9d637139460f796f0ace5ee89bed97a283c40a7552e38d5dc2345ed8b8084428  packages/cli/src/rpc/rpc-server.ts
6a46e721570f4e6ee338332feb352c4dacfb92135c380a95ebbc8f20a6868377  tests/functional-parity/installed-executable.test.ts
```

Pinned `/tmp/audit-pi-mono-1.0.0/packages/coding-agent/` reference inputs:

```text
45daa19ad4aa08856cf1eb9b026230b918eb25e163c7dc9ab5cf8add6825955a  src/core/resource-loader.ts
30812e3299d8037a69ab3835c032979ccdaa5da1dc68e2fc7baec0587013918b  src/cli/args.ts
d5f850220fa7ed946b6e6d21593fee33e2ab7ce815cc40fb380c47a856e0301f  src/main.ts
f634d79780f8f5b650f5462da38ad7466aace3ef3fbe0dd0731cda2b6f6e897d  docs/cli.md
```

## Remaining startup counterexample

A separate real-process probe finds a preexisting bootstrap credential-authority defect, not repaired by this resource batch. After a contributed boolean, `hello --api-key ordinary-prompt-literal-arity` is definitively prompt text, but the bootstrap registers the last string as a secret; actual `before:provider` user input becomes `[REDACTED]`. Both accepted offline base and final current image reproduce two failures (print/JSON), while four controls retain literal text after `--` and redact a genuine API key. All six child processes exit0 without stderr; the probe exits1 on the semantic assertion. Evidence:`/tmp/aih-startup-credential-arity-{base,original}.{log,state.json}`, probe SHA256 `bbb26bf01575193a835ebdf4c610550cc0c5e9041cb434708531c4dea58f8e86` on the accepted `9a820677…` and final `ce8c5355…` images. CLI-RUN-07 stays PARTIAL; this is neither a new resource-policy regression nor an accepted missing capability.

## Final qualification ledger

| Gate | Final observed result |
|---|---|
| `make typecheck IMAGE_TYPECHECK=ai-harness:resource-discovery-qualified` | All workspace/parity types pass on exact final image; two new leaves also compile strictly |
| Six code owners, zero-warning ESLint + focused | `aih-resource-discovery-final-focused`,exit0/OOMfalse,19:55:31.759350078Z–19:57:41.711293602Z;16 files/344 cases |
| `make test IMAGE_TEST_RUN=ai-harness:resource-discovery-qualified` |247 files/2,995 cases,start19:35:37,duration603.24s,exit0; actual final image pinned above |
| `make test-parity IMAGE_TEST_RUN=ai-harness:resource-discovery-qualified` | Two files/37 cases,start19:57:42,duration56.53s,exit0; unchanged goldens |
| `make build-prod IMAGE_PROD=ai-harness:resource-discovery-prod` | Exit0; unchanged148KiB entry/159KiB eager gzip/17 JS chunks |
| Production smoke | Image `sha256:bebbe2c049905f5d242ebe8ae52e8dedae06c40d37bb37ce7033346034a776e7`,Node26.12.0,network none;exit0/OOMfalse,19:59:07.120171377Z–20:00:32.752996577Z |

Earlier focused container `aih-resource-discovery-qualified-focused`,exit0/OOMfalse,19:15:20.740306073Z–19:17:27.947728667Z:16 files/344 cases on the initial image, retained without substituting it for final-image proof.

Production reports the new public ESM Core/SDK policy,30 headless calls,four genuine PTYs/four reloads,real package/default controls,exact/zero body reads and fresh actual provider input at19:59:27.006Z. Prior offline19-headless/six-PTY/six-reload, scoped46-headless/four-PTY,boundary30-headless/eight-PTY,theme,startup,module/native/manifest/typed probes also pass. Explicit health/HTML/JS HTTP200 arrives20:00:32.733362011Z. Captured watchdog failures at19:59:12.219650073Z–12.299761026Z,19:59:39.825992820Z–39.915499893Z and20:00:07.470409200Z–07.564328250Z remain exit1;captured health is unhealthy/failingstreak3. Later HTTP200 is not uptime certification.

Final production legacy-flat control remains deliberately negative:exit1/OOMfalse,20:00:33.470627914Z–20:00:33.745144343Z. Public Core reads `UNREQUESTED BASE GLOB MATCH` from `agentl/templates/review.md`,not the requested literal declaring base,and reports no load errors. CLI-CFG-09 remains open; this failure is neither hidden nor waived.

All14 following emitted hashes match exact final test and production images:

```text
29fc221af1a0438952bd826a91a0fcc3a3acc647a8276585f23ea096a0223373  packages/core/dist/index.js
fbd35906cf262ab8cc8cf7a3342b71b702a1a025ac9568eedf96cd6e2724c7c5  packages/core/dist/index.d.ts
83d8e6fb80dae63623bd49c297aef2e7951d1f640c924811d998a089968b5906  packages/core/dist/resources/index.js
9f560d7482aacb4807a5bb952978479d994516d323937048648e99af0e111407  packages/core/dist/resources/index.d.ts
37eff4cc745ec63368b61cdc9ed5a312ea61ad3c8c7fd710a9119db0afc635e3  packages/core/dist/resources/resource-manager.js
8531c0903a9ecac14c3577136a0cfa3fda4f9d009e902cce0e072247765383ea  packages/core/dist/resources/resource-manager.d.ts
c5e01d82de939f00d1c9e4b297dce2d4e1325da56d9936225abea12069d537d4  packages/core/dist/sdk/index.js
372aa68173f28c1a58d6209c4dc4d9ca8cc4676a0b79854e7e58fdc3d7796371  packages/core/dist/sdk/index.d.ts
9b51d3bee91937f787687d3f7f02898bd3ef5422dbf016ac9c81ff278733f771  packages/core/dist/sdk/resource-loader.js
06d0e1b7b52ada555b020273b1b4fd7538b292ad6a174f93ce228b9f890e031e  packages/core/dist/sdk/resource-loader.d.ts
607670353e94774523f1e0897d00b1fe9211878050960e1f089ff37fa1bb57e1  packages/cli/dist/index.js
28f6febb9b51e593316bd49c125cf3170875188867bb71d4d4a43f01b274b964  packages/cli/dist/index.d.ts
adb721d008e8f1eb20c00daf09fc9bb2fc8a83fe6aaabb83c0b15a6b364fdb06  packages/cli/dist/rpc/rpc-server.js
03a8a0757daeeab90ada6c6610e55b9b69874e26161e2e127b0285b1aac30eec  packages/cli/dist/rpc/rpc-server.d.ts
```

Initial documentary lint correctly refuses four links into the still-ignored new receipt; force-track that exact file and revalidate, preserving `initial-docs.{log,exit}`. Final `make lint-docs` checks104 Markdown files/719 local links with no violation; matrix validation retains152 unique criteria,89 DONE/63 PARTIAL,CLI39/48,Web50/15 and the exact63-ID remaining checklist. Staged admission checks the exact20-path scope and source/image/staged hashes before commit; these green gates do not close either reproduced remaining counterexample.

Evidence prefix:`/tmp/aih-resource-discovery-*`; scripts, logs, states, failed inputs, exact source manifests and control records remain distinct. Local acceptance is not remote CI/public registry distribution, live-provider/device certification, deployment or whole-audit completion. No new browser run/certification is claimed for this Core/CLI-only policy.
