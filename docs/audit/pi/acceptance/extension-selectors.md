# Extension selector acceptance — 2026-10-13

Scope: the discovered-file selector portion of [AUDIT-2](../AUDIT-2.md) CLI-CFG-09/CLI-EXT-01, not complete extension/configuration parity. Both criteria remain PARTIAL; audit totals remain 88 DONE / 64 PARTIAL / 152.

## Requirement-to-artifact checklist

| Required contract | Implementation | Direct evidence |
|---|---|---|
| Apply inclusion globs/exclusions to files, not unresolved strings | Core `extensions/{extension-selectors,module-loader}.ts` | Core filesystem tests admit nested JS/ESM/CommonJS, omit excluded throwing modules and unsupported TypeScript, remove descendants and permit later exact reinclusion |
| Preserve literal paths, declaring directories and deterministic ownership | Additive `ExtensionModuleSelector` string/scoped records and readonly/callback `selectors`; existing `paths` remains literal | Cwd/scoped directories with metacharacters, literal filenames, scoped-input negatives, deduplication/sorting, successful owned replacement and independent-owner conservation |
| Trust before traversal/import | Same containment predicate for initial discovery and selector candidates; root-safe `path.relative` checks | Trusted/untrusted/revoked project discovery, ancestor/root patterns, exact reinclusion, linked/hard-linked/oversized files; existing loader race checks remain unchanged |
| Refuse incomplete generations | 200 ordinary paths/selectors, 32-KiB selector bytes (pattern plus base for scoped entries), 1,000 selected files at any stage, 1,000 entries/directory, 10,000 glob entry visits, 256 directory visits, depth eight | Every limit has a real-filesystem or exact-input negative; ordinary, exact-selector and glob directory truncation all fail closed; previous managed commands survive discovery refusal |
| Layer order and all CLI startup routes | CLI `configuredExtensionSelectors`, startup composition, `index.ts`, RPC fallback | Twelve emitted-process cases under literal-metacharacter roots: print/JSON/RPC × trusted/refused project × contributed-option/ordinary startup; automatic entries survive, excluded throwing entries never become direct imports, provider hooks run once per admitted owner |
| Actual reload and agent-directory conservation | Dynamic selector callback and agent-directory automatic path in ordinary/reused-loader composition | Genuine Linux PTY changes settings, excludes an old glob entry, discovers a new one, retains automatic commands and trusted project entries, then exits cleanly |
| Genuine public declaration/runtime | Core root exports of loader options and `ExtensionModuleSelector` | Outside-checkout strict NodeNext readonly async scoped-selector consumer, negative scalar type, emitted Core load/reload without source aliases |
| Operator contract | EN/FR contributor selectors and user-guide sections; AI map/extensions topic | Documents order, literal relative bases, all bounds, host trust, unchanged literal paths, separate Server settings ownership and non-sandboxed Node dependency/side-effect limits |

## Final validation and provenance

Base: `53e4761158c18a5705b6c61ad225f6253c0cde22`. All nine product/test owners match image `sha256:2384a78339d61665ad8c17a91c620e5a9191015293257c524b2555a0f7f537ce`; manifests are `/tmp/aih-selectors-literal-{owner,image}-hashes.txt`. The six preceding product-owner hashes match original image `sha256:a414321d146630fbaf335f9b04198eaf0ff5342d524e3a7aeee9ba6029ac380f`. The final Make unit build exports the same manifest as the type/focused image. Nine owning emitted JS/declaration hashes also agree between the final test and production images (`/tmp/aih-selectors-literal-{test,prod}-emitted-hashes.txt`).

- `make typecheck`, separate strict two-leaf test types and nine-owner zero-warning ESLint pass.
- 64 focused tests pass: 41 new (27 Core / 14 emitted/public/PTY), 16 existing loader and seven settings cases.
- Complete exact-source default `make test`: **216 files / 2,174 tests pass**.
- Standalone `make test-parity`: **32 unchanged cases pass**.
- `make build-prod` passes with unchanged entry 148 KiB/eager 159 KiB gzip and 17 chunks. Network-disabled production image `sha256:7f2f48e2c718976f46dcfdba43c031041c5258400a3e8d5a94fa23f6a07beecb` runs the actual Node 26.11.1 CLI selector/mock-provider hook under a literal-metacharacter root, then serves health, HTML and emitted JS with HTTP 200; actual exit 0, OOM false.
- Original-image and intermediate controls are retained separately below; green validation is not inferred from a union of filtered passes.
- Exact-tree documentation lint and whitespace checks accompany the commit.

## Causal controls and retained failures

- The initial 35-case original-image control fails 34 / passes one literal-path non-regression case. The final expanded original-image control fails 40 / passes one across all41 new cases; actual exit 1, OOM false, under `/tmp/aih-selectors-complete-base-control.*`.
- The first selector implementation mishandled filesystem-root containment and lost the configured agent directory on ordinary startup/reload. Its final-35-test control fails all eight affected cases (27 deselected), including a genuinely working command becoming unknown after `/reload`; actual exit 1, OOM false. Final source passes these contracts without weakened expectations.
- The next candidate treated metacharacters in declaring directories as wildcard syntax. The exact final 41-case control on that candidate fails 16 / passes 25; actual exit 1, OOM false. Final scoped bases and cwd-relative matching preserve literal identity across all twelve startup routes and public/PTY execution.
- The preceding source's first complete default run fails: 2,161 passes, one unchanged auth-help child SIGSEGV and six installed cases skipped after a fresh Core compiler SIGSEGV/139 (214/216 files pass). Its separate whole-target reproduction fails one unchanged shell-prefix case: output is `first` but status is `failed` (2,167 passes). A supplemental emitted diagnostic completes 500 paired/1,000 shell commands without reproducing that failure; it does not diagnose it. A third complete default run passes 2,168 tests before the final literal-base correction. All three results remain retained; neither later green run explains native exits or the shell-result failure.
- Initial lint refusal (redundant regex escape), incomplete-boundary controls, the earlier partial PTY control and a smoke-script-only invalid Unicode-regex escape are retained. Correcting the smoke script changes no product code. Earlier 2,160-test checkpoints also precede final boundary/composition improvements.

Logs, source manifests and state records remain locally under `/tmp/aih-selectors-*`, not published CI artifacts. No browser, physical terminal/device or remote deployment is newly certified; previous browser evidence remains tied to its recorded source. Built-in extension switches, TypeScript loading/complete module resolution and broader extension contracts remain open. Selected privileged Node modules can still import excluded entries as dependencies; filesystem selector policy is not a sandbox.
