# Terminal keybindings

These settings affect the regular and fullscreen CLI, not Web shortcuts, print, JSON or RPC. See [terminal themes](./user-guide.md#custom-theme-and-keybindings) for palette locations, `system` and reload.

## Choose a file

The default is `<agent-directory>/keybindings.json`, normally `~/.ai-harness/keybindings.json`. AiHarness resolves an independently trusted agent directory first; `AI_HARNESS_AGENT_DIR` does not let a project approve itself.

A nonempty `AI_HARNESS_KEYBINDINGS` selects one literal file instead:

```bash
export AI_HARNESS_KEYBINDINGS="$HOME/.ai-harness/keybindings.json"
ai-harness --regular
```

Relative paths resolve from the startup working directory; `~/` expands to your home. Brackets are literal, not globs. The override is captured at startup: restart to change it. A selected file inside the workspace requires project resource trust even when explicitly selected. There is no automatic project `keybindings.json` overlay or package-keybinding discovery.

Files must be stable, single-link, nonsymlink regular UTF-8 files, at most 64 KiB. Unsafe ancestors and changing files are refused. Loading configuration never executes an action.

## File format and schema

Use a JSON array, for example:

```json
[
  { "id": "my-help", "keys": ["ctrl", "h"], "action": "app.help" },
  { "id": "my-hotkeys", "keys": ["f2"], "action": "app.hotkeys" },
  { "id": "older", "keys": ["f4"], "action": "transcript.up" }
]
```

Each entry has a unique `id` and one `keys` chord. Optional fields are `action`, `description` and boolean `preventDefault`; other fields are rejected. `action` defaults to `id`. Unknown action IDs remain inert and appear unavailable; a file cannot define callbacks, evaluate code or grant an extension authority.

Limits: 512 entries; IDs/actions 256 UTF-8 bytes; descriptions 512 bytes; one nonmodifier and at most five normalized chord parts. Chord parts are case-insensitive ASCII names, optionally joined with `+`; `control`, `option`, `return`, `esc` normalize to `ctrl`, `alt`, `enter`, `escape`. Controls/bidi text, duplicate IDs and duplicate normalized chords are refused. Use `slash` for `/`. Terminal key encodings determine which chords actually arrive; `cmd`/`meta` names do not promise native macOS Command-key support.

Configured chords override the same default chord; adding another chord does not remove an action's other defaults. `preventDefault` defaults to true. Set it false only if you deliberately want the action **and** native editor handling, potentially producing two effects. Ctrl+C, Ctrl+D, Escape and Node's `alt+escape` decoder alias cannot target another action; their native safety behavior remains owned by the input driver. Legacy saved-default IDs do not create callbacks.

The [source schema](../../../packages/cli/schemas/keybindings.schema.json) is shipped byte-for-byte at `@ai-harness/cli/dist/schemas/keybindings.schema.json`. Select it through your editor's schema association rather than adding `$schema` to this array. Runtime validation remains authoritative for UTF-8 bytes, normalized uniqueness and reserved ownership.

## Browse without executing

Press **F1** or **Alt+K** by default. The view lists all 29 actions, their effective chords and reserved/conditional/unavailable/unbound state. A conditional marker is metadata, not proof that its predicate is currently true. Opening or filtering does not execute handlers or probe their predicates.

| Input while open | Effect |
|---|---|
| Text then Enter | Filter by action ID, description or chord |
| Empty Enter, `:next`, Down or PageDown | Next page |
| `:prev`, Up or PageUp | Previous page |
| `:all` | Clear the filter |
| `:close`, Escape, F1 or Alt+K | Close and restore the draft and caret |

The view displays at most eight actions per page, fewer on short screens. Queries and rows are bounded and terminal-cell clipped. Registered credentials are redacted before clipping; this is not a guarantee to detect arbitrary private text. Filter submissions never become provider prompts, external-editor requests or native history entries. The underlying transcript/stream continues; closing restores the saved editor without cancelling the agent. Native interrupt and exit controls remain available.

## Action inventory

| ID | Default chords |
|---|---|
| `app.interrupt` | Ctrl+C: interrupt; idle exit |
| `app.exit` | Ctrl+D: exit only with an empty editor |
| `app.escape` | Escape: cancel operation/multiline input or close the view; no idle exit |
| `app.help` | Alt+H, Ctrl+/ |
| `app.hotkeys` | F1, Alt+K |
| `terminal.clear` | Ctrl+L |
| `input.submit` | Enter: submit, or steer during an active response |
| `input.newline` | Alt+J: insert a newline without submitting |
| `input.followUp` | Alt+Enter, Ctrl+Q |
| `input.dequeue` | Alt+Up: restore queued input, otherwise scroll older |
| `input.externalEditor` | Ctrl+G |
| `transcript.up` | PageUp |
| `transcript.down` | PageDown, Alt+Down |
| `editor.left` | Left |
| `editor.right` | Right |
| `editor.home` | Home, Ctrl+A |
| `editor.end` | End, Ctrl+E |
| `editor.wordLeft` | Ctrl+Left, Alt+B |
| `editor.wordRight` | Ctrl+Right, Alt+F |
| `editor.deleteWordLeft` | Alt+Backspace |
| `editor.deleteWordRight` | Alt+D |
| `editor.undo` | Ctrl+Z |
| `editor.redo` | Alt+Z |
| `editor.previous` | Up |
| `editor.next` | Down |
| `editor.backspace` | Backspace |
| `editor.delete` | Delete |
| `editor.clear` | Ctrl+U |
| `editor.complete` | Tab |

Regular transcript actions print actual buffered previews in 20-entry older/newer pages, one bounded row per entry, preserving draft/caret and active streaming. They are not a full-screen viewport or full-journal search: retained history is capped at 500 entries/16 MiB. Fullscreen uses its own transcript viewport. Neither implies complete mouse, selection, image, hyperlink or terminal-emulator support.

## Reload and recovery

Save the file, close the hotkey view, then run `/reload`. A successful load replaces the entire custom layer; removed custom chords retire and ordinary defaults remain. A malformed or unreadable file at the same selected source retains the last published custom layer, with a value-free reason such as `json` or `read`. A changed/unavailable source clears its old layer; removing the default agent-directory file restores defaults without a load-failure notice. Invalid candidates never partially publish, and stale reads cannot overwrite a later reload or shutdown.

If a remap is inconvenient, remove it or use an empty array and reload. Keep at least one usable entry chord for `app.hotkeys`; native Escape/Ctrl+C/Ctrl+D safety controls cannot be repurposed. Restart after changing the environment-selected path. Physical terminals may reserve or encode keys differently; Linux PTY and packed executable tests do not certify every OS or terminal.

See [CLI security](./cli-security.md) for safe diagnostics and terminal fallbacks; the [user guide](./user-guide.md) covers trust and external-editor configuration.
