# AiHarness Extensions — Web UI Bridge and Declarative Interactions

## Table of Contents

- [Overview](#overview)
- [Loading and atomic reload](#loading-and-atomic-reload)
- [Widgets, notices and interactive requests](#widgets-notices-and-interactive-requests)
  - [Interaction types](#interaction-types)
  - [Lifecycle](#lifecycle)
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
4. ChatView renders dialog with focus trap and Escape handling
5. User responds or cancels (`POST /api/agent/sessions/:sessionId/interactions/:requestId`)
6. Server revalidates structured response before resolving extension
7. If tab not visible, a Web Push notification category "attention" is sent
```

**Important rules:**
- An interaction **always requires an active run**. Without a run, it is ignored.
- Custom forms remain declarative: no arbitrary HTML or direct DOM access.
- The structured response is revalidated by `AgentRuntime` before resolution.
- Focus remains trapped in the dialog while open, then returns to previous control.

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
