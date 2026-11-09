# AI Agent Documentation — AiHarness

Welcome to AiHarness's technical documentation, designed for AI agents. Each file covers a specific domain to load only the necessary context.

## 📚 Files by Domain

### Quick Navigation

| Domain | File | Context Load |
|---|---|---|
| Project overview | [`project-map.md`](./project-map.md) | ~660 lines — load first for global navigation |
| AI Providers | [`topics/providers.md`](./topics/providers.md) | ~1260 lines — independently bound Together17-C (production held),Fireworks8-C (both constructions held),Zen28-C (canonical construction held),Go20-C,Zen7-G,Zen18-A/30-R and Go5-A/6-R private SDK subsets (other APIs/hosts/defaults separate); bounded original Responses encrypted continuation (not crypto/account/CLI qualification); explicit Kimi issuer/Bearer selection (not account/subscription acceptance); E78 explicit Moonshot CN constructor/shared pinned C policy and native global/CN JSON/SSE requested-model capture (297 loopback/three intercepted defaults/four RPC prompts;preserved provenance failure,not ambient auth,Settings or regional accounts),E77 explicit MiniMax CN constructor/default/shared pinned A policy (259 loopback/three intercepted endpoint controls;no ambient key,factory,Settings or regional account certificate),E76 explicit Zen83-chat/two-native-classifier A/G/C/R/T supplied-key SDK/private Google REST/83 local RPC prompts (owning CLI SIGSEGV/Hugging Face emitted child-code:null failures retained;not whole acceptance),E75 explicit OpenCode Go mixed A/C/R key SDK/31 local RPC prompts (genuine temperature defect/correction preserved;selected setup/unit/parity failures remain despite112 artifact/17 browser passes),E74 explicit Kimi Coding A key SDK/four local RPC prompts (selected/unit/parity failed;110 artifact/17 retained browser passes do not repair them;subscription OAuth remains separate),E73 Xiaomi C SDK (failed unit/production and54 not-run families retained),E72 Together/Baseten/Ant Ling JSON fallback capture,native Bedrock/Azure/Mistral,explicit Hugging Face C (E71 fallback capture;failed gates/history retained),mixed Fireworks A/C and Together/Baseten/Meta/Ant Ling/xAI/MiniMax SDKs,explicit NVIDIA/Moonshot/Z.ai/Groq/DeepSeek/Cerebras SDKs/custom hosts,NVIDIA poll-header override priority,mixed OpenAI R/D/Cloudflare C/S/OpenRouter SDKs/custom hosts,adapter-owned metadata/windows/thinking,private lifecycle and API-specific accounting/provenance |
| Model Dispatch Policies | [`topics/model-dispatch-policies.md`](./topics/model-dispatch-policies.md) | ~105 lines — virtual routing, actual-adapter physical thinking clamps, provenance, billable warming and historical notices |
| Pinned Provider / Configuration Matrix | [`topics/provider-matrix.md`](./topics/provider-matrix.md) | 188 lines — E78 explicit Moonshot CN C SDK (24 groups/824 projections,not full42-factory composition),E77 explicit MiniMax CN A SDK (23 groups/820 projections,not unique usable models or full composition),E76 Zen83-chat/two-native-classifier mixed key SDK (22 groups/817 projections,not42-factory/full-profile/account composition),E75 31-profile OpenCode Go mixed A/C/R key SDK (not factory/Server/Settings/account or full-profile qualification),E74 four-profile Kimi Coding A key SDK/subscription gap,E73 Xiaomi C SDK/three regional-plan gaps (failed unit/production and54 not-run families retained),E72 JSON fallback capture,42 factories,API/auth gaps,pinned explicit Hugging Face C (E71 fallback capture;failed gates/history retained),mixed Fireworks A/C and Together/Baseten/Meta/Ant Ling/xAI/MiniMax SDKs,explicit NVIDIA/Moonshot/Z.ai/Groq/DeepSeek/Cerebras SDKs/custom hosts,NVIDIA poll-header ownership,mixed custom hosts,adapter-owned R/A-C/C/Cerebras/DeepSeek/Groq/Z.ai/Moonshot/Mistral metadata/thinking plus NVIDIA declarations,preserved native discovery and numeric host composition |
| Sessions & Persistence | [`topics/sessions.md`](./topics/sessions.md) | ~230 lines — native journals, actual-adapter compaction windows and independent session scopes |
| Session Context State | [`topics/session-context-state.md`](./topics/session-context-state.md) | ~100 lines |
| TypeScript Session SDK | [`topics/session-sdk.md`](./topics/session-sdk.md) | ~75 lines |
| Native Run Lifecycle | [`topics/run-lifecycle.md`](./topics/run-lifecycle.md) | ~130 lines — lifetime, queues, bounded recovery and parallel/nested/rich results |
| Extensions System | [`topics/extensions.md`](./topics/extensions.md) | ~270 lines — owned MCP registration and generation retirement |
| Native Extension / SDK Contract | [`topics/native-extension-contract.md`](./topics/native-extension-contract.md) | ~110 lines — host/import/event/UI/package adaptation |
| CLI Interface | [`topics/cli-reference.md`](./topics/cli-reference.md) | ~430 lines |
| CLI Invocation Contract | [`topics/cli-invocation-contract.md`](./topics/cli-invocation-contract.md) | ~150 lines — explicit issuer/storage-label separation and post-loading authorization deadline |
| Native Terminal Contract | [`topics/terminal-contract.md`](./topics/terminal-contract.md) | ~140 lines — capabilities, 90 pinned/29 native actions, stored-only settings and PTY boundaries |
| Terminal Themes | [`topics/themes.md`](./topics/themes.md) | ~80 lines |
| Native Editor Schemas | [`topics/editor-schemas.md`](./topics/editor-schemas.md) | ~85 lines |
| QuickJS Code Mode | [`topics/codemode.md`](./topics/codemode.md) | ~155 lines — trusted limits, native questions/images, explicit OpenRouter classifiers and sandbox |
| Server API and lifecycle | [`topics/server-api.md`](./topics/server-api.md) | ~240 lines |
| Web Application (React) | [`topics/web-app-architecture.md`](./topics/web-app-architecture.md) | ~210 lines |
| Detached Stream Reconstruction | [`topics/detached-streams.md`](./topics/detached-streams.md) | ~90 lines |
| Static Demonstration | [`topics/static-demo.md`](./topics/static-demo.md) | ~120 lines |
| Linked-Directory Consent | [topics/linked-directories.md](./topics/linked-directories.md) | ~66 lines |
| Security & Trust | [`topics/security.md`](./topics/security.md) | ~225 lines — explicit provider issuer, bounded registration and publication versus later rejection |
| Native Security Contract | [`topics/native-security-contract.md`](./topics/native-security-contract.md) | ~105 lines — explicit issuer, bounded token registration and CAS/publication versus later rejection |
| Child Agents | [`topics/child-agents.md`](./topics/child-agents.md) | ~115 lines |

### Reference Documentation

| File | Usage |
|---|---|
| [`AGENTS.md`](./AGENTS.md) | Documentation maintenance conventions for agents |
| `docs/audit/documentation/AUDIT-1` | Documentation structure, completeness & bilingual coverage audit (DONE) |
| `docs/audit/pi/AUDIT-5` | Active pinned Pi/Pi Web comparison, stable criteria and prioritized work packages; global qualification tracked separately |

## 🎯 How to Use This Documentation

### For an Agent Working On...

**An AI provider** → Load `providers.md` + the relevant package rows in `project-map.md` §3; add `model-dispatch-policies.md` for virtual selection, direct summary routing, cache economics or durable warming usage
```
→ packages/core/src/providers/index.ts
→ packages/core/src/types/index.ts (shared contracts)
→ packages/server/src/runtime/model-catalog.ts and api/proxy.ts
```

**A session or persistence change** → Load `sessions.md` + `project-map.md` §4; add `session-context-state.md` for edits, prompt/tool provenance or compaction checkpoints
```
→ packages/core/src/sessions/session-manager.ts
→ packages/core/src/sessions/serialization.ts
→ packages/core/src/sessions/compaction-{generation,preparation}.ts
```

**The extensions system** → Load only `extensions.md` + `project-map.md` §4
```
→ packages/core/src/extensions/{extension-registry,module-loader}.ts
→ packages/cli/src/extensions/extension-loader.ts
→ packages/server/src/runtime/plugin-service.ts
```

**A CLI command** → Load `cli-reference.md`, the versioned `cli-invocation-contract.md` option/channel map, and `project-map.md` §3
```
→ packages/cli/src/index.ts (composition root)
→ packages/cli/src/cli/{provider-auth-command,export-command}.ts (standalone operations)
→ packages/cli/src/commands/handler.ts (conversation command router)
→ packages/cli/src/tui/*.ts (UI implementations)
→ tests/functional-parity/ (public contract probes and reviewed goldens)
```

**Terminal editing, keybindings or passive hotkey browsing** → Load `terminal-contract.md`, `cli-reference.md` and the CLI rows in `project-map.md`; inspect `packages/cli/src/utils/{terminal-actions,keybinding-config,keybinding-manager,keybinding-source,keypress-gate,hotkey-view}.ts`, both input hosts, schema copy and actual emitted/packed PTY tests. Preserve reserved driver controls and draft/caret/history; never execute actions or predicates to render the view.

**A server API endpoint or startup lifecycle** → Load only `server-api.md` + `project-map.md` §§3–4
```
→ packages/server/src/index.ts (Express app, middleware)
→ packages/server/src/api/{domain}-routes.ts
→ packages/web/src/services/api.ts (client counterpart)
```

**The React/Web client, including router/store identity and optional-pane/form lifetimes** → Load only `web-app-architecture.md` + `project-map.md` §§3–4
```
→ packages/web/src/index.tsx, App.tsx
→ packages/web/src/store/*.ts
→ packages/web/src/components/{domain}.tsx
```

**Settings navigation, scope memory or trust refresh** → Load `web-app-architecture.md` and the Web persistence rows in `project-map.md`; inspect `store/{settings-navigation,use-settings-scope,workspace-refresh}.ts`, the stable `SettingsView` boundary, `components/settings-navigation.ts`, owning unit controls, `e2e/settings-navigation.spec.ts` and built-asset `e2e/pane-lifetime.spec.ts`. Keep metadata separate from configuration/authority, conserve fresh peer positions and withdraw deferred focus on newer intent.

**UI localization or diagnostics** → Load `web-app-architecture.md` + the i18n rows in `project-map.md`; use typed app codes from `packages/core/src/mcp/config-inventory.ts`, feature-local `packages/web/src/components/{mcp-entry-messages,tool-progress-messages}.ts`, the registry and Settings allocation tests. Preserve arbitrary technical details and the existing lazy/fill-only copy boundary; never classify API errors by English text.

**The separate static demo or Pages artifact** → Load `static-demo.md` + the root/validation rows in `project-map.md`; use `bash demo/run-docker.sh`, not production agent APIs.

**MCP configuration inheritance, hosting, OAuth, or discovery** → Load `security.md` + the MCP flow in `project-map.md` §4 and the [native MCP-01 field/lifecycle contract](../audit/pi/MCP-01.md) plus [MCP-02 exposure/selection](../audit/pi/MCP-02.md) and [MCP-03 resources/rich results](../audit/pi/MCP-03.md), plus [MCP-04 owned registrations](../audit/pi/MCP-04.md) for extension provenance/retirement; add `server-api.md` or `cli-reference.md` for the adapter
```
→ packages/core/src/mcp/{config-inventory,registered-servers,session-host,resource-tools,resource-content,oauth,oauth-provider-factory,oauth-flow}.ts
→ packages/core/src/tools/tool-search.ts
→ packages/server/src/api/mcp-routes.ts
→ packages/web/src/components/McpSettings.tsx
```

**Code-mode sandbox or nested calls** → Load `codemode.md` + the code-mode flow in `project-map.md` §4
```
→ packages/core/src/tools/{codemode,codemode-worker,tool-search}.ts
→ packages/core/src/config/codemode-limits.ts
→ packages/core/src/providers/{specialized-models,classification-questions}.ts
→ packages/server/src/api/tool-routes.ts
→ e2e/{codemode,codemode-live}.spec.ts
```

**Child agents** → Load only `child-agents.md` + `project-map.md` §4
```
→ packages/server/src/runtime/subagent-runtime.ts
→ packages/server/src/api/subagent-routes.ts
→ packages/web/src/components/SubagentPanel.tsx, SubagentSettings.tsx
```

**Linked-directory browsing/consent** → Load [linked-directories.md](./topics/linked-directories.md) plus the workspace/security rows in `project-map.md`; keep source trust independent and re-admit every target/descendant handle.

**A security change** → Load only `security.md` + the security rows/flows in `project-map.md` §§3–6
```
→ packages/core/src/security/
→ packages/server/src/security/request-security.ts
→ packages/server/src/security/credential-store.ts
```

## 🔄 Recommended Workflow

1. **Identify the domain** via the table above
2. **Read `AGENTS.md`** for documentation maintenance conventions
3. **Load only** the thematic file + corresponding section from `project-map.md`
4. **Consult `project-map.md`** if cross-package context or validation workflow is needed

## 📐 Design Principles

- **One file = one conceptual domain** — no mixing providers/sessions/CLI in same file
- **Self-contained and sufficient** — each file contains everything needed to work on its domain
- **Cross-references** — related domains are pointed at end of file, not duplicated
- **Automatic maintenance** — agents maintain this documentation during changes

## ⚠️ External Documentation (Non-Agents)

These files do NOT belong to the agent documentation system:

| Surface | Audience | French / English entry points |
|---|---|---|
| User guide | End users | [FR](../users/fr/user-guide.md) / [EN](../users/en/user-guide.md) |
| Container guide | Operators | [FR](../users/fr/containerization.md) / [EN](../users/en/containerization.md) |
| Architecture overview | Contributors | [FR](../contributors/fr/architecture-overview.md) / [EN](../contributors/en/architecture-overview.md) |
| Server architecture | Contributors | [FR](../contributors/fr/server-architecture.md) / [EN](../contributors/en/server-architecture.md) |
| Web architecture | Contributors | [FR](../contributors/fr/web-architecture.md) / [EN](../contributors/en/web-architecture.md) |
| CLI extensions | Contributors | [FR](../contributors/fr/extensions-cli.md) / [EN](../contributors/en/extensions-cli.md) |
| Web extensions | Contributors | [FR](../contributors/fr/extensions-web.md) / [EN](../contributors/en/extensions-web.md) |
| Public contracts and parity | Contributors | [FR](../contributors/fr/public-contract-policy.md) / [EN](../contributors/en/public-contract-policy.md) |
| Resource group batches | Users / contributors | [FR user](../users/fr/resource-batches.md) / [EN user](../users/en/resource-batches.md); [FR contributor](../contributors/fr/resource-batches.md) / [EN contributor](../contributors/en/resource-batches.md) |
| Session SDK | Contributors | [FR](../contributors/fr/session-sdk.md) / [EN](../contributors/en/session-sdk.md) |
| Internationalization and lazy Settings copy | Contributors / users | [FR contributor](../contributors/fr/i18n.md) / [EN contributor](../contributors/en/i18n.md); [FR loading](../users/fr/settings-loading.md) / [EN loading](../users/en/settings-loading.md) |
| Settings navigation | Users | [FR](../users/fr/settings-navigation.md) / [EN](../users/en/settings-navigation.md); per-folder intent, fresh fallback, trust retirement and storage limits |
| Optional file-pane loading | Users | [FR](../users/fr/workspace-loading.md) / [EN](../users/en/workspace-loading.md) |
| Terminal keybindings | Users | [FR](../users/fr/terminal-keybindings.md) / [EN](../users/en/terminal-keybindings.md); all actions, passive view, source/reload and schema limits |
| Standalone authentication/export | Users / operators | [FR](../users/fr/standalone-operations.md) / [EN](../users/en/standalone-operations.md) |
| Mobile keyboard layout | Users | [FR](../users/fr/mobile-keyboard.md) / [EN](../users/en/mobile-keyboard.md); conservative detection and device limits |
| User/contributor navigation | Humans | [`users/README.md`](../users/README.md) / [`contributors/README.md`](../contributors/README.md) |
| Screenshot inventory | Humans | [`screenshots/README.md`](../screenshots/README.md) |
