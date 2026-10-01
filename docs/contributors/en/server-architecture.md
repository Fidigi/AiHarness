# AiHarness Architecture — Server

## Table of Contents

- [Composition](#composition)
  - [Core services](#core-services)
  - [API routers](#api-routers)
- [Detached agent flow](#detached-agent-flow)
- [Shell commands and PTY terminals](#shell-commands-and-pty-terminals)
- [Configuration](#configuration)
- [HTTP security](#http-security)

## Composition

`packages/server/src/index.ts` assembles Express and the services created by `runtime/services.ts`. For the project overview, see [architecture-overview.md](./architecture-overview.md).

### Core services

- `SessionManager` and `JsonlSessionStore`;
- `AgentRuntime` and its event journal;
- `CommandRuntime` for session commands and `TerminalRuntime` for interactive PTYs;
- `WorkspaceManager` and `ProjectTrustManager`;
- `ConfigurationStore`, `ModelCatalogService`, `ProviderRegistryService` and persistent usage metrics;
- `PluginService`, `SkillCatalogService`, `SkillRegistryService` and `ExtensionModuleLoader`;
- `PushService` for VAPID and encrypted or volatile subscriptions;
- `SubagentService` for persisted profiles and `SubagentRuntime` for child executions;
- extension registry, built-in/custom providers and OAuth Device Flow.

### API Routers

| Module | Main Surface |
|---|---|
| api/agent-routes.ts | Detached runs, state, SSE, queues, commands, compaction, palette, interactions and extension reload |
| api/session-pagination.ts | Bounded tail/before/around message windows and revision metadata |
| api/workspace-routes.ts | Default cwd, validation, navigation, trust and worktrees |
| api/file-routes.ts | Tree, content/download, bounded index, explicit-collision upload, Git status/diff and SSE watching |
| api/terminal-routes.ts | PTY creation/listing, input, resize, offset-based SSE replay and close |
| api/config-routes.ts | Global/project/session layers and effective configuration |
| api/model-routes.ts | Grouped catalog, discovery and global/project model activation |
| api/provider-registry-routes.ts | Auth/OAuth, compatible providers, custom models, tests and imports |
| api/tool-routes.ts | Effective inventory and tool/preset settings at global or project level |
| api/plugin-routes.ts | Metadata-only catalog, install/activate/remove, check/update and atomic reload |
| api/skill-routes.ts | Skill catalog/invocation and globally/project-installable registry |
| api/push-routes.ts | VAPID public key, state, subscribe and unsubscribe Web Push |
| api/subagent-routes.ts | Global/project settings/profiles and child agent lifecycle |
| api/proxy.ts | Providers, credentials, priced metrics and legacy compatible chat endpoints |

Legacy `/api/chat*` endpoints remain available for compatibility, but the current Web application starts a run through `/api/agent/runs`.

## Detached Agent Flow

```text
POST /api/agent/runs
  -> cwd validation + trust
  -> optional session creation on first send
  -> AgentRuntime.start() returns 202 without waiting for model
  -> user message persisted
  -> model -> tools -> model ...
  -> messages/tools/usage persisted streaming

GET /api/agent/sessions/:id/state?messageLimit=80
  -> session snapshot + bounded queue

GET /api/sessions/:id/messages?before=<message-id>&limit=80
  -> previous page and global positions

GET /api/agent/sessions/:id/events?after=N
  -> connection.ready
  -> replay events > N
  -> live subscription + heartbeat
```

Closing the HTTP stream does not stop the run. On reconnection, the client first retrieves state and then resumes from its last sequence. If the cursor predates the bounded journal, the server requires a full snapshot. The snapshot also preserves a scheduled retry, active tool, and pending extension interaction, so the interface can restore phase, error, attention, and stop controls without duplicating a partial assistant message.

Every provider call in the tool loop, including intermediate turns, passes through the usage callback. `AiProxyServer` normalizes input/output/cache counters, prefers an explicit provider cost, and otherwise applies custom or published pricing. Legacy chat/SSE, compaction, automatic titles, and automatic summaries use the same counter. Provider totals are restored from and atomically written to `usage-metrics.json`; each turn’s cost is also persisted in its session.

After a message persists enough context, the loop passes the run’s `AbortSignal` to `SessionManager.checkAndTriggerCompaction()`. The effective scoped policy can disable this step. At the threshold, internal `compaction:start|end|error` events publish automatic mode, before/after/saved tokens, and cancellation; Server maps them to `compaction.started|completed|failed` run events. The summary reaches JSONL only after complete generation, so failure or cancellation leaves history intact. The Web application then reloads the canonical window, as after manual compaction, to remove replaced messages from the visible store.

`POST /api/sessions/:id/auto-name` sends at most eight truncated user/assistant messages to the selected provider, normalizes one title line to 100 characters, and persists it. `DELETE /api/sessions/:id` responds with `CASCADE_CONFIRMATION_REQUIRED` and every recursive descendant until `cascade=true` is explicitly confirmed; an independent clone is not a descendant.

## Shell Commands and PTY Terminals

`CommandRuntime` launches a bounded command in an approved cwd, captures stdout/stderr progressively, bounds journal memory, persists status/output/code/duration, and supports cancellation and replay. `!command` includes its result in model context; `!!command` keeps it in the session but excludes it from model context.

`TerminalRuntime` owns `node-pty` processes independently of HTTP request lifetimes. Each PTY has an approved canonical cwd, a bounded ANSI journal indexed by UTF-8 offsets, an exit state, and a process-wide instance limit. SSE routes start with `connection.ready`, signal a reset if the requested offset was evicted, replay output, and then follow live events. Input and dimensions are bounded; the shell environment is built from an allow-list without server/provider credentials. Closing a tab kills its process, and server shutdown kills every PTY. The xterm client handles emulation, selection/clipboard, resize, and workspace-specific tabs in `sessionStorage`; a workspace-keyed React boundary prevents an old cwd’s PTY from remaining mounted after a switch.

## Configuration

`ConfigurationStore` validates a closed list of non-secret keys, writes atomically with `0600` permissions, and `resolveEffectiveConfiguration()` applies one priority chain to the API, capabilities, runs, and compaction policy:

```text
defaults < global < project < persisted session < JSONL session fields < environment
```

The effective response associates each value with its provenance (`default`, `global`, `project`, `session`, or `environment`). Runtime fields `model`, `thinking`, `toolPreset`, and `autoCompaction` are conversation overrides serialized to JSONL. The Web protocol’s `settingOverrides` distinguishes presence from value: an absent key inherits, an explicit key persists the supplied value, and `null` removes the override. Legacy clients that omit this array retain their historical behavior and modify only request fields that are present.

`AI_HARNESS_DEFAULT_PROVIDER`, `AI_HARNESS_DEFAULT_MODEL`, `AI_HARNESS_DEFAULT_THINKING`, `AI_HARNESS_DEFAULT_TOOL_PRESET`, and `AI_HARNESS_AUTO_COMPACTION` feed the highest-priority environment layer and cannot be changed from the composer. A `null` patch at global/project scope removes an explicit value and restores inheritance. Credentials remain in environment variables, encrypted stores, or service memory; this store never accepts or returns them.

### Model Catalog

`ModelCatalogService` merges four non-secret sources: the published/versioned catalog, configured model, remote provider discovery, and custom models from `ProviderRegistryService`. OpenAI-compatible providers use `/models`, Gemini keeps models that support `generateContent`, Anthropic uses its catalog, and Azure does not invent generic discovery. Identifiers are normalized and deduplicated; a failure preserves the last valid result. Capabilities, context/output limits, prices, and compatibility are exposed without credentials. `GET /api/models?projectId=…&refresh=true` returns groups, availability, metadata, and activation provenance. `PATCH /api/models/enabled` accepts only qualified `provider:model` keys, requires `configuration`, and writes project or global scope while reading legacy IDs compatibly.

### Tools and Presets

`/api/tools` derives its inventory from the loaded `ExtensionRegistry` and stores `enabledTools`, preset, and PowerShell activation in `ConfigurationStore`. A `projectId` is never resolved alone: its canonical cwd is required. `AgentRuntime` then intersects the preset, scoped setting, subagent allow-list, and model `toolCalls` capability; the UI displays that same decision. PowerShell is registered only on Windows and is disabled by default.

### Skills

SkillCatalogService discovers global SKILL.md documents, from packages, explicit AI_HARNESS_SKILL_PATHS paths and project. Traversal bounded in depth, count and file size, does not follow symlinks, caches metadata per cwd and recalculates automatically after trust change. GET /api/skills returns only name, description, version, file, source, scope, trust level and invocation state: instruction body never leaves server. PATCH /api/skills/enabled accepts only discovered qualified keys, writes enabledSkills at project or global scope and refuses a project skill until workspace approved. Read-only load_skill tool exposes to model only activated and approved instructions; name duplicates follow priority project, explicit path, package, global. A child profile can still reduce this list with its skills allowlist.

### Skill Registry

SkillRegistryService explicitly reads HTTPS index AI_HARNESS_SKILL_REGISTRY_URL, bounded to 2 MiB/2000 entries and cached five minutes. Each SKILL.md limited to 256 KiB, downloaded without redirect or credentials, verified by mandatory SHA-256 and validated against announced metadata. Install and update atomically replace a global folder or approved .ai-harness/skills after lstat checks; failure restores previous version. Reading remains metadata-only; registry mutations demand packages capability.

### Plugins and Packages

PluginService persists in plugins.json global and project packages, independently of workspace-derived inventory. Accepts only npm:, an HTTPS Git URL on allowlist (AI_HARNESS_PLUGIN_GIT_HOSTS) or absolute path resolved by WorkspaceManager. Npm runs with --ignore-scripts --omit=dev; Git uses shallow clone then installs dependencies without scripts. Install and update pass through staging, rename and backup/trash with rollback, state atomically replaced in 0600 mode. No GET triggers install, remote check or update.

Inventory reads directory conventions or pi block of manifest, with depth/files/resources budgets, without following symlinks. API publishes only cleaned metadata, diagnostics and extension/skill/prompt/theme counts: no code/instructions, credentials or command output. Project packages configured but resources hidden before trust. Active skills provided internally to SkillCatalogService; invalidation mutates all derived caches so a global package does not remain stale in another workspace.

`POST /api/plugins/check` explicitly runs `npm view` or `git ls-remote`; updates reuse the same transactional replacement. `POST /api/plugins/reload` constructs and validates a candidate package generation, can resolve an in-memory or JSONL session, and rejects a different workspace. It then calls `RuntimeServices.reloadResources()`, which discovers global, trusted-project, and package extensions, imports them through the bounded loader, and atomically replaces commands, providers, tools, UI panels, hooks, and listeners in `ExtensionRegistry`. Failure in the same workspace preserves the previous generation; on an invalid workspace switch, `clear()` removes the old workspace’s handlers instead. `restartRequired` remains true only when executable code could not be committed. Loaded modules are trusted Node code running in the server process, not security-sandboxed code.

### Subagents

`SubagentService` provides the built-in **Explore**, **General purpose**, and **Plan** profiles, then persists global settings and full project copies to `subagents.json` by atomic write. It validates IDs, instructions, tool/skill/extension allow-lists, model, thinking, turn limit, context inheritance, and background mode. `/api/subagents/settings|profiles` exposes CRUD under the `configuration` capability. `SubagentRuntime` reuses `AgentRuntime`: it creates a JSONL child session linked by `parentId`, `parentAgentId`, and `agentId`; copies at most 40 messages/120,000 content characters; applies profile allow-lists; limits depth to three; and uses the configured process-wide concurrency of 1–16.

The built-in `spawn_subagent` tool, available in presets that permit reading, starts a profile with the parent’s provider and effective preset. A synchronous call waits for the result and follows parent cancellation; a background call immediately returns run and child-session IDs. The runtime publishes `subagent.started|updated|completed|failed` to the parent journal, retains up to 200 snapshots in memory, supports stop and attention acknowledgement, and stops children during shutdown. Child sessions/messages remain persisted, but the ephemeral run registry is not rebuilt after a server restart.

### Custom Providers and OAuth

ProviderRegistryService persists non-secret definitions in providers.json, their secrets in provider-secrets.enc only with AI_HARNESS_MASTER_KEY (otherwise memory). OpenAI Completions/Responses, Anthropic and Google dialects adapted to proxy, testable and discoverable. Custom models enrich capabilities, context, price and compatibility. ProviderOAuthService keeps device code server-side, imposes HTTPS endpoints and bounded responses/timeouts, then stores token directly in vault or proxy memory without returning it to browser.

### Web Push Notifications

PushService generates VAPID keys and keeps up to 1000 subscriptions in push.enc only if master key exists. Endpoints must be HTTPS and, outside tests, their DNS resolution cannot contain any private/loopback address. completion and attention notifications have independent categories, tag and relative URL; 404/410 responses remove subscription. Service worker deduplicates with visible clients and displays only after user-action-originated registration.

### Update Checking

`GET /api/app-update` exposes Web/agent versions separately and bounded release metadata. By default, the server queries GitHub Releases with a timeout, deduplicates concurrent requests, and caches the result for six hours; errors and invalid responses become a non-sensitive diagnostic. This route neither downloads nor installs binaries.

## HTTP Security

- loopback listen by default; non-loopback listen refused without token;
- User/admin Bearer or opaque Web session in HttpOnly, SameSite=Strict cookie;
- distinct capabilities for read, workspace/file write, terminal, configuration, credentials and packages administration;
- Origin verification on mutations and WebSocket upgrades;
- JSON/upload limits, in-memory rate limiting and neutralized 5xx messages;
- WebSocket authentication by cookie, Bearer or subprotocol (query token only compatible with legacy clients).

In multi-replica deployment, reverse proxy must also apply rate limits and HTTPS.
