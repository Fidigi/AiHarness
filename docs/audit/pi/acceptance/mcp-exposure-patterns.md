# MCP original-name exposure patterns

> **Status: PARTIAL — implementation delivered; qualification FAILED** (2026-10-18)
>
> Narrow A3-CLI-02 subset included with this record (parent `6891e2d`); not whole-criterion or release acceptance. Global AUDIT-3 remains 1 DONE / 94 PARTIAL / 2 ABSENT / 2 TO BE DEFINED, with 98 open.

## Contract and boundaries

- `packages/core/src/mcp/config-inventory.ts::mcpToolExposure` checks an own exact original remote-name key first, then the first matching own `*` pattern in object property order, then server exposure/default `direct`.
- Only `*` is special (zero or more characters). Case/Unicode and other characters stay literal. Ordered literal segments avoid regex backtracking; existing 128-entry/256-character configuration-key bounds and runtime name bounds remain unchanged.
- Both explicit one-shot Test and persistent host consume this single policy before provider-safe namespace generation. Trust, presets, discovery and live/retired invocation checks remain independently enforced. Test invokes no tool.
- Web renders current config-keyed Test exposure for inherited tool rows, preferring own explicit overrides. No browser matcher, redacted-name authority, new API field or implicit session-SDK MCP hosting.
- CLI mutation syntax/field names and exposure modes do not change. The fixed value-free `tool-exposure` diagnostic now describes name/pattern keys in EN/FR; its typed code is unchanged. No golden/snapshot or public schema/version change.
- Broader MCP targetless inheritance, orphan diagnostics, policy migration and automatic SDK hosting are not implemented or accepted by this increment. Pending policy decisions stay pending.

## Differential evidence before qualification

All product tests run inside Docker based on parent `aih-a3-e2e-exit:full`; overlays are iteration evidence, not fresh-image qualification.

| Probe | Actual parent RED | Candidate iteration GREEN | Evidence |
|---|---|---|---|
| Core helper, 42 cases | 23 failed / 19 controls | Initial combined 79/79 | `/tmp/aih-a3-mcp-pattern-{red,green}.{log,exit}` |
| Real stdio, 5 cases | 4 failed / 1 control | Combined Core/Web 9 files / 146 passed | `/tmp/aih-a3-mcp-pattern-native-{red,green}.{log,exit}` |
| Emitted CLI/public Core, 10 cases | 10 failed with corrected fixture | 10 passed, Core rebuilt in container | `/tmp/aih-a3-mcp-pattern-public-corrected-{red,green}.{log,exit}` |
| Browser, whole exposure file | 1 failed / 7 controls | Fresh 8/8 | `/tmp/aih-a3-mcp-pattern-browser-red.{log,exit}` |

Vitest differential total: **37 causal failures / 20 controls** across 57 cases. Browser RED separately observes `direct` instead of canonical `deferred`; its existing details button and combobox resolve successfully. No existing test selectors, retries, deadlines, browser/runtime flags, snapshots or suite ownership changed.

### Preserved initial public fixture failures

Initial public RED failed ten cases; initial rebuilt iteration and diagnostic iteration each failed six conversation cases / passed four command/Core cases. The six shared failures are **not causal pattern evidence**. Captured provider declarations contained only ordinary `read`, `write`, `edit`, `bash`: the new fixture passed `--no-extensions`, which intentionally disables optional built-in MCP. `packages/cli/src/extensions/extension-loader.ts` and Core `extensions/builtin-extensions.ts` plus its existing explicit-selection control establish the precondition. The corrected new probe explicitly selects `-e builtin:mcp`, preserving automatic executable-discovery suppression. Identical corrected probes then ran against parent/candidate. Historical logs remain `/tmp/aih-a3-mcp-pattern-public-{red,green,inspect}.{log,exit}`; no product workaround or failed-gate substitution.

## Coverage

- Helper: four modes, exact priority independent of key position, first pattern not specificity, empty/absent-name compatibility, anchoring, repeated segments, literal regex/glob characters, Unicode/case, own/prototype keys and existing bounds.
- Native stdio: global/project locked→saved-allow boundaries, explicit Test metadata with zero effects, direct/discovery/call policy, original name versus provider namespace, first-match denial/exact grant, read-only filtering and config reload retiring old execution.
- Public probes: global/project atomic CLI `--tool '*'` writes, exact override priority, Test with zero effects; public Core real hosting/denial/reload/indirect calls; actual print/JSON/RPC loopback-provider declarations and one real allowed remote call, exit/channel/framing controls. Public Core host use is explicit, not a session-SDK capability.
- Installed leaf adds the same ten scenarios through genuine offline-packed Core/CLI, external consumer root and installed PATH-bin, with the controlled stdio fixture copied outside checkout. **All ten pass inside the failed fresh parity aggregate; no aggregate acceptance.**
- Web helper: canonical Test values, own explicit overrides and inherited-key safety. Browser checks inherited values and an exact-only write with focus retained. Bilingual diagnostic expectations remain strict.

## Frozen candidate and fresh qualification

Fifteen changed executable/test inputs frozen in `/tmp/aih-a3-mcp-pattern-sources.sha256`:

```text
08ac2459556d068e53681cc6c049ca9e30461efd46284e5fd774144d2b74b0de  e2e/mcp-exposure.spec.ts
00d2ecd2729e1cc7e1c62e79b292c987f53637959f71525db1a72bb6cf541804  e2e/settings-validation-locales.spec.ts
95f9aeb0774bac623b9e5589733de9e70dd1fc29bd3f30e50e2052311dcfcda2  packages/cli/src/cli/fixtures/mcp-pattern-probe.mjs
99131d65614c3e325417f14d27bf90e959626cd911fae4269c82cc2be5ffe394  packages/cli/src/cli/mcp-pattern-process.test.ts
c99457e3b568dd25b214efcddabb9e7acf91ff26db86e0027e77e70e5e9552fe  packages/core/src/mcp/config-inventory.ts
b2baffeef9aa1b59f7cc27a2ae1fa0c6edef744a08f2f00235ab4ad4130b271a  packages/core/src/mcp/entry-diagnostics.test.ts
074a2de349cd9eb96593f86d82659bfd1551207128c15d55e8b4a7e88781d7d1  packages/core/src/mcp/fixtures/test-server.mjs
ad37bc2966c7dbf0985e153f1942e754237392639bce28e0c0837c38020ba7bf  packages/core/src/mcp/tool-exposure-patterns.test.ts
4021df9f0f7d38c1a4aed81b60b097af51807ed500b67a7bd6deddb6a85d0a35  packages/core/src/mcp/tool-exposure-runtime.test.ts
c8ddee4a6436280265f40577978c80f77a473aa487e6a5cd5d737ac7cbc305ea  packages/web/src/components/McpSettings.tsx
47315368b2e347c18804a54ec30f98520fc0f36e996017eee62ee148bdc841b2  packages/web/src/components/mcp-entry-messages.test.ts
a3edf996eb64e2c7427c36d020d3f93475c5e20fcf16e3e87a205aa74f94bdc7  packages/web/src/components/mcp-entry-messages.ts
91b1a7643d9cc99a1e6466f4cecc431acc6e99d41d96c1db10ed7d0843ce0dd3  packages/web/src/components/mcp-tool-exposure.test.ts
d39f540b2f4d2a1679dfa8a635196187af325d991cf776828bcae1068a4e05d7  packages/web/src/components/mcp-tool-exposure.ts
cda489c0b9a78e48e6c8491f798a7e3823f61702da85b91bf731702201563c7f  tests/functional-parity/installed-executable.test.ts
```

The separately included SDK README remains `c34253aae578f995a8a1b9b62387deb8e65750b769b3db388524bab888935687`. All sixteen hashes match current source and actual fresh image `aih-a3-mcp-pattern:test`, ID `sha256:365623b96ef1a16e4c85cd1af432ec302544240dc80b45887414336129c93ba4` (`/tmp/aih-a3-mcp-pattern-image-source-check.log`). Root documentation is excluded from Docker context. Exact test-image runtime: Node v24.15.0 / V8 13.6.233.17-node.48 / Linux x64 (`/tmp/aih-a3-mcp-pattern-test-runtime.json`).

| Gate | Actual result | Evidence |
|---|---|---|
| `make typecheck IMAGE_TYPECHECK=aih-a3-mcp-pattern:test` | **FAILED**, Web `tsc --noEmit`: `Segmentation fault (core dumped)`, compiler/Docker 139, Make 2; preceding workspace checks completed | `/tmp/aih-a3-mcp-pattern-typecheck.{log,exit}` |
| `make test-parity IMAGE_TEST_RUN=aih-a3-mcp-pattern:parity` | **FAILED**, 126 passed / 1 failed, Make 2 / runner 1. All ten new MCP installed cases pass; the unchanged installed resource-discovery declaration compiler returns code null/empty output, and helper discards signal. No compiler cause inferred | `/tmp/aih-a3-mcp-pattern-parity.{log,exit}` |
| `make test-e2e IMAGE_TEST=aih-a3-mcp-pattern:focus E2E_ARGS='e2e/mcp-exposure.spec.ts'` | **8/8 passed**, Make/runner 0; not a replacement for either failed gate | `/tmp/aih-a3-mcp-pattern-browser-green.{log,exit}`, `/tmp/aih-a3-mcp-pattern-focused-e2e-artifacts/` |
| `make test IMAGE_TEST_RUN=aih-a3-mcp-pattern:full` | **FAILED**, 343 files / 5,160 tests pass, 1 file / 1 test fails; 833.69 s; Make 2 / runner 1. Existing `tool-json-process.test.ts`, `rpc/completions/invalid-text`: CLI child code null / SIGSEGV, empty stdout/stderr. All added MCP leaves and the complete 101-case installed leaf pass, without replacing prior failed gates | `/tmp/aih-a3-mcp-pattern-full.{log,exit}` |
| Fresh focused Vitest in `aih-a3-mcp-pattern:full` | **10 files / 156 passed**, 7.79 s, exit 0; all listed existing/new Core/Web leaves plus emitted public probe. Supplemental, not failed-gate substitution | `/tmp/aih-a3-mcp-pattern-focused.{log,exit}` |
| `make test-e2e IMAGE_TEST=aih-a3-mcp-pattern:e2e` | **FAILED**, 568 passed / 3 failed, all nine configurations; Make 2 / runner 1. Standard: 386 pass / 2 worker SIGSEGV failures (`visual.spec.ts:137:5`, `:413:5`). Demo: 7 pass / 1 `page.goto: Page crashed`, `ready` line 8, mobile-dark case line 180. Interactions 69, locale 8, workspace 11, pane 18, linked 43, title 2, progress 24 pass. Standard/demo command receipts code/status 1, signal null; seven siblings code/status 0, signal null; inner worker signals are separate evidence | `/tmp/aih-a3-mcp-pattern-e2e.{log,exit}`, `/tmp/aih-a3-mcp-pattern-complete-e2e-artifacts/` |
| `make build-prod IMAGE_PROD=aih-a3-mcp-pattern:prod` | **Passed**, Make 0, complete image `sha256:5f55fafc405ac04cff218e6adf15ba6e5d6614f4f21d833ba2ee0d715bbb0dca`. Runtime Node v26.12.0 / V8 14.6.202.34-node.39 / Linux x64. No earlier abort diagnosis or deployment/release qualification | `/tmp/aih-a3-mcp-pattern-prod.{log,exit}`, `/tmp/aih-a3-mcp-pattern-prod-runtime.json` |

A first launch incorrectly continued after its host-only manifest preflight failed (`python3` unavailable). That pre-freeze typecheck passed and is preserved in `/tmp/aih-a3-mcp-pattern-preflight-typecheck.{log,exit}`; it does **not** replace the subsequent failed frozen gate. Native SHA tools then froze the unchanged inputs before the recorded qualification chain. No cause is inferred for the native compiler failure; no source, runtime flag, budget or retry workaround. Parent nine-suite artifacts are preserved in `/tmp/aih-a3-mcp-pattern-parent-e2e-artifacts/` before focused replacement. Earlier production Server compiler abort and historical E2E failures remain unresolved; parent 570/570 does not qualify this candidate. Current native SIGSEGVs and the demo page crash are not attributed to MCP, Node version, each other or any memory/dispatcher cause. Production success does not waive the four failed gates. No release/deployment, remote CI, external-service or physical-device qualification is claimed.

### Full context identity limitation

Typecheck/parity/full and focused-browser builds use image `365623…`. The complete E2E build instead exports `sha256:0fd04a43966dc1250df27fbc43a66224c924bda575cdfc704656616235421d98`; all fifteen MCP inputs and the SDK README match the live container (`/tmp/aih-a3-mcp-pattern-e2e-source-check.log`). Inspection establishes that `.dockerignore` **does not exclude `.git`**: staging this acceptance record changed copied Git metadata, although root Markdown file bytes are excluded. The typecheck image's index hashes `cca9e32771f17aeb0b3d8a813a4db6579c8db5070ff265be981d17410ca47ea3`; the built E2E image's index hashes `ea450fd9bc37c6e4b44dd637c4b102e07eb7a7480502b2a9c3014e5dea081482`. Running Git commands additionally refresh the live container's index. A complete comparison of **2,186 non-Git/non-node_modules `/app` files, including emitted artifacts, is byte-identical** between both images: `/tmp/aih-a3-mcp-pattern-{test,e2e}-app-files.sha256` and empty `/tmp/aih-a3-mcp-pattern-app-files.diff`. These establish conserved product inputs/outputs, not unchanged whole build context. Full-context freeze was therefore not maintained across staging. Do not claim the same complete image identity or fully frozen aggregate qualification. No compiler cause is inferred. The serial chain has now settled and final source/SDK checks pass; staging can resume without changing the recorded gate inputs or results. A subsequent context/termination-evidence correction must retain these results rather than relabel them.
