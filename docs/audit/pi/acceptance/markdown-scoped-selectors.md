# Literal Markdown declaring directories — acceptance

Date: 2026-10-15 UTC. Base: `8f21899ab6e239b41db5a5be18170186ce3e77c6`.
Decision/evidence: DEC-79 / E-AH-MARKDOWN-SCOPED-01 in [AUDIT-2](../AUDIT-2.md).

**Qualified scoped repair, not whole-audit completion.** Workspace/strict types, ten-owner zero-warning lint,228 focused,2,881 full units,35 parity and production Core/PTY/headless/HTTP smoke pass. No criterion closes from this subset.

## Scope and public compatibility

Seven product owners preserve literal declaring-directory identity rather than flattening it into Markdown glob syntax:

- Public readonly `ResourceFileSelector` is `{ pattern, baseDir }`. Additive `globalSkillSelectors`, `projectSkillSelectors`, `globalPromptSelectors` and `projectPromptSelectors` coexist with unchanged mutable string `*Paths` options. Legacy paths run before scoped records in the same layer.
- `resolveAgentResourceSelectors(resolved, 'skills' | 'prompts', homeDir?, scope?)` preserves settings-layer identity, markers, order and home expansion; it skips ineligible global/project settings. CLI print/JSON/interactive and RPC use it. Interactive reload reconstructs the manager; RPC retains its startup snapshot.
- Glob matching and pre-read search roots derive from the pattern alone, then anchor to the literal base. Relative explicit CLI strings retain literal cwd anchoring. Automatic roots are exact directories; validated package locations are literal file/directory paths, not a second round of glob authority. Directory-only requests never admit an existing file.
- ResourceManager snapshots each eligible scoped array's own entries and own pattern/base data fields before awaits; accessors/sparse entries are refused without invoking those getters. It requires an absolute base, nonempty/NUL-free strings, at most 512 requests per combined legacy/scoped layer and 32KiB per pattern/base pair. Fixed error: `Resource selectors are invalid or exceed their limits.` Project selector option fields are not inspected before project trust.
- Existing stable no-follow/single-link/UTF-8 body reads, strict skills, frontmatter, collision/provenance behavior, project/operator-root boundaries and exact/exclusion fixes remain. Existing traversal/count/body/aggregate limits remain separate. No shared-engine migration, sandbox, new trust grant, dependency, persistence/protocol schema, API major or bundle-budget change is implied.

`createAgentResourceLoader` receives the additive options through its existing ResourceManager option type. It stays passive: ResourceManager is constructed during explicit `load`, not during the SDK factory. The genuine installed consumer checks declarations, runtime, explicit SDK resource load and actual PATH bin.

## Criteria and remaining boundary

CLI-CFG-09 remains **PARTIAL** pending complete cross-resource reconciliation. The actual CLI/RPC declaring-directory defect is repaired through scoped records, but the legacy public string helper retains its ABI and absolute-glob ambiguity: a caller that flattens `agent[literal]` into `resolveAgentResourcePaths` and passes those strings cannot recover that literal base. Exact `+` or the new scoped API is required. The original public control is retained, not rewritten into a claim that the old API was repaired or an accepted gap. On the final production image, unchanged `/tmp/aih-markdown-scoped-base-control.mjs` still reads `UNREQUESTED BASE GLOB MATCH` from `agentl`, with no load errors: `aih-resource-scoped-legacy-control`, exit1/OOMfalse,2026-10-15T17:40:55.183083631Z–17:40:55.464852494Z,Node26.12.0. The separate scoped public/CLI probes pass; do not conflate the two interfaces.

**89 DONE / 63 PARTIAL / 152 (58.6%)**, no closure here. Broader configuration/startup/TUI, Server skill ownership, platform/device/vendor and remote release requirements remain separate.

## Tests and causal evidence

**81 added cases:**30 Core,50 emitted CLI and one genuine installed public consumer/bin.

- Core: four scoped ingress fields × bracket/question/star/brace declaring directories with real sibling bait; global/project/home settings, unchanged legacy string helper, literal automatic agent/home/project roots, relative explicit selectors, package file/directory paths, ordered exclusions/reinclusion, immutable construction snapshots, getter/sparse refusal, exact512 and byte/combined bounds, directory intent.
- CLI:42 actual print/JSON/RPC × skill/prompt × automatic/global/project/settings/relative explicit/global/project package routes; four refused-project cases; four real regular/fullscreen PTYs, each checking exact initial reads, catalogue, settings replacement, `/reload`, fresh exact read, refreshed catalogue and clean exit. A delegated FileHandle observer records actual temporary Markdown body reads: exact admitted files or zero before project trust, never sibling bait.
- Installed: real local Core/CLI pack/install outside the checkout, readonly positive/negative NodeNext declarations, mutable legacy path/string-helper compatibility, public Core/SDK runtime and actual PATH executable. Existing installed byte-integrity/protocol/type assertions remain unchanged.

Accepted base image `sha256:724c45d6b83e0f1c3887ed9ec0259dc097d15b9513ae59aec32a09fa875000ac` plus **only the final process leaf**: `aih-resource-scoped-complete-base-control`, **46 failures / four passes**, exit1/OOMfalse,2026-10-15T17:27:43.556485545Z–17:28:09.038332665Z. All42 admitted headless cases and four initial PTY body checks expose the old defect; four project-refusal controls pass. No product restoration, assertion, deadline, runtime flag, retry, golden or baseline weakening is used.

## Retained exploratory history

1. First rebuilt Core/CLI overlay passes five files/114 cases, including the first18 Core cases and96 conserved settings/boundary/resource cases. It is not final exact-image qualification.
2. First expanded strict test check fails TS2345/TS2322: fixture options were widened to optional cwd, and a throwing getter inferred void. Correct the new fixture's static types; no compiler strictness or product contract is weakened. Container exit2/OOMfalse.
3. Corrected exploratory run passes strict/lint and71/77 tests. Six package-skill assertions incorrectly expect the catalogue's directory path as a body-read filename; actual reads are its exact `SKILL.md`. Correct only that expected fixture path, retaining exact equality. All nine genuine installed tests pass.
4. First base process control reports42fail/eight pass. Review notices that four PTYs checked initial inventory names but not initial body identity; strengthen those tests to assert initial exact body reads. The final unchanged-product control then reports46fail/four pass. Keep both checkpoints; the earlier eight passes are not complete literal-base proof.
5. Final independent focused image passes all228 tests across11 files, with strict two-leaf types and ten-owner zero-warning lint, exit0/OOMfalse,2026-10-15T17:28:49.820906563Z–17:30:16.282370382Z. Earlier native SIGTRAP/null-exit failures in [boundary acceptance](./markdown-selector-boundaries.md) remain unexplained; this pass does not diagnose them.

## Exact inputs

Test image from final workspace typecheck: `sha256:cebdfbf0d46a550b8b35263f0cc0281d6a378c25f8e099b444ed77758a5f1e31` (Node24.15.0). Ten working-tree hashes match that image:

```text
f98e4aaf372512fdbd0d55df6390a6a7dde350f302c59529f8d949049eea3dad  packages/core/src/resources/resource-manager.ts
851057970fc8fb5c78ae18551f5af736d617b5b7a46784c7eafd1590e02b3d81  packages/core/src/resources/index.ts
145334c5164c0a13cfb0062f4427d011a588cfb4e14aa0ad607f8ccd621b635f  packages/core/src/resources/resource-scoped-selectors.test.ts
3b1530778f81c3e34ce56bbaefe7d6e7ceca51de630dd29120ee27b5efed911e  packages/core/src/config/agent-settings.ts
18d2d1985d4ae053e95fb9bad0831359c9f1c6bd2fbcae6cd9939d5c75243c9d  packages/core/src/index.ts
0e5937388b674e124e8701196e518aebda5264bd041f1ab02fd866e8a69fafb7  packages/cli/src/index.ts
c44a94ca51ae4a3d454acff14e7c9c49e8bc54f4d5ea5913baaec15ee13937e4  packages/cli/src/rpc/rpc-server.ts
ac288197fe7388ee2409d042728ee3c0c1860787717ee928518d3340b1306f14  packages/cli/src/resources/resource-manager.ts
f6a97f727607dffbe37336e6e9e6a8654d046461e381e35285ae458b13c0d05a  packages/cli/src/cli/resource-scoped-selectors-process.test.ts
d53db4d17512ff31be22028e8c08de9d24097f6095ef8b886e5bd89030d223ee  tests/functional-parity/installed-executable.test.ts
```

All eight pre-existing source owners independently match accepted Git base and control image:

```text
115e7d9473881aaa840fca9a102a5ef4ac27fdcc687bb399fee18dee89ed9efa  packages/core/src/resources/resource-manager.ts
7f476309c6bf0a769727bc0ba1173d76e3303c86f62a0f1c3231df8f37d753b1  packages/core/src/resources/index.ts
0b58e25d3c96b95f6cd39c4cabbb353982830c393644da005db552825ae3b9e7  packages/core/src/config/agent-settings.ts
96261dd43cedd0f01f93e3f86158600a460ff80cd01b3251c81cb82f528a3783  packages/core/src/index.ts
1cc7913485e82996c14a1f789ade6759b868f6140bdfa1c5dd62727095c44af1  packages/cli/src/index.ts
6c3ce92abb1235b8b750850c6b9a1f62a23ecab4a1b900226c0c3a01693b38d6  packages/cli/src/rpc/rpc-server.ts
1818bcecb4ad6379dcad2adfaa1729b85a5fc7783b3948232381e1972eba76d8  packages/cli/src/resources/resource-manager.ts
6e54fbb973f8d2e1d40d436cd93bfbe6a13e9950245693530fd83f02042f1730  tests/functional-parity/installed-executable.test.ts
```

Owning documents: AI project map/security topic, EN/FR user resource guidance and EN/FR SDK contributor guidance. Audit/receipt/completion changes are separately composed; Markdown is excluded from the Docker code context.

## Final gates and production

| Gate | Actual result |
|---|---|
| `make typecheck` | exit0; all workspace/public parity types,Node24.15.0 |
| Strict owning-test types and ESLint | Two new leaves,ten owners,zero warnings;exit0 |
| Independent focused |11 files/228 passed;exit0/OOMfalse;state timestamps above |
| `make test` |242 files/2,881 passed;exit0;reported duration547.52s |
| `make test-parity` |35 passed;exit0 |
| `make build-prod` |exit0;148KiB entry/159KiB eager gzip,17 JS chunks;unchanged budgets |
| Input/artifact identity |10 sources match final test image;8 originals match accepted base/control;14 emitted hashes equal test/production |
| Production smoke |exit0/OOMfalse,network disabled;Node26.12.0;46 new headless calls,four real PTYs/four reloads,public Core/SDK and prior smoke contracts |
| Documentation/whitespace/matrix | `make lint-docs`:102 Markdown files/703 local links,exit0;staged whitespace clean;152 unique IDs,89 DONE/63 PARTIAL,CLI39/48,Web50/15 and exact63-ID open checklist unchanged |

Final test image remains `sha256:cebdfbf0d46a550b8b35263f0cc0281d6a378c25f8e099b444ed77758a5f1e31`; production is `sha256:7283e1d009624428d24c55c35d7b314d16e33b3d7bca186b78b8afdd27e8a947`. Identical emitted SHA-256:

```text
29fc221af1a0438952bd826a91a0fcc3a3acc647a8276585f23ea096a0223373  packages/core/dist/index.js
fbd35906cf262ab8cc8cf7a3342b71b702a1a025ac9568eedf96cd6e2724c7c5  packages/core/dist/index.d.ts
7f31306e7f17188300ab639a68bd70f2bf754bb444a259ff5f5c6c0765b2792d  packages/core/dist/config/agent-settings.js
d8b50ff2887dfad172b5a5411d1bec1b5e42d9325dab1a984f4a442b0d687ab1  packages/core/dist/config/agent-settings.d.ts
83d8e6fb80dae63623bd49c297aef2e7951d1f640c924811d998a089968b5906  packages/core/dist/resources/index.js
9f560d7482aacb4807a5bb952978479d994516d323937048648e99af0e111407  packages/core/dist/resources/index.d.ts
43b7805ff85ec617b59a495ada5856ac530a9613f4bbcb6badb5e091b769beba  packages/core/dist/resources/resource-manager.js
0fc0245a8e677cdcf4c0ce3534ac4e6b7cbc879aae8af90c37bfdf9c4592f9f5  packages/core/dist/resources/resource-manager.d.ts
850514212e8dee913cd4de38780fcc4a35e581c5c43aa0e85c3cbfe98b3db691  packages/cli/dist/index.js
28f6febb9b51e593316bd49c125cf3170875188867bb71d4d4a43f01b274b964  packages/cli/dist/index.d.ts
6bfce412a228317fd084e0fbadce9e3ea7091bd441fe46729d3dcb0ac323d9c7  packages/cli/dist/rpc/rpc-server.js
6cf5f61eaa8cd7b132e7501f8407f5f18930ec1334517c77e90c8dc09da2385e  packages/cli/dist/rpc/rpc-server.d.ts
4d3fa5048a0522978232bbb6921d0bdf1717a6185bd31ca4d8afa1b4e608df36  packages/cli/dist/resources/resource-manager.js
a1583e4fad1c1a7765da0a9315d5ab2ccd18e04e07b9f3c0dc9e2d882eb3c202  packages/cli/dist/resources/resource-manager.d.ts
```

Production `aih-resource-scoped-production-smoke`:2026-10-15T17:39:59.991429139Z–17:40:54.468700214Z. New scoped evidence prints at17:40:22.179413625Z; previous30 headless/eight resource PTYs and theme/startup/module/native/manifest/TypeScript contracts pass. Explicit health/HTML/JS HTTP200 is observed at17:40:54.448015475Z. Retained watchdog probes fail before Server startup at17:40:02.590526442Z–02.691486963Z,17:40:07.693451405Z–07.779709969Z and17:40:35.295414347Z–35.400441528Z; captured state remains unhealthy,failing streak2. Later HTTP200 does not erase these probes or certify uptime. No new browser/device certification is inferred.

Local evidence prefix `/tmp/aih-resource-scoped-*`; original public legacy control `/tmp/aih-markdown-scoped-base-control.mjs`. Logs/states/manifests are local evidence, not published CI, physical-device, live-vendor or release acceptance.
