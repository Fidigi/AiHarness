# AiHarness Architecture — Web Application

## Table of Contents

- [React components](#react-components)
- [Stores and persistence](#stores-and-persistence)
  - [`session-store.ts`](#session-storets)
  - [`preferences.ts`](#preferencests)
- [Rich rendering and sanitization](#rich-rendering-and-sanitization)
- [Accessibility and keyboard navigation](#accessibility-and-keyboard-navigation)
- [Current conversation flow](#current-conversation-flow)
- [PWA and service worker](#pwa-and-service-worker)
- [Validation and budgets](#validation-and-budgets)

## React components

The React application is organized around these main components:

| Component | Responsibility |
|---|---|
| `Sidebar` | workspace, trust, worktrees, search and session lifecycle |
| `ChatView` | rich history, agent execution/reconnection, composer, images, commands, branches and information |
| `WorkspacePanel` | files, Git changes, cancellable XHR upload and source/preview/diff viewer with monitoring |
| `TerminalPanel` | xterm tabs linked to server PTYs, dynamically loaded on first open |
| `CommandPalette` | keyboard search and execution of commands, sessions, settings and files |
| `StatusCenter` | bounded global queue of successes, warnings, errors and progressions, preserved during navigation with expiration suspended on hover/focus |
| `PluginSettings` | global/project packages, explicit installation, inventory, activation, updates, diagnostics and session-linked reload |
| `EcosystemSettings` | provider lifecycle/OAuth, custom providers and models, defaults, tools and skill registry |
| `SubagentSettings`, `SubagentPanel`, `SubagentMonitor` | global/project profiles, permissions, progress, attention, global notifications, stop and parent/child navigation |

For project overview, see [architecture-overview.md](./architecture-overview.md).

## Stores and persistence

### session-store.ts

Hydrates API contract dates and keeps in memory drafts, attachments, runs, per-session settings and workspace model/skill catalogs. Catalog requests are sequenced on project switch; activation is optimistic then confirmed by server response or restored on failure.

`SettingsView` groups and filters models, exposes availability/capabilities/provenance and triggers refresh; `ChatView` offers only activated and available entries from current provider. `PluginSettings`, lifted with a workspace key, has the same optimistic rollback for activation and reloads an isolated catalog on each cwd change.

A new chat uses local `draft:*` ID; its remote session is created only on first successful send. Run snapshots carrying older sequence are ignored so concurrent reconnection does not erase a newer queue.

The versioned v2 view cache accelerates the first render from `sessionStorage` before reconciliation and explicitly migrates v1 snapshots. It is limited to 2 MiB, three remote sessions, three drafts, 160 messages per session, and 24 hours. It prioritizes text/settings over bulky attachments, remembers the active provider and models without credentials, truncates heavy outputs, and systematically removes `providerConfig.apiKey`. A `pagehide` write protects the last change before reload.

The initial list receives only metadata and the total message count. The active conversation loads a bounded queue, then merges earlier pages or a window around a search result using global indexes. Non-contiguous ranges remain visible and reloadable. Beyond 120 messages, `@tanstack/react-virtual` mounts only visible rows; an identified anchor is materialized and then restored after page insertion. The root route resumes the active ID from the reconciled cache, previous/next navigation follows the workspace list, and a 404 removes an inaccessible local entry. A full export remains a server download and is never assembled in the store.

### preferences.ts

Persists a validated v3 browser document synchronized between tabs, with v1/v2 migration: theme, content width, font size, expanded reasoning, volume, independent sound/local-notification/Web Push categories, selection actions, panels, last section, and `Mod+…` keybindings. It stores no credential or Push subscription.

`ChatView` reuses the bounded workspace index for the `@` palette, switches to a server request when the index is truncated, and offers a turn/tool map compatible with pages and gaps. It stores at most 24 positions per workspace in `sessionStorage` for 24 hours: raw offset, distance from the bottom, and visible-entry ID/offset. Writes are deferred, storage errors are ignored, and an absent paginated anchor is loaded with `messages?around=` before repeated virtual-measurement correction.

## Rich rendering and sanitization

Rich rendering never injects model HTML. GFM and `file:` links are parsed by `react-markdown`/`rehype-sanitize`, KaTeX output passes through DOMPurify with `trust: false`, and `beautiful-mermaid` is imported only for a diagram block. Active Mermaid directives are filtered; the resulting SVG is stripped of imports/URLs and sanitized without `script`, `foreignObject`, `iframe`, `object`, or `embed` before insertion. The viewer reuses this rendering for Markdown/frontmatter, serves media through the download route, and listens to a file SSE stream to invalidate source, diff, and Git status together.

Search, content, diff, and hydration requests are cancelled or sequenced when their results become obsolete.

The `/api/sessions/:id/info` diagnostic aggregates messages, tools, usage/cost, and context without exposing secrets. The Web panel offers targeted copy actions and delegates full export to the server instead of assembling the entire journal in the browser. Each message retains its timestamp, provider/model, duration, and per-turn usage/cost. `ChatView` groups tools and reasoning into Process/Response, renders ANSI, keeps preview and context bounded, and uses `tool_result.fullContent` only after explicit expansion for copying or downloading.

Extension widgets render exclusively as text. The `confirm`, `input`, `select`, `editor`, and `custom` interactions produce declarative React controls without `dangerouslySetInnerHTML`; `AgentRuntime` revalidates their structured responses. The palette, widgets, and active requests resume from the snapshot/journal after navigation.

## Accessibility and Keyboard Navigation

Modals, palettes, drawers, zoom views, and extension interactions share a focus trap with restoration. `inert`, ARIA announcements, `focus-visible` styles, forced colors, and `prefers-reduced-motion` complete keyboard navigation.

## Current conversation flow

```text
ChatView
  -> POST /api/agent/runs (or queue of active run)
  -> local draft replacement by server session
  -> GET state
  -> GET events?after=sequence
  -> optimistic deltas identified by messageId
  -> session resync to terminal events
```

`LoginView` appears only when authentication is configured and no valid cookie session exists. If the server is merely offline, the shell remains navigable and displays loading errors.

## PWA and service worker

The production bundle is a PWA with an installable manifest/icon, offline fallback, explicitly updated service worker, and Web Push receiver. It caches only the shell and static resources, excludes `/api/`, checks for visible clients before displaying a notification, and opens the relative session URL on click. The release check shown in **About** remains independent: it starts after render, presents the link and notes as text, and never installs anything.

## Validation and budgets

Vitest covers Core contracts, the agent/extension runtime, providers, JSONL, workspace/Git, commands, PTY, configuration, catalogs and registries, OAuth, priced metrics, Push, subagents, security, real routes, and Web stores. Playwright covers the interface with an intercepted deterministic API **and** an end-to-end flow through Express, the mock provider, persistence, PTY, and files. `web-server.test.ts` adds Git/worktree/diff/upload/watch, PTY, and HTTP contracts without a browser. Dedicated suites verify axe/WCAG, focus and keyboard behavior, virtualization/cache, restoration, and deferred loading.

The 114 Light/Dark desktop/tablet/mobile baselines cover custom models/providers, the skill registry, extension process and dialogs, and established surfaces, with a maximum 2% difference threshold.

The Web build runs `packages/web/scripts/check-bundle-budget.mjs` after Vite and fails beyond:

| Budget | Limit |
|---|---|
| Raw entry / gzip | 500 KiB / 150 KiB |
| Eager JS assets gzip | 180 KiB |
| Async chunk raw / gzip | 1.6 MiB / 500 KiB |
| Raw CSS leaf | 64 KiB |

Canonical validations run in Docker:

```bash
make typecheck
make test
make test-e2e
make build-prod
```
