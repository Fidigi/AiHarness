# Process-only offline startup — acceptance

Date: 2026-10-15 UTC. Base: `92864ced3c6c0edc479f2f4b06214bf323d23053`.
Decision/evidence: DEC-80 / E-AH-OFFLINE-01 in [AUDIT-2](../AUDIT-2.md).

**Qualified bounded capability, not whole-audit completion.** Workspace/strict types, sixteen-owner zero-warning lint,227 focused,2,932 full units,36 parity and actual production Core/CLI/PTY/HTTP smoke pass. No criterion closes:89 DONE/63 PARTIAL/152 remain.

## Scope and compatibility

Twelve product owners compose one explicit startup policy, without a global transport replacement:

- Strict reserved idempotent `--offline`, or trimmed case-insensitive `AI_HARNESS_OFFLINE=1|true|yes`. Other environment values preserve online defaults; `--offline=<value>` fails with `--offline does not accept a value.` before executable/credential admission. The CLI captures environment policy before trusted extension registration, then combines it with the **definitive** parsed flag, not the bootstrap's unknown-arity guess. A prompt token stays text. No setting/session field or wire banner is added.
- Startup scopes, `--list-models`, interactive `/model` and RPC catalogue/cycling use published/configured metadata without discovery. Core adds optional `CollectModelCatalogOptions.discover`; exact false skips discovery capability and model-list callbacks. RPC also skips an injected catalogue callback. Existing conservative availability/metadata remain; no live-only models or durable offline cache are invented.
- Core adds optional `ResolveProviderCredentialOptions.allowCommands` and `allowRefresh`. False denies a selected command before execution **and cached-value consumption**, without silently falling through to a lower-priority key. OAuth due for refresh under the unchanged 60-second window resolves unavailable without reading refresh configuration, fetching or saving credentials. Environment/static keys and usable OAuth remain eligible. Both policies default to existing behavior and do not revoke secrets, clear caches or change explicit later resolution.
- CLI initial/list/reload and RPC composition pass these policies explicitly. Interactive reload and extension environment mutation cannot change the captured process choice. Embedded `runRpcMode({ offline })` can explicitly override its environment default. Core itself does not infer policy from CLI environment variables; Server/Web defaults remain unchanged.
- This is **not a firewall or sandbox**. Explicit model turns with usable credentials, authentication/share/package actions, MCP preparation, tools and privileged extension/provider code retain ordinary authority and trust checks. No implicit update/version-check, download, dependency, persistence/protocol/API-major or browser feature is introduced.

The installed help fixture deliberately adds only the flag and environment lines; it remains an exact independently written string. Existing print/JSON/RPC goldens, version markers, assertions, compiler strictness, retries, deadlines, screenshots and bundle budgets are unchanged.

CLI-RUN-07 still needs complete startup/resource/display reconciliation; CLI-MOD-05 still lacks complete authoritative metadata and durable offline catalogue/cache coverage; CLI-SEC-07 still lacks complete warning/diagnostic/shell-alias/platform guidance. This scoped implementation is not an accepted gap for any remaining clause. The [completion review](./completion-review.md) retains all63 open IDs.

## Requirement-to-evidence map

**51 added cases:**6 Core,19 CLI policy/composition,25 actual emitted CLI and one genuine installed consumer/bin.

| Capability | Concrete evidence |
|---|---|
| Flag/environment/strict reservation and precedence | `cli/offline-mode.test.ts`:13 environment spellings, strict/idempotent/prompt/completion/reservation checks; actual flag/environment print/JSON/RPC and installed PATH bin |
| Passive published/configured catalogue and conserved online behavior | `providers/offline-policy.test.ts`, CLI startup/list helper tests, RPC injected callback with uncached requests; actual loopback GET counts in all headless modes and both terminal renderers |
| Command denial/cache/fallback without losing environment/static keys | Core real command marker plus positive execution/cache control; CLI runtime composition/reuse; actual headless/PTY startup/reload with configured command and synthetic encrypted credentials |
| OAuth no-refresh/no-mutation | Core memory/encrypted cases with zero fetch/config-getter access, exact encrypted bytes/descriptors and positive explicit refresh; runtime composition; actual loopback token POST and ciphertext-change online controls |
| Definitive contributed-option arity | Two real print/JSON cases keep `--offline` as user text after a boolean option, preserve initial environment policy despite extension mutation, and require real command/model/OAuth online work |
| Explicit operations remain possible | Three real local OpenAI-compatible chat streams, authorized extension HTTP and retained `read`/custom tool declarations while offline; default online controls remain exact |
| Real interactive reload | Six regular/fullscreen PTYs:flag/environment offline plus online controls; initial ready frame,`/model list`,`/reload`,fresh prompt and clean exit; extension deliberately mutates the environment the opposite way |
| Public compatibility | Actual Core/CLI archives installed outside checkout; strict NodeNext positive/negative boolean declarations, public ESM Core runtime and two actual PATH-bin calls; all prior installed byte/protocol/SDK/worker assertions conserved |

Process transport redirects only the two synthetic HTTPS OAuth/OpenAI-model destinations to real loopback HTTP; it never replaces provider construction, credential lifecycle, selection or payload generation. The delegated fetch tracer records attempts without headers/bodies and refuses other destinations. Offline cases require no attempts, no HTTP requests, no command marker and byte-identical encrypted credentials. No live vendor credentials or issuer certification are involved.

## Causal controls and retained failures

- Final original-product control:accepted image `sha256:cebdfbf0d46a550b8b35263f0cc0281d6a378c25f8e099b444ed77758a5f1e31` plus **only the final two new Core/process leaves**, `aih-offline-final-base-control`:22 failures/nine passes,exit1/OOMfalse,2026-10-15T18:29:45.674917231Z–18:30:16.689258008Z. Five Core/seventeen process cases expose missing policies; one Core/eight process conservation cases pass. The earlier29-case control records22fail/seven pass before the two definitive-arity cases were added.
- An intermediate implementation incorrectly captured the bootstrap flag. Frozen image `sha256:f9961399fa3a6e305dd978cd7be713c99261397f218df7a0cd2abda27a3146c1`, Main source `f34bb6595f4150e68a1adc3fae2088a1688ca8bfb949a457b4f8d54f9014ace1`:both definitive-arity cases fail on the missing command marker,23 deselected,exit1/OOMfalse,18:15:22.678363783Z–18:15:25.545454629Z. Final Main captures environment first and the definitive flag later; all25 emitted cases pass in final focused/global qualification. The first version of that RED additionally expected two print responses; the actual contract prints only the final response. Correcting only that exact expectation exposes the causal missing-marker failure in both modes; retain both checkpoints.
- Initial workspace/strict/lint pass then36/37 focused cases:the new absent-live-model fixture expected `/match/`, while the existing fixed diagnostic is `Model "local/live-only" not found.` Correct to that exact message, not a broader matcher. First process expansion passes46 cases; the subsequent four-file expansion passes58, including all ten installed tests.
- First independent image typecheck passes, but strict new-test checking exits2/TS2322 because the newly added static contributed-option descriptor omits required `extensionId`. Add that fixture field; no compiler/assertion relaxation. Final independent image passes workspace/strict types and all227 focused cases.
- Initial production probe exits1/OOMfalse before any capability runs,18:30:17.305134475Z–18:30:17.411753854Z:`createRequire().resolve('@ai-harness/core')` uses the unsupported CommonJS export condition. Keep package exports unchanged; place the corrected harness under `/app` and use actual public ESM `import('@ai-harness/core')`. Final production qualification below succeeds on the same product image with unchanged assertions.
- Historical native SIGSEGV/null/SIGTRAP/Rolldown and watchdog failures remain in preceding receipts. These passes are not diagnoses and do not erase failed controls or setup runs.

## Exact source qualification

Final test image:`sha256:9a82067701b7f8b374010b1557bfcf6cedba881c382f1bef8eccc7d58171847d`,Node24.15.0. All16 current sources match the image:

```text
96bc262bc24a18049ac24e35a2b9919fce9f3467c3c3f0a0e31b6b4eeca0eb51  packages/cli/src/cli/args.ts
f3fe4cc62c5dee196e9e8c3ee2f647cc302ef7f5b46ce9b2402e6fbc51419c30  packages/cli/src/cli/model-list.ts
072cc3a8b1b3e5203b58fd266880d406ae7d2f498c0ca6e2cf637bed894e5395  packages/cli/src/cli/offline-mode-process.test.ts
08297ced303828e3026057b9244ab67f8396f1f2af3c6e8ac6fc9bf20564c7db  packages/cli/src/cli/offline-mode.test.ts
a9d18e41dcc2fe044de7c8eb905d2ad270a176eda728ed706c307de0857e9714  packages/cli/src/cli/offline-mode.ts
a3171c24145668cde72c834db03775a778be43828912931fee57858c0543791d  packages/cli/src/commands/handler.ts
3ed615ab750961deec3346051f6cd4cd1c23593818651f715a33e954b9b6c5d9  packages/cli/src/index.ts
4dd8d8a82c8fdd0d205b46e22cf55c16b60d4b52283728da1378dc98ca13e3de  packages/cli/src/providers/configured-providers.ts
b029bbb472cc6e3c92802c611e96f2d61655648e72a23e9ace64e59c6aeeb102  packages/cli/src/providers/provider-runtime.ts
fdddcad09e457a081ee96a249892f70cb2bbd68ce34d671a7ad91d60e3d32017  packages/cli/src/rpc/rpc-controller.ts
9d637139460f796f0ace5ee89bed97a283c40a7552e38d5dc2345ed8b8084428  packages/cli/src/rpc/rpc-server.ts
9487aa8f5d1ab5bd34ab5658df9f242d05b0d95d6be5c2afd9a226d666c96d5b  packages/core/src/extensions/startup-options.ts
ea100f48394df8403f0101b6a34d29d7894e7225fcd5efcda3968b2d5810090c  packages/core/src/providers/credentials.ts
01f0adae78b84866a7ac013001ea0f300483bb6776f62b73550a6c13656dc431  packages/core/src/providers/model-catalog.ts
99fef4bdd0e9463bcf1dff37c2f15b6bdfe3413fbb80b74bbe0bca64aef3e1bf  packages/core/src/providers/offline-policy.test.ts
6a46e721570f4e6ee338332feb352c4dacfb92135c380a95ebbc8f20a6868377  tests/functional-parity/installed-executable.test.ts
```

Twelve existing inputs independently match accepted Git parent and the original control image:

```text
9c481729ca8abe5460b5d052c4253ead612bfb5fd3cb2c03627980eb4df1396d  packages/cli/src/cli/args.ts
b6cea0570f46ffb7ff32dfbd957d9f2207a0e55097bf915f308afffc4056faef  packages/cli/src/cli/model-list.ts
d5eed1bdba35d0f0adeb605cb2f8ab77b1263139214d426b502baa430c3f2e52  packages/cli/src/commands/handler.ts
0e5937388b674e124e8701196e518aebda5264bd041f1ab02fd866e8a69fafb7  packages/cli/src/index.ts
46cd0c610228ee5234d31ad25091c219f6183846ef6471bc6f00fbe41dec1363  packages/cli/src/providers/configured-providers.ts
82918782436fc8bcbe01f32db2d1f36f53f22381c8dfe15a55d233e4eb383539  packages/cli/src/providers/provider-runtime.ts
f2b9861118d13088e0c665a4bec23be2d332d751f31ae5c4a0d1a99a4d6a97b7  packages/cli/src/rpc/rpc-controller.ts
c44a94ca51ae4a3d454acff14e7c9c49e8bc54f4d5ea5913baaec15ee13937e4  packages/cli/src/rpc/rpc-server.ts
dd41ca10efd3cf820e5e6f19cd22912549829c4c01fd6ee93d9a47bbb4683b1b  packages/core/src/extensions/startup-options.ts
a36cde518d104ef93031c684f1783b749877e313d55df531832f9924e0d47d18  packages/core/src/providers/credentials.ts
74dbd753b26bc022894a765dda13652e3408aa7e4e51b1b8ee3e53de8dbb49a7  packages/core/src/providers/model-catalog.ts
d53db4d17512ff31be22028e8c08de9d24097f6095ef8b886e5bd89030d223ee  tests/functional-parity/installed-executable.test.ts
```

AI project map/CLI/provider/security topics and EN/FR user guidance own the documentary contract. Audit/receipt/completion deltas are separately admitted; Markdown is excluded from the Docker code context.

## Final gates and production

| Gate | Actual result |
|---|---|
| `make typecheck` | All workspace/public parity types,exit0 |
| Strict new-test types and ESLint | Three new leaves,sixteen owners,zero warnings,exit0 |
| Independent focused |14 files/227 pass,exit0/OOMfalse;18:18:40.877794185Z–18:19:41.575778593Z |
| `make test` |245 files/2,932 pass,exit0;566.82s |
| `make test-parity` |36 pass,exit0;51.26s |
| `make build-prod` |exit0;unchanged148KiB entry/159KiB eager gzip,17 JS chunks |
| Source/artifact identity |16 current/image hashes,12 parent/control hashes and28 equal test/production emitted hashes |
| Production |Node26.12.0,network-none,exit0/OOMfalse;public ESM Core,19 new headless cases,six genuine PTYs/six reloads,prior contracts and explicit HTTP200 |
| Documentation/whitespace/matrix | 103 Markdown files/712 local links;staged whitespace clean;152 unique criteria,89 DONE/63 PARTIAL and exact63-ID open checklist |

Production image:`sha256:37c124dca473a3f299db98fb4a455c3c1329819fc3751b3b12581ec34b9392bb`. Identical test/production emitted SHA-256:

```text
29fc221af1a0438952bd826a91a0fcc3a3acc647a8276585f23ea096a0223373  packages/core/dist/index.js
fbd35906cf262ab8cc8cf7a3342b71b702a1a025ac9568eedf96cd6e2724c7c5  packages/core/dist/index.d.ts
308dcf721f7ccdf788251899a58734e551d6cc7d77e5117585d5ba0645c351e9  packages/core/dist/providers/index.js
953c63a6bb2b647820c2992a97cc690a5af946b0b8e4bb78ad8ee5bcda2ce543  packages/core/dist/providers/index.d.ts
52ff554b57848895d5ee9c2ad80a054d741639b64a38ed4d40ae43ba796a6540  packages/core/dist/providers/credentials.js
1926a054154eeabeab8bc621070fbc3d0127975fbf85cda6e788f21139d01016  packages/core/dist/providers/credentials.d.ts
315be06d0b77cec279b4149258d66a6e645e96a68d855d5374dace6ad4a605ab  packages/core/dist/providers/model-catalog.js
ab114b24c3418ca3e8248c3070282559648e828b42e1585039453e43f58971b7  packages/core/dist/providers/model-catalog.d.ts
a4ede328f2a8182d0a36b349a1436ed2a5d2f5b6dfeee067d14ad0a795b6b83d  packages/core/dist/extensions/startup-options.js
3bb7ff50440774ca17f60a421e61e2b653996a96bfdf9871cf12256695ecae21  packages/core/dist/extensions/startup-options.d.ts
954c8b3f3efd4100cd77930d399e8f1203f99c70a30d1edd40ffb25122ed5f0d  packages/cli/dist/cli/args.js
a54edc328637da79062b90acda16304bf638659a387e77dd4fc6368726a824aa  packages/cli/dist/cli/args.d.ts
c58d1e8836c7a81841dc114a226a42e5fea2a53447e7971dcf21d982f86dfa96  packages/cli/dist/cli/model-list.js
08433331cd030455b9d7eb07c30c9201ff862c69ec76390d778ed0497a891823  packages/cli/dist/cli/model-list.d.ts
5f9840d1d1b6c21a0a3d6c9071e4e42ef51c4431cb3ef299f665c9495894c04f  packages/cli/dist/cli/offline-mode.js
e4b6438fe2a5658773ae4d863c121d3a18ef26fd588d1dd2581c56a0e908528d  packages/cli/dist/cli/offline-mode.d.ts
43238f5a86e7a6f0bb3edc1541958f9b7e90cd4e816275188d1edbed4e526ced  packages/cli/dist/providers/configured-providers.js
986f7bddd4e7d7ad514ee62666410f32bc36747faf672ef321cb1395fba716b0  packages/cli/dist/providers/configured-providers.d.ts
1f3de0abe21d71f48b855599caf408c5e2ed727337dcdca19b55bb536f6abf77  packages/cli/dist/providers/provider-runtime.js
75525f606f17b4a4d97dc5b2e769934a17562189d1ca26f20eee6793c4259156  packages/cli/dist/providers/provider-runtime.d.ts
6d338d5e69cd58a5b2521a9abb82a9b8d79e8e40760ac9528bd4cbee66354673  packages/cli/dist/commands/handler.js
c38bb88a7b1f82af302e9730aa1f2a3bc24b3482bbc556f41f7bfdab9c28e036  packages/cli/dist/commands/handler.d.ts
45a4506b6030dce2d242e9450208f3a80c8054587a5632d32cf2ff9eadacf28d  packages/cli/dist/index.js
28f6febb9b51e593316bd49c125cf3170875188867bb71d4d4a43f01b274b964  packages/cli/dist/index.d.ts
f8e3d718ab935d727f7dd088f5b498b155cc726899f55ab3882832debfe841fe  packages/cli/dist/rpc/rpc-server.js
03a8a0757daeeab90ada6c6610e55b9b69874e26161e2e127b0285b1aac30eec  packages/cli/dist/rpc/rpc-server.d.ts
07aee6f72cfd1c1faf3b2f89e160dfa4fb89cbb08001b1ff703c02696fedec36  packages/cli/dist/rpc/rpc-controller.js
b33583eb8125b62af602f538120d438f39c70bc84e21169df435f08f2087b363  packages/cli/dist/rpc/rpc-controller.d.ts
```

Final container `aih-offline-qualified-production-smoke`:18:31:37.861723648Z–18:32:43.045853363Z. New offline evidence prints at18:31:48.593108339Z; production additionally combines credential/OAuth suppression with `--list-models`. Prior scoped Markdown46-headless/four-PTY, boundary30-headless/eight-PTY, theme/startup/module/native/manifest/TypeScript probes pass. Explicit health/HTML/JS HTTP200 is observed at18:32:43.027626780Z. Four retained watchdog probes fail before Server startup at18:31:40.500369094Z–40.595693008Z,18:31:45.596163301Z–45.671937170Z,18:32:13.199766828Z–13.283290492Z and18:32:40.836716058Z–40.927722143Z. Captured health remains unhealthy,failing streak3; later HTTP200 does not erase probes or certify uptime.

Local evidence prefix:`/tmp/aih-offline-*`. Failed exploratory/setup/control states remain separate from final source/image qualification. No new browser/device certification, remote publication,deployment,live-vendor acceptance or complete152-criterion goal is inferred.
