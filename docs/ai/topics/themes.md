# Terminal theme sources

> **Navigation:** Start with [`project-map.md`](../project-map.md) for repository ownership and validation.

Core owns palette validation and bounded metadata discovery; CLI owns source composition and presentation. These are terminal themes, not Web CSS or extension-executable modules.

## Owners

- `packages/core/src/themes/theme-sources.ts`: public `discoverThemeSources` and readonly `ThemeSourceSelector`.
- `packages/core/src/resources/file-selectors.ts`: shared metadata-only selection engine. The existing extension adapter keeps its 200-selector policy and diagnostics; theme discovery uses its own bounded policy.
- `packages/core/src/themes/theme-manager.ts`: stable palette reads, schema/color resolution, built-ins, inventory and adaptive terminal probes.
- `packages/cli/src/cli/theme-sources.ts`: global/project/package/explicit composition and selection precedence.
- `packages/cli/src/{index,commands/handler}.ts`: startup, reload, current palette and interactive inventory.
- `packages/cli/schemas/theme.schema.json`, `packages/cli/scripts/copy-assets.mjs`: complete declarative theme editor asset and byte-exact installed distribution; Core remains the runtime authority.

## Discovery and precedence

`discoverThemeSources(selectors, { cwd, projectTrusted })` accepts ordered readonly records with `pattern`, an absolute literal `baseDir`, `scope`, `source` and `trusted`. It snapshots own data fields before asynchronous work; selector-field accessors are not invoked. Ineligible sources are skipped. Project paths and ancestor scans stay blocked without project trust, regardless of a misleading user/temporary source label. The caller supplies the canonical workspace and current trust decision.

Discovery reads metadata, never palette bodies. Literal directories enumerate only immediate `.json` files. Globs can descend explicitly. Plain paths/globs add candidates, `+path` adds an exact file/directory, `-path` removes an exact path/subtree, and `!glob` removes matches. A later exact include can restore a removed candidate. Declaring directories are not glob syntax, and trailing directory separators cannot select files. Symlink/hardlink leaves are not admitted; unsafe ancestors and metadata failures fail the whole operation with `Theme sources are invalid or exceed their limits.`

CLI composes, in increasing priority:

1. Eligible `<agent-dir>/themes/`, enabled global package themes, global `themes` selectors.
2. Trusted `<cwd>/.ai-harness/themes/`, enabled project package themes, project `themes` selectors.
3. Repeatable literal `--theme-source <path>` requests.

Settings selectors resolve relative to their declaring directory; `~` expands to the process home. Explicit CLI source paths resolve from cwd and are literal, including glob metacharacters. Package paths retain the shared package catalogue's eligibility/filter rules; this does not broaden allowed roots or install anything.

Actual paths deduplicate. Last inclusion determines provenance/priority. Discovery returns highest priority first, conserving `ThemeManager.load`'s existing first-match semantics. Selection by filename stem remains case-insensitive; `dark`, `light`, `system` and `auto` keep their built-in meanings. Explicit absolute selection retains an admitted source's provenance. Inventory reads actual files even when their basenames resemble built-ins.

The selected theme follows `--theme` → nonempty `AI_HARNESS_THEME` → trusted project/global `theme` setting → `auto`. `COLORFGBG` remains an automatic appearance input. Existing direct `--theme <file>` selection is preserved.

## Suppression, reload and modes

Strict `--no-themes` suppresses automatic roots, settings arrays and package theme admission, not built-ins, explicit source requests or direct theme-file selection (including a saved file selection). Both new long option names are reserved against extension shadowing. Suppression never grants project trust, disables extensions/tools or changes provider execution.

Interactive `/reload` refreshes source discovery and settings-driven selection. A manually selected theme keeps its selection until another explicit choice. Source-generation failure clears the candidate catalogue, reports a warning and leaves the already rendered palette intact; it does not grant stale sources future read authority. The active palette can be reported from its already loaded metadata even when it is not a discovery candidate. Its current project trust is reflected in that metadata. Exact active path identity prevents two same-name palettes from both appearing active.

Print/JSON retain their existing literal-prompt and pure-output contracts: `/theme` in print is model input, not an interactive command. RPC accepts these startup flags but has no terminal palette renderer/catalogue. No RPC reload or Web theme API is added.

## Bounds and admission

- At most 1,000 source requests and 32 KiB combined pattern/declaring-directory bytes per selector.
- At most 1,000 intermediate selected paths and 512 final custom candidates, matching the existing inventory ceiling; overflow refuses the generation rather than hiding an arbitrary suffix.
- Glob traversal: 256 directories, 1,000 entries per directory, 10,000 aggregate entries and eight descendant levels.
- Separate shallow-discovery budget: 256 directory scans, 1,000 entries per directory, 10,000 aggregate entries and 10,000 candidate probes. Repeated work counts again. These are separate from the glob budget, not one shared 10,000-entry total.
- Resolved candidate paths are capped at 32 KiB. Linux metadata probes/enumeration use held directory descriptors; actual body admission remains a fresh stable read.
- Existing palette admission remains 256 KiB per stable single-link regular UTF-8 file, 256 variables and 128 color tokens. Body/variable/export validation is not relaxed. Unknown color/export keys now produce fixed diagnostics instead of echoing private field names or terminal controls.
- CLI may display one additional already loaded active custom palette outside discovery; this adds no body read or candidate authority.

These bounds are not a sandbox, filesystem-wide snapshot or new cross-platform race certification.

## Shipped palette schema

The source `packages/cli/schemas/theme.schema.json` ships at `@ai-harness/cli/dist/schemas/theme.schema.json`, beside the keybinding schema. It enumerates all 58 rich/optional/legacy color tokens and all three literal-only export fields (`pageBg`, `cardBg`, `infoBg`), bounded variable names/values, ANSI indices and hex/named literal grammar. Built-ins initialize 54 fields; the other four are optional scrollbar/search tokens, not missing runtime support. Partial custom colors inherit the selected built-in appearance.

`name` and `colors` are required. Nonnull `appearance` takes precedence over legacy `mode`; absent/null `appearance` requires `mode: dark|light`. Unknown root metadata is accepted in the input file but not copied into the loaded palette. Unknown color/export keys fail. Exact case-sensitive variable references resolve before named literals; Core resolves forward references with own-property lookups, rejects cycles/missing literals, and never borrows `Object.prototype` values. Export fields do not resolve variables.

JSON Schema is an editor aid, not filesystem or execution authority. Core separately enforces stable 256 KiB UTF-8 file admission, UTF-16 code-unit ceilings, reference existence/cycles and project trust. `x-maxUtf8Bytes`/`x-maxUtf16CodeUnits` document those runtime-only limits; schema character counts alone cannot enforce them.

## Common Changes

- Adding a palette token: update Core types/defaults/validation, renderer uses, the full schema token inventory and actual per-token load tests together; optional tokens need not appear in every built-in.
- Changing theme sources: preserve metadata/body separation, declaring-directory identity, trust, suppression, bounds and current active-path identity.
- Changing color parsing: retain variable-before-literal semantics and own-property resolution; test inherited literals and forward references, not only ordinary hex colors.

## Evidence

`packages/cli/src/utils/theme-schema.test.ts` covers all 58 real token loads, literal/export grammar, legacy precedence, variables, invalid names/keys and emitted schema equality. Core `themes/theme-color-ownership.test.ts` covers prototype literals/forward references; packed PATH-bin consumers assert both schemas' inventory, nonsymlink files and byte equality outside the checkout. These tests do not certify arbitrary editors or fresh-registry installation.

`themes/theme-sources.test.ts`, CLI `cli/theme-sources{,-process}.test.ts` and the actual installed-package test cover metadata/body separation, ordered sources, negative trust, identity, limits, public readonly declarations, both real PTYs, reload and headless conservation. Existing selector/module-entry tests protect the extracted engine's extension behavior. See the [acceptance record](../../audit/pi/acceptance/theme-sources.md) for exact qualified artifacts and retained failures; the [CLI reference](./cli-reference.md) describes the surrounding runtime.

## Related Domains

- [Native editor schemas](./editor-schemas.md): original byte-exact palette asset beside new settings/model projections; both native PTY startup/reload validation controls.
- [CLI reference](./cli-reference.md): keybinding ownership, renderer/input lifecycle and installed commands.
- [Security](./security.md): project trust, stable-file admission and privileged extension boundaries.
- [Extensions](./extensions.md): package resources and fresh generation composition.
