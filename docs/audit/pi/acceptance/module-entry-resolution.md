# Literal module-entry resolution and CLI-EXT-01 closure

Date: 2026-10-14. Base: `1a50a955daf4da083c405c32fb67fa139c1085e4`. Decision/evidence: DEC-75 / E-AH-EXT-ENTRY-01.

**Close only CLI-EXT-01**, after the complete clause mapping below. Matrix: 152 unique criteria, **90 DONE / 62 PARTIAL (59.2%)**. The user goal and extension API/lifecycle/UI/MCP families remain incomplete.

## Full criterion reconciliation

Criterion: “Discover and load TypeScript/JavaScript AiHarness extensions from user/project/settings/package/CLI sources with duplicate and trust rules.” Its earlier residual module-entry resolution is included, not discarded.

| Required clause | New or conserved implementation and evidence |
|---|---|
| JavaScript and TypeScript execution | Core shared `module-format.ts`, descriptor-backed `module-loader.ts`, pinned `typescript-module.ts` and `native-module-alias.ts`; seven executable formats, no declarations, real public host Core identity, captured-source/race checks and differentiated native/private transformed cache ownership. [Typed acceptance](./typescript-extensions.md) and [native acceptance](./native-core-aliases.md); their process/PTY/Server cases pass in the current full suite. |
| User/project/settings/environment/CLI sources | The existing 36-case typed source × mode × startup matrix includes all six sources (including actual installed packages). Ordered layer-relative settings selectors retain actual-file include/exclude/reinclude, literal metacharacters and configured agent-directory identity. Current main/suffix matrix adds 60 actual global/project/settings/environment/explicit × print/JSON/RPC × ordinary/contributed cases. [Selector acceptance](./extension-selectors.md) remains conserved. |
| Enabled package sources | Core `PluginService.getEnabledResourceLocations` / `getEnabledExtensionFiles` retain trust/scope/filter/dedup behavior; `plugin-service.test.ts` inventories all seven formats, excludes declarations, selects one typed file and rejects declaration-only installation. `typescript-extensions-process.test.ts` installs a real local package through public workspace/trust/package services and invokes its file through all headless/startup modes. Existing package resource globs remain actual-file filters, not another literal main resolver. |
| Directory/module entry resolution | Stable native/legacy resource manifests remain conserved ([manifest acceptance](./extension-manifests.md)). `readExtensionPackage` shares the held-descriptor reader with declared module-directory `main` resolution. Literal confined main targets precede indexes, with eight indirections and no malformed-main fallback. Missing requests have JS-first seven-suffix lookup and only `.js`→`.ts`, `.mjs`→`.mts`, `.cjs`→`.cts`, `.jsx`→`.tsx` output mappings. Existing files win; no new executable format, recursive resource-manifest interpreter, exports-only directory rule, implicit tsconfig alias or bare package-specifier authority is introduced. |
| Duplicate and ordering rules | Results use actual admitted absolute files, sorted/deduplicated before import. Core tests first load each missing output request **alone**, then independently verify request-plus-exact-source dedup on reload. Fifteen actual CLI mode/request cases likewise run request-only and dedup phases separately. Declared duplicates and outer removal/reinclude use actual paths. Existing JavaScript-first index priority is preserved. |
| Trust and negative discovery | Trust precedes metadata/body admission and rechecks resolved selection; untrusted project startup never reads malformed main metadata. Stable metadata identity/link/size/UTF-8 rules are reused. Unsafe fallback targets, main escapes/self/shape/string limits, declaration exclusion, exact eight-level and 10,000-candidate-probe boundaries refuse whole incomplete generations. A real Linux emitted-Core race replaces the **nested main** manifest between lstat and descriptor open; no factory runs. |
| Automatic discovery must not gain sibling file authority | Core records directory intent before normalization; exact selectors preserve trailing separators. Ordinary/contributed CLI, RPC and Server mark their configured automatic roots as directories. Missing `extensions/` never imports adjacent `extensions.ts`, and an explicitly directory-marked file cannot execute. Six actual CLI cases and Server startup/workspace switching protect this boundary; the intermediate seven-failure control below is retained. |
| Modes, reload and ownership | Existing and new genuine PTYs exercise selection changes only on reload, same-cwd refusal retention, recovery and owned option values. The emitted Server proves passive/unauthorized no-import, authenticated trusted reload, actual persisted tool results before/after main reselection, exact execute-function retention after an escaping main, and workspace retirement preserving `read`. Existing failed-workspace, alias disposal/rollback and typed helper refresh cases remain conserved. |
| Optional built-ins and suppression | [Built-in acceptance](./builtin-extensions.md) retains bounded virtual-ID policy and complete CLI-CFG-09 composition. New tests prove main resolution remains suppressed automatically under `--no-extensions`, while trusted explicitly selected duplicate directories still load once. This does not close separate Server/Web capability-switch composition. |
| Documented owned contract and compatibility | AI navigation/extension/CLI guidance plus EN/FR contributor/user guides specify supported formats, source roles, suffix/index/main precedence, actual-path filtering, bounds, directory intent and cache/privilege limitations. No persisted schema, public API major, golden or package dependency changed. Backend/CLI discovery does not add a visual surface; existing browser evidence is retained, not newly certified. |

The new leaves contain **136 cases: 49 Core, 86 CLI, one Server**. API-family §3.3 and CLI-EXT-02–07 remain PARTIAL: this closes loading/discovery, not all extension behavior or the entire audit.

## Qualified source and gates

Final source-qualified Docker image (Node 24.15.0):

`sha256:5960c5a1f399ba5e8e6ed61b6911aa3dbfee2f2479be00d44e7cd6a7115498fc`

Production image:

`sha256:20fb131db9930edef7e63d694fd9506e25ab2a27bab504d03fa9c44d5ac246a8`

Eleven current inputs match the final test image:

```text
cec56f96269b6599221304065a6648f40258c19d527f7357f9db5534679c2e89  packages/cli/src/cli/extension-startup.ts
3b6e95560eaa2b54ec8ee1ff7f7fc0a0139788c5b95c0101e9b9dbc13310946a  packages/cli/src/cli/module-entry-process.test.ts
3d13e0f84942ad411b8da99607d62df148bc3430bc5d4059f155408aca607dc9  packages/cli/src/index.ts
6c3ce92abb1235b8b750850c6b9a1f62a23ecab4a1b900226c0c3a01693b38d6  packages/cli/src/rpc/rpc-server.ts
0c820234f7a15deb589d3709fee5c25a416f49fc929a6360db9f7321f5071302  packages/core/src/extensions/extension-selectors.ts
0c655db3ffb15f45fb1351ee9104667edb14d4a8151b32b7c321e5e91a472ab0  packages/core/src/extensions/module-entry-resolution.test.ts
68a553d16d7b4ae44f8142ad12995fbb6433dc38e85c87f26ac506c545a523cb  packages/core/src/extensions/module-format.ts
25ee8bfeb3ef7fd665c4214544d0fe39265df3be4e0224f5d228b2d9ad2e4dd0  packages/core/src/extensions/module-loader.ts
8d62e1d4d7c08b5bf20561a727dd6cfed5d6ca0175b5ea0ae3cd4e754a43a0e4  packages/core/src/extensions/module-manifest.ts
a2a4576cd99bfaae76e814f8a7b9a68670b156a9da60df772c9c183505396dd0  packages/server/src/api/module-entry-process.test.ts
8d413c6bf8ecf49ba8c56f3ae21c4a0c5c6846cd92c08ffe613c685b8bf44862  packages/server/src/runtime/services.ts
```

All eight preexisting product owners match the Git base and causal-control image. Sixteen emitted JS/declaration hashes match between final test and production images:

```text
dc53985974c70986b2888067db70ae351341d7e84bc0ea4455d85be506367f36  packages/cli/dist/cli/extension-startup.js
7aa10e5fd1dec90c0166dbd479527530fd89e8d3d6fa0775a706ed45d221818a  packages/cli/dist/cli/extension-startup.d.ts
86d1049bb4175aad144979de2366365501ed315149c135b402ef5a9fcad1aec3  packages/cli/dist/index.js
28f6febb9b51e593316bd49c125cf3170875188867bb71d4d4a43f01b274b964  packages/cli/dist/index.d.ts
bb27df242ac311e123361ca0c919c8f4d1f4380cc03bf06cc3d379ee884f85e7  packages/cli/dist/rpc/rpc-server.js
6cf5f61eaa8cd7b132e7501f8407f5f18930ec1334517c77e90c8dc09da2385e  packages/cli/dist/rpc/rpc-server.d.ts
e8d39e3a1df27b5a82527db2d5cee0f6477ed37b98976e516ddd777d3750c29b  packages/core/dist/extensions/extension-selectors.js
fada331c78185a7d867ddbd4432c1c7acfdc241e06ca66afa24665d032d56aa8  packages/core/dist/extensions/extension-selectors.d.ts
94aff72f916f7b309851689942117b2d5497210cfbb14a9711769bcf6e6e7895  packages/core/dist/extensions/module-format.js
4ec24b1659eca81529c4a3821cc4d5221a0390c374a9b63714f4adebc19831e2  packages/core/dist/extensions/module-format.d.ts
1b13676aaedcd786fb272d6faeafe225b5cfdc7eaa8a7c79c6e09cdb373af020  packages/core/dist/extensions/module-loader.js
da0a149cbb3f71303bce0515d5712de82105ae46fbcb89c1975ec50337506897  packages/core/dist/extensions/module-loader.d.ts
392fa77b626c46addbbde6b4a3e542413c64c8374bf6e8caa49e7f923609c70d  packages/core/dist/extensions/module-manifest.js
1ea949fe55b45f65ac158ef9e5de77a8c2ee2fdab5cf510d285c755eedb64a4e  packages/core/dist/extensions/module-manifest.d.ts
e57905bc07974b3985d0f8ce3b77d089fe69ecafad26e070d811996e53e4ac59  packages/server/dist/runtime/services.js
68913e776ca5e28c29a47b8d0e4cb5d6cb9e107d90dab8e61ca7e86eb93ea236  packages/server/dist/runtime/services.d.ts
```

| Gate | Evidence |
|---|---|
| Workspace types | `make typecheck`, exit 0 |
| Owning strict/lint | Strict three-leaf NodeNext config, eleven-owner zero-warning ESLint, exit 0 |
| Final focused | **242 passed / nine leaves**, exit 0 / OOM false |
| Full units | `make test`: **233 files / 2,620 passed**, exit 0 |
| Public/installed parity | `make test-parity`: **32 passed**, exit 0; no golden updates |
| Production build | `make build-prod`, exit 0; unchanged 148 KiB entry / 159 KiB eager gzip / 17 JS chunks |
| Production runtime | Network-disabled Node **26.11.1**: seven suffixless formats, four independent output/source mappings and separate dedup, main precedence/reselection/escape retention, automatic directory conservation and real print/JSON/RPC. Preceding native-alias/manifest/typed smoke also passes; actual health/HTML/JS HTTP 200. Exit 0 / OOM false |

The short-lived smoke retains an image-watchdog unhealthy sample during its pre-Server CLI phases; timestamped output distinguishes it from the later explicit HTTP 200 checks. No long-lived service-uptime certification is inferred.

Local artifacts: `/tmp/aih-module-entry-qualified-{types,units,parity,prod}.{log,exit}`, `qualified-focused.{log,state.json}`, `{base-control,directory-control,production-smoke}.{log,state.json}`, `{owner,image,base-owner,base-image,test-artifact,prod-artifact}-hashes.txt`, owner/base/artifact path lists, strict config and production smoke. Exact-source hashes distinguish the final image from exploratory overlays; these receipts are not published CI.

Final metadata gates: documentation lint validates **97 Markdown files / 673 local links**, exit 0 (`/tmp/aih-module-entry-docs.*`); staged whitespace checks pass. `/tmp/aih-module-entry-matrix.log` confirms 152 unique rows, CLI 40/47 and Web 50/15, exactly one status change (CLI-EXT-01), and the exact 62-ID remaining checklist. Final source hashes remain unchanged.

## Reference reconciliation, controls and intermediate evidence

- DEC-74 retained source inspection and a Jiti probe distinguishing literal module targets from resource discovery. The expanded pinned Jiti 2.7.0 probe confirms **only** the four output/source mappings above: `.js`→`.tsx`, `.mjs`→`.ts` and `.cjs`→`.ts` fail. Exports-only and resource-manifest-only directories passed to Jiti fail; Node main/index and extensionless entries succeed. `/tmp/aih-module-resolution-reference-expanded.*` records the real Node 26.11.1 probe. This implements actual remaining entry conveniences without pretending arbitrary exports or recursive resource manifests are required/supported.
- Original `1a50a95` image `sha256:49a68b259517efde902b04e8f2cd92c28f8646102c8d4fd6d573d561f465f439`, overlaid with only the three current leaves: **118 failed / 18 passed (136)**, exit 1 / OOM false. Conservation passes include unsupported-map/declaration/nonexecutable refusal, ordinary-resource and automatic-directory behavior; a too-deep main also fails in the original because main resolution is absent, not because its new bound already existed. The nested descriptor race cannot reach its second manifest in the base, and retains that failed wait.
- Initial Core overlay passed **146 / six leaves**. Inspection found that CLI/Server automatic roots were also supplied through ordinary `paths`, so a missing directory could accidentally acquire sibling-file fallback. Reusing those exact intermediate Core sources with unchanged adapters and the new six CLI/one Server probes produces **seven failures / 80 deselected**, exit 1 / OOM false. The product now carries directory intent explicitly; current tests pass unchanged.
- Expanded overlay passed **242 / nine leaves**. Review strengthened the suffix fixtures: a request plus its exact existing source could pass even without fallback. Final cases first load the missing request alone, then separately prove deduplication. The source-qualified full/focused/control/production evidence above uses those stronger assertions.
- Initial/expanded logs, states and the exact intermediate Core source snapshot remain under `/tmp/aih-module-entry-{initial,expanded,directory-control}*`. No assertions, retries, deadlines, screenshots, goldens or bundle budgets were relaxed. Later success does not diagnose any historical compiler/browser/Rolldown/intermittent native failure retained by earlier receipts.

## Closure limits

This is the complete documented AiHarness loading/discovery capability, not upstream source compatibility, a Node sandbox or universal filesystem/OS behavior. Privileged dependencies and already admitted effects are not rolled back. Native caches are preserved; transformed TypeScript graphs refresh separately. Full extension event/context/UI/MCP/disposer contracts, other CLI/session/provider/Web criteria, physical devices and authorized remote publication remain open. No goal completion or remote action follows from this single criterion closure.
