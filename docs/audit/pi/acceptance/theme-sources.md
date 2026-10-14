# Bounded terminal-theme sources — acceptance

Date: 2026-10-14 UTC. Base: `9bb41a5c875be61b512579211eca63274859b2a1`.
Decision/evidence: DEC-77 / E-AH-THEME-SOURCES-01 in [AUDIT-2](../AUDIT-2.md).

## Result and boundary

The terminal-theme subset is qualified: metadata-only public Core discovery, ordered CLI sources, suppression, reload, exact active identity and private unknown-key diagnostics. No complete theme/keybinding/configuration or audit closure is claimed. This is not Web CSS, an RPC palette API, an executable loader or filesystem-wide snapshot.

**CLI-CFG-09 reopens**, rather than inheriting its DEC-71 closure: independent public-Core probes on both the accepted base and current images show that the unchanged Markdown resource manager interprets `+review[1].md` as a glob and loads `review1.md`. The theme/extension engine is not yet shared with Markdown discovery. Accepted built-in controls remain delivered; complete cross-resource exact-add semantics do not. Current totals are **89 DONE / 63 PARTIAL / 152 (58.6%)**. CLI-RUN-07, CLI-CFG-07, CLI-CFG-10 and CLI-TUI-10 remain PARTIAL.

## Delivered contract

- `discoverThemeSources` and readonly `ThemeSourceSelector` are exported from public Core. Own data fields are snapshotted before asynchronous work; selector-field getters are not called. Ineligible/project-refused sources are skipped before reading their pattern/base fields.
- Selection shares the existing extension engine without changing its 200-selector policy, asynchronous adapter or diagnostics. Literal declaring directories remain separate from patterns. Ordered include/glob, exact `+path`, exact/subtree `-path` and `!glob` act on actual candidates; later inclusion restores priority/provenance. Actual paths deduplicate, with highest priority first for the existing first-match theme loader.
- Discovery is metadata-only. Literal directories are shallow JSON catalogues; explicit globs descend. Linked/nonregular/non-JSON leaves are excluded; unsafe parents or metadata failures refuse the whole generation. Held parent descriptors and Linux anchored probes do not replace fresh palette-body admission.
- Untrusted project descendants and ancestor scans containing cwd remain blocked, including misleading source labels. CLI uses eligible global automatic/package/settings sources, then trusted project automatic/package/settings sources, then literal repeatable `--theme-source` requests. Settings resolve from their declaring directory, with home expansion. Package admission retains PluginService's actual trust/allowed-root policy.
- Selection is `--theme` → nonempty `AI_HARNESS_THEME` → trusted merged `theme` → `auto`. Strict `--no-themes` suppresses automatic roots/package admission/settings arrays, not built-ins, explicit sources or direct selected files, including a saved file selection. It grants no trust and disables no extension/tool.
- Interactive reload obtains a fresh catalogue. Discovery failure clears candidate authority while retaining the already rendered palette. Manual selection remains manual. Already loaded direct palettes may contribute active metadata without another body read or future discovery authority, with current project trust reflected.
- Active identity is an exact path, not a display name. Inventory loads the real absolute file even for builtin-looking names such as `dark.json`. Explicit admitted paths retain their source provenance; homonymous palettes are not both active.
- Unknown palette color/export fields produce `Unknown theme color token.` / `Unknown theme export token.`, never their private field names or terminal controls. Existing schema, body/color/variable validation and limits remain.
- Print `/theme` is still literal model input. JSON/RPC framing remains pure; RPC accepts flags but does not compose a terminal palette renderer or reload API. New long flags are reserved against extension shadowing.

### Bounds

At most 1,000 source requests, 32 KiB combined pattern/base bytes, 32 KiB resolved candidate paths, 1,000 intermediate selected files and **512 final custom candidates**. Overflow refuses rather than truncating a suffix. Glob traversal retains 256 directories, 1,000 entries per directory, 10,000 aggregate entries and eight levels. Shallow discovery separately limits 256 directory scans, 1,000 entries per directory, 10,000 aggregate entries and 10,000 candidate probes; repeated work counts again. These are **separate** glob/shallow counters, not one combined 10,000-entry allowance. Palette reads retain 256 KiB/single-link stable regular file, 256 variables and 128 color tokens. One already loaded active palette outside discovery may be displayed without adding read authority.

## Tests and controls

62 added cases: Core theme discovery/identity/privacy **22**, CLI parser/composition **7**, emitted CLI/PTY **32**, genuine installed package **1**. Existing extension selectors, module-entry resolution, palette/renderer behavior and installed cases are conserved. Final focused run: **8 files / 165 passed**.

Coverage includes readonly public declarations and frozen inputs; a FileHandle-read observer proves discovery reads zero palette bodies before ThemeManager loads; descriptor/accessor/snapshot behavior; exact/glob/remove/reinclude and literal bases; precedence/dedup; refused trust/ancestor scans; symlinks/hardlinks/directory intent; exact 512/256/10,000-entry/10,000-probe boundaries; real palette identity; fixed private diagnostics. CLI proves all seven source types in both real regular/fullscreen PTYs, actual package installation under authorized cwd, discovery/settings refresh, explicit/saved-file suppression, same-name identity, selection precedence, refused project inputs and independent extension imports. Installed PATH-bin behavior uses a genuine PTY, not an imagined headless slash command.

Original-source control: container `aih-theme-sources-base-control`, accepted startup image plus **only** the unchanged current 32-case process leaf. Reported **26 failures / 6 passes**, exit1/OOMfalse, `03:13:15.335528655Z–03:16:29.319202410Z`. No candidate product overlay. Failures include absent flags/catalogues, provenance/identity and private diagnostic behavior; conserved package/headless paths are not claimed as new.

Privacy control: `aih-theme-sources-diagnostic-control`, first-qualified pre-fix image plus the new unchanged privacy case: **1 failure / 31 deselected**. It reproduces the private palette key/control in stderr; the fixed diagnostics pass Core and actual CLI cases.

Cross-resource reconciliation: `/tmp/aih-markdown-literal-reference.mjs` constructs two synthetic prompt files with distinct valid frontmatter names/content. Public `ResourceManager({globalPromptPaths: ['+' + literalFile]})` returns `bait` from `review1.md`, not `literal` from `review[1].md`, with zero load errors. Both `aih-markdown-literal-base` and `aih-markdown-literal-current` fail the unchanged exact-name assertion, exit1/OOMfalse, Node24.15.0. This is a reproduced pre-existing defect, not a theme regression or an accepted exception; it reopens CLI-CFG-09. Scripts/logs/states are retained locally, and the Markdown owner is unchanged in this batch.

## Final qualification

Test image: `sha256:feab08f193b26dc869dfaea7f3da08f5ed49bf37e6b2af5c5c22747ea8617f23`.
Production image: `sha256:bde5fe7632641b704fa23f081d044628aa3ef3757bf0eae9b7ad1e19ff543995`.
Base control image: `sha256:18dcd2db2fd31ca47c01b475af6ecd74e1cd197f1e263cc733316e109b6ef9f0`.

| Gate | Actual result |
|---|---|
| `make typecheck` | exit0; workspace and public parity types |
| Strict new-test types | Three new leaves, unchanged strict options; exit0 |
| Owning ESLint | Fourteen product/test owners, zero warnings; exit0 |
| Independent accepted focused run | 8 files / 165 passed; exit0/OOMfalse |
| Final `make test` | 238 files / 2,721 passed; exit0 |
| Final `make test-parity` | 34 passed; exit0 |
| Final `make build-prod` | exit0; existing bundle budgets unchanged |
| Production Core/PTY/headless/HTTP smoke | Actual Node26.11.1, network disabled; exit0/OOMfalse |
| Source/artifact comparison | 14 current input hashes match test image; 8 existing base inputs match accepted base; all 20 emitted JS/declaration hashes match test and production |
| `make lint-docs`, staged whitespace | 100 Markdown files / 691 local links; exit0; no whitespace errors |
| Matrix/completion reconciliation | 152 unique rows,89 DONE/63 PARTIAL; only CFG-09 reopened; CLI39/48,Web50/15; exact63-ID open checklist |

The installed help expectation adds only the two new documented flags; no existing golden assertion, screenshot, deadline, retry, type strictness or bundle budget is weakened. No browser sources/baselines or dependencies/lockfile change; historical browser evidence is not a new browser certification.

Production container `aih-theme-sources-production-smoke` runs `03:12:25.712407011Z–03:12:44.661090526Z`. New public metadata/trust/count/identity checks pass, then **six actual theme PTYs, two reloads, three headless modes, strict refusal and private diagnostics** pass at `03:12:30.255520824Z`. Previous startup/module-entry/native-alias/manifest/TypeScript smokes also pass. Explicit health/HTML/JS HTTP200 is observed at `03:12:44.643843307Z`.

The retained Docker watchdog sample fails at `03:12:30.785259939Z–03:12:30.858770247Z` while the script is still running CLI probes before starting Server. Container health remains `unhealthy`, failing streak1. The later explicit HTTP200 does not erase that sample or certify uptime.

## Failure history (retained, not rewritten)

1. Initial exploratory Core test omitted required palette `appearance`; add the valid field, not relax schema validation. Existing selector/module-entry cases stayed conserved.
2. Expanded actual-package cases initially placed packages outside the CLI's allowed cwd. Four cases failed. Fixtures now install genuine packages under the authorized trusted cwd; product allowed roots/trust are unchanged.
3. Operational tests incorrectly expected `/theme` dispatch in print, which correctly returned `[Mock AI Response]\n`. Tests now use actual PTYs for interactive assertions and retain exact literal-prompt headless output.
4. First fresh whole gates passed **238 files/2,718 units and34 parity**, before the private-key defect was added/reproduced. Test image `sha256:06e3b1c39f3cba1c7ad938717a60a32b2d9445483c5a524c8691fa1d75f55ba8`; production `sha256:8882bba83dcde45b8af5c8c14e6c68f7af1146d6615870ec9d159ac22c3156f7`. Those are not the final privacy-fixed images.
5. Privacy RED above requires the product fix; two Core cases and one process case raise the full total to2,721.
6. Final-image initial focused run passed strict types/lint but had **1 failure / 164 passes**: installed public declaration compiler child returned `code:null`; its signal was not captured. Container exit1/OOMfalse, `02:27:17.228873894Z–02:28:16.484475136Z`. Cause remains **undetermined**.
7. Five independent diagnostic invocations of that installed case each pass1/deselect7. A child-close observer records50 exits, including5 compilers, with no abnormal exit. These passes do **not** diagnose the preceding null exit or justify changing compiler/runtime/assertion policy. Final complete Make gates and separate165-case acceptance pass independently.
8. The Markdown exact-add RED above remains an open capability, despite all final theme/global gates passing. Earlier native crashes and failures remain in preceding receipts; no repair is inferred here.

Local evidence prefixes: `/tmp/aih-theme-sources-{initial,expanded,fixed,operational,qualified,final,accepted,diagnostic,native,base,production}*`, `/tmp/aih-theme-sources-child-exits.jsonl`, `/tmp/aih-markdown-literal-*`. Driver `/tmp/aih-theme-sources-accept-qualify.sh` records independent command statuses. Logs, states, scripts and hashes are local evidence, not published CI or remote release artifacts.

## Exact inputs

SHA-256; documentary changes are separate from the Docker code context.

```text
9c481729ca8abe5460b5d052c4253ead612bfb5fd3cb2c03627980eb4df1396d  packages/cli/src/cli/args.ts
e0a620e832466a369b94cdb61705020de1f7ab19c908b7b81e06b9f16dce3b91  packages/cli/src/cli/theme-sources-process.test.ts
015647b7db91d11133a951bcabe0d07c8c6f1429bfffa20f56c2c3933bf742a9  packages/cli/src/cli/theme-sources.test.ts
0f4040acd4131e8b501af301195f5d8f0fc22429c0a2f212b69d4bc1f46d1383  packages/cli/src/cli/theme-sources.ts
d5eed1bdba35d0f0adeb605cb2f8ab77b1263139214d426b502baa430c3f2e52  packages/cli/src/commands/handler.ts
1cc7913485e82996c14a1f789ade6759b868f6140bdfa1c5dd62727095c44af1  packages/cli/src/index.ts
ea646aad2aa4b8a1c9f17e21b7a615ffe49191f97af42b46962ae19a1b29df32  packages/core/src/extensions/extension-selectors.ts
dd41ca10efd3cf820e5e6f19cd22912549829c4c01fd6ee93d9a47bbb4683b1b  packages/core/src/extensions/startup-options.ts
78dac5efaabebe1ef4597e20a57862e32d1ff0b8dd4b7f28567a911c203326a2  packages/core/src/resources/file-selectors.ts
9217abe1ee4816e212c4c58f6194104344d22f8e19500a87f0cd1fb2de134dbd  packages/core/src/themes/index.ts
7041a9c220a8b1ef873fd2c0cc24440b4d96eed4b4ab288f84b1d1fe0648bc7e  packages/core/src/themes/theme-manager.ts
18a18023ffa698b53d560cdf5bd6d9327fb3ea87d7ec6e78cf554453d8ad2c07  packages/core/src/themes/theme-sources.test.ts
bff4cb7705756abd03e4214644a74a4c7d61f329326ee3f98bf066039b4be870  packages/core/src/themes/theme-sources.ts
6e54fbb973f8d2e1d40d436cd93bfbe6a13e9950245693530fd83f02042f1730  tests/functional-parity/installed-executable.test.ts
```

## Identical emitted artifacts

```text
1bd9496afebb96c5b652794405a812f5853fa13e6c17c2421c5f633f4de340e5  packages/cli/dist/cli/args.js
1ea3331dd844970265ae2cb013d0963058a8ccea38dcd66e01daf059d0da8c1d  packages/cli/dist/cli/args.d.ts
0af4e9e0f91a5eb3497790f7d09f0e0f4ebf211b5ef7cb81eaa1e480d9227989  packages/cli/dist/cli/theme-sources.js
544483090ac25a31be8ed35c068ac3202208e42a62cafa6a56fd0321766ac28a  packages/cli/dist/cli/theme-sources.d.ts
3db2c88b50eab0731b772bcc0c54c29e0fbdf2e4e4a8019d7719516b748f5ec4  packages/cli/dist/commands/handler.js
b341c1832fa6017cb9703c133566e9d53ee6aa29e37db57733025af632a845b8  packages/cli/dist/commands/handler.d.ts
e10ac1556c7727753b1584026e526d2fd72fd2628488ca1831ae6b17a3e7b318  packages/cli/dist/index.js
28f6febb9b51e593316bd49c125cf3170875188867bb71d4d4a43f01b274b964  packages/cli/dist/index.d.ts
cb109443708cd4e05008ec9f4acd9c53581ba4172dc55e7bc35f819fa0e5edb6  packages/core/dist/extensions/extension-selectors.js
4169b0b479584ae1d8b0cb0c8c94d42af508427e4a89dc1b32d21aab9532df89  packages/core/dist/extensions/extension-selectors.d.ts
7d1cc91969b4a95e9e4f87aa16f073608503745e1dc184656797bd9ac6295f65  packages/core/dist/extensions/startup-options.js
3bb7ff50440774ca17f60a421e61e2b653996a96bfdf9871cf12256695ecae21  packages/core/dist/extensions/startup-options.d.ts
91ab49c5eb035f09359e6e8c62cf92003cddc5dae56c141bf3713fa0274406ba  packages/core/dist/resources/file-selectors.js
22200d86748fb8f7e923061b20b6bcf806934c2777948834911d5ef4f965fb6b  packages/core/dist/resources/file-selectors.d.ts
2ed67a7b3cf308460a1391f93dc3d61d02ea9868d561038fec124286969ae19a  packages/core/dist/themes/index.js
3fe4b522c587d8a3fd45931c6785750ad52dbad25eb037bbebba394b8381fc49  packages/core/dist/themes/index.d.ts
bf9f08a7a3996f7b2762716a715818f2a731c9e2bb2167fe786a5cfa92defa04  packages/core/dist/themes/theme-manager.js
c356c4e4a1dbb1a1ec12f5e0fa41ecd399a43c7cec3333dce78612c5bc453e13  packages/core/dist/themes/theme-manager.d.ts
5f0ca660cffe73ca98d1c5d2a7ddf7774033b445a391f58604a6065320e5f414  packages/core/dist/themes/theme-sources.js
0128ae5c2be3f3d6277892781db49af77842f5bc56bf8c07723f65e56e882a26  packages/core/dist/themes/theme-sources.d.ts
```

## Remaining acceptance

Markdown exact-add/literal-base and complete cross-resource selector reconciliation; remaining startup/offline/configuration behavior; complete keybindings/hotkey view and theme/TUI schemas; all other63 open criteria in the [completion review](./completion-review.md). No remote publication/deployment, authorized live-vendor acceptance, physical-terminal/mobile certification or goal completion is claimed.
