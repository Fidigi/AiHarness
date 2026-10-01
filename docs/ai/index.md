# AI Agent Documentation — AiHarness

Welcome to AiHarness's technical documentation, designed for AI agents. Each file covers a specific domain to load only the necessary context.

## 📚 Files by Domain

### Quick Navigation

| Domain | File | Context Load |
|---|---|---|
| Project overview | [`project-map.md`](./project-map.md) | ~400 lines — load first for global navigation |
| AI Providers | [`topics/providers.md`](./topics/providers.md) | ~100 lines |
| Sessions & Persistence | [`topics/sessions.md`](./topics/sessions.md) | ~115 lines |
| Extensions System | [`topics/extensions.md`](./topics/extensions.md) | ~120 lines |
| CLI Interface | [`topics/cli-reference.md`](./topics/cli-reference.md) | ~110 lines |
| Server API | [`topics/server-api.md`](./topics/server-api.md) | ~110 lines |
| Web Application (React) | [`topics/web-app-architecture.md`](./topics/web-app-architecture.md) | ~115 lines |
| Security & Trust | [`topics/security.md`](./topics/security.md) | ~115 lines |
| Child Agents | [`topics/child-agents.md`](./topics/child-agents.md) | ~115 lines |

### Reference Documentation

| File | Usage |
|---|---|
| [`AGENTS.md`](./AGENTS.md) | Documentation maintenance conventions for agents |
| `docs/audit/documentation/AUDIT-1` | Documentation structure, completeness & bilingual coverage audit (DONE) |

## 🎯 How to Use This Documentation

### For an Agent Working On...

**An AI provider** → Load only `providers.md` + the relevant package rows in `project-map.md` §3
```
→ packages/core/src/providers/index.ts
→ packages/core/src/types/index.ts (shared contracts)
→ packages/server/src/runtime/model-catalog.ts and api/proxy.ts
```

**A session or persistence change** → Load only `sessions.md` + `project-map.md` §4
```
→ packages/core/src/sessions/session-manager.ts
→ packages/core/src/sessions/serialization.ts
→ packages/core/src/sessions/compaction.ts
```

**The extensions system** → Load only `extensions.md` + `project-map.md` §4
```
→ packages/core/src/extensions/{extension-registry,module-loader}.ts
→ packages/cli/src/extensions/extension-loader.ts
→ packages/server/src/runtime/plugin-service.ts
```

**A CLI command** → Load only `cli-reference.md` + `project-map.md` §3
```
→ packages/cli/src/index.ts (composition root)
→ packages/cli/src/commands/handler.ts (command router)
→ packages/cli/src/tui/*.ts (UI implementations)
```

**A server API endpoint** → Load only `server-api.md` + `project-map.md` §§3–4
```
→ packages/server/src/index.ts (Express app, middleware)
→ packages/server/src/api/{domain}-routes.ts
→ packages/web/src/services/api.ts (client counterpart)
```

**The React/Web client** → Load only `web-app-architecture.md` + `project-map.md` §§3–4
```
→ packages/web/src/index.tsx, App.tsx
→ packages/web/src/store/*.ts
→ packages/web/src/components/{domain}.tsx
```

**Child agents** → Load only `child-agents.md` + `project-map.md` §4
```
→ packages/server/src/runtime/subagent-runtime.ts
→ packages/server/src/api/subagent-routes.ts
→ packages/web/src/components/SubagentPanel.tsx, SubagentSettings.tsx
```

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
| Internationalization | Contributors | [FR](../contributors/fr/i18n.md) / [EN](../contributors/en/i18n.md) |
| User/contributor navigation | Humans | [`users/README.md`](../users/README.md) / [`contributors/README.md`](../contributors/README.md) |
| Screenshot inventory | Humans | [`screenshots/README.md`](../screenshots/README.md) |
