# Web Application Architecture

> **Navigation:** See [`project-map.md`](../project-map.md) for repository boundaries and Docker validation.

## Overview

`@ai-harness/web` is a React/Vite client. Express remains authoritative for persisted sessions, workspaces, credentials, tools, and running agents; the browser owns drafts, bounded caches, preferences, viewport state, and declarative rendering.

HTTP and streaming contracts are defined in [`server-api.md`](./server-api.md). Session IDs, windows, dates, and reconciliation follow [`sessions.md`](./sessions.md).

## Main Entry Points

| File | Responsibility |
|---|---|
| `packages/web/src/index.tsx` | React root, `I18nProvider`, global styles and service worker bootstrap |
| `packages/web/src/App.tsx` | Auth bootstrap, route/deep-link restoration and top-level data hydration |
| `packages/web/src/store/session-store.ts` | Sessions, windows, drafts, runs, catalogues and bounded workspace cache |
| `packages/web/src/store/preferences.ts` | Versioned appearance, layout, notification, panel and keybinding state |
| `packages/web/src/services/api.ts`, `packages/web/src/services/mcp-api.ts` | Credential-aware fetch, REST/SSE contracts and Settings-lazy MCP import-preview/persistence/mutation requests |
| `packages/web/src/components/ChatView.tsx` | Detached runs, history, composer, queues, settings and reconciliation |
| `packages/web/src/components/{Sidebar,WorkspacePanel,TerminalPanel}.tsx` | Navigation, files/Git and PTY surfaces |
| `packages/web/src/components/SettingsView.tsx` | Lazy Settings route and administration sections |
| `packages/web/src/components/{McpSettings,McpImportPreview}.tsx` | Redacted global/project MCP groups, paste preview, field/reference completion, scope/confirmation-gated atomic import, trust lock, row/group activation, per-server exposure, confirmed removal, temporary undo and file diagnostics |
| `packages/web/src/components/PluginSettings.tsx` | Project/global package inventory, individual and one-request group activation, partial-result and reload-pending feedback |

## State Boundaries

| State | Authority and storage |
|---|---|
| Persisted sessions/messages | Server JSONL; browser keeps indexed windows only |
| `draft:*` conversation | Browser until first `POST /api/agent/runs` |
| Workspace cache | Per-tab `sessionStorage`, schema v2, 2 MiB and bounded entries |
| Scroll restoration | Separate per-workspace map, 24 entries and 24-hour expiry |
| Preferences | `localStorage`, schema v3 with v1/v2 migration and cross-tab updates |
| PTY tabs | Per-tab and keyed by workspace; server owns processes and replay |
| Credentials | Provider secrets stay server-side; auth uses HttpOnly cookie or legacy per-tab bearer, never workspace cache/preferences |

The cache favors draft text over binary previews, strips provider keys, and discards/reconciles remote windows when the server revision changes.

## Detached Conversation Flow

```text
local draft -> effective configuration -> POST /api/agent/runs
  -> server persists user message and returns run/session IDs
  -> GET session state, then SSE events after last sequence
  -> temporary assistant delta keyed by messageId
  -> terminal/tool events trigger canonical session resync
```

`ChatView` may render one temporary streamed assistant message. Terminal events must replace it with canonical history without duplicates. Reconnection restores run queues, retries, partial text, pending extension interaction, and sequence position.

## History and Scroll

- Start with the latest bounded window and fetch older pages with `before`.
- Use `around` to materialize a search/deep-link target not currently loaded.
- Above the threshold, virtualize rows while preserving stable message anchors.
- Capture scroll state when scrolling, not from reused DOM during route cleanup.
- Debounce storage and correct measured offset after rematerializing an anchor.
- Keep full export server-side.

## Workspace and Terminal Boundaries

A cwd change aborts stale requests, clears old file/search results, and keys React state so old PTY/file surfaces unmount before target state restores. Browser paths are never trusted directly: Server resolves them with `WorkspaceManager` and applies project trust before mutations or execution.

`WorkspacePanel` owns lazy tree/index, Git state/diffs, bounded uploads, file watching, and source/media/Markdown views. `TerminalPanel` dynamically loads xterm, resumes bounded ANSI output by UTF-8 offset, and stores tab IDs per workspace.

## Rendering and Extensions

- `MarkdownContentRenderer` sanitizes supported rich output; raw HTML remains non-executable.
- Tool turns render Process/Response blocks with bounded preview and explicit full-output retrieval.
- Extension widgets remain plain text; interactions are schema-driven dialogs, never extension React/DOM/HTML.
- Dialogs/palettes trap focus, handle Escape, and restore the previous target.
- Child runs appear in `SubagentPanel`, the global monitor, and bounded notices.

See [`extensions.md`](./extensions.md) for server-side ownership and interaction validation.

## Settings Packages and MCP Configuration

`PluginSettings` groups packages by Project and Global scope. **Enable all** and **Disable all** send only changed rows in one bounded API request rather than looping over cards. The returned catalogue replaces local state; ordered Core outcomes produce changed/unchanged/refused feedback, so a refused untrusted project enable does not hide successful entries. Package filters are not rewritten. Executable changes retain a visible pending notice until the separate atomic resource reload succeeds.

`McpSettings` requests the selected workspace through `getMcpConfig()`, reloads on cwd/trust changes, and keeps the returned inventory in component state only. It labels entries as Configured, Disabled, Invalid, or Replaced by project—never Connected—and renders only the already-redacted target, env/header names, command-backed field names and variable references returned by Core. A present untrusted project file shows a lock notice and no project names or values. File diagnostics use typed reasons translated in both built-in locales; server entry diagnostics are fixed, value-free schema messages.

`McpImportPreview` keeps pasted text only in component state and sends the original text, explicit foreign/AiHarness syntax choice and current cwd to the administrator preview route—never a browser-built configuration object. Text/syntax/workspace/inventory changes abort or invalidate stale requests. Returned cards contain only source kind, normalized name, masked target, structural field names, variable names, fixed notes and per-scope eligibility/confirmations. Literal env/header/OAuth values, argument text, source excerpts and writable normalized configuration never render.

A scope action opens a focus-trapped completion dialog. It collects a bounded target name, only the missing fields reported by Core, optional host-variable substitutions for reference-capable secret locations, and explicit confirmations for remaining global literals and named remote variables. The write request resends the original paste and these choices; Core reparses it and the browser never submits an approved normalized entry. Success replaces inventory with the server response and clears the paste. Every failure closes stale revision-backed controls and reloads canonical inventory; UI errors remain localized and generic.

Valid rows can be enabled, disabled, assigned `direct`, `codemode` or `deferred` tool exposure, or removed; each scope also has one-request bounded activation controls. Requests include the opaque revision from the last inventory. A removal uses an accessible confirmation dialog and only a short-lived opaque undo token crosses into the browser; the literal removed entry stays in server memory. Busy controls serialize browser intent; focus returns after cancellation and exposure changes or moves to Undo after removal, and any uncertain timeout/network result triggers a canonical reload because the write may already have committed. Server responses replace local inventory rather than applying speculative patches.

This panel still has no general add/edit, Test/sign-in or runtime controls beyond the reviewed single-entry import and local exposure flows. Do not implement a browser-side parser or resolver: source files, literal values, environment access and command handling stay entirely on the Server/Core side.

## PWA, Push, and i18n

The service worker caches the offline shell/static assets, never `/api` data. Updates require user activation. Web Push is explicit and category-specific; visible clients suppress duplicate service-worker notifications. Locale resolution uses registered language packages with English fallback and a persisted selection. Feature-only bilingual copy such as `mcp-import-messages.ts` stays co-located with the lazy Settings surface instead of inflating the eager locale registry.

## Build and Performance Contracts

- Settings, terminal/xterm, Mermaid, syntax highlighting, and other heavy surfaces stay lazy where configured.
- `packages/web/scripts/check-bundle-budget.mjs` fails eager, async, or CSS budget regressions.
- Visual coverage currently comprises 118 reviewed baselines, including the full MCP state/import-preview matrix in Light/Dark desktop/mobile layouts.
- Performance tests protect cache bounds, virtualization, and lazy loading.

## Associated Tests

- `packages/web/src/store/session-store.test.ts` plus `.remote.test.ts` and `.integration.test.ts` — hydration, windows, drafts, cache and run state
- `packages/web/src/store/preferences.test.ts` — schema migration and validation
- `packages/web/src/services/api.test.ts` — REST/SSE contracts, including MCP import-preview/original-text persistence/exposure/action bodies, typed errors and uncertain timeouts
- `packages/web/src/services/{push,pwa,keyboard,notices}.test.ts` — global browser services
- `e2e/chat.spec.ts`, `e2e/sessions.spec.ts`, `e2e/settings.spec.ts`, and `e2e/workspaces.spec.ts` — primary browser flows, including locked/redacted MCP inventory, non-mutating paste preview, completion/confirmation-gated atomic import, grouped activation, exposure selection, focus, undo and failure reconciliation
- `e2e/accessibility.spec.ts`, `e2e/performance.spec.ts`, and `e2e/visual.spec.ts` — a11y, bounds and baselines
- `e2e/live-server.spec.ts` — real browser-to-server smoke path

## Common Changes

### Change chat or session state

Update API parsing, store hydration/windows, `ChatView`, detached protocol fixtures, reconnection/duplicate tests, and long-history behavior together.

### Change a visible surface

Update component and scoped CSS, keyboard/focus behavior, responsive layouts, axe coverage, and Docker-generated visual baselines.

### Change browser persistence

Version and validate the schema, add migration/fallback tests, preserve bounds and secret stripping, and test cross-workspace/cross-tab behavior.

## Related Domains

- [`server-api.md`](./server-api.md) — HTTP, SSE and authentication contracts
- [`sessions.md`](./sessions.md) — canonical history, pagination and dates
- [`extensions.md`](./extensions.md) — declarative widgets and interactions
- [`security.md`](./security.md) — browser secrets, origins and workspace trust
