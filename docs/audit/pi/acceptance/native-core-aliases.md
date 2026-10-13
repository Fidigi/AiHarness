# Native JavaScript host Core identity — acceptance

Date: 2026-10-13. Base: `d7ec9ad92a1644de75e1985e34a64271564dc383`. Decision/evidence: DEC-74 / E-AH-EXT-ALIAS-01. Qualified scoped delivery, **not audit completion**. CLI-EXT-01 remains PARTIAL; 152 unique criteria / 89 DONE / 63 PARTIAL, 58.6%, unchanged.

## Requirement-to-artifact mapping

| Requirement | Implementation and direct evidence |
|---|---|
| Actual host public Core identity in native JavaScript | Core `extensions/native-module-alias.ts` aliases only `@ai-harness/core`, from admitted native entry/dependency contexts. Three actual emitted `.js`/`.mjs`/`.cjs` cases compare real host classes across static, dependency and late imports outside the checkout, with another local Core package already cached. Private subpaths and unrelated importers retain ordinary resolution. No CLI/Server/UI-library aliases or public API/version changes. |
| Keep native cache identities and external resolver ownership | One contextual Node resolve hook plus owned-caller `Module.prototype.require` adapter. CJS same-directory fast-cache dispatch otherwise precedes hooks. No cache entry or cached module object is deleted/replaced. Two cached transitive ESM/CJS cases preserve actual namespace/cache object identity through full retirement/reacquisition. A preexisting virtual require adapter, a later foreign wrapper and a foreign Node hook survive repeated generations. Host implementation graphs are excluded, including explicit absolute Core requires; a read-count observer proves their cached children are not traversed. |
| Complete candidate and factory lease ownership | `module-loader.ts` acquires only after descriptor admission, retains temporary leases until whole-candidate registration/refusal and releases all candidates in `finally`. Wrapped factories acquire independent active leases, kept through awaited cleanup and restored on rollback. Direct registry unload, multiple loaders, failed import/factory/cleanup, abandoned candidates and a real pending-import continuation are exercised. Descriptor/race and preceding typed/manifest tests remain conserved. |
| Bounded bookkeeping, not an unbounded native cache mirror | Per graph: 1,000 URLs / 32 KiB per URL. Active process: 10,000 contexts / 20,000 owner associations. Retained URL metadata: 10,000 parents / 20,000 edges / 16 MiB edge bytes. Cached CJS traversal: 1,000 nodes and children per node. Overflow gives `Extension module resolution exceeds its limits.`. Tests independently exhaust graph size, URL/retained bytes/edges, promptly retired parent metadata, active contexts and associations, then verify partial-admission cleanup. Three global-bound cases access the emitted internal helper; they are not new public API claims. |
| Actual CLI modes, startup options, trust and terminal reload | CLI `cli/native-module-alias-process.test.ts`: 18 native-format × print/JSON/RPC × ordinary/contributed startup cases; three refused-project modes; two genuine five-prompt ESM/CJS PTYs. Real provider hooks verify the host identity, option values and ordinary `read`; entry refresh, failed candidate retention and recovery coexist with intentionally unchanged native helper cache values. Cleanup imports retain Core identity. |
| Actual Server composition and invocation | Server `api/native-module-alias-process.test.ts` starts the emitted authenticated server outside the checkout. Project code is absent before trust, then HTTP reload registers a native tool; a real agent run invokes it and persists `true` for actual host/static/late namespace equality. Direct registry unload awaits the author cleanup and removes its tool. The provider stream is controlled, not a live-vendor claim. |
| Public operational contract | AI navigation/extensions/CLI reference and EN/FR contributor/user guides describe exact-root scope, leased global hooks/owned CJS dispatch, native-cache retention, bounds/restart behavior, foreign-wrapper conservation and the difference from TypeScript's private transformed graphs. |

The three new leaves contain **41 cases: 17 Core, 23 CLI, one Server**. Native alias behavior is tested through actual emitted Node processes, not Vitest's source-module loader. Existing descriptor admission, trust, selectors, manifests, TypeScript/Jiti and registration semantics remain separate; aliases do not grant execution permission.

## Exact-source qualification

All tests/type checks ran in Docker. Final test/type/focused/unit/parity image:

`sha256:49a68b259517efde902b04e8f2cd92c28f8646102c8d4fd6d573d561f465f439`

Final production image:

`sha256:cfa25faa3272304a55a721291fd02a373cce25b03051325705c1829e11155bae`

Five current source hashes match the final test image, not an exploratory overlay:

```text
1099d3a34b0c251945e2f986e4f7b45995c8191d95e9e8f4e33d0d455fab1cb4  packages/cli/src/cli/native-module-alias-process.test.ts
fd176219b15d5799aa8d36ab2599bc0c05ff95f1a13a028128e808ef1aab9c5d  packages/core/src/extensions/module-loader.ts
bac16a1a4419b5e3b7bb9fbd9d59836f7289821b75902384b5e2b67d9b5a602e  packages/core/src/extensions/native-module-alias-process.test.ts
c37b98bb7c616b0b972fbd0bd4ae4281a4e8fe4406aaf2b8b28d78042fbcd4dd  packages/core/src/extensions/native-module-alias.ts
fc372311c4c5670bb5305a3fc39bb845ca058acd2f866a8fd247c484abcbf5f2  packages/server/src/api/native-module-alias-process.test.ts
```

Four emitted JS/declaration hashes match both final test and production images:

```text
34f545e4e3b5037aeba29198ad852fceae283057a472dc7a6738287ba879c0bf  packages/core/dist/extensions/module-loader.js
b27493511808166c2237aae845f40f48e9e1a34f9939dfab11da1056ac254039  packages/core/dist/extensions/module-loader.d.ts
964c1fdaf0003ec4f9e14df91104c081f4c14b7479b749f7be626cc11fca65ba  packages/core/dist/extensions/native-module-alias.js
613ffa6b9d31052be40b68c62d1b3f3615069ac62bf33fb1d002f9c425698b20  packages/core/dist/extensions/native-module-alias.d.ts
```

| Gate | Final result |
|---|---|
| Workspace types | `make typecheck`, exit 0 |
| Owning strict tests and lint | Three-leaf strict NodeNext consumer config; five-owner ESLint with zero warnings, exit 0 |
| Focused ownership/conservation | Six leaves, **101 passed**, exit 0 / OOM false |
| Full units | `make test`: **230 files / 2,484 passed**, exit 0 |
| Public/installed parity | `make test-parity`: **32 passed**, exit 0; no golden updates |
| Production build | `make build-prod`, exit 0; entry 148 KiB gzip, eager 159 KiB gzip, 17 JS chunks; budgets unchanged |
| Production runtime | Network-disabled Node **26.11.1**: all three native formats, actual host versus preexisting foreign CJS namespace, failed/successful reload, cleanup/require restoration, nine actual CLI format/mode calls; preceding manifest and typed smoke plus real health/HTML/JS HTTP 200. Exit 0 / OOM false |

Local artifacts: `/tmp/aih-native-alias-final-{types,units,parity,prod}.{log,exit}`, `final-{focused,base-control,production-smoke}.{log,state.json}`, `owner-final-hashes.txt`, `final-image-hashes.txt`, `base-{owner,image}-hashes.txt`, `final-{test,prod}-artifact-hashes.txt`, the owner/base/artifact path manifests, strict config and production smoke scripts. These are local receipts, not published CI or remote release acceptance.

Final documentation/metadata gates: `make lint-docs` validates **96 Markdown files / 661 local links**, exit 0 (`/tmp/aih-native-alias-docs-staged.*`); `git diff --cached --check` passes. The matrix probe confirms 152 unique rows, 89 DONE, 63 PARTIAL and the exact 63-ID completion-review checklist. A final source-hash recheck is unchanged.

## Controls and retained intermediate evidence

- Original manifest-qualified image `sha256:ec8065f20bbc608555cb4b7a1128012413b2f0cc06da3e3fe53eacd853c95308`, with only the three current test leaves overlaid: **37 failed / four passed (41)**, exit 1 / OOM false. The four conservation positives are the three refused-project CLI cases and host-cache non-traversal. Original `module-loader.ts` matches the Git base hash. The three internal-helper bound probes fail because that helper does not exist in the base; they are not presented as earlier public-API regressions.
- Initial direct native-hook/three-format probes passed simpler scenarios. The first owning run retained **five failed / 63 passed**: two real CJS defects (same-directory foreign Core cache interference and cached transitive ownership), plus three observer failures caused by attempting to replace a native `ModuleHooks.deregister` method. The observer now returns a delegating facade, retaining the real hook internally. No lifecycle assertion was removed.
- The corrected nine-case overlay passed 69 conserved cases; expanded 14-case Core plus CLI/Server overlay passed 98. These remain exploratory evidence, not exact-source final qualification.
- An intermediate source-qualified image `sha256:295e2165a96316c7284f97ebb2c5d7959bfea0abd39eb7f54692df29865a7a2f` passed 100 focused, 2,483 units, 32 parity and production smoke (`sha256:a6c9bbaa62299f06622349d31bd03791e32a15d145a212e8a1cb7707bae9b69d`). Review then identified needless traversal of an explicitly required host Core cache root. The added observational case failed on that exact image: **three children reads instead of zero**, one failure / 16 deselected. The product now skips host cache roots before traversal; the final 17-case Core/101-focused/full qualification includes that assertion unchanged.
- The initial documentation pass rejected four links to this still-ignored receipt (exit 2); force-staging the intended versioned receipt corrects that boundary, rather than excluding its links. The original docs log remains retained.
- The short-lived production probe retains a default image-watchdog unhealthy sample during its pre-Server CLI phases. Timestamped output and source ordering distinguish that sample from the later explicit health/HTML/JS HTTP 200 checks; this is not a long-lived service-uptime qualification.
- Evidence is retained under `/tmp/aih-native-alias-{initial,core,core-fixed,expanded,qualified-*,host-cache-red,production-smoke}*`, beside final artifacts. Later passes do not diagnose any preceding compiler, Rolldown, browser or intermittent native failure recorded by earlier acceptance batches. No deadline, retry, assertion, screenshot, golden or bundle budget was relaxed.

## Remaining resolver scope, checked against the reference

The inspected reference `packages/coding-agent/src/core/extensions/loader.ts` calls Jiti on resolved declared entries; `resolveExtensionEntries` itself checks manifest entries and supported indexes, not recursively interpreted manifests. Its `core/pi-manifest.ts` reads resource arrays, not Node export maps. A separate network-disabled Node 26.11.1 probe of the pinned Jiti 2.7.0 resolver (`/tmp/aih-module-resolution-reference.{mjs,log,state.json}`, source hashes alongside) found:

- Literal directory `main` and `index.ts`: function loaded and executed.
- Extensionless entry and a JavaScript path backed only by TypeScript: function loaded and executed.
- Literal exports-only directory or `pi.extensions`-only directory passed directly to Jiti: `MODULE_NOT_FOUND`.

Therefore the earlier broad “main/exports/recursive” residual label is refined to actual **bounded main and extensionless/JavaScript-to-TypeScript entry fallback** work. Ordinary package dependency exports are not arbitrary directory-entry rules. This is source/probe reconciliation, not removal of an implemented criterion or permission to narrow the audit; CLI-EXT-01 stays PARTIAL.

## Explicit non-claims

Aliases follow native **module identity**, not caller authority. Existing native exports/caches and privileged side effects may survive retirement, and shared dependencies are not reexecuted on reload. Bounded URL metadata intentionally survives until process exit so a later owner can adopt cached transitive dependencies. A newer foreign require wrapper is preserved; a delegate it retains becomes inactive when there are no owned contexts. This is neither a Node sandbox nor cache/authority revocation, full extension disposer/shutdown coverage, arbitrary private aliases, complete entry resolution, upstream-source compatibility, live-vendor/mobile/browser acceptance, remote publication or completion of the remaining 63 criteria.
