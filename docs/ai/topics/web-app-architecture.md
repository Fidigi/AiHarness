# Web Application Architecture

> **Navigation:** See [`project-map.md`](../project-map.md) for repository boundaries and Docker validation.

## Overview

`@ai-harness/web` is a React/Vite client. Express remains authoritative for persisted sessions, workspaces, credentials, tools, and running agents; the browser owns drafts, bounded caches, preferences, viewport state, and declarative rendering.

HTTP and streaming contracts are defined in [`server-api.md`](./server-api.md). Session IDs, windows, dates, and reconciliation follow [`sessions.md`](./sessions.md).

## Main Entry Points

| File | Responsibility |
|---|---|
| `packages/web/src/index.tsx` | React root, urgent declarative router identity, `I18nProvider`, global styles and service worker bootstrap |
| `packages/web/src/App.tsx` | Auth bootstrap, route/deep-link restoration and top-level data hydration |
| `packages/web/src/store/session-store.ts` | Sessions, windows, drafts, runs, catalogues and bounded workspace cache |
| `packages/web/src/store/preferences.ts` | Versioned appearance, send-key, layout, notification, panel and keybinding state |
| `packages/web/src/services/api.ts`, `packages/web/src/services/mcp-api.ts` | Credential-aware fetch, REST/SSE contracts, workspace creation/file-manager/force-retry operations, and Settings-lazy MCP one-shot Test, explicit OAuth status/start/poll/paste/cancel/logout, import/replacement preview, persistence and local mutation requests |
| `packages/web/src/components/ChatView.tsx` | Detached runs, history, composer, queues, settings and reconciliation |
| `packages/web/src/components/{ExtensionInteractionBoundary,ExtensionInteractionDialog}.tsx` | Ordered pending-head form, waiting count, own lazy CSS and guarded response/focus/IME lifetimes |
| `packages/web/src/components/{Sidebar,WorkspacePanel,WorkspacePanelBoundary,TerminalPanel}.tsx` | Lazy navigation, locally admitted optional file-pane JS/CSS, unchanged files/Git and PTY surfaces |
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

`BrowserRouter useTransitions={false}` keeps location updates urgent alongside the synchronous Zustand workspace/session store. A canonical browser URL must not leave the previous React route epoch available for a file intent that a delayed navigation commit then retires. Keep the pane's complete workspace/cwd/session/navigation key and true-navigation cancellation; do not repair the writer by replaying across scopes.

## Detached Conversation Flow

```text
local draft -> effective configuration -> POST /api/agent/runs
  -> server persists user message and returns run/session IDs
  -> GET session state, then SSE events after last sequence
  -> temporary assistant delta keyed by messageId
  -> terminal/tool events trigger canonical session resync
```

`ChatView` may render one temporary streamed assistant message. Terminal events must replace it with canonical history without duplicates. Reconnection restores run queues, retries, partial text, pending extension interaction, and sequence position.

Durable transcript publication is separate from run/queue setter admission. `canSyncCanonicalSession` requires a private session-bound canonical witness, current collection generation/epoch/workspace/active-session identity and a nonstale sequence. Same-run SSE advancement may retire the setter without invalidating that transcript; known terminal recovery never reopens an absent run. Readiness resets/gaps trigger a fresh guarded GET because readiness contains no messages. A foreign `run.started` is only a discovery hint: its payload/version is not consumed, and fresh canonical state must independently name that exact run. Only the matching terminal settlement can pass an already-terminal event fence. Failed admitted state publishes the same stable error-notice ID as live failure, including when failure precedes subscription.

Session title metadata is presentation data, not SSE lifetime identity: a canonical title refresh must not restart ChatView’s subscription or discard a valid notice. The three existing attention/completion/failure Notification sites read the latest canonical title already in the store for the subscribed session at dispatch, with `AiHarness` for an absent/empty title. Existing session/cwd replacement and unmount still withdraw owned transport; this is not a new full-address SSE epoch.

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

`WorkspacePanelBoundary` imports the real panel and original stylesheet together only at the workspace-eligible open-pane call site. Its key includes workspace ID/cwd, active session, navigation key and pathname/search/hash. Address fields also retire navigation when external history entries reuse the router's fallback key. Markdown file links capture their actual origin element and address before showing the pane; their next-task dispatch is suppressed after address change or origin disconnection, rather than publishing into an already replaced boundary. This is presentation lifetime, not file/trust authority. Local nonmodal loading/error exposes Close/Cancel without focus mutation or global suspension; failed imports stay rejected on reopen. Explicit page-reload retry warns about unsent text. A latest bounded file intent survives loading and the DOM/passive-listener gap; replay waits one task for the child's development StrictMode setup, is cancelled on teardown, and is superseded by newer live intent. Loading grants no new path/trust authority; see the bilingual [file-pane loading guide](../../users/en/workspace-loading.md).

`WorkspacePanel` retains tree/index, Git state/diffs, bounded uploads, file watching, and source/media/Markdown ownership. `TerminalPanel` dynamically loads xterm, resumes bounded ANSI output by UTF-8 offset, and stores tab IDs per workspace.

## Mobile Keyboard Layout

`hooks/useMobileKeyboard.ts` observes eleven fixed browser events with one coalesced animation frame. Compact chat needs editable focus, a coarse pointer, width ≤959 CSS pixels and height loss above max(160px, 20%) against a trusted unzoomed baseline; closing uses max(120px, 15%) hysteresis. Pinch-only loss, toolbar motion and panning do not open it. Focused rotation waits for blur before reseeding.

The view identity is a tuple of workspace ID/cwd, session ID and route key. Replacement scopes discard old publication and require fresh focus/input/composition intent. `hooks/mobileKeyboardStyles.ts` loads `hooks/mobile-keyboard.css` through a URL-only import; publication waits for readiness and a fresh measurement. Failed links are removed, stalled requests have an eight-second deadline, and a closed sample rearms retry. Disposal cancels the request, frame and listeners; success retains the link until its owner retires.

Secondary chat chrome collapses without replacing the composer, images, Queue or Stop. Settings and MCP keep their own styles. Floating/overlay keyboards without viewport loss and initially zoomed/resized mounts may remain undetected; Chromium touch emulation is not physical Android/iOS/Safari certification. See the [mobile keyboard guide](../../users/en/mobile-keyboard.md).

## Rendering and Extensions

- Memoized `MarkdownContentRenderer` shares currency/math, CJK autolink, raw-text and initial frontmatter parsing across messages, file previews and noninteractive minimap/accessibility projections. Only user messages preserve soft breaks. Raw HTML remains non-executable.
- Composer paste treats plaintext as authoritative. An inert template provides bounded optional link metadata (65,536 code units, 1,024 nodes, 32 links); every failure/overflow preserves complete plaintext. List continuation obeys newline/send-mode/IME rules and restores the caret only on the same connected textarea.
- Tool turns render Process/Response blocks with bounded preview and explicit full-output retrieval.
- Extension widgets remain plain text; interactions are schema-driven dialogs, never extension React/DOM/HTML.
- App registers global shortcuts in a layout effect before bootstrap DOM observers or input can see an unregistered committed shell; matching and view eligibility remain with the existing App handler. Preference setters update their own hook state before broadcasting, so an early write cannot be lost before passive subscription.
- Dialogs/palettes trap focus and handle Escape. Deferred initial/return focus belongs to one modal lifetime: remount retires old return, and a newer explicit focus destination supersedes it. Return uses only a connected, visible, enabled, non-inert invoker or fallback, and cannot leave another active modal scope.
- Child runs appear in `SubagentPanel`, the global monitor, and bounded notices.

Ordered extension presentation uses `ExtensionInteractionBoundary`: the real renderer and own stylesheet load only for a pending request. Local nonmodal loading/error keeps Close/Cancel, chat and Stop usable; rejection remains cached until explicit page reload with an unsent-text warning. Complete workspace/cwd/session/run/route identity retires stale transport and late presentation. Aborting transport suppresses browser publication, not an already accepted server response. Compatible same-ID/kind drafts and connected IME survive schema refresh; composition/legacy-229 Enter and Escape cannot acknowledge/cancel the form. Initial-focus admission observes intent even before import completes and again before first-frame focus. A replacement route presenting the same request is not fresh focus intent. Return is view/fallback/newer-focus/modal guarded; coarse pointers avoid unsolicited editable focus but permit guarded return after owned manual editing. The same mounted form advances between queue heads without intermediate restoration; editable intent belongs to the current head, not a previous head. This is not physical-device certification.

`session-store.ts` returns an explicit boolean admission receipt: accepted identical observations preserve callback authority, while stale replies are rejected. Session journal watermarks and run versions are separate. Exact same-version captured-head acknowledgement uses a private reply witness, not a generic membership exemption. App polling and Chat transport use full-address local lifetimes; bootstrap waits for canonical workspace id/cwd. Own-key access supports legal prototype-like session IDs. Negative retirement memory stays bounded (256 exact session records, 16 exact retired runs, conservative 1,024-bit filters); fresh privately witnessed current-state discovery may recover collisions. These are browser-local guards, not backend settlement, durable tombstones or a general fork-transaction guarantee.

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

The service worker caches the offline shell/static assets, never `/api` data. Updates require user activation. Web Push is explicit and category-specific; visible clients suppress duplicate service-worker notifications. Locale resolution uses registered language packages with English fallback and a persisted selection. Feature-only bilingual copy such as `mcp-import-messages.ts` stays co-located with the lazy Settings surface. `SettingsLocaleBoundary.tsx` additionally loads `settings-locale.ts` on entry and registers both built-in feature dictionaries before mounting business controls. Shared/dynamic/default copy stays eager; fill-only registration preserves live package references and custom overrides. Translated loading/error/Close remain local, and explicit Reload and retry reloads the page because failed ESM imports remain rejected on reopen. Unmount/navigation invalidates late completion without focus, scroll or navigation effects. This is copy allocation, not complete localization of every residual feature; see the bilingual [i18n contributor guide](../../contributors/en/i18n.md).

## Build and Performance Contracts

- Settings, optional file-pane and extension-form JS/CSS, terminal/xterm, Mermaid, syntax highlighting, and other heavy surfaces stay lazy where configured.
- `packages/web/scripts/check-bundle-budget.mjs` fails eager, async, or CSS budget regressions.
- E2E snapshots comprise 206 PNGs: 178 earlier accepted baselines, twelve mobile keyboard, eight linked-directory, four provider-rename and four interaction-queue additions. This includes the MCP state/import-preview matrix in Light/Dark desktop/mobile layouts; optional form extraction adds no PNGs and the independent static demo has separate captures.
- Performance tests protect cache bounds, virtualization, and lazy loading.

## Generic Progress Regression Scope — Audit Remains Partial

`components/{ToolProgressBoundary,ToolProgressCard}.tsx` and `tool-progress-{state,messages,card.css}` retain bounded inert host-issued v1 progress, optional JS/CSS, distinct code-mode rendering and no nested usage/store authority. The whole 14-case `e2e/tool-progress.spec.ts` protects genuine live phases, durable terminal/reload and readiness recovery, legacy/code-mode separation and lazy-asset faults; its owning config blocks service workers so faults cannot be hidden by PWA caching/reloads. Historical development 13-fail/one-pass and built-preview 14-fail checkpoints remain retained failures, not a passing union. Two mobile-light expectations were reviewed against genuine captures; no mask, assertion, timeout or tolerance was relaxed. Green regression execution does not close the wider audit or certify physical devices/live providers. Explicit browser `node --no-maglev` is not a diagnosis of historical default-engine crashes.

## Associated Tests

- `packages/web/src/store/canonical-session-sync.test.ts` — private session binding, fresh same-run/known-terminal transcript publication without setter authority, stale/foreign/deleted/generation and identity-ABA rejection
- `.docker/e2e-suites.test.mjs`, `tests/e2e-budget.test.ts` — exhaustive owning-host dispatch, retained sibling failures/artifacts, selected demo base rebuild ordering and real quota-window scheduling; see the canonical workflow in `project-map.md`
- `e2e/visual.spec.ts` checks that accessible minimap role prefixes are out of grid flow and previews retain their wide cell; missing previews are fixed in CSS, not approved as new screenshots.
- `packages/web/src/hooks/useMobileKeyboard.test.ts` and `packages/web/src/hooks/mobileKeyboardStyles.test.ts` — geometry, tuple identity, listener/frame ownership and bounded stylesheet lifecycle
- `e2e/mobile-keyboard.spec.ts` — actual ChatView/MCP, touch/viewport emulation, native interaction fields through the optional renderer, retired sessions, asset failure/retry and compact IME/attachment/Stop; no physical-keyboard proof
- `packages/web/src/components/extension-interaction-dialog.test.ts` — declarative fields/output, CSS allocation, abort/cached-reload contract and compatible draft projection
- `e2e/interaction-single-asset-load.spec.ts` with its production-preview config — genuine optional form JS/CSS, local loading/error/cancel/reload, retired replies/view tuples, same-ID drafts/composition, delayed initial focus and coarse manual-editing return
- `e2e/interaction-queue.spec.ts`, `interaction-admission.spec.ts`, `interaction-asset-load.spec.ts` and `queue-reconciliation.spec.ts` — ordered heads, captured replies/Stop, bootstrap/full-address retirement, legal prototype IDs, genuine optional assets and stale App discovery; controlled HTTP/SSE, not backend Stop certification
- `packages/web/src/store/session-store.queue-reconciliation.test.ts`, `run-retirement-filter.test.ts` and `services/interaction-scope.test.ts` — local receipts, bounded negative history, privately witnessed recovery, exact-head acknowledgements and address ABA
- `e2e/interaction-live-boundary.spec.ts` — real extension/HTTP schema rejection, response/cancel and mock-provider resumption
- `e2e/session-event-lifetime.spec.ts` — controlled first-frame notice preservation across empty/existing title hydration; `e2e/session-title-production.browser.ts` and its production config/server — real command/metadata writer/publisher, unchanged subscription and session-navigation retirement. The completion event is directly published, not real compaction execution; Notification titles and plural queue/attention/progress are not directly proved.

- `packages/web/src/store/session-store.test.ts` plus `.remote.test.ts` and `.integration.test.ts` — hydration, windows, drafts, cache and run state
- `packages/web/src/store/preferences.test.ts` and `packages/web/src/components/composer-submit.test.ts` — schema migration, preference validation, newline shortcuts and IME-safe send decisions
- `packages/web/src/services/api.test.ts` — shared REST/SSE credential and response contracts, including minimal OAuth selectors even when callers pass full inventory rows
- `packages/web/src/hooks/useFocusTrap.test.ts`, `packages/web/src/store/preferences-bootstrap.test.ts` and `e2e/pane-lifetime.spec.ts` with its production-preview config — commit-time shortcut registration, newer-focus ownership, ordinary return, remount/StrictMode retirement and unavailable fallback negatives
- `packages/web/src/services/{push,pwa,keyboard,notices}.test.ts` — global browser services
- `e2e/chat.spec.ts`, `e2e/sessions.spec.ts`, `e2e/settings.spec.ts`, and `e2e/workspaces.spec.ts` — primary browser flows, including MCP OAuth sign-in/paste/cancel/logout UI state, minimal-config-free MCP Test requests and identity/cwd/capability/tool reports, locked/redacted inventory, atomic import/replacement, fresh-project trust-plus-first-write, grouped activation, exposure, focus, undo and failure reconciliation
- `e2e/accessibility.spec.ts`, `e2e/performance.spec.ts`, and `e2e/visual.spec.ts` — a11y, bounds and baselines, including desktop/mobile Light/Dark workspace creation dialogs
- `e2e/defaults.spec.ts` — independent composer/Settings saves, fresh draft inheritance, unreadable settings, precedence warnings and reviewed responsive axe/overflow baselines
- `packages/web/src/components/settings-locale.test.ts` — exact eager/feature literal and placeholder conservation, eligible consumers, bounded fill-only registration and cached loader outcomes
- `e2e/settings-locale-asset-load.spec.ts` with its production-preview config — real dictionary assets, controlled API fixtures, delayed/failed loading, EN/FR switch, keyboard/axe, reload/retry and retired close/session/workspace lifetimes; not live-provider proof
- `packages/web/src/components/workspace-panel-boundary.test.ts` — local loading, retained failure/reload warning, bounded bilingual copy, keyed call site, urgent root router declaration, fallback-key address retirement and scoped styles
- `packages/web/src/components/workspace-file-intent.test.ts` — show-before-dispatch order and unchanged reference, address-change and disconnected-origin suppression for the delayed Markdown link producer
- `e2e/workspace-asset-load.spec.ts` with its production-preview config — actual pane JS/CSS delay/refusal, Close/Cancel/reload, retained/latest/commit-phase file intent and retired navigation; controlled API fixtures, not live file-authority proof
- `e2e/live-server.spec.ts` — real browser-to-server file/viewer, traversal refusal, PTY and persisted mock-provider smoke paths; workspace readiness and the actual uploaded-file row replace timing-sensitive synthetic file-open dispatch

## Common Changes

### Change chat or session state

Update API parsing, store hydration/windows, `ChatView`, detached protocol fixtures, reconnection/duplicate tests, and long-history behavior together. Preserve urgent router updates alongside external-store identity and the real-file/PTY assertions and security guard; metadata or timing changes must not retire a valid intent behind an already canonical URL.

### Change a visible surface

Update component and scoped CSS, keyboard/focus behavior, responsive layouts, axe coverage, and Docker-generated visual baselines.

### Change browser persistence

Version and validate the schema, add migration/fallback tests, preserve bounds and secret stripping, and test cross-workspace/cross-tab behavior.

## Related Domains

- [`server-api.md`](./server-api.md) — HTTP, SSE and authentication contracts
- [`sessions.md`](./sessions.md) — canonical history, pagination and dates
- [`extensions.md`](./extensions.md) — declarative widgets and interactions
- [`security.md`](./security.md) — browser secrets, origins and workspace trust
