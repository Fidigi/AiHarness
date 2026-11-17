# RPC extension UI

AiHarness owns this additive RPC contract; it is not a foreign wire/API compatibility layer. Start with `ai-harness --mode rpc`. Read stdout continuously as LF-framed JSONL; write replies to stdin. Diagnostics use stderr.

## Extension context

RPC commands and tools receive optional `context.ui`:

```ts
context.ui?.setStatus('review', 'Checking');
context.ui?.setWidget('review', ['Plain text, never HTML']);
context.ui?.setTitle('Review');
context.ui?.setEditorText('Suggested draft');
const dialog = context.requestInteraction?.({
  kind: 'select', title: 'Continue?',
  options: [{ label: 'Yes', value: 'yes' }],
});
// Optional capabilities on the returned Promise, not caller-assigned IDs:
dialog?.update?.({ kind: 'confirm', title: 'Continue?', message: 'Ready' });
const answer = await dialog;
context.ui?.setStatus('review'); // undefined clears this key
```

`ui.mode` is `rpc`. Immutable `ui.capabilities` lists `select`, `confirm`, `input`, `editor` dialogs and `setStatus`, `setWidget`, `setTitle`, `setEditorText` presentation methods. `custom` and `terminal` are false. Test for optional methods in cross-mode extensions. Registered terminal `registerUI` components, terminal escape sequences, custom components, fields/ANSI rendering and actual terminal/editor management are not supported by this adapter. A custom interaction resolves cancelled without emission. Editor text is a client presentation intent, never a submitted prompt or shell command.

## Wire records

Existing `extension_ui_request` records retain host-generated `id`, `method`, `title` and optional `timeout`:

- `confirm`: `message`; reply `{type:"extension_ui_response",id,confirmed:true|false}`.
- `select`: `options` labels; reply with string `value` matching a current label or value. Extensions receive the option's value.
- `input`: optional `placeholder`; `editor`: `prefill`. Reply with string `value`.
- Any dialog: `{type:"extension_ui_response",id,cancelled:true}` cancels it.
- `notify`: `message`, `notifyType` (`info`, `warning`, `error`); no reply.

Presentation methods emit `extension_ui_request` with `method`, `id`, `key`, and `value` (string, or string array for widgets). Missing values emit `cleared:true`; title/editor use the empty key. Clients must render plain text and decide whether/how to display intents. No response is expected.

Updates emit a replacement request with the **same ID**, keep admission order and the original timeout/signal, and validate replies against the latest schema. `dialog.close()` cancels exactly that request; controls return false after settlement. Host cancellation emits `{type:"extension_ui_closed",id,reason}` where reason is `closed`, `aborted`, `timeout`, `session-changed`, `shutdown` or `delivery-failed`. Normal client replies settle once without an extra closure record. Late/foreign/malformed responses are consumed without settling a current dialog. A timed-out confirm resolves `false`; other timeouts cancel.

## Explicit replay

Send `{type:"get_extension_ui",id:"ui-state"}`. Only `type` and optional string `id` are accepted. The ordinary correlated response contains:

```json
{"version":1,"mode":"rpc","capabilities":{"dialogs":["select","confirm","input","editor"],"presentation":["setStatus","setWidget","setTitle","setEditorText"],"custom":false,"terminal":false},"closed":false,"requests":[],"presentation":[]}
```

`requests` contains pending wire records in admission order; `presentation` contains the last value per method/key. Replace client state with this snapshot; requesting replay does not emit/re-admit dialogs, reset timeouts, or repeat notifications. This state is process-local, not disk persistence or reconnection across a new process. Snapshots and emitted records are detached copies. Registered credentials are redacted; arbitrary unknown conversation secrets are not automatically recognized.

## Bounds and shutdown

There are at most 16 pending dialogs, 100 presentation keys, 100 options/widget lines, 128,000 UTF-8 bytes per normalized/wire record and 512,000 aggregate retained-state bytes (including private option values). Keys are capped at 256 bytes. Admission/update/presentation overflow refuses the change without dropping previous state. Timeout is an integer 1–2,147,483,647 milliseconds. At most 256 UI deliveries may be pending on a slow sink: an undeliverable dialog cancels; excess notification/presentation emissions are best-effort, while the latest presentation stays available in the explicit snapshot. Extensions remain privileged executable code, not a sandbox.

Abort cancels pending dialogs but allows later requests. Successful new-session/switch/fork cancels old pending requests; presentation remains process-wide. EOF, signals and bridge shutdown cancel before waiting on commands, reject later dialog admission, clear retained presentation and remove timers/listeners. Output shares the normal serialized RPC writer; delivery failure cancels affected requests and the composition root treats sink failure as terminal.

Validation: `make typecheck`, `make test`, `make test-parity`. Owning state/lifecycle regressions and an actual emitted executable process test live under `packages/cli/src/rpc/rpc-extension-ui*.test.ts`.

[Français](../fr/rpc-extension-ui.md) · [CLI extensions](./extensions-cli.md)
