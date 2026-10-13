# Bounded directory extension manifests — acceptance

Date: 2026-10-13. Base: `6fb3a672526f05b741821c88efc745aa44d6155d`. Decision/evidence: DEC-73 / E-AH-EXT-MANIFEST-01.

**Scoped progress, not audit completion.** CLI-EXT-01 remains PARTIAL for broader module/JavaScript host-alias resolution, including arbitrary directory `main`/`exports` or recursively declared directory entries. Status totals remain **89 DONE / 63 PARTIAL / 152**. See the [completion review](./completion-review.md) and preceding [typed-loading acceptance](./typescript-extensions.md).

## Implementation and acceptance mapping

| Requirement | Concrete implementation / tests |
|---|---|
| Uninstalled folder declarations | Core `extensions/module-manifest.ts` reads native `aiHarness.extensions` and legacy `pi.extensions`; `module-loader.ts` resolves them in automatic child folders and explicit/environment/settings directories. Native fields override legacy fields individually |
| Complete selection rather than sibling fallback | A declared list replaces ordinary index/sibling discovery; absent field retains existing discovery and `[]` selects nothing. Core tests cover precedence, reselection, empty lists, distinct ownership and outer selectors |
| Literal, confined paths | Exact directory-relative entries, including literal bracket names/bases and portable backslash separators. No glob/selector interpretation, absolute/drive/escaping/self entries. Regular supported files or JavaScript-first index directories only; no recursive manifest authority |
| Preserve safe entry admission | Declared missing/linked/oversized/index-less entries fail the candidate; declarations and other safe non-executable files are ignored. Existing descriptor-backed module import rechecks remain authoritative |
| Metadata cannot become executable authority through a race | Stable parent/file descriptors, before/open/read/path identities, bounded reads and fatal UTF-8; actual emitted Core replacement between real lstat and real open refuses the candidate before either factory executes. The child interposes only a one-shot await around the real filesystem open; no fake file identity or source loader |
| Fail closed and avoid source diagnostics | Fixed `Extension manifest is invalid or exceeds its limits.` for malformed/unsafe metadata, paths and overflows. Core prior-generation callback identity, genuine PTY syntax failure and emitted HTTP metadata failure retain the previous generation without quoting source |
| CLI composition and trust | 30 emitted cases: print/JSON/RPC × global/project/settings/environment/explicit × ordinary/contributed startup. Six further cases prove refused-project metadata is not parsed, automatic suppression precedes parsing and explicit duplicate paths still import once. Mandatory `read` remains |
| Real lifecycle and Server behavior | Genuine five-prompt PTY: disk-only edits inactive, reload selects next entry, invalid metadata retains prior callback/options and repaired manifest selects third. Additive Server variant preserves the original direct-file case and proves manifest trust, HTTP reload, actual model/tool execution, syntax/metadata failure retention and failed-workspace retirement |

### Bounds and exclusions

One manifest: **256 KiB**, **100 exact entries**, **32 KiB per string**. One discovery operation, including paths and selectors: **200 manifest reads**, **4 MiB metadata bytes**, **1,000 declared-entry visits**. Repeated metadata work counts; imports remain path-deduplicated. Existing directory/selector/module bounds stay unchanged. Tests separately exceed each aggregate bound while preserving unrelated registered owners.

Missing optional `package.json` or an absent extensions field keeps old discovery. A malformed present manifest fails rather than silently falling back. Installed-package resource globs retain their existing separate service semantics; directory declarations are literal, not a second glob dialect. Invalid native/legacy extensions values are not executed. This does not implement arbitrary package `main`/`exports`, recursively interpreted manifests, broad JavaScript host aliases, static typing or a Node sandbox. Privileged dependency imports/effects are not rolled back.

## Exact-source qualification

Five owners (two product, three test leaves) match Docker image **`sha256:ec8065f20bbc608555cb4b7a1128012413b2f0cc06da3e3fe53eacd853c95308`**. Two original existing owners match base **`sha256:7eb67ed94c5a92514d49f69f3ccc313c908d13ed8967bd79e05bbcd7eeceae2d`**. Four emitted JS/declaration artifacts match production **`sha256:17fcb07f90fc0a1d4e360b3beb2c20cdeae580fd4a3114d1602e252a14753ec0`**.

- Docker workspace types plus strict NodeNext checks of all three owning test leaves; five-owner zero-warning ESLint: pass.
- **73 added cases**: 34 Core, 38 emitted CLI/PTY/public race and one additional emitted Server variant. Final seven-leaf **172-case focused suite** passes, exit 0/OOM false.
- Full `make test`: **227 files / 2,443 passed**. `make test-parity`: **32 passed**, unchanged public goldens.
- Original-source control overlays only three current test leaves: **67 failures / seven passes** across 74 cases, exit 1/OOM false. Conserved direct-file Server, ordinary/index discovery and refused-project behavior pass; manifest-specific behavior fails. No base product or dependency change was made.
- `make lint-docs`: **95 Markdown files / 654 local links** valid; staged whitespace checks pass. The matrix/checklist parser confirms 152 unique criteria, unchanged 89/63 totals and exactly the same 63 open IDs.
- `make build-prod`: pass; unchanged **148 KiB entry / 159 KiB eager gzip / 17 chunks**. Network-disabled **Node 26.11.1** production smoke verifies real literal manifests, native/legacy precedence, no sibling fallback, changed/empty selections, invalid/escaping metadata retention, print/JSON/RPC contributed startup, preceding typed-loader behavior and health/HTML/JS HTTP 200; exit 0/OOM false.

Initial 133-case and expanded 172-case overlays passed; only the final fresh-image source/artifact hashes qualify the committed scope. Earlier native/compiler/browser/shell failures remain unexplained and retained in preceding receipts. No assertion/deadline/retry/golden/budget relaxation, new browser matrix, physical-device, live-vendor or remote publication evidence is claimed.

## Local retained artifacts

- `/tmp/aih-manifests-{initial,expanded,base-control,production-smoke}.*`
- `/tmp/aih-manifests-qualified-{types,units,parity,prod,focused}.*`
- `/tmp/aih-manifests-{owner,image,base-owner,base-image,test-artifact,prod-artifact}-hashes.txt`; owner/base/artifact path lists
- `/tmp/aih-manifests-tests.tsconfig.json`, `/tmp/aih-manifests-production-smoke.mjs` (also runs the retained typed-loader production script)
- `/tmp/aih-manifests-docs.*`, `/tmp/aih-manifests-matrix.log`

Local artifacts are not published CI evidence.
