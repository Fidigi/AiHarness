# AiHarness Extensions — Web UI Bridge and Declarative Interactions

## Table of Contents

- [Overview](#overview)
- [Loading and atomic reload](#loading-and-atomic-reload)
- [Widgets, notices and interactive requests](#widgets-notices-and-interactive-requests)
  - [Interaction types](#interaction-types)
  - [Lifecycle](#lifecycle)
  - [Optional form loading and focus](#optional-form-loading-and-focus)
  - [Detached host queue contract](#detached-host-queue-contract)
- [Security and loader limits](#security-and-loader-limits)
- [Administration via Settings](#administration-via-settings)

## Overview

The Web server exposes an interface for declarative extensions: text widgets, status notices and interactive requests (confirm, input, select, editor, custom). Unlike CLI extensions that execute in the Node process, the Web interface receives **only cleaned metadata** — never the source code of an extension.

For executable CLI extensions, see [extensions-cli.md](./extensions-cli.md).

## Loading and Atomic Reload

Extensions come from three sources:

1. global directory `~/.ai-harness/extensions/`;
2. project directory `<project>/.ai-harness/extensions/` (only in an approved workspace);
3. active packages/plugins installed via npm, Git or local path.

The server builds an **atomic generation**: it discovers all active extensions, imports them via the bounded loader (`ExtensionModuleLoader`), then replaces the previous generation in a single operation. On an error in the same workspace, the previous generation remains active and no handler from the partial candidate is committed.

Server reload can be triggered from:
- the **Settings → Plugins and packages** page;
- `POST /api/agent/reload` with `cwd`/`projectId` in the body;
- `POST /api/plugins/reload` with `sessionId` in the body to resolve a specific workspace.

The CLI command `/reload` reloads only extensions in the CLI process; it does not notify the Web server.

A workspace change immediately invalidates handlers of the old project and removes its resources before restoring those of the new one.

## Widgets, Notices and Interactive Requests

### Interaction Types

An extension can publish:

| Type | Description |
|---|---|
| **Text widget** | Static display in a collapsible panel (e.g., provider status) |
| **Notice** | Non-blocking message in the global status center (`StatusCenter`) |
| **Confirm interaction** | Dialog with Yes/No buttons keyboard-trapped |
| **Input interaction** | Text field with validation and structured return |
| **Select interaction** | Dropdown menu with predefined options |
| **Editor interaction** | Multi-line input area for longer instructions |
| **Custom interaction** | Declarative form: text fields, selection, checkbox and buttons |

### Lifecycle

```text
1. Active extension → AgentRuntime publishes an `extension.ui` event
2. Server stores the request in the active run snapshot
3. Event broadcast to browser via SSE
4. ChatView presents local loading/error, then lazily mounts the declarative form and its CSS
5. User responds or cancels (`POST /api/agent/sessions/:sessionId/interactions/:requestId`)
6. Server revalidates structured response before resolving extension
7. If tab not visible, a Web Push notification category "attention" is sent
```

**Important rules:**
- An interaction **always requires an active run**. Without a run, it is ignored.
- Custom forms remain declarative: no arbitrary HTML or direct DOM access.
- The structured response is revalidated by `AgentRuntime` before resolution.
- The mounted form owns its focus trap and ordinary Escape; return respects current view, newer focus and other modals rather than always restoring the previous control.

### Optional Form Loading and Focus

`ExtensionInteractionBoundary.tsx` remains eager; only a pending singular request imports `ExtensionInteractionDialog.tsx` and its stylesheet. Loading/error is nonmodal and translated, with Close/Cancel still available, while composer and Stop remain usable. Failed imports stay cached even after reopening. **Reload and retry** reloads the page, so copy unsent text first.

Request/schema or view replacement aborts the response transport and suppresses stale browser publication; it does not roll back a response already accepted by Server. The view tuple includes workspace ID/cwd, session, run and all route identity fields. Same-ID/kind compatible controls retain drafts and connected composition. Changed/removed controls reset. IME and legacy key-code 229 Enter/Escape remain native editing, not form acknowledgement/cancellation; ordinary post-composition Enter can submit once.

Initial focus is admitted before import completion and checked again on the renderer's first frame. Newer focus (even followed by blur), another modal, or the same request re-presented in a replacement route defeats admission. Return requires a current view, unchanged available fallback and no newer focus/modal. Coarse pointers avoid unsolicited editable focus, but guarded return to the composer remains possible after manual editing inside the form; external focus clears that editing intent.

`extension-interaction-dialog.test.ts` protects fields, inert text, CSS/transport/copy and draft projection. Production-preview `e2e/interaction-single-asset-load.spec.ts` exercises actual JS/CSS delay/refusal, reload and focus/IME/lifetime controls. `e2e/interaction-live-boundary.spec.ts` separately proves real extension/HTTP validation and response/cancel through the mock provider. Chromium touch emulation is not physical Android/iOS/Safari certification.

### Detached Host Queue Contract

The detached Core/Server host now supports concurrent pending requests. The current Web client still has singular interaction state, including the first-entry compatibility snapshot; complete browser queue, waiting-count and attention delivery is not implied by the singular form's validated focus/lifetime controls.

- `requestInteraction(request)` returns an awaitable Promise. Detached hosts additionally issue readonly `id`, `update(replacement)` and `close()` controls; other adapters may omit them. Retain the returned handle: knowing an ID alone gives no update/close authority.
- `update` fully replaces display/schema without changing ID, admission order, creation time, original AbortSignal or deadline. Omitted display fields are removed. The next response is checked against the latest schema.
- Responses, close, abort and timeout settle once. Retired/settled controls return `false`. No active run yields `{cancelled: true}`.
- Per run: 16 pending requests, 128,000 UTF-8 JSON bytes per normalized request and 512,000 aggregate bytes. Admission/updates exceeding these bounds throw `409 EXTENSION_INTERACTION_QUEUE_FULL` without replacing prior state. Normalization retains existing field/string limits and secret redaction.
- An optional timeout must be finite, nonnegative and at most 2,147,483,647 ms; invalid values throw `400 INVALID_EXTENSION_INTERACTION_TIMEOUT`. Signals and timeouts never enter reconnect snapshots.
- `extensionRequests` carries complete admission-order reconnect state; `extensionRequest` remains the first entry. Events carry only the changed request or closed ID. HTTP response/cancel stays bound to session/request IDs; stale, foreign or repeated responses return 404.
- Stop, settlement, successful executable/tool-generation commits and failed-workspace safety clearing cancel requests and revoke old requesters. Passive reads and failed same-workspace candidates preserve the current generation. Server binds command requesters before session/trust awaits.

These are in-memory requests, not crash-durable dialogs or concurrent CLI/RPC UI parity. The inherited completed-run registry is not newly bounded. Stop acknowledgement is not durable settlement: interrupted-tool accounting still persists before terminal replay.

## Security and Loader Limits

The extension loader applies the following discovery safeguards, but it does not isolate loaded code in a sandbox:

| Limit | Value |
|---|---|
| Maximum module size | 5 MiB |
| Symbolic links | Systematically refused |
| Injected HTML/DOM | Forbidden (widgets = text only) |
| `dangerouslySetInnerHTML` access | Never used for widgets/interactions |

Project resources remain hidden and inactive until the workspace is explicitly approved via `/trust`. Any activated module is nevertheless trusted Node code executed in the server process.

## Administration via Settings

The **Settings → Plugins and packages** page allows:

1. Inventory of extensions by package (name, version, status);
2. Activation/deactivation of each package without uninstallation;
3. Atomic reload of resources linked to a specific session;
4. Diagnostics on loading failures.

Under authentication, mutations require the `packages` admin capability. The catalog transmitted to the browser contains only cleaned metadata: no code, instructions or credentials.
