# Architecture decisions: shared runtime and Web delta

Decision date: **2026-10-17**. Scope: the implemented AiHarness contracts at `6903145` and their operator/developer documentation. This register records decisions and their limits; it does not declare complete Pi parity, healthy production, remote publication or physical-device acceptance.

Read the [architecture overview](./architecture-overview.md), [server architecture](./server-architecture.md) and [operator runbook](../../users/en/operations.md) together. Detailed implementation navigation lives in the [project map](../../ai/project-map.md).

## ADR-01 — One Core owner, host-specific adapters

**Context.** CLI, JSONL RPC and detached Web agents must not independently reinterpret trust, tool execution or session history. A browser must not load privileged Node implementation.

**Decision.** Core owns shared contracts, providers, the tool loop, session projection/persistence, workspace trust, MCP and sandbox bridges. CLI owns terminal/protocol orchestration; Server owns HTTP authorization, detached host services and transport; Web owns state reconciliation and presentation and imports Core types only. Core API1 and JSONL schema2 remain separate versioned compatibility surfaces; additive implementation helpers are not mandatory extension/store methods.

**Consequences.** Reuse shared operations rather than copy policy into routes/components. Preserve structural-store and borrowed-resource lifetimes. A capability advertised by one host is not automatically available on another; static names do not grant runtime authority.

Owners: `packages/core/src/agent/tool-loop.ts`, `packages/core/src/sdk/agent-session.ts`, `packages/server/src/runtime/services.ts`, `packages/cli/src/index.ts`. Compatibility proof: `tests/functional-parity/installed-executable.test.ts`, `packages/core/src/sdk/public-consumer.test.ts`. See [public-contract policy](./public-contract-policy.md).

## ADR-02 — Separate MCP metadata, Test, session hosting and OAuth

**Context.** Opening Settings or previewing pasted configuration must not execute server commands, contact remote endpoints or acquire credentials. Configured/Test/Connected are different observations.

**Decision.** Inventory/preview/mutations remain file-policy operations. Explicit Test rereads one scope/name/configuration under fresh trust and closes its bounded transport without invoking tools or publishing credentials. The per-session host prepares eligible connections at prompt boundaries, uses current configuration keys and retires changed targets. Explicit OAuth is a distinct encrypted active flow; ordinary hosts use passive credentials and never initiate interactive login.

**Consequences.** Do not reuse a browser-normalized entry as authority. Reparse original import text; bind mutation to opaque revision and scope. A timed-out client does not prove no write. Project bodies require saved trust, including after an empty-folder inventory. OAuth identity includes name/normalized URL; logout retires stale writers but does not revoke issuer tokens. Local flow cancellation and actual transport/process settlement are not interchangeable.

Owners: `packages/core/src/mcp/config-inventory.ts`, `packages/core/src/mcp/config-import.ts`, `packages/core/src/mcp/server-test.ts`, `packages/core/src/mcp/session-host.ts`, `packages/core/src/mcp/oauth-flow.ts`. Tests: `packages/core/src/mcp/config-import-mutation.test.ts`, `packages/core/src/mcp/server-test.test.ts`, `packages/core/src/mcp/session-host.test.ts`, `packages/core/src/mcp/oauth-flow.test.ts`, `packages/server/src/api/mcp-oauth-routes.test.ts`. Operator procedure: [MCP](../../users/en/operations.md#2-mcp-configure-test-authorize-then-use).

## ADR-03 — Tool discovery is not authorization; sandbox the guest, not the host

**Context.** Large tool catalogs need deferred schemas and code-mode composition without granting every discovered tool or exposing ambient Node privileges to generated JavaScript.

**Decision.** Effective tools intersect registration, preset, scope, allowlist/exclusions and current MCP read-only policy. `direct`, `deferred`, `codemode` and `hidden` control declaration/discovery, not OS isolation. Search activation affects a later provider declaration, not the already fixed response. The disposable QuickJS guest has bounded memory/time/calls/results and no ambient Node/files/network; every nested host call revalidates current eligibility, including queued calls.

**Consequences.** Hidden, model-only and recursive control capabilities cannot be smuggled through a helper. MCP annotations are untrusted safety hints. Trusted extensions and MCP processes keep their actual host rights. Branch-local sandbox store changes publish only on success, but host side effects and billed model helpers already executed are not rolled back. Persist normalized outer nested usage once; unknown cost stays incomplete, not zero. Running progress is not promised crash-durable.

Owners: `packages/core/src/tools/tool-search.ts`, `packages/core/src/tools/codemode.ts`, `packages/core/src/tools/codemode-worker.ts`. Tests: `packages/core/src/tools/codemode.test.ts`, `packages/core/src/tools/tool-search.test.ts`, `e2e/codemode.spec.ts`. See [code-mode implementation boundary](../../ai/topics/codemode.md) and [operator procedure](../../users/en/operations.md#3-tools-and-code-mode).

## ADR-04 — Path reach, project trust and request capability are separate

**Context.** A selected cwd, an allowed root, a linked-directory consent or authenticated user must not silently become unrestricted read/write/execute authority.

**Decision.** Canonicalize and confine paths through Core workspace services; apply nearest saved allow/refusal and operation-specific capabilities independently. Inspect project-resource metadata before trust, not bodies. Keep agent/data/trust/credential directories independent of editable projects. Linked directories grant exact bounded read consent, not new global roots or write/execute access. Upload collision policy, child creation and dangerous Git/terminal operations require explicit operations.

**Consequences.** Resolve the current canonical identity again at privileged boundaries. An unavailable default does not select an arbitrary root. Frontend display labels or browser state cannot grant trust. Stable-file receipts protect supported owned replacement checks but are not hostile-writer exclusion, OS-atomic CAS or multi-file crash atomicity. Trusted code and PTYs still run as the host user.

Owners: `packages/core/src/security/workspace-manager.ts`, `packages/core/src/security/project-trust.ts`, `packages/core/src/security/stable-file.ts`, `packages/server/src/security/request-security.ts`. Tests: `packages/core/src/security/workspace-manager.test.ts`, `packages/core/src/security/project-trust.test.ts`, `packages/core/src/security/stable-file-receipt.test.ts`, `e2e/linked-directories.spec.ts`. See [stable publication](./stable-file-publication.md), [linked-directory consent](../../users/en/linked-directories.md) and [files/access runbook](../../users/en/operations.md#4-workspaces-files-and-access).

## ADR-05 — Durable parented history, volatile detached lifetimes

**Context.** Context reduction, branching, reconnect and interruption must not manufacture ancestry, duplicate a streamed reply or promise recovery of in-memory work after a crash.

**Decision.** JSONL schema2 records parented message/command/summary/custom history; parent links—not timestamps—determine active ancestry. Effective model projection and usage accounting are distinct from raw history. Detached runs continue when a browser stream closes. Bounded sequenced replay plus canonical snapshots reconcile clients; volatile run/dialog/replay registries are not a crash-restart scheduler.

**Consequences.** Preserve private custom state without sending it to the ordinary model/RPC projection. Capture source/lifetime/store authority before awaits and revalidate before unpublished persistence. Finish a captured save already admitted rather than claim cancellation rollback. Logical withdrawal is not physical settlement or proof that invalid/withdrawn provider attempts were never billed. API export projections are not complete raw-journal backups. Metadata rewrites/atomic saves mean this is not a universal append-only transaction protocol.

Owners: `packages/core/src/sessions/session-manager.ts`, `packages/core/src/sessions/compaction-model-messages.ts`, `packages/core/src/agent/runtime.ts`, `packages/core/src/agent/events.ts`. Tests: `packages/core/src/sessions/session-compaction-store-admission.test.ts`, `packages/core/src/sdk/session-compaction-lifecycle.test.ts`, `packages/core/src/agent/events.test.ts`. See [session SDK](./session-sdk.md) and [interruption/backup procedure](../../users/en/operations.md#5-sessions-interruption-and-recovery).

## ADR-06 — Honest model metadata, current-request estimates and accounting

**Context.** Provider dialects differ; historic usage, current context, output allowance and a published limit are not the same measurement.

**Decision.** Keep bounded non-secret model catalogs and normalize known usage/cache fields without inventing prices or capacities. Shared provider execution owns payloads before/after extensible redaction and preserves legitimate awaited observer changes. Known canonical context checks use `canonical-json-utf8/4-v1`, not vendor tokenization. Reserve explicit pre-redaction output evidence; exact first-party Anthropic preparation shares the native thinking/default policy without a mandatory provider capability.

**Consequences.** Unknown limits/media/costs are not zero. Ordinary CLI/RPC budget composition, initial unknown→known authority, effective post-hook model/media admission and useful overflow rebuild remain incomplete. Refusal before dispatch for an impossible known request does not certify all transports or solve once-per-actual-settled-attempt accounting. Native/subclass/extension dialects retain their own compatibility boundaries; never infer support from a model name alone.

Owners: `packages/core/src/providers/model-catalog.ts`, `packages/core/src/providers/model-metadata.ts`, `packages/core/src/agent/provider-request-estimate.ts`, `packages/core/src/providers/anthropic-thinking.ts`, `packages/core/src/sessions/session-accounting.ts`. Tests: `packages/core/src/agent/provider-request-budget.test.ts`, `packages/core/src/providers/provider-output-budget.test.ts`, `packages/core/src/sessions/session-accounting.test.ts`. See [provider implementation](../../ai/topics/providers.md) and [model/settings operations](../../users/en/operations.md#6-models-settings-and-reload-scope).

## ADR-07 — Scoped settings, passive catalogs and explicit executable reload

**Context.** Viewing metadata, installing a package, selecting a workspace and changing defaults must not silently execute code or replace another scope's state.

**Decision.** Preserve provenance and separate global/project/conversation/environment values. Missing values inherit; Web Auto/removal clears an override rather than saving its resolved value. Environment wins on Server. CLI settings remain bounded read-only inputs, project bodies require trust and diagnostics omit values. Catalog reads/install/activation are separate from an explicit managed executable generation commit. Failed same-workspace candidates preserve the prior generation; workspace retirement removes old authority.

**Consequences.** Reload is host-specific: interactive CLI refreshes supported settings/resources; RPC's passive `reload_context_settings` covers only compaction/branchSummary; Web resource reload targets the current session/workspace. No generic cross-host broadcast or complete configuration parity follows. Group actions affect selected qualified rows, refresh canonical state on uncertainty and do not claim rollback of an intervening writer. Restricted provider rename stays OFF by default and is not general shared-host rename.

Owners: `packages/core/src/config/agent-settings.ts`, `packages/core/src/extensions/module-loader.ts`, `packages/core/src/plugins/plugin-service.ts`, `packages/server/src/config/config-store.ts`. Tests: `packages/core/src/config/agent-settings.test.ts`, `packages/core/src/plugins/plugin-service.test.ts`, `packages/cli/src/rpc/context-settings-reload.test.ts`. See [extension loading](./extensions-cli.md), [resource batches](./resource-batches.md) and [restricted rename recovery](./server-architecture.md#restricted-provider-rename).

## ADR-08 — Keep credentials and network authority on the host

**Context.** Browser convenience and local defaults do not justify exposing provider secrets, unauthenticated remote administration or project-controlled trust stores.

**Decision.** Use loopback by default, separate user/admin capabilities, Origin checks and bounded HTTP/WebSocket inputs. Persist secrets only in protected master-key-backed stores; metadata APIs omit values. Filter child environments and redact registered secrets across independent streaming channels before persistence/presentation. CLI offline suppresses automatic provider work only; it is not an OS/container network boundary.

**Consequences.** Protect data and master key separately; back up coherently after stopping writers. A lone auth token is administrative. Remote deployments require independent HTTPS/proxy/origin/limit configuration. OAuth/logout do not replace tool authorization or issuer revocation. A failed HTTP response or stable-file write may follow publication. Preserve uncertain outcomes instead of inventing rollback. HTTP200, clean process exit, local preview and an available Pages workflow do not prove deployment health or remote publication.

Owners: `packages/server/src/security/request-security.ts`, `packages/core/src/providers/credentials.ts`, `packages/cli/src/cli/offline-mode.ts`, `packages/server/src/web-cli.ts`. Tests: `packages/server/src/security/request-security.test.ts`, `packages/core/src/providers/offline-policy.test.ts`, `packages/server/src/web-cli.test.ts`. See [security implementation](../../ai/topics/security.md) and [host preparation](../../users/en/operations.md#1-prepare-and-verify-the-host).

## ADR-09 — Optional Web assets retain a small authoritative boundary

**Context.** Lazy Settings, explorer, terminal and extension forms must not block Stop, lose unsent work or apply a late reply to another workspace/session. Localization and keyboard behavior belong to the operation, not just its initial label.

**Decision.** Keep eager lifetime/loading/error boundaries and import optional implementation/assets only when requested. Bind replies and focus to the current view identity; reconcile from canonical state after mutations/reconnect. Use localized inert text and schema-driven forms, not arbitrary extension HTML. Close/cancel remain local and available; explicit reload/retry warns about unsent text.

**Consequences.** Asset-import failures do not grant new host authority or automatically roll back accepted Server operations. Keep IME editing native, avoid unsolicited coarse-pointer editable focus and reject stale selection/reply publication. Emulated browser/axe coverage does not certify physical mobile keyboards/zoom or every supported locale. Record historical failed configurations separately from complete later passes.

Owners: `packages/web/src/components/SettingsView.tsx`, `packages/web/src/components/ProcessBlockBoundary.tsx`, `packages/web/src/store/mcp-selection.ts`. Tests: `packages/web/src/store/mcp-selection.test.ts`, `e2e/interaction-single-asset-load.spec.ts`, `e2e/pane-lifetime.spec.ts`. See [Web architecture](./web-architecture.md), [extensions](./extensions-web.md) and [localization](./i18n.md).

## Maintenance and validation

For each changed domain, update its public procedure and owning AI topic, verify every source/test path, and preserve host/scope/security limitations. For documentation-only changes, run `make lint-docs` and `git diff --check`; do not claim new runtime execution. If code, build tooling or public behavior changes, follow the [project validation workflow](../../ai/project-map.md#8-validation) and the affected functional/visual gates.

| Required documentation area | Operator procedure | Decision |
| --- | --- | --- |
|MCP|Runbook §2|ADR-02|
|Code mode|Runbook §3|ADR-03|
|Files/access|Runbook §4|ADR-04|
|Sessions|Runbook §5|ADR-05|
|Models|Runbook §6|ADR-06|
|Tools|Runbook §3|ADR-03|
|Settings|Runbook §6|ADR-07|
|Changed security/environment controls|Runbook §1/§7|ADR-04/ADR-08|

See the [French decisions](../fr/architecture-decisions.md) and [contributor index](./README.md). The table is a documentation coverage map, not permission to close any missing product capability or the overall audit.
