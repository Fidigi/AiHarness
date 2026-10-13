# Descriptor-admitted TypeScript extensions — acceptance

Date: 2026-10-13. Base: `b799869234c5a5dc0ad38616ce2c7455b5119ad9`. Decision/evidence: DEC-72 / E-AH-EXT-TS-01.

**Scoped delivery, not audit completion.** CLI-EXT-01 remains PARTIAL: uninstalled directory-manifest entry resolution and broader module/JavaScript host-alias resolution still need implementation and evidence. The actual matrix remains **89 DONE / 63 PARTIAL / 152**. The [completion review](./completion-review.md) retains every remaining criterion.

## Requirements and implementation

| Delivered requirement | Concrete evidence |
|---|---|
| Execute TypeScript from normal extension sources | Core `extensions/{module-format,typescript-module,module-loader}.ts`; CLI process matrix covers six sources × print/JSON/RPC × ordinary/contributed startup (36 cases) |
| Shared package/standalone executable-format rules | Core `plugins/plugin-service.ts` shares the format predicate; appended package test admits seven formats, excludes declarations from counts/activation, retains exact filters and rejects standalone declarations |
| Preserve entry admission and atomic generations | Existing stable parent/file descriptors, 5 MiB cap, single-link checks, trust, selectors and post-import identities remain. Core negatives plus actual emitted Linux pathname replacement prove no replacement body executes and the candidate refuses commit |
| Real typed language/module behavior | `.ts`, `.mts`, `.cts`, `.tsx`; enums, parameter properties, CommonJS exports, classic JSX, relative/extensionless imports, original filename/import.meta and late imports. Actual host Core root identity is checked outside the checkout |
| Freshness without replacing native cache ownership | Per-entry private transformed graph, reload after success/failure, existing CJS cache entry/object conservation. Genuine five-prompt PTY verifies disk-only edits remain inactive, reload refreshes dependencies, syntax failure preserves old callbacks, and subsequent repair succeeds with contributed values retained |
| Real Server integration, not just CLI | Actual emitted Server/Core over HTTP: metadata/unauthorized requests do not import, saved trust admits the typed tool, real model/tool runs persist its output, dependency reload refreshes it, same-cwd failure preserves complete metadata and exact execute callback, failed workspace replacement retires it while preserving `read` |
| No source-code diagnostic leakage | Evaluation/transformation failures return fixed `TypeScript extension evaluation failed.`; CLI PTY and HTTP syntax-failure fixtures exclude source tokens/code frames |
| Existing public contracts and documentation | Root APIs, protocol/session majors and CLI goldens unchanged; strict six-leaf types and complete parity pass. AI and EN/FR guides describe transpile-only behavior, caches, aliases, source/compiled duplicates and remaining limits |

### Execution contract

Core uses lazily imported, exactly pinned **`jiti` 2.7.0**. The Core manifest changed deliberately; `make lockfile` generated the sole lockfile in Docker, adding only this dependency/lock entry. No manual lock edit or reference-package runtime import occurred.

The transpiler receives captured entry bytes through `evalModule`, not an entry pathname to reopen. Native entry loading, transpiler filesystem/global module caches, implicit tsconfig aliases and debug/code-frame output are disabled. Each entry retains its own transformed dependency graph, refreshed on reload. Native dependencies retain Node cache behavior; privileged module effects and dependency reads remain outside entry rollback/sandbox guarantees. The exact `@ai-harness/core` root resolves to the actual host namespace. No broad private-module or JavaScript alias resolver is claimed.

Executable suffixes are `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`, `.tsx`. Declarations `.d.ts`, `.d.mts`, `.d.cts` are never factories. Child index priority conserves `.mjs`, `.js`, `.cjs` before the four typed suffixes. Distinct source and compiled paths are distinct candidates; operators should select one implementation rather than autoloading both. Classic JSX requires the author's factory/library; it grants no React, HTML or custom Web rendering surface. This is **transpilation, not static type checking**.

## Exact-source qualification

Twelve inputs (four product owners, six test leaves, Core manifest and lockfile) match image `sha256:7eb67ed94c5a92514d49f69f3ccc313c908d13ed8967bd79e05bbcd7eeceae2d`. Seven original existing inputs match base image `sha256:6ac80cc84aece2a36a17bce94fc35e5296e3fe785839884b7b3ae528fa32681a`. Eight emitted JS/declaration artifacts and five actual `jiti` runtime/package artifacts match production image `sha256:e537ef477998d72c5d6a4cc8d9d66c9432365f1281bf86a5898e54a9c5e389ca`.

- Docker `make typecheck`, separate strict NodeNext checks of all six test leaves and ten-owner zero-warning ESLint: pass.
- **57 added cases**: ten Core typed-loading, 45 emitted CLI/public/PTY/race, one package-format and one emitted Server HTTP/tool case. Final nine-file focused suite: **185 passed**, exit 0/OOM false.
- `make test`: **225 files / 2,370 passed**. `make test-parity`: **32 passed**. No changed golden, retry setting, deadline or output normalization.
- Original-source control overlays only the three new test leaves, without changing base product/dependencies: **52 failures / four passes** across 56 cases, exit 1/OOM false. Existing refusal/no-import behavior still passes; typed admission, transformations, source/activation, reload and emitted contracts fail. The added package-format case separately passes in owning/full suites.
- `make lint-docs`: **94 Markdown files / 645 local links** valid; staged whitespace checks pass. Matrix parser confirms 152 unique IDs, unchanged 89/63 status totals and exact equality with the 63-ID remaining-work checklist.
- `make build-prod`: pass; unchanged **148 KiB entry / 159 KiB eager gzip / 17 chunks**. Network-disabled **Node 26.11.1** production smoke verifies the shipped parser, real Core typed entries/host alias/relative imports, fresh helper reload, fixed failure retention, actual print/JSON/RPC contributed startup, and HTTP 200 health/HTML/JS; exit 0/OOM false.

## Retained authoring failures and boundaries

- The initial 69-case and expanded 184-case exploratory runs passed; overlays are not substituted for the final fresh-image source/hash qualification.
- Expanded strict coverage exposed four older test declaration errors: a CLI extensionless relative import and three public-Service/source-private-class mismatches. The fixture now uses `.js` and public Workspace/Trust constructors for its public API calls. Product types and security assertions were not relaxed; initial strict exit 2 is retained.
- The first new emitted Server fixture incorrectly required stable wrapper object identity from `ExtensionRegistry.getTools()`. Source returns a fresh shallow descriptor each call. The corrected fixture asserts the entire descriptor **and exact execute callback identity**, followed by a real tool invocation. The one-failure/17-pass run remains recorded; no product correction or ownership weakening was needed.
- One EN documentation edit initially failed exact-text matching; it applied no partial changes and was corrected to the actual file text.
- Earlier native Rolldown/compiler/browser/shell failures remain retained in preceding receipts; current successful commands do not diagnose them. No new browser matrix, physical-device, live vendor or remote publication qualification is claimed.

## Local artifacts

- `/tmp/aih-typescript-lock.*`, `/tmp/aih-typescript-{initial,expanded}-types.*`, `/tmp/aih-typescript-{initial,expanded}-focused.*`
- `/tmp/aih-typescript-strict-discovery.*`, `/tmp/aih-typescript-server-wrapper-control.*`
- `/tmp/aih-typescript-qualified-{types,units,parity,prod,focused}.*`
- `/tmp/aih-typescript-{base-control,production-smoke}.*`
- `/tmp/aih-typescript-{owner,image,base-owner,base-image,test-artifact,prod-artifact}-hashes.txt`, input/base/artifact path lists
- `/tmp/aih-typescript-tests.tsconfig.json`, `/tmp/aih-typescript-production-smoke.mjs`, `/tmp/aih-jiti-cache-inspection.txt`
- `/tmp/aih-typescript-docs.*`, `/tmp/aih-typescript-matrix.log`

These are local retained evidence, not published CI artifacts.
