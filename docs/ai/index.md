# AI Agent Documentation — AiHarness

Read [`project-map.md`](./project-map.md) first for package ownership, runtime flows, repository authority and Docker validation. Load only the relevant domain afterward. Code/tests and current configuration take precedence over documentary descriptions or historical qualification notes.

## Files by Domain

Line counts are approximate context estimates, not completion or test-coverage claims.

| Domain | File | Context load |
|---|---|---:|
| Project overview | [`project-map.md`](./project-map.md) | ~735 lines |
| Providers, native policies, credentials and OAuth | [`topics/providers.md`](./topics/providers.md) | ~2070 lines |
| Copilot and Codex subscription providers | [`topics/subscription-providers.md`](./topics/subscription-providers.md) | ~430 lines |
| Provider/configuration inventory and host composition | [`topics/provider-matrix.md`](./topics/provider-matrix.md) | ~210 lines |
| Virtual routing, physical dispatch and cache economics | [`topics/model-dispatch-policies.md`](./topics/model-dispatch-policies.md) | ~105 lines |
| Sessions, persistence, compaction and branches | [`topics/sessions.md`](./topics/sessions.md) | ~220 lines |
| Context edits and private loadout state | [`topics/session-context-state.md`](./topics/session-context-state.md) | ~95 lines |
| TypeScript session SDK | [`topics/session-sdk.md`](./topics/session-sdk.md) | ~75 lines |
| Run admission, queues, cancellation and settlement | [`topics/run-lifecycle.md`](./topics/run-lifecycle.md) | ~130 lines |
| Extensions, packages, loading and interactions | [`topics/extensions.md`](./topics/extensions.md) | ~260 lines |
| Native extension/embedding contract | [`topics/native-extension-contract.md`](./topics/native-extension-contract.md) | ~110 lines |
| CLI, standalone commands, JSON and RPC | [`topics/cli-reference.md`](./topics/cli-reference.md) | ~465 lines |
| CLI invocation, channels and exit policy | [`topics/cli-invocation-contract.md`](./topics/cli-invocation-contract.md) | ~130 lines |
| Terminal actions, editing and active/stored settings | [`topics/terminal-contract.md`](./topics/terminal-contract.md) | ~115 lines |
| Terminal theme discovery and palette ownership | [`topics/themes.md`](./topics/themes.md) | ~80 lines |
| Native editor schemas and installed assets | [`topics/editor-schemas.md`](./topics/editor-schemas.md) | ~85 lines |
| QuickJS code mode and nested/model helpers | [`topics/codemode.md`](./topics/codemode.md) | ~160 lines |
| REST, SSE, WebSocket and server lifecycle | [`topics/server-api.md`](./topics/server-api.md) | ~265 lines |
| React application, stores and view lifetimes | [`topics/web-app-architecture.md`](./topics/web-app-architecture.md) | ~250 lines |
| Detached stream reconstruction | [`topics/detached-streams.md`](./topics/detached-streams.md) | ~95 lines |
| Separate static demonstration and publication | [`topics/static-demo.md`](./topics/static-demo.md) | ~120 lines |
| Linked-directory read consent | [`topics/linked-directories.md`](./topics/linked-directories.md) | ~65 lines |
| Workspace trust, secrets and execution boundaries | [`topics/security.md`](./topics/security.md) | ~225 lines |
| Native field/resource/security contract | [`topics/native-security-contract.md`](./topics/native-security-contract.md) | ~105 lines |
| Child-agent profiles, delegation and monitoring | [`topics/child-agents.md`](./topics/child-agents.md) | ~120 lines |

## Task-Oriented Entry Points

Paths below are relative to the repository root. Pair the domain above with the relevant package/flow rows in the project map.

| Task | Start here |
|---|---|
| Provider implementation or metadata | `packages/core/src/providers/{index,model-catalog,provider-model-metadata}.ts`, `packages/core/src/types/index.ts`; inspect CLI runtime and Server catalogue/proxy separately |
| Subscription login or refresh | Core issuer/credential implementation; `packages/cli/src/cli/provider-auth-command.ts`, `packages/server/src/runtime/provider-oauth.ts`; distinguish storage label, issuer and inference authority |
| Sessions, copies or compaction | `packages/core/src/sessions/{session-manager,serialization,compaction-generation,compaction-preparation}.ts`; preserve raw journal versus model/export projections |
| SDK lifetime or store ownership | `packages/core/src/sdk/{agent-session,session-store,resource-loader}.ts`; no implicit executable/auth/MCP discovery |
| Run lifecycle or tool execution | `packages/core/src/agent/{runtime,tool-loop,provider-turn}.ts`; preserve physical settlement separately from cancellation acknowledgement |
| Extension loading or packages | `packages/core/src/extensions/{extension-registry,module-loader,module-manifest}.ts`, `packages/core/src/plugins/plugin-service.ts`; CLI/Server are host adapters |
| CLI syntax or standalone commands | `packages/cli/src/{index,commands/handler}.ts`, `packages/cli/src/cli/{provider-auth-command,export-command}.ts`; check both TUI help surfaces and installed goldens |
| Terminal editing/keybindings | `packages/cli/src/utils/{terminal-actions,keybinding-config,keybinding-source,keypress-gate,hotkey-view}.ts`, both input hosts and installed schema; keep passive browsing inert |
| HTTP/streaming contracts | `packages/server/src/index.ts`, `packages/server/src/api/`; update the matching `packages/web/src/services/api.ts` client and actual boundary tests |
| React view or optional asset lifetime | `packages/web/src/{App,index}.tsx`, `packages/web/src/components/`, `packages/web/src/store/`; preserve route/workspace/session identity and newer intent |
| Settings navigation/trust | Web `store/{settings-navigation,use-settings-scope,workspace-refresh}.ts`, `components/{SettingsView,settings-navigation,settings-categories}`; ready modal/category/General-panel ownership and preference memory grant no configuration authority |
| Localization | Web `src/i18n/`, `hooks/useI18n.tsx`, feature-local message modules; translate typed app codes, not arbitrary English API errors |
| MCP configuration/OAuth/hosting | Core `src/mcp/{config-inventory,registered-servers,session-host,resource-content,oauth,oauth-flow}.ts`, Server `api/mcp-routes.ts`, Web `McpSettings.tsx`; keep passive reads, Test and login distinct |
| Code mode/discovery | Core `src/tools/{codemode,codemode-worker,tool-search}.ts`, `src/config/codemode-limits.ts`, `src/providers/specialized-models.ts`; discovery never grants execution |
| Child agents | Server `src/runtime/{subagent-service,subagent-runtime}.ts`, `api/subagent-routes.ts`, Web `SubagentPanel.tsx`; reuse Core runtime and parent policy |
| Linked-directory consent | Core `src/security/linked-directory-*`, Server linked-directory service/routes; consent does not widen execution trust or allowed roots |
| Security | Core `src/security/`, Server `src/security/{request-security,credential-store}.ts`; recheck trust, capability, redaction and source lifetime |
| Static demo | `demo/`, `.github/workflows/demo-pages.yml`; validate with `bash demo/run-docker.sh`, independently of agent/backend tests |

## Documentation Maintenance

1. Read [`AGENTS.md`](./AGENTS.md) and [`acceptance/AGENTS.md`](./acceptance/AGENTS.md).
2. Select the relevant [workflow](./workflows/validate-document.md); verify claims against owning implementation and tests before editing.
3. Update the owning domain, not duplicated feature summaries in navigation.
4. Recalculate changed topic counts, run `make lint-docs` and `git diff --check`.
5. If runtime/build behavior changes, run the Docker validation required by the project map.

The [documentation audit from 2026-10-02](../audit/documentation/AUDIT-1.md) is a pinned historical snapshot, not a current inventory or a blanket guarantee that later documentation remains up to date. Historical test counts/failure receipts in technical topics do not replace validation of the current checkout; the retired comparison audit/evidence tree is no longer available in this tree.

## Human Documentation

Load these when the user requests human-documentation maintenance or the task requires its public contract.

| Audience/domain | French | English |
|---|---|---|
| User navigation | [Index](../users/fr/README.md) | [Index](../users/en/README.md) |
| User guide | [Guide](../users/fr/user-guide.md) | [Guide](../users/en/user-guide.md) |
| Operator runbook | [Operations](../users/fr/operations.md) | [Operations](../users/en/operations.md) |
| Containers | [Docker](../users/fr/containerization.md) | [Docker](../users/en/containerization.md) |
| Standalone authentication/export | [Commands](../users/fr/standalone-operations.md) | [Commands](../users/en/standalone-operations.md) |
| Terminal keybindings | [Keys](../users/fr/terminal-keybindings.md) | [Keys](../users/en/terminal-keybindings.md) |
| Contributor navigation | [Index](../contributors/fr/README.md) | [Index](../contributors/en/README.md) |
| Architecture | [Overview](../contributors/fr/architecture-overview.md) | [Overview](../contributors/en/architecture-overview.md) |
| Server architecture | [Server](../contributors/fr/server-architecture.md) | [Server](../contributors/en/server-architecture.md) |
| Web architecture | [Web](../contributors/fr/web-architecture.md) | [Web](../contributors/en/web-architecture.md) |
| CLI extensions | [Extensions](../contributors/fr/extensions-cli.md) | [Extensions](../contributors/en/extensions-cli.md) |
| Web extensions | [Extensions](../contributors/fr/extensions-web.md) | [Extensions](../contributors/en/extensions-web.md) |
| Public contracts and goldens | [Policy](../contributors/fr/public-contract-policy.md) | [Policy](../contributors/en/public-contract-policy.md) |
| Session SDK | [SDK](../contributors/fr/session-sdk.md) | [SDK](../contributors/en/session-sdk.md) |
| Localization | [i18n](../contributors/fr/i18n.md) | [i18n](../contributors/en/i18n.md) |

The user/contributor indexes also route to focused Settings, resource-batch, optional-pane, mobile and security guides. See the bilingual [screenshot inventory](../screenshots/README.md) for capture provenance and refresh instructions.
