# Quiet/header/full interactive startup — acceptance

Date: 2026-10-14. Base: `68d632656b07f151c7d2a2ff59e40187a140e804`. Decision/evidence: DEC-76 / E-AH-STARTUP-DISPLAY-01.

**Scoped delivery only.** CLI-RUN-07 and CLI-CFG-07 remain PARTIAL. The matrix remains **90 DONE / 62 PARTIAL / 152 (59.2%)**; no goal, browser/device, provider or release completion is inferred.

## Contract

- CLI `startup-display.ts` resolves validated `quietStartup`: absent/false shows the versioned heading, hints and initial status/resources; `"header"` keeps heading/hints only; true suppresses welcome and the initial snapshot. Process-only strict boolean `--verbose` wins over either quiet value. `-v` remains version, inline boolean values are refused, positional/`--` boundaries remain literal, and the long name is reserved against extension registration.
- Both renderers retain initial detail suppression across empty input, theme replacement and redraws. The first nonempty submitted line or positional initial prompt restores normal live status. Reload does not restart that presentation phase or hide ongoing status. Settings are not mutated by the flag.
- Fullscreen **enters its operational screen independently of welcome**. Quiet mode must not leave a running invisible editor. Its frame/editor remain visible; the heading uses the configured, control-filtered title and installed CLI version rather than a hard-coded renderer title. This is not an OSC terminal-window-title feature.
- Resource discovery/execution, project trust, diagnostics and provider behavior remain independent. Print/JSON/RPC do not gain welcome text. Actual emitted processes prove headless framing and quiet-mode warnings; saved project display settings apply only after trust.
- No schema, dependency, public Core major or browser surface changed. The installed exact-help fixture gains only the new flag line; all preexisting protocol goldens and assertions remain unchanged. An additional genuine installed-bin case compares complete print result objects with/without `--verbose`.

Reference behavior was checked in pinned Pi 1.0.0 `src/cli/args.ts`, `src/modes/interactive/interactive-mode.ts` (`shouldShowStartupHeader` / `shouldShowStartupDetails`) and `docs/settings.md`: verbose overrides startup quietness, while header-only retains version/hints but not details. AiHarness keeps its own bounded status snapshot, terminal layout and command names. Other renderer/settings and offline/startup capabilities remain open.

## New coverage

**39 cases:** 13 policy/parser/renderer cases; 25 emitted process cases (18 genuine regular/fullscreen PTYs, six headless mode/quiet combinations, one strict pre-discovery refusal plus warning case); one added genuine installed-bin case.

The PTYs verify all three quiet values with/without verbose, exact package version, active extension execution, empty-input conservation, later live status, trusted/refused project precedence, positional initial prompts, reload and normal exit. A real `agent:end` witness is required before accepting a later ready frame: fullscreen can render a ready frame **before** model execution, so an earlier ready substring is not a completion fence. Negative discovery checks use an actual top-level import marker, not merely absence of a provider call.

## Exact-source qualification

Test image (Node 24.15.0):

`sha256:18dcd2db2fd31ca47c01b475af6ecd74e1cd197f1e263cc733316e109b6ef9f0`

Production image:

`sha256:9857684d8d0fa2d3a2cfb38ed5fdcfc4ac7feb595f40400d2ce6c38fa38e173f`

Nine current inputs match the final test image:

```text
ed6f200f5dbc053400d5c455e79a868e1870a6b5e7f2927b4971a0912b2240fc  packages/cli/src/cli/args.ts
9016f720a48a507ab72ab5a42254d1ae623811e837368d8bef0c30407be6b026  packages/cli/src/cli/startup-display-process.test.ts
50579ca1f8a37f5cf2bd8460060cbab7e91df232c9837c6e14c61fff5c51b345  packages/cli/src/cli/startup-display.test.ts
053cfae8f2fc6f4a6c7827949633be5f72a9e0a5201a6fbfdfac773114676267  packages/cli/src/cli/startup-display.ts
66daaa45645851fe486b2ebe80c085e80dd7a0a386dcbf4716ea1fc4e66e990f  packages/cli/src/index.ts
1ce1b3a140830d33b3b4035c81ca212c6142844f58e6a0f2c7239c48acbc66d7  packages/cli/src/tui/fullscreen-ui.ts
c13edfc6b81adc806ec8f853482303c18965e2d194707b5cc4642eb4dd8e1062  packages/cli/src/tui/terminal-ui.ts
26c6b5bce5954c2aad2c3d91a03a2122b1929666b4fb6b41cbb164b914cac19c  packages/core/src/extensions/startup-options.ts
29f10f9f9af7f8e7b3697d2ebd83dbae521a7770ea5e7d724dfdefb9fa986a1c  tests/functional-parity/installed-executable.test.ts
```

Six preexisting owners match the accepted Git base and image. Twelve emitted JS/declaration artifacts match between test and production:

```text
6a111031bffa4033cec3f7dc3b53e75e06e84c1e8bf54065cb7e1abe7dbb4bff  packages/cli/dist/cli/args.js
0bed5d6a175c2879ad9e9bf48dad6eb138bd506d1e74eb7f0b63ea28a612bf2a  packages/cli/dist/cli/args.d.ts
bbc7c67814c8d5986ab7035bc01212a5d3b2130c86ca49b9ec754887f472b4e6  packages/cli/dist/cli/startup-display.js
36a48aa478f4f820b5f7851a3399b6f2853b3c46b3a4cc9d3aff353949754100  packages/cli/dist/cli/startup-display.d.ts
35f92d439d47005246129d7055bf62c7eae0db1ca11825358797be5d2d05e040  packages/cli/dist/index.js
28f6febb9b51e593316bd49c125cf3170875188867bb71d4d4a43f01b274b964  packages/cli/dist/index.d.ts
c5898aee20c47a40563cbb1a86410acd8d2bfb15fa86a205bf82d84695020f74  packages/cli/dist/tui/fullscreen-ui.js
a60a81e4697e0ed6d0fe4c633dd651d30f660297cb8062aec8df01d5e86bd540  packages/cli/dist/tui/fullscreen-ui.d.ts
428fe73845df89adf3b493ca83076a298c2caefa9c4d5331a93836384156ad55  packages/cli/dist/tui/terminal-ui.js
fa8fc3e75387495211b98453d4477c25c7c4d825c40c5fa06213f54ab1b7a5e6  packages/cli/dist/tui/terminal-ui.d.ts
178bc1da05bf37b0a5a05b742459dcb7daa14d7ef946d49a91f2a3e0e3f16ea0  packages/core/dist/extensions/startup-options.js
3bb7ff50440774ca17f60a421e61e2b653996a96bfdf9871cf12256695ecae21  packages/core/dist/extensions/startup-options.d.ts
```

| Gate | Evidence |
|---|---|
| Workspace types | `make typecheck`, exit 0, including public parity declarations |
| Full suite, independent final run | `make test`: **235 files / 2,659 passed**, exit 0; failed first run retained below |
| Public/installed parity | `make test-parity`: **33 passed**, exit 0 |
| Production build | `make build-prod`, exit 0; unchanged 148 KiB entry / 159 KiB eager gzip / 17 JS chunks |
| Owning checks | Strict two-leaf NodeNext config, nine-owner zero-warning lint and **133 focused cases / eight leaves**, exit 0 / OOM false |
| Production runtime | Network-disabled Node **26.11.1**, six real PTYs plus print/JSON/RPC and strict refusal; preceding module-entry/native/manifest/typed smoke and actual health/HTML/JS HTTP 200. Exit 0 / OOM false |
| Documentation/matrix/whitespace | **98 Markdown files / 677 local links**, exit 0; 152 unique rows, unchanged 90/62 statuses and exact 62-ID remaining checklist; staged whitespace and final source-hash checks pass |

## Retained failures and controls

- Initial overlay built Core/CLI, then its strict config failed with TS2688 because it was placed in `/tmp`, outside `/app/node_modules` type lookup. The identical config is now placed under `/app`; no type assertions or checks were removed.
- Expanded owning run: **17 failed / 114 passed (131)**. Sixteen fixtures incorrectly expected one extension although the registry also owns `builtin:workspace-tools`; source inspection justified the stronger exact two-extension snapshot. The negative parser fixture incorrectly expected exit 1 rather than the established startup-argument exit 2. Both expected values were corrected without changing product behavior.
- The next run retained **eight failures / 123 passes (131)**. Inspection found the real quiet-fullscreen activation defect and a separate fixture completion error: pre-turn fullscreen ready frames allowed commands to be sent while the provider was still active. Product screen entry is now unconditional; fixtures retain all assertions/deadlines and require the actual end witness followed by a later ready frame. The operational overlay passed **131 / eight leaves**; final sources add two positional-prompt cases and the installed-bin case.
- The first fresh full run retained **one failure / 2,658 passes (235 files)**: the unchanged `module-entry-process.test.ts` case `json: direct .js entry to .ts with exact-source deduplication` received child `{code:null,signal:'SIGSEGV'}`. Make exited 2. Twenty-five independent diagnostic repetitions of that exact existing case (**50 CLI subprocess invocations**) passed on the same source-qualified image without retries, assertion/timeout changes or engine flags. The later complete 2,659-pass run is **not a diagnosis** of the earlier native crash. Cause remains undetermined, alongside prior retained native/runtime failures.
- Original accepted image `sha256:5960c5a1f399ba5e8e6ed61b6911aa3dbfee2f2479be00d44e7cd6a7115498fc`, with only the current process leaf added: **22 failed / three passed (25)**, exit 1 / OOM false. The three conserved cases are regular fully quiet startup, its refused-project variant and regular positional input; this is not a control for the new internal policy helper.
- Isolated operational-screen control: the exact intermediate `index.ts` differs from the final file only by the unconditional screen-entry statement and its comment. Rebuilding that entry on the final image with the unchanged current quiet-fullscreen case gives **one failure / 24 deselected**, exit 1 / OOM false, at the absent initial prompt. The final 133-case run includes the same assertion passing. No browser screenshots, protocol goldens, bundle budgets or validation deadlines were relaxed.

The short-lived production probe retains a watchdog failure at 01:19:07.470–01:19:07.553 UTC, during the pre-Server CLI phases. Timestamped explicit HTTP 200 follows at 01:19:16.828 UTC; this is not long-lived service-uptime acceptance.

Artifacts are local `/tmp/aih-startup-display-*`: source/base/artifact manifests and hashes; `qualified-types.*`, failed `qualified-units.*`, successful `final-{units,parity,prod}.*`; initial/expanded/fixed/operational logs/states; `native-diagnostic.*`; pre-enter index snapshot, controls, strict config and production smoke. They are not published CI, external vendor, device or remote release proof.
