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
| `packages/web/src/store/preferences.ts` | Versioned appearance, send-key, layout, notification, panel and keybinding state |
| `packages/web/src/services/api.ts`, `packages/web/src/services/mcp-api.ts` | Credential-aware fetch, REST/SSE contracts, workspace creation/file-manager/force-retry operations, and Settings-lazy MCP one-shot Test, explicit OAuth status/start/poll/paste/cancel/logout, import/replacement preview, persistence and local mutation requests |
| `packages/web/src/components/ChatView.tsx` | Detached runs, history, composer, queues, settings and reconciliation |
| `packages/web/src/components/{Sidebar,WorkspacePanel,TerminalPanel}.tsx` | Lazy navigation with bounded folder creation/host opening/worktree force retry, files/Git and PTY surfaces |
| `packages/web/src/components/SettingsView.tsx` | Lazy Settings route and administration sections |
| `packages/web/src/components/{McpSettings,McpImportPreview}.tsx` | Redacted global/project MCP groups and explicit Test reports, paste preview, field/reference completion, scope/confirmation-gated atomic import or replacement, trust lock, row/group activation, per-server exposure, confirmed removal, temporary undo and file diagnostics |
| `packages/web/src/components/PluginSettings.tsx` | Project/global package inventory, individual and one-request group activation, partial-result and reload-pending feedback |

## State Boundaries

| State | Authority and storage |
|---|---|
| Persisted sessions/messages | Server JSONL; browser keeps indexed windows only |
| `draft:*` conversation | Browser until first `POST /api/agent/runs` |
| Workspace cache | Per-tab `sessionStorage`, schema v2, 2 MiB and bounded entries |
| Scroll restoration | Separate per-workspace map, 24 entries and 24-hour expiry |
| Preferences | `localStorage`, schema v4 with v1/v2/v3 migration, validated Enter or Mod+Enter send mode, and cross-tab updates |
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

## History Edits and Live Settings

**Edit from here** stages a persisted user message in the current composer without a server mutation. A visible cancel control restores the previous draft and composer focus; navigation/reload discards the transient target. Only Send forks before that user entry and submits the replacement text on the new related session, preserving the source and excluding the old prompt. Staged input is literal conversation text, not a slash or shell command. **New chat from here** copies a persisted user entry even while its source run continues; neither source Stop nor active-leaf mutation is sent. Server refuses unwritten and running-command sources and locks in-session branch switching while busy.

Reasoning changes persist during streaming and apply at the next model request through Core's live host resolver. **Auto** clears the session override; the in-flight request retains its options and environment precedence remains authoritative.

Open the composer Model/Thinking scope disclosures to save the current model/provider or reasoning independently as a global new-session default. The save does not patch history, change a running request or enqueue a message. Project/environment overrides produce an explicit warning, including when a current session override hides them. Fresh drafts wait for their own effective configuration before sending and inherit its provider/model/thinking. Settings offers all seven reasoning levels plus inheritance, sends only dirty keys and disables saves when the settings read fails.

## History and Scroll

- Start with the latest bounded window and fetch older pages with `before`.
- Use `around` to materialize a search/deep-link target not currently loaded.
- Above the threshold, virtualize rows while preserving stable message anchors.
- Capture scroll state when scrolling, not from reused DOM during route cleanup.
- Debounce storage and correct measured offset after rematerializing an anchor.
- Keep full export server-side.

## Workspace and Terminal Boundaries

Sidebar directory reads are sequence guarded and visibly report the server's 500-entry truncation. Its focus-trapped creation dialog submits one direct-child name and navigates into the server-returned canonical folder. A host-file-manager button appears only after the no-store availability probe succeeds; it submits only the current cwd. Dirty worktree removal sends `force: false`, then asks separately before the one explicit `force: true` retry.

A cwd change aborts stale requests, clears old file/search results, and keys React state so old PTY/file surfaces unmount before target state restores. Browser paths are never trusted directly: Server resolves them with `WorkspaceManager` and applies project trust before mutations or execution. Workspace descriptors keep resource-sensitive `trusted` separate from persisted-decision `operationTrusted`; Sidebar prompts, file/search surfaces and project configuration gates use the latter (with a compatibility fallback only when older descriptors omit it), so an implicitly safe empty folder cannot silently authorize an operation.

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

`McpSettings` requests the selected workspace through `getMcpConfig()`, reloads on cwd/trust changes, and keeps the returned inventory in component state only. Configuration labels remain Configured, Disabled, Invalid, or Replaced by project; Connection state is shown separately in a Test report or volatile persistent-runtime status; neither configuration nor OAuth credential presence implies a currently connected session. Cards render only already-redacted targets, env/header names, command-backed field names and variable references returned by Core. A present untrusted project file shows a lock notice and no project names or values. File diagnostics use typed localized reasons; server entry diagnostics are fixed, value-free schema messages.

A valid row’s **Test** action sends only scope/name/current cwd to the administrator route—never the descriptor or configuration. All mutation/import controls are disabled while it runs. A successful bounded response shows tested time/duration, server identity, transport context and canonical cwd when applicable, capability counts, truncation/timeout state, and each bounded tool’s name, one-line description, read-only annotation and effective exposure. Error and stderr text is server-redacted and bounded; `needs-auth` explains that sign-in is a separate explicit action rather than starting OAuth. The component may attach the matching result immediately, then reloads canonical inventory so config/trust races and stale status are reconciled. Workspace changes invalidate pending UI results. A disabled but valid entry remains testable.

`McpImportPreview` keeps pasted text only in component state and sends the original text, explicit foreign/AiHarness syntax choice and current cwd to the administrator preview route—never a browser-built configuration object. Text/syntax/workspace/inventory changes abort or invalidate stale requests. Returned cards contain only source kind, normalized name, masked target, structural field names, variable names, fixed notes and per-scope eligibility/confirmations. Literal env/header/OAuth values, argument text, source excerpts and writable normalized configuration never render.

A scope action opens a focus-trapped completion dialog. It collects a bounded target name, only the missing fields reported by Core, optional host-variable substitutions for reference-capable secret locations, and explicit confirmations for remaining global literals and named remote variables. When Core marks a decision-free folder safe for its first project resource, the same dialog also requires a distinct fresh-project trust confirmation; only then does the import request include `trustProject: true`. The write request resends the original paste and these choices; Core reparses it and the browser never submits an approved normalized entry. Other mutation controls stay disabled while the dialog is open. Success replaces inventory with the server response and clears the paste. Every success or failure refreshes selected-workspace trust from Server, while failures close stale revision-backed controls and reload canonical inventory; trust is never changed optimistically and UI errors remain localized and generic.

A valid row's **Edit** action reuses that pipeline in a fixed scope. It sends only target scope/name/revision with the complete replacement paste for preview, never loads current hidden values into inputs, and warns that omitted fields are removed. The write uses the original text and bounded completion/confirmation choices plus `targetName`; the canonical response supplies only previous/new identity and redacted inventory. Other mutation controls remain disabled while an edit is open. Cancel, rename success and failure restore focus to the selected or canonical replacement row, with Refresh as a safe fallback.

Valid rows can be edited, enabled, disabled, assigned `direct`, `codemode` or `deferred` tool exposure, or removed; each scope also has one-request bounded activation controls. Requests include the opaque revision from the last inventory. A removal uses an accessible confirmation dialog and only a short-lived opaque undo token crosses into the browser; the literal removed entry stays in server memory. Busy controls serialize browser intent; focus returns after cancellation and exposure changes or moves to Undo after removal, and any uncertain timeout/network result triggers a canonical reload because the write may already have committed. Server responses replace local inventory rather than applying speculative patches.

Eligible HTTP rows have a distinct OAuth panel. Inventory remains passive; a separate bounded status POST revalidates scope/name/config key and returns only stored/signed-in booleans. Explicit Sign in submits only that selector plus cwd, then polls the detached flow once per second, renders a validated HTTPS (or loopback HTTP) authorization link, and accepts a pasted full callback address. Cancel remains available through exchange/verification, and Sign out invalidates server-side writers and closes matching process-local MCP connections. Phase/outcome/failure copy is bilingual; tokens, client secrets and PKCE verifiers never reach component state or browser storage. Cwd/trust changes invalidate pending action/status/poll results. Missing encrypted storage gives stable unavailable state, not plaintext credentials.

This panel still has no non-import add or long-lived runtime reconnect control. Test is deliberately one-shot and cannot invoke tools. Do not implement a browser-side parser, resolver or transport: source files, literal/resolved values, environment access, command handling, trust and connection cleanup stay entirely on the Server/Core side.

## PWA, Push, and i18n

The service worker caches the offline shell/static assets, never `/api` data. Updates require user activation. Web Push is explicit and category-specific; visible clients suppress duplicate service-worker notifications. Locale resolution uses registered language packages with English fallback and a persisted selection. Feature-only bilingual copy such as `mcp-import-messages.ts` stays co-located with the lazy Settings surface instead of inflating the eager locale registry.

## Build and Performance Contracts

- Settings, terminal/xterm, Mermaid, syntax highlighting, and other heavy surfaces stay lazy where configured.
- `packages/web/scripts/check-bundle-budget.mjs` fails eager, async, or CSS budget regressions.
- Visual coverage currently comprises 118 reviewed baselines, including the full MCP state/import-preview matrix in Light/Dark desktop/mobile layouts.
- Performance tests protect cache bounds, virtualization, and lazy loading.

## Associated Tests

- `packages/web/src/store/session-store.test.ts` plus `.remote.test.ts` and `.integration.test.ts` — hydration, windows, drafts, cache and run state
- `packages/web/src/store/preferences.test.ts` and `packages/web/src/components/composer-submit.test.ts` — schema migration, preference validation, newline shortcuts and IME-safe send decisions
- `packages/web/src/services/api.test.ts` — shared REST/SSE credential and response contracts, including minimal OAuth selectors even when callers pass full inventory rows
- `packages/web/src/services/{push,pwa,keyboard,notices}.test.ts` — global browser services
- `e2e/chat.spec.ts`, `e2e/sessions.spec.ts`, `e2e/settings.spec.ts`, and `e2e/workspaces.spec.ts` — primary browser flows, including MCP OAuth sign-in/paste/cancel/logout UI state, minimal-config-free MCP Test requests and identity/cwd/capability/tool reports, locked/redacted inventory, atomic import/replacement, fresh-project trust-plus-first-write, grouped activation, exposure, focus, undo and failure reconciliation
- `e2e/accessibility.spec.ts`, `e2e/performance.spec.ts`, and `e2e/visual.spec.ts` — a11y, bounds and baselines, including desktop/mobile Light/Dark workspace creation dialogs
- `e2e/defaults.spec.ts` — independent composer/Settings saves, fresh draft inheritance, unreadable settings, precedence warnings and reviewed responsive axe/overflow baselines
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
