# Native Configuration Editor Schemas

> **Navigation:** See [`project-map.md`](../project-map.md) for package ownership and required Docker validation.

## Overview

Core publishes owned JSON Schema editor data for existing native settings and public model-registration metadata. The normal CLI build emits these alongside the original keybinding/theme assets. This is an editor aid, not a new configuration loader or replacement for runtime admission.

[IMPORTANT] Schema validity never grants project trust, command execution, filesystem access, provider membership, HTTP privileges or persistence. Keep native recoverable settings loading and Server authority unchanged.

## Main Entry Points

| File | Responsibility |
|---|---|
| `packages/core/src/config/agent-settings.ts` | Private eight-kind native descriptor tree plus owned global/project editor projection |
| `packages/core/src/providers/model-editor-schema.ts` | Typed nonsecret editable-model shape, not private registry storage |
| `packages/core/src/index.ts` | Public factory exports; Core API marker remains 1 |
| `packages/cli/schemas/editor-schemas.mjs` | Pure build-time composition through public Core exports |
| `packages/cli/scripts/copy-assets.mjs` | Generate three new JSON assets; copy original two byte-exactly |
| `packages/server/src/runtime/provider-registry.ts` | Existing stateful public model registration, normalization, defaults and persistence |
| `packages/server/src/api/provider-registry-routes.ts` | Existing authenticated, configuration-capability-gated registration/update |

## Public Contracts and Invariants

`getAgentSettingsEditorSchema(scope?: AgentSettingsScope)` defaults to `global`; only `global` and `project` are accepted. Invalid scopes throw a fixed value-free error. `getCustomModelEditorSchema()` takes no configuration/credential arguments. Both return fresh mutable `Record<string, unknown>` graphs; callers cannot mutate native descriptors or another returned document.

| Installed CLI asset | Native editor contract / identity |
|---|---|
| `dist/schemas/settings.schema.json` | Agent-directory `settings.json`; `urn:ai-harness:schemas:settings:global:1` |
| `dist/schemas/project-settings.schema.json` | Project `settings.json`; `urn:ai-harness:schemas:settings:project:1` |
| `dist/schemas/models.schema.json` | One public model-registration body; `urn:ai-harness:schemas:custom-model:1` |
| `dist/schemas/keybindings.schema.json` | Original data-only keybinding schema, unchanged |
| `dist/schemas/theme.schema.json` | Original complete 58-token palette schema, unchanged |

All use JSON Schema 2020-12. New identities are version 1; original schemas retain their existing vocabulary/package version and exact bytes. Do not edit generated `dist/` files. Configure editor associations externally: adding an inline `$schema` field to native settings would still be an unknown setting.

### Settings projection

Project the canonical descriptor tree rather than maintaining a second field/bounds list. Arrays, records, required package sources, unions, enums, integers and nested limits retain their native owner. Project scope refuses the four global-only fields (`cacheWarming`, `defaultProjectTrust`, `httpProxy`, `deviceId`) without granting permission to read any project body.

Supported legacy forms include `queueMode`, `websockets`, the legacy skills object and `retry.maxDelayMs`; native modern-value precedence remains. Canonical editor shapes may flag malformed legacy values that migration salvages or discards. Native loading remains recoverable and authoritative, including valid siblings, trust, provenance, resource merge and host defaults.

Standard string limits count Unicode scalars, not native UTF-16 units or UTF-8 bytes. `x-maxUtf16CodeUnits` and `x-maxUtf8Bytes` are optional annotations, not validators or permission. Native URL parsing, normalized command identifiers, stable/nonlinked file reads, execution-time npm bounds and trust are separate. Schema validity does not execute credential commands or create settings files.

### Model metadata, not a new models file

The model schema describes existing `POST /api/provider-registry/models` input (or a complete native update body): canonical existing provider ID, model ID/name, capabilities, context/output limits, pricing and scalar compatibility metadata. It excludes response-only key/timestamps, provider connection settings, credentials and private registry structure.

[WARNING] AiHarness does not gain a CLI `models.json` loader. Do not apply this schema to private `providers.json`, encrypted secrets or live-discovery `/custom/:id/import-models`. Registration stays an explicit native API operation.

Provider membership is stateful. Optional numeric null/empty values defer to native fallback, not invented defaults or clearing semantics. Canonical editor types flag unknown/inert/coerced API extras; the existing API parser is not tightened. Native authentication, capabilities, Origin, previous/published defaults and atomic publication remain independent.

### Themes remain runtime-owned

Startup and reload already call the same Core `ThemeManager.load` with current cwd/trust. Invalid startup falls back to dark; invalid reload retains the last good palette. Required name/appearance, variable names/cycles, color/export keys and bounds are checked natively. Unknown root metadata remains inert compatibility data. See [theme ownership](./themes.md), not a duplicate palette implementation.

## Critical Flows

1. Build Core, then CLI; asset composition calls public pure factories, serializes fresh documents and copies original schemas. No configuration discovery, provider operation or command execution is added.
2. An editor validates data against shipped JSON. Native settings loading still independently admits files/scopes; explicit Server registration still checks identity/state/privileges before persistence.
3. Actual outside-checkout consumers load public Core declarations/runtime and installed asset bytes. A test path is not discovery proof; observe file/case totals and keep complete required aggregates binding.

## Associated Tests

- `packages/core/src/config/agent-settings-editor-schema.test.ts`: exhaustive typed field inventory, actual strict 2020 validation/native round trips, migration, project trust/global-only rules, owned graphs and disclosed byte/Unicode/URL/legacy boundaries.
- `packages/server/src/runtime/model-editor-schema.test.ts`: typed metadata shapes, actual native registration/persistence/reload, numeric bounds, stateful refusal and canonical-editor limits.
- `packages/server/src/api/model-editor-http.test.ts`: actual loopback 401/403/Origin refusals, native admin registration/update/read, persistence and absence of model/tool/MCP work.
- `packages/cli/src/utils/settings-schema.test.ts`: exact generated owner documents and byte-preserved original assets.
- `packages/cli/src/cli/editor-schema-process.test.ts` and `packages/cli/src/cli/fixtures/editor-schema-probe.mjs`: real emitted public package resolution, all five actual strict-engine schemas and native settings/theme admission.
- `packages/cli/src/cli/editor-theme-validation-process.test.ts`: both real PTY hosts, identical malformed startup/reload diagnostics, safe initial fallback and last-good retention.
- `packages/cli/src/cli/theme-sources-process.test.ts`, `packages/cli/src/utils/{theme,keybinding}-schema.test.ts` and the additive `tests/functional-parity/installed-executable.test.ts` case preserve original theme/keybinding ownership and prove genuine installed assets/public strict declarations.

## Common Changes

- **Change a setting:** update the private native descriptor/type first, then exhaustive samples and boundary tests. Do not silently change recovery, migration, global-only or trust rules to match an editor.
- **Change model metadata:** reconcile shared public types with actual native registration/stateful defaults, editor projection and genuine HTTP/storage probes. Do not expose credentials or introduce a new loader.
- **Change asset composition:** keep original JSON bytes/tokens, regenerate through normal Docker builds, test actual offline pack/install and run the production build required by [the project map](../project-map.md#8-validation).

## Related Domains

- [CLI contracts](./cli-reference.md) — configuration consumption and headless purity
- [Providers](./providers.md) — model catalogue, native metadata/state and credentials
- [Themes](./themes.md) — palette, file/trust and startup/reload authority
