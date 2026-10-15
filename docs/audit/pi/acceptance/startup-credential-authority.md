# Definitive startup credential authority and CLI-RUN-07 reconciliation

Date: 2026-10-15. Accepted parent: `3e23517e0ae2f07c1cd5ca6771878f647f28d140`. Decision/evidence: DEC-82 / E-AH-CREDENTIAL-AUTHORITY-01.

**Qualified CLI-RUN-07 closure.** The complete eight-clause reconciliation below and exact final gates pass:203 focused,248 files/3,032 units,48 parity and production. Close only CLI-RUN-07:90 DONE/62 PARTIAL/152 (59.2%),CLI40/47 and Web50/15. Other terminal/settings/provider/resource/session criteria retain their independent requirements; the whole goal is not complete.

## Defect and bounded repair

A real trusted extension registers a Boolean option. The bootstrap parser does not know its arity and may consume the next positional prompt. It can then interpret a later literal `--api-key value` as a credential. The definitive parser correctly retains those tokens as prompts, but the previous composition root had already registered the guessed value in the permanent redactor.

This has two observed consequences: ordinary prompt text and its encoded variants become `[REDACTED]`; if a genuine key occurred earlier, the guessed replacement can also prevent that actual CLI key from joining runtime redaction authority. New actual `before:provider` records reproduce both consequences on accepted code. Disposable fixture values are not production credentials.

The repair is local to CLI composition: snapshot environment plus bootstrap candidate in a separate **diagnostic-only** `CredentialRedactor`; use that combined snapshot for extension-startup parse errors. Register the CLI key in the long-lived output/provider redactor only after definitive parsing. Keep genuine environment/resolved credentials, encoded variants, strict syntax, trust-before-registration, prepared-generation ownership, offline capture, public versions and wire/session schemas unchanged. No Core redactor reset/enumeration API or parser grammar is added. Help/completion remain early metadata operations, not model execution.

## Requirement-to-evidence reconciliation: CLI-RUN-07

Criterion: “Support startup model, tool, resource, system-prompt, trust, offline, verbosity, and display options with validation and precedence.”

| Explicit clause | Owning implementation and direct evidence |
|---|---|
| Model and credential selection | Strict `cli/args.ts`; `providers/configured-providers.ts`; shared Core model resolution; actual `cli/invocation.test.ts` saved-scope/thinking/tool precedence and RPC processes; `cli/model-list.test.ts`, provider-runtime/RPC tests and installed bin. This batch repairs definitive CLI credential authority with literal/genuine/mixed, separator, Boolean/string arity and environment controls. Broader provider dialects/catalogue/default maps remain CLI-MOD requirements, not a missing startup flag. |
| Tool choices and precedence | Core tool selection/loadout and CLI/RPC composition apply saved defaults beneath explicit replacement/exclusion/no-builtins/no-tools, revalidate actual declarations and preserve reload. Existing CLI-TOOL-04 acceptance and real invocation/RPC tests cover the named startup policy; richer tool schemas and progress remain separate. |
| Resource choices and suppression | Qualified extension entry/alias/manifest/TypeScript/source/built-in receipts, theme sources, Markdown boundaries/scoped selectors/discovery policy. Actual all-headless, installed and genuine PTY/reload proofs cover explicit paths, automatic/settings/package sources, trust, ordered selectors and exact body admission. Legacy flattened public Core string ambiguity remains CLI-CFG-09; the CLI/RPC adapter uses the qualified scoped representation. |
| System/context prompts | Shared Core instruction/prompt loaders; real `cli/invocation.test.ts` “applies shared system and context prompts in print, JSON, and RPC modes”; literal/file replacement, repeatable appends, no-context, trusted project precedence and provider delivery are CLI-CFG-03/04's accepted contract. |
| Trust flags and precedence | Opposing flags refuse; overrides are process-only. Actual invocation tests exercise allow/refuse/global policy, no persisted override, hostile agent-directory placement and protected-resource interactive choice. Extension-loading/trust flags must precede contributed options; this documented owned syntax remains strict. |
| Offline | [Offline acceptance](./offline-startup.md): strict/reserved/idempotent flag and environment capture, authoritative parsing, actual automatic discovery/command/cache/OAuth denial, default-online and explicit-network controls, reload snapshot and installed consumers. Not a firewall or durable catalogue claim. |
| Verbosity | [Startup display](./startup-display.md): `--verbose` is strict/process-only, `-v` remains version; verbose wins over every quiet value, without changing settings or headless framing. |
| Display and validation | Same display receipt and [theme sources](./theme-sources.md): quiet/header/full, actual fullscreen activation, live restoration after input, trusted settings and CLI/environment selection precedence, reload without replay. Strict parser/mode tests cover invalid values/conflicts and redirected-stream behavior. Full editor/image/mouse/settings UI remain explicitly separate CLI-RUN-02/TUI/CFG-07 criteria. |

All clauses need their mapped positive/negative evidence and current integrated conservation. Names/serialization may be AiHarness-owned; no upstream source import or drop-in parser interface is required. No new residual may be silently dropped merely to close the row.

## Added permanent coverage

**37 added cases:** one parser conservation case,25 emitted process cases and11 genuine installed PATH-bin cases. The parser case compares bootstrap/definitive keys with and without an earlier actual credential. Process coverage includes16 print/JSON scenarios,three early-error secrecy cases,two RPC cases and four genuine regular/fullscreen PTYs with four reloads/fresh turns. Actual extension hooks capture provider-bound user messages; no message/parser/provider substitute is used.

- Ambiguous ordinary prompt bytes and raw/base64/base64url/hex/URI/JSON forms remain exact when not credentials.
- Separator, inline Boolean and string-arity controls preserve the existing input boundary.
- Real CLI keys before/after contributed flags and environment credentials still remove raw/encoded forms.
- Mixed real-key/later-false-key cases keep ordinary bytes while removing the real key; this catches both halves of the original defect.
- Early diagnostics preserve genuine-key masking with status2,empty stdout and exact stderr across print/JSON/RPC.
- RPC verifies actual stdin provider input and correlated success,not merely an acknowledgement or registry descriptor.
- PTYs require actual initial provider inputs,an `agent:end` witness and subsequent live editor frame,then reload,fresh input,another completed turn and exit0. Both ordinary-data and genuine-key policies must survive.
- Installed cases rebuild/pack/install genuine local archives outside checkout and invoke only the PATH bin. Six print/JSON,three diagnostic and two RPC children retain exact text/framing/secret assertions. No public API/schema/type change is implied.

## Frozen source/context identities

Four changed code/test owners:

```text
ff6698d948dfc259bf368fd90fbf49d697035d759228950e9dfd24c3e9346883  packages/cli/src/index.ts
9d876729b01146694369dfea1489630a3d9ac73680295b49fc4dfe7d64424701  packages/cli/src/cli/extension-args.test.ts
6f44fb2203914f2e896694ef868fa6cd85fb484185571e0006751e5b0825a3b9  packages/cli/src/cli/startup-credential-arity-process.test.ts
2aecc23d51c62b8fdb55a7486ab13ddf7b41906da7e1b2c0504eac4246c5e585  tests/functional-parity/installed-executable.test.ts
```

Four conserved context inputs,including nested SDK documentation that is **not excluded** by `.dockerignore`:

```text
bbe77eaa05a28d2899d1c5c002d24f835a10f952127d789fe1b372cf2bfccb64  packages/core/src/sdk/README.md
ea100f48394df8403f0101b6a34d29d7894e7225fcd5efcda3968b2d5810090c  packages/core/src/providers/credentials.ts
96bc262bc24a18049ac24e35a2b9919fce9f3467c3c3f0a0e31b6b4eeca0eb51  packages/cli/src/cli/args.ts
a3c1791b135130838b932072caf3dea4d2f731eee0e839ca1db5be99524f021b  packages/cli/src/rpc/rpc-server.ts
```

Three accepted-parent owners:

```text
a668e371867870fb83cf2c7aecfaa821eb42da18aca20afdae286c320a5adfa8  packages/cli/src/index.ts
edad1f2c9d0fda1a70c8440f1850df5a30f637c0116070ba5447f75e055ac7e2  packages/cli/src/cli/extension-args.test.ts
37dcaab95d7daa58fb9608d08766f5a0f40c30262f857add76b65a790b21f6c0  tests/functional-parity/installed-executable.test.ts
```

## Causal controls and retained setup failures

1. Original frozen six-process probe SHA256 `bbb26bf01575193a835ebdf4c610550cc0c5e9041cb434708531c4dea58f8e86` fails two literal cases and passes four separator/genuine controls on both accepted offline and accepted discovery images. Its exact sources/logs/states remain under `/tmp/aih-startup-credential-arity-*`; this was not introduced by the resource batch.
2. Initial permanent leaf on accepted code passes isolated compilation/lint but reports14fail/11pass. Six are the real defect; six print expectations incorrectly require every intermediate mock answer rather than the existing final-only output; two RPC expectations incorrectly assume concurrent prompts each force a separate provider call. Preserve initial source/hash/log/state. Fix fixtures only: one exact final print answer and one RPC prompt containing all encoded forms; no dispatch, deadline or retry change.
3. Corrected original-product control overlays only the two final test leaves on accepted discovery image `sha256:ce8c5355bdf6f0e3cd008159b9c094bdde5197c4776fbbe3a0d0dff1b2d0004e`: **six failures/26 passes**,exit1/OOMfalse,20:22:35.993412265Z–20:23:24.359564229Z. All four headless false/mixed and both ordinary-data PTYs fail;genuine/environment/error/RPC controls and parser cases pass. This exact control also exposes genuine-key variants remaining unredacted in the mixed scenario.
4. Initial repaired overlay passes strict new-leaf compilation,three-owner lint and32 cases/two files. It is exploratory proof,not final-image acceptance.
5. First frozen qualification passes workspace/strict types and four-owner zero-warning lint,then reports **one failure/192 passes** in11 files on image `sha256:957a3660423db22b43f2a208b8eb9f586bed2a53ab3058ead321e48158092cce`. The new installed test put11 serial children under one default5,000ms deadline and times out;retain source/hash/container/state (20:28:07.113364335Z–20:30:41.404668568Z,exit1/OOMfalse). Split into11 independent one-child cases with the **same default five-second limit**,same child deadlines and all original assertions. No timeout increase,retry or reduced scenario count. Production prerequisite guard refuses to run against that failure. Final qualification uses a fresh identity below;initial32/193-case evidence is not substituted.

## Final gates

Evidence prefix:`/tmp/aih-credential-authority-final-*`. Exact test image,Node24.15.0:

`sha256:c808258798406f5dafe32c6d5cdf3e353c978f12f1ac7832a62d20b1fb15e872`

Exact production image,Node26.12.0:

`sha256:f8307e215d4254c14a9fc5565cd6f7d1d554550f1e0048748734c386b000336b`

| Gate | Actual result |
|---|---|
| `make typecheck IMAGE_TYPECHECK=ai-harness:credential-authority-qualified` | All workspace/parity types pass; strict new-leaf NodeNext config also passes |
| Four-owner zero-warning lint/focused |11 files/203 cases,exit0/OOMfalse;20:34:47.309652839Z–20:37:26.301806632Z;reported170.01s |
| `make test IMAGE_TEST_RUN=ai-harness:credential-authority-qualified` |248 files/3,032 cases,exit0;start20:37:28,reported620.70s;image guard unchanged |
| `make test-parity IMAGE_TEST_RUN=ai-harness:credential-authority-qualified` | Two files/48 cases,exit0;start20:47:03,reported63.45s;unchanged goldens/image identity |
| `make build-prod IMAGE_PROD=ai-harness:credential-authority-prod` | Exit0;unchanged148KiB entry/159KiB eager gzip/17JS chunks |
| Production network-none smoke | Exit0/OOMfalse;20:48:33.449029847Z–20:50:32.163902294Z;new21-headless/four-real-PTY/four-reload actual credential proof at20:49:03.713Z |
| Original probe and accepted chain | Unmodified original six-process probe now passes all six at20:49:08.809Z. Discovery public Core/SDK/30-headless/four-PTY/four-reload,offline19-headless/six-PTY,scoped46-headless/four-PTY,boundary30-headless/eight-PTY,theme/startup/module/native/manifest/typed probes pass;HTTP health/HTML/JS200 at20:50:32.143545990Z |

Captured Docker health remains **unhealthy/failingstreak5**,with five exit1 checks and empty output. Retain recorded starts/ends exactly:20:48:41.167839432Z–41.246284304Z;20:49:08.774334816Z–08.869394712Z;20:49:36.395519042Z–36.481523685Z;20:50:04.020969080Z–04.110402045Z;20:50:34.111987424Z–34.192299771Z. The final recorded check's clock is later than captured process finish; preserve both records without inventing ordering or uptime certification. Explicit HTTP200 does not explain or erase the watchdog history.

Final legacy-flat control still fails deliberately,exit1/OOMfalse,20:50:32.884886808Z–20:50:33.151018943Z,reading `UNREQUESTED BASE GLOB MATCH` with no load errors. CLI-CFG-09 remains PARTIAL. This does not contradict the repaired scoped CLI startup adapter or close a broader resource API contract.

All18 following emitted hashes match test and production:

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
c14cd34c57dd426cc673bce1d624067a1d9dc9fd7a6ac5155b6e1603d7bf6cc8  packages/cli/dist/index.js
28f6febb9b51e593316bd49c125cf3170875188867bb71d4d4a43f01b274b964  packages/cli/dist/index.d.ts
adb721d008e8f1eb20c00daf09fc9bb2fc8a83fe6aaabb83c0b15a6b364fdb06  packages/cli/dist/rpc/rpc-server.js
03a8a0757daeeab90ada6c6610e55b9b69874e26161e2e127b0285b1aac30eec  packages/cli/dist/rpc/rpc-server.d.ts
52ff554b57848895d5ee9c2ad80a054d741639b64a38ed4d40ae43ba796a6540  packages/core/dist/providers/credentials.js
1926a054154eeabeab8bc621070fbc3d0127975fbf85cda6e788f21139d01016  packages/core/dist/providers/credentials.d.ts
954c8b3f3efd4100cd77930d399e8f1203f99c70a30d1edd40ffb25122ed5f0d  packages/cli/dist/cli/args.js
a54edc328637da79062b90acda16304bf638659a387e77dd4fc6368726a824aa  packages/cli/dist/cli/args.d.ts
```

Documentary/matrix/staged admission verifies the exact15-path scope,eight frozen owner/context inputs,three parent inputs,18 emitted hashes and the single allowed criterion transition before commit. Final `make lint-docs` passes105 Markdown files/727 local links;matrix validation allows only CLI-RUN-07's transition and checks the exact62-ID remaining checklist;staged whitespace passes. Whole-audit completion,remote CI,provider/device certification,publication and deployment are not claimed.
