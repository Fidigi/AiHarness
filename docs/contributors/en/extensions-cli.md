# AiHarness Extensions — CLI

## Table of Contents

- [Locations](#locations)
- [Configured selectors](#configured-selectors)
- [Example](#example)
- [Available API](#available-api)
  - [Transforming and cancellable hooks](#transforming-and-cancellable-hooks)
  - [Automatic tool invocations](#automatic-tool-invocations)
- [Package management](#package-management)
- [Management commands](#management-commands)
- [Current limitations](#current-limitations)

## Locations

The CLI automatically discovers:

- `<agent-directory>/extensions/*` (default `~/.ai-harness`), with supported JavaScript/TypeScript suffixes
- `<project>/.ai-harness/extensions/*`, after project trust
- subdirectories containing a supported index entry (priority below)

A module can also be loaded explicitly:

```bash
ai-harness --extension ./extensions/example.mjs
```

Multiple paths can be provided with multiple `--extension` options, or with `AI_HARNESS_EXTENSIONS` separated by the system path separator.

TypeScript entries (`.ts`, `.mts`, `.cts`, `.tsx`) now run directly through Core's transpile-only loader; declarations (`.d.ts`, `.d.mts`, `.d.cts`) never execute. An installed package can additionally declare extensions, skills, prompts, and JSON themes through `aiHarness` only. Enabled extensions, skills, and prompts join CLI and RPC startup through the same Core catalogue used by the Web server; a selected package theme joins interactive CLI startup.

Markdown discovery suppression is independent: `--no-skills` / `-ns` and `--no-prompt-templates` / `-np` omit automatic/settings/package candidates, not explicit repeatable `--skill` / `--prompt-template` selections. Trust and stable-file checks still apply; interactive reload keeps this choice and refreshes explicit contents. Core/SDK hosts use additive `discoverSkills` / `discoverPrompts`; legacy `disableSkills` / `disablePrompts` remain all-loading denials. See [SDK resource policy](./session-sdk.md#scoped-markdown-resources).

Terminal theme discovery is shared in Core through `discoverThemeSources` and readonly `ThemeSourceSelector` records. It is metadata-only, bounded, ordered and trust-gated; palette bodies are admitted separately by `ThemeManager`. CLI composes automatic roots, package files and declaring-directory `themes` selectors globally then for a trusted project, followed by literal `--theme-source` requests. `--no-themes` suppresses automatic admission but preserves explicit sources/direct selections and does not affect extensions. Both new flag names are reserved. Interactive reload refreshes the catalogue; this does not add Web CSS or a terminal palette API to RPC. See the [theme contract](../../ai/topics/themes.md) for selector semantics, limits, provenance and actual installed-package evidence.

Contributed boolean/string options are reparsed with their definitive registered arity. Bootstrap guesses may mask startup error diagnostics, but never register runtime credentials. A `--api-key value` sequence after the first positional prompt remains literal input, not redaction authority; an earlier genuine key and environment/resolved credentials still redact their raw and encoded forms. This applies across print/JSON/RPC and both terminal modes, including reload. It adds no extension privilege or option syntax.

## Configured Selectors

The `extensions` array in global and trusted-project `settings.json` is applied to actual discovered files **before imports**. Global selectors run first, then project selectors; relative paths use the declaring settings directory, not the shell cwd. That directory is literal filesystem identity, including any brackets or other glob characters in its name. Automatic, explicit and enabled-package entry candidates are subject to these selectors:

```json
{
  "extensions": [
    "extra/**/*.mjs",
    "!extensions/**/disabled.mjs",
    "!extra/**/experimental*.mjs",
    "+extra/stable/experimental-approved.mjs",
    "-extra/retired"
  ]
}
```

- An unmarked path adds a file or ordinary shallow entry directory; an unmarked glob expands matching supported JavaScript/TypeScript entries using Node path-glob semantics.
- `+path` adds an exact file/directory, treating glob characters literally.
- `-path` removes that exact file or discovered files under that directory; `!glob` removes matching files.
- Order matters: a later add can restore an earlier removal. Files are deduplicated and imported in sorted absolute-path order. `--extension`, environment paths and Core `paths` remain literal, not shell/glob expressions.
- Project selectors and project files remain trust-gated, including an exact `+` and patterns whose root contains the untrusted cwd. Selectors do not grant trust or bypass stable-file checks. Virtual `builtin:` switches use a separate hosted-capability policy below, not filesystem matching.

A generation admits at most 200 ordinary discovery paths and 200 selectors (32 KiB UTF-8 per string, or combined pattern/base for a scoped entry). With nonempty selectors, the candidate set cannot exceed 1,000 files at any step, even if later exclusions would reduce it. A glob scan permits 1,000 entries per directory, 10,000 aggregate entry visits, 256 directory visits and eight descendant levels; repeated patterns consume the same aggregate budget. Nonrecursive globs do not descend unrelated subtrees. Overflow refuses the whole candidate generation rather than importing a truncated prefix. Missing optional paths are skipped. Linked/hard-linked or oversized modules remain inadmissible (5 MiB maximum); Declaration files remain excluded.

Core exports additive `ExtensionModuleLoaderOptions.selectors`: a readonly `ExtensionModuleSelector` array or sync/async callback returning one, reevaluated on discovery/reload. An entry is a string relative to the loader cwd, or `{ pattern, baseDir }` with an absolute literal base directory. Only the pattern is glob syntax; CLI layers and home expansion retain this distinction. Hosts still own trust and discovery context through `isProjectTrusted` and `cwd`. CLI startup, print/JSON/RPC and interactive reload pass the ordered layer-resolved settings to this shared implementation; Server configuration is not changed by this CLI settings feature. A discovery failure preserves the previous managed registrations; successful replacement leaves unrelated owners intact. Executed Node side effects and dependency imports are **not** sandboxed or rolled back: an admitted module can itself import an excluded entry as a dependency.

## TypeScript execution

```ts
import type { ExtensionAPI } from '@ai-harness/core';
export default function review(api: ExtensionAPI) {
  api.registerCommand('review', { description: 'Review', handler: () => 'Ready' });
}
```

Load it with `ai-harness -e ./review.ts`, or use ordinary user/project/settings/environment/package discovery. Core evaluates already admitted descriptor bytes with pinned `jiti`, preserving entry size/link/trust checks and transactional registrations. The exact `@ai-harness/core` root uses the host's real public namespace, including in late imports outside an installation. Relative/extensionless imports, enums, parameter properties, CommonJS exports and classic JSX work; JSX still requires the author's factory/library and does not add a React or browser rendering surface.

No static type check or implicit `tsconfig` path aliases are performed. Each entry's transformed dependency graph is private and refreshed on reload; native dependencies retain Node caching. Transpiler filesystem/global module caches are disabled. Invalid evaluation reports a fixed diagnostic without source/code frames; previous same-workspace registrations survive. Dependencies and admitted Node effects are **not sandboxed or rolled back**.

Child index priority is `.mjs`, `.js`, `.cjs`, then `.ts`, `.mts`, `.cts`, `.tsx`. Avoid autoloading both compiled and source copies of one extension; different paths remain different candidates. Installed package manifests are honored through the package service. Uninstalled directory manifests now use the literal rules below. Native JavaScript receives the same exact public Core root identity. Literal entry requests also have the bounded main/suffix rules below.

## Native JavaScript Core imports

Native `.js`, `.mjs` and `.cjs` modules may also import/require the exact `@ai-harness/core` root outside the installation. Static, late, dependency and awaited cleanup calls use the host's actual namespace, not another Core copy. Private subpaths and CLI/Server/UI-library aliases are not added. JavaScript retains Node format detection and dependency caches; changing a helper on disk does not refresh an already cached native dependency during `/reload`.

Core owns a contextual Node resolve hook plus an owned-caller `Module.prototype.require` adapter: CommonJS can otherwise bypass resolver hooks through its same-directory cache. No native cache entry is deleted/replaced. Ordinary unrelated imports retain their own installation; preexisting virtual require adapters and newer foreign wrappers are conserved. Import leases survive until candidate registration/refusal; active factory leases survive through user cleanup and are restored on rollback. Shared native modules retain their existing exports/effects. Alias context is **not** a sandbox or revocation mechanism.

Bounds are explicit: 1,000 URLs per graph, 32 KiB per URL, 10,000 active contexts and 20,000 ownership associations. URL-only metadata retained for Node's cached dependencies is limited to 10,000 parents, 20,000 edges and 16 MiB per process; cached CommonJS traversal allows 1,000 nodes/children per node. Overflow reports `Extension module resolution exceeds its limits.`; a process restart clears retained metadata. The final owner removes its hook/adapter without overwriting a newer library's wrapper.

## Directory manifests

A discovered child folder or an explicit/settings/environment directory can select its entries without package installation:

```json
{ "aiHarness": { "extensions": ["src/review.ts", "src/other.mjs"] } }
```

Only `aiHarness.extensions` selects directory entries. Move resource declarations from any other manifest namespace into `aiHarness`; other namespaces are ignored. No extensions field preserves ordinary discovery; an empty list disables that directory's entries. A declared list replaces sibling/index autodiscovery. Outer settings selectors still apply afterward.

These are **exact relative paths**, not globs or selector operators; brackets and other filename metacharacters remain literal, and backslash separators are normalized. A declared module directory resolves a confined `package.json` `main` before its supported index; absent `main` preserves JavaScript-first index priority. Nested resource manifests and exports-only directory maps are not reinterpreted. Declarations/non-executable regular files are ignored as direct declarations; unresolved/unsafe declared entries and nonexecutable main targets fail the generation, with no sibling fallback. Installed package resource globs retain their separate existing semantics.

Metadata is read through stable descriptors after trust admission: 256 KiB and 100 paths per manifest, 32 KiB per string; shared per-discovery limits are 200 manifest reads, 4 MiB and 1,000 declared-path visits (including repeated work). Absolute/escaping/self paths, invalid UTF-8/JSON and identity changes fail with a source-free diagnostic. `/reload` reselects entries; invalid metadata preserves the previous same-workspace registrations. These entry checks do not sandbox privileged imports or roll back their effects.

## Literal module requests

For a **missing** explicit/environment/literal-selector or declared file request, no suffix tries `.mjs`, `.js`, `.cjs`, `.ts`, `.mts`, `.cts`, then `.tsx`. Output suffixes map only `.js` → `.ts`, `.mjs` → `.mts`, `.cjs` → `.cts`, `.jsx` → `.tsx`. Existing exact files win; safe nonexecutable/declaration files do not redirect to siblings. Physical `.jsx` files are not executable entries. Example: `ai-harness -e ./review.js` may admit `review.ts` if `review.js` is absent. Exclusions and deduplication act on the **actual admitted file**, not the missing request alias.

A resource declaration `{"aiHarness":{"extensions":["module"]}}` can target `module/package.json` containing `{"main":"src/review.js"}`, backed by `module/src/review.ts`. Main is literal, confined to its declaring directory, descriptor-read under the existing metadata budgets and limited to eight indirections. Invalid, linked, escaping or self-referential main metadata refuses the generation rather than falling back to an index. Nested extension arrays are not resource selectors in this module-target role.

An ordinary discovery directory without resource declarations still uses shallow/index discovery: its main is **not** an automatic resource selector. Automatic CLI/RPC/Server directories retain directory intent, as do explicit trailing separators (`-e ./review.ts/` cannot load a file). Missing `extensions/` never activates adjacent `extensions.ts`. Installed-package resource globs remain separate actual-file filters. Module resolution shares a 10,000-candidate-probe budget per discovery and a 32 KiB resolved-path bound; missing/repeated attempts count. Unsafe/overflowing required resolution uses `Extension manifest is invalid or exceeds its limits.`, with no partial import or loss of the prior generation.

## Optional built-in switches

The optional CLI/RPC IDs are `builtin:mcp`, `builtin:codemode` and `builtin:tool-search`. In global `extensions`, `!glob` exclusions apply before exact `+builtin:name` additions, then exact `-builtin:name` removals. The last matching trusted-project modifier overrides global policy. Bare IDs do not override exclusions. Explicit `-e builtin:name` has final priority; unknown exact IDs fail without echoing the supplied value. Limits are 200 entries per input list and 32 KiB per string.

`--no-extensions` (`-ne`) suppresses automatic global/project, settings, environment and enabled-package **executable** discovery and these optional capabilities. Explicit `-e` files/directories and built-in IDs still work; trust and stable-file checks still apply. Put discovery flags before contributed options. Example: `ai-harness --no-extensions -e builtin:mcp -e ./review.mjs`.

Workspace tools, skills/prompts/themes, providers and explicit MCP administration are independent. This is not an offline/no-tools/sandbox switch. Codemode still needs its ordinary activation/selection settings; disabling hosted `tool_search` does not erase earlier eligible activations or disable a third-party replacement. `/reload` refreshes interactive policy and closes disabled MCP connections before continuing; reenablement connects only on a later prompt. RPC requires restart. File-generation rollback does not roll back the separate refreshed settings policy; already admitted external effects cannot be undone.

Core exposes `resolveBuiltinExtensionPolicy`, frozen `BUILTIN_EXTENSION_NAMES`, readonly `BuiltinExtensionPolicy`, additive `ExtensionModuleLoaderOptions.includeEnvironmentPaths`, `CreateAgentToolLoadoutOptions.toolSearchEnabled` and reusable `McpSessionHost.setEnabled(boolean)`. The policy itself imports nothing and grants no trust. Server/Web settings composition is unchanged.

## Example

```js
export default function exampleExtension(api) {
  api.registerCommand('hello', {
    description: 'Display a message',
    usage: '/hello [name]',
    handler: async (args, ctx) => {
      const message = `Hello ${args || 'world'}`;
      ctx.notify(message, 'success');
      return message;
    },
  });

  api.registerTool({
    name: 'sum',
    description: 'Add two numbers',
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'number' },
      },
      required: ['a', 'b'],
    },
    execute: ({ a, b }) => ({
      content: String(a + b),
      details: { a, b },
    }),
  });

  api.registerUI({
    name: 'example-status',
    placement: 'status',
    render: ({ provider }) => `Active provider: ${provider || 'unknown'}`,
  });

  api.before('before:agent', data => ({
    input: data.input.trim(),
  }));

  api.before('before:tool', data => {
    if (data.tool === 'sum' && Number(data.input?.a) < 0) {
      return { cancel: true, reason: 'Negative numbers are not allowed.' };
    }
  });

  const unsubscribe = api.on('session:create', event => {
    api.events.emit('example:session-created', event);
  });

  return () => unsubscribe();
}
```

## Available API

Use the [native extension/embedding contract v1](../../ai/topics/native-extension-contract.md) for the complete imports/events/results/UI host matrix, package/resource adaptation and unsupported contracts. Runtime `on`/`before` refuses unknown event names; registration APIs captured from an unloaded generation refuse late registrations. The public root is `@ai-harness/core`, not a private/TUI peer alias.

Every factory receives `api.version`. Version `1` is also exported as `AI_HARNESS_EXTENSION_API_VERSION` from `@ai-harness/core`; extensions should reject an unsupported major before registering behavior.

- `version`: current major version of the AiHarness-owned extension contract.
- `registerCommand(name, definition)`: adds a `/name` command.
- `registerTool(definition)`: adds an executable tool. Tools are listed by `/tools` and can be tested with `/tool <name> <json>`.
- `registerProvider(type, definition)`: adds a provider factory selectable with `/provider <type>`.
- `registerUI(component)`: adds a text panel to the fullscreen CLI interface. The component receives notably `currentSessionId` and `provider`.
- `on(event, handler)`: listens to a lifecycle event and returns an unsubscribe function.
- `before(event, handler)`: transforms or cancels an operation before execution.
- `events`: event bus for inter-extension communication.

Current events cover sessions, messages, compaction, agent/provider/tool calls, `system:ready` and `system:shutdown`.

### Session state, context and generations

Commands and tools receive the actual `context.sessionManager` plus the current session ID. Capture that ID before awaiting. Use existing manager operations for messages, navigation, compaction and copies; hosts still own foreground admission. Do not introduce another conversation engine or navigate concurrently with a running provider/tool operation.

- `appendCustomEntry(id, customType, data?)` appends owned private JSON (durably when persistence is enabled); it never becomes model input. Type names are exact conventions, not extension ownership or isolation. Custom JSON rejects accessors/exotics/cycles/sparse arrays and is bounded to depth 32, 65,536 nodes and 1 MiB; custom types are at most 256 UTF-8 bytes.
- `appendCustomMessage(id, customType, content, {display?,details?})` contributes its content to model context even when `display:false`; details remain outside model input. These are not secrets storage or arbitrary custom UI renderers.
- `await getActiveBranchEntries(id)` returns an owned parent-first path, including private state before compaction. Reduce by your exact type and take the last matching entry to restore your state. It excludes abandoned branches, follows no summary-source provenance, uses the last append projection per ID and refuses incomplete ancestry. Raw history includes abandoned work; effective model context deliberately excludes private data, so neither is a substitute.
- Related forks preserve selected custom ancestry/stable IDs; independent clones remap internal IDs. Both reuse Core's bounded copy path (at most 1,024 extra custom/summary/compaction entries), preserve required private state and refuse live command ancestors. Arbitrary IDs inside custom payloads are not rewritten.
- Startup `--fork` ID/prefix/file selection reuses that Core engine; it must not drop private state by copying only model messages. A foreign native source is read through one stable bounded `JsonlSessionStore.getSessionSnapshot(id)` without rewriting it or importing it into the destination manager. Snapshot entries are raw history, not active state. Low-level `forkSession` accepts own captured `{sourceStore?,id?,cwd?,workspaceId?,signal?}` as its fourth argument; accessors/unknown keys/invalid values and stale destination-store authority are refused. Explicit undefined workspace clears inheritance. Existing no-session startup precedence remains; no facade method or CAS is added. Ordered cancellation admission is separate below.

```js
api.registerCommand('remember', {
  description: 'Save a private extension note',
  handler: async (text, context) => {
    const id = context.currentSessionId;
    if (!id) return 'No active session.';
    await context.sessionManager.appendCustomEntry(id, 'example:note', { text });
    const path = await context.sessionManager.getActiveBranchEntries(id);
    const latest = path.filter(e => e.type === 'custom' && e.customType === 'example:note').at(-1);
    return latest ? 'Private note saved.' : 'No note on this branch.';
  },
});
```

Writes must settle before success. Reads serialize with manager mutations and refuse a host store/leaf replacement while awaiting; they are not a cross-process CAS transaction or an atomic read-modify-write helper. Schema remains JSONL v2, independently of Core API major2 and extension API major1. The high-level session facade adds no custom mutation or active-path method; see the [session SDK](./session-sdk.md).

Durable state survives process restart and executable generations; `--no-session` state does not. `/reload` replaces interactive factories and their module-local variables, not the session journal; read the selected path again rather than treating closure state as persistence. Failed same-workspace candidates retain/restore the preceding factory, not arbitrary Node side effects. RPC executable generations remain startup-scoped: disk edits and `reload_context_settings` do not reload them; restart explicitly. Lifecycle hooks, disposer completeness, custom renderers and sandboxing are separate contracts.

### Transforming and Cancellable Hooks

Transforming hooks include:

- `before:agent` receives `{ sessionId, provider, input }`;
- `before:provider` receives `{ provider, model, messages, options }`;
- `before:tool` receives `{ tool, input, context }`.

Handlers execute in registration order. They can return a partial object to transform subsequent data, `false` to cancel, or `{ cancel: true, reason?: string }` to cancel with a reason. An exception interrupts the operation and identifies the offending extension. Hooks are automatically unsubscribed on unload.

To modify a provider option without removing others, explicitly preserve the existing object:

```js
api.before('before:provider', data => ({
  options: { ...data.options, temperature: 0.2 },
}));
```

### Actionable output and settlement hooks

The shared CLI/JSON/RPC/SDK/Web loop supports `before:message` returning `{content}`, `before:tool:result` returning a public top-level `{result}`, and `before:turn:end` / `before:agent:settle` returning `{continuation:{type,content}}`. The last defined continuation wins; null clears it. These are native names, not `turn_end`/`agent_before_settle` aliases. Context transformations remain `before:provider`.

```ts
api.before('before:agent:settle', event => event.round === 0
  ? { continuation: { type: 'review:check', content: 'Check the answer once.' } }
  : undefined);
```

Continuations append native model-visible custom messages, retain the existing round budget and cancellation, and never masquerade as user messages. Hooks run in order with copied public output and pinned authority; unknown fields/accessors/invalid output fail closed. Veto/error conserves completed authentic accounting; no arbitrary result details/store/usage or pending tool authority can be forged. Callback retirement on abort/unload is not Node termination or storage rollback. Already streamed text can precede its final replacement; use credential redaction for secrets. See the linked contract for exact boundaries and per-host unsupported UI.

### Ordered branch and summary hooks

`before:session:branch` is cancel-only: frozen `{sourceSessionId,operation,entryId?,position,externalSource,signal}` describes fork/clone/branch-before without private journal data. Return undefined to continue, false or own `{cancel:true,reason?}` to veto. Unknown keys, accessors, transforms and invalid results fail closed; reasons are bounded to 4,096 UTF-8 bytes/no NUL and manager adapters do not disclose them. Ordinary lifecycle observers remain concurrent/error-isolated.

`before:session:summary` runs only for explicitly requested navigation summaries. Frozen source/from/target IDs, model-visible transcript, token/output budgets and owned signal grant no rewrite authority. Return undefined, cancellation or copied validated `{summary,provider?,model?,usage?}`. The last defined override wins; later veto cancels; fallback runs only without an override. Private data/details stay excluded while `display:false` custom content remains model-visible. Global callbacks use an owned generation signal; legacy per-call summarizers retain the original caller signal.

Registration/removal/unload/rebind/shutdown withdraws unpublished work before awaited cleanup, including ignored callbacks. Limits:128 Core hooks/kind and256 pending admissions; registry128 managers,256 leases/manager and256 callbacks/kind. `attachSessionBranchHooks(manager)` owns an independent lease; SDK borrowing never moves/removes another host's lifecycle binding. Admitted durable writes finish, without rollback/CAS. CLI/RPC keep nondestructive busy refusal, preserve queues/selection on veto and retire dialogs only on publication; Server persisted-target copies remain allowed while the source runs. The SDK adds no facade/store methods. See [session ownership](../../ai/topics/sessions.md#fork-versus-clone).

### Automatic Tool Invocations

Tool schemas automatically pass through the shared provider contract; the OpenAI/Azure, Anthropic, Gemini/Vertex, Bedrock, and local-compatible adapters translate them when the model allows tool calls. When the model requests a tool, the CLI persists the tool call, executes the tool, persists its result (errors included), then resumes the model call. The loop is limited to eight consecutive turns to avoid infinite calls. An `Escape` or `Ctrl+C` interruption cancels the provider request and propagates the signal to the active tool.

## Package Management

Package state and source policy live in `@ai-harness/core`; CLI and Web do not maintain separate installers. Use `ai-harness package --help` for all options:

```bash
ai-harness package install npm:@scope/review-kit@^2 --global
ai-harness package install ./review-kit --project --approve
ai-harness package configure @scope/review-kit --extensions='extensions/*.mjs,!extensions/unsafe.mjs'
ai-harness package list --json
ai-harness package check @scope/review-kit
ai-harness package update @scope/review-kit
ai-harness package remove @scope/review-kit
```

`npm:`, restricted HTTPS `git:`, and explicit local paths are supported. `--extensions`, `--skills`, `--prompts`, and `--themes` only narrow manifest resources; an empty value disables a kind and `--reset` restores defaults. Installing, configuring, enabling, updating, or loading project packages requires project trust; disabling and removal remain available for safe cleanup. Packages run trusted Node code without a sandbox, so review sources before installation.

Web Project/Global **Enable all** and **Disable all** controls delegate one bounded batch to Core. Core preserves resource filters, commits allowed changes with one atomic state write, reports per-entry trust/not-found failures, and flags executable changes for the separate resource reload.

## Management Commands

```text
/extensions   Lists extensions and their capabilities
/tools        Lists registered tools
/tool         Manually executes a tool
/reload       Stages and atomically replaces the CLI-owned module generation
```

Unloading automatically removes commands, tools, providers, UI panels and listeners belonging to the extension. A cleanup function returned by the factory is also called.

## Current Limitations

- The CLI and Web server load separate extension generations: `/reload` reloads only the CLI process, while the Web API has its own reload routes.
- CLI panels registered with `registerUI` are text-only and visible only in fullscreen mode; the server separately returns its text widgets and declarative interactions.
- Executable modules are trusted Node code run in the host process, without a security sandbox.
- Public compatibility and golden-probe rules are defined in the [AiHarness public contract policy](./public-contract-policy.md).
