# Native terminal editor and settings contract

> **Navigation:** See [`project-map.md`](../project-map.md) for ownership and Docker validation.

## Overview and owners

This is AiHarness's terminal contract, not Pi's component, settings or keyboard ABI. `packages/cli/src/index.ts` composes both hosts; Core still owns prompts, tools, queues, trust and persistence. Print/JSON/RPC do not enable terminal paste or load keybindings. CLI-04 installation/update remains separate.

| Owner | Responsibility |
|---|---|
| `packages/cli/src/tui/editor-state.ts` | Owned UTF-16 draft/caret, grapheme operations, whitespace-word edits, bounded undo/redo and modal history separation |
| `packages/cli/src/tui/fullscreen-{input,ui}.ts` | Raw decoder, 100-entry history, exact draft recall, three-logical-row editor viewport, transcript/footer, resize and alternate-screen cleanup |
| `packages/cli/src/index.ts` regular host | Readline decoding/output, exact application history and shared editor dispatch; no private Node methods |
| `packages/cli/src/utils/keypress-gate.ts` | Bracketed-paste byte framing before theme filtering/keypress dispatch; complete owned configuration dispatch |
| `packages/cli/src/utils/{terminal-actions,hotkey-view}.ts` | 29 named actions and passive filter/pages; callbacks belong to hosts |
| `packages/cli/src/tui/terminal-settings.ts` | Accepted-but-unsupported storage-field inventory, fixed value-free notices and `/settings` projection |

## Capability matrix

| Capability | Regular | Fullscreen | Boundary |
|---|---|---|---|
| Multiline draft | Shared buffer, readline redraw | Up to three logical rows around caret | Alt+J inserts LF; Enter submits the entire draft. `/edit` + `/send` remains available |
| Cursor/deletion | Shared grapheme boundaries | Same | ICU graphemes, not UTF-16 code-unit deletion; Home/End are logical-line-relative |
| Word edit / undo | Shared model | Same | Whitespace-delimited words, not language syntax; at most 100 snapshots and 1 MiB UTF-16 storage per undo/redo stack. Submission resets undo |
| History | Exact application buffer | Exact application buffer | Last 100 nonempty submissions; Down after recall restores the unsent draft. Passive view queries are excluded |
| Committed Unicode / IME text | UTF-8 terminal input | Same | Combining marks, astral/ZWJ emoji and CJK are accepted. The OS/terminal owns IME preedit/candidate/Enter behavior; no physical IME certification |
| Paste | Bounded inert bracketed paste | Same | CSI 200~/201~; 65,536 UTF-8 bytes. CRLF/CR normalize to LF, tabs to spaces; controls/OSC/CSI/bidi are removed. Overflow discards the **whole** paste with a fixed error |
| Unfinished / unbracketed paste | Unfinished framed data discarded on retirement | Same | Partial markers are retained across chunks; outside-paste Escape has a bounded decoder delay. Unbracketed bytes remain ordinary typing and may submit lines |
| Resize / streaming | Readline redraw and ordinary scrollback | Recomputed bounded frame/caret viewport | Conventional narrow-ambiguous cell widths, not a font/emulator guarantee; very short frames omit chrome |
| Interrupt / restoration | Existing Escape/Ctrl+C and queue restoration | Same | Preserve Core cancellation/settlement. Ctrl+D exits only when empty; raw mode, paste mode and alternate screen are restored on owned exit |
| Completion / external editor | Slash/option completion, configured editor | Same | Existing command vocabulary; no shell/path/IDE completion engine. External editor handoff temporarily disables paste mode |
| Selection / mouse / clipboard | Terminal-native selection; explicit `/copy` | Terminal-native selection where emulator permits | No application selection, mouse capture, wheel protocol or copy-on-select; no OSC 52 clipboard writer |
| Images / links / overlays | Inert text/ordinary terminal output | Plain-text host panels and passive hotkeys | No Kitty/iTerm2 inline images, OSC 8 links, arbitrary component/overlay renderer or extension executable TUI |
| Terminal protocols | Standard readline/xterm escape decoding | Same decoder and native ANSI alternate screen | No negotiated Kitty keyboard/CSI-u/modifyOtherKeys, cursor-position/IME protocol or universal terminal/Windows qualification |

The Linux Docker PTYs use `TERM=xterm-256color`; committed Unicode is injected as actual UTF-8 bytes. This is not side-by-side upstream, physical keyboard, Safari, Windows, macOS or arbitrary emulator acceptance. See the audit receipt for executed rather than merely available scenarios.

## Named action map

All entries below have callbacks in **both** hosts. Default chords remain independently configurable except driver-owned safety keys. A configured chord overrides matching defaults, not every binding for an action. Native fall-through is deliberate only with `preventDefault:false`. Unknown action names are inert, not Pi aliases.

| Action(s) | Default(s) / actual effect |
|---|---|
| `app.interrupt`, `app.exit`, `app.escape` | Ctrl+C, Ctrl+D, Escape; reserved cancellation/empty exit/modal close |
| `app.help`, `app.hotkeys` | Alt+H or Ctrl+Slash; F1 or Alt+K; real help or passive view |
| `terminal.clear` | Ctrl+L; refresh without changing draft |
| `input.submit`, `input.followUp` | Enter; Alt+Enter or Ctrl+Q; Core steering/follow-up |
| `input.newline`, `input.dequeue`, `input.externalEditor` | Alt+J; Alt+Up; Ctrl+G; insert LF, restore queue, trusted editor |
| `transcript.up`, `transcript.down` | PageUp; PageDown or Alt+Down; actual bounded transcript preview/viewport |
| `editor.left`, `editor.right`, `editor.home`, `editor.end` | Left/Right, Home or Ctrl+A, End or Ctrl+E; grapheme/logical-line caret |
| `editor.wordLeft`, `editor.wordRight` | Ctrl+Left or Alt+B; Ctrl+Right or Alt+F; whitespace-word caret |
| `editor.deleteWordLeft`, `editor.deleteWordRight` | Alt+Backspace; Alt+D; delete whitespace word |
| `editor.undo`, `editor.redo` | Ctrl+Z; Alt+Z; draft-only undo/redo, not journal rollback |
| `editor.previous`, `editor.next` | Up/Down; exact history/draft restoration |
| `editor.backspace`, `editor.delete`, `editor.clear`, `editor.complete` | Backspace, Delete, Ctrl+U, Tab; grapheme deletion, clear, completion |

Hotkeys retain exact underlying draft/caret **and undo history**; modal queries have separate edit history and cannot become provider input through undo. There is no general action executor in the passive view. `/help` in both renderers documents new editing keys, paste bounds and unsupported capabilities directly to users.

## Pinned Pi action adaptation inventory

Static comparison uses Pi commit `06a466935536f8c9bcacb2d5efc0fc021be1bdff`, `packages/coding-agent/src/core/keybindings.ts` (43 application actions) plus `packages/tui/src/keybindings.ts` (47 TUI actions). The following 90-name inventory maps **intent**, not key/config imports. Native defaults, reserved Ctrl+C/Escape behavior, platform-specific chords and configuration-array grammar are independent. Every listed unsupported action remains a retained difference, not a hidden alias or an upstream acceptance claim.

| Pinned action name(s) | Native outcome or unsupported difference |
|---|---|
| `app.interrupt`, `app.clear`, `app.exit` | `app.escape`/`app.interrupt`, `editor.clear`, `app.exit`; Ctrl+C is not Pi's clear binding |
| `app.suspend` | Unsupported suspend action; Ctrl+Z is native draft undo |
| `app.thinking.cycle`, `app.thinking.save` | Explicit `/thinking <level>`; no cycle/save selector action |
| `app.model.cycleForward`, `app.model.cycleBackward`, `app.model.select` | `/model cycle`, `/model <reference>`; no reverse-cycle or model-picker keyboard action |
| `app.tools.expand`, `app.thinking.toggle`, `app.session.toggleNamedFilter` | Unsupported toggle/filter UI |
| `app.editor.external`, `app.message.followUp`, `app.message.dequeue` | `input.externalEditor`, `input.followUp`, `input.dequeue` |
| `app.message.copy`, `app.clipboard.pasteImage` | Explicit `/copy` of last assistant; bounded `@file` images/text, not selection-copy/image-clipboard actions |
| `app.session.new`, `app.session.tree`, `app.session.fork`, `app.session.resume` | Explicit `/new`, `/tree` + `/navigate`, `/fork`, `/list` + `/switch`; no equivalent picker actions |
| `app.tree.foldOrUp`, `app.tree.unfoldOrDown`, `app.tree.editLabel`, `app.tree.toggleLabelTimestamp` | Unsupported interactive tree folding/entry-label/timestamp controls |
| `app.session.togglePath`, `app.session.toggleSort`, `app.session.rename`, `app.session.delete`, `app.session.deleteNoninvasive` | `/session`, `/name`, inactive `/delete`; no picker path/sort/conditional deletion actions |
| `app.models.save`, `app.models.enableAll`, `app.models.clearAll`, `app.models.toggleProvider`, `app.models.reorderUp`, `app.models.reorderDown` | Unsupported terminal model-batch selector actions; native configured scopes and explicit model commands remain |
| `app.tree.filter.default`, `app.tree.filter.noTools`, `app.tree.filter.userOnly`, `app.tree.filter.labeledOnly`, `app.tree.filter.all`, `app.tree.filter.cycleForward`, `app.tree.filter.cycleBackward` | Unsupported terminal tree-filter actions |
| `tui.editor.cursorUp`, `tui.editor.cursorDown`, `tui.editor.historyPrevious`, `tui.editor.historyNext` | Native `editor.previous`/`editor.next` history, not vertical multiline cursor navigation |
| `tui.editor.cursorLeft`, `tui.editor.cursorRight`, `tui.editor.cursorWordLeft`, `tui.editor.cursorWordRight`, `tui.editor.cursorLineStart`, `tui.editor.cursorLineEnd` | `editor.left`, `editor.right`, `editor.wordLeft`, `editor.wordRight`, `editor.home`, `editor.end` |
| `tui.editor.jumpForward`, `tui.editor.jumpBackward`, `tui.editor.pageUp`, `tui.editor.pageDown` | No character-search jump or editor page navigation; native page actions scroll transcript |
| `tui.editor.deleteCharBackward`, `tui.editor.deleteCharForward`, `tui.editor.deleteWordBackward`, `tui.editor.deleteWordForward` | `editor.backspace`, `editor.delete`, `editor.deleteWordLeft`, `editor.deleteWordRight` |
| `tui.editor.deleteToLineStart`, `tui.editor.deleteToLineEnd`, `tui.editor.yank`, `tui.editor.yankPop` | No shared kill-ring/yank or delete-to-line action; `editor.clear` clears the entire draft |
| `tui.editor.undo`, `tui.input.newLine`, `tui.input.submit`, `tui.input.tab`, `tui.input.copy` | `editor.undo`, `input.newline`, `input.submit`, `editor.complete`; selection copy unsupported |
| `tui.select.up`, `tui.select.down`, `tui.select.pageUp`, `tui.select.pageDown`, `tui.select.confirm`, `tui.select.cancel` | Native passive hotkeys browse pages/filter/close; no generic configurable selection-component protocol |
| `tui.altScreen.pageUp`, `tui.altScreen.pageDown`, `tui.altScreen.halfPageUp`, `tui.altScreen.halfPageDown`, `tui.altScreen.lineUp`, `tui.altScreen.lineDown` | `transcript.up`/`transcript.down` use host-native increments, not separate page/half/line actions |
| `tui.altScreen.previousPrompt`, `tui.altScreen.nextPrompt`, `tui.altScreen.search`, `tui.altScreen.searchNext`, `tui.altScreen.searchPrevious`, `tui.altScreen.searchClose`, `tui.altScreen.top`, `tui.altScreen.bottom` | Explicit `/search`; no semantic prompt jumps, match-selection/search overlay or viewport top/bottom actions |

## Per-setting native support map

The following inventory covers every canonical `AgentSettings` top-level field; nested groups inherit the stated policy unless listed separately. Schema acceptance is storage validation, never proof of a host consumer. The existing [settings trust/merge contract](./cli-reference.md#agent-settings) and [theme source policy](./themes.md) remain authoritative.

| Field(s) | CLI status and lifecycle |
|---|---|
| `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `modelThinkingLevels`, `thinkingBudgets`, `enabledModels` | Consumed at startup and interactive reload, with CLI/session model choices and capability clamps |
| `steeringMode`, `followUpMode` | Consumed; reload refreshes Core queue-delivery defaults |
| `defaultTools`, `codemode` (mode, inlineBudget, limits) | Consumed by selected loadout; reload, with unchanged authorization/absolute ceilings |
| `externalEditor`, `shellPath`, `shellCommandPrefix`, `npmCommand`, `providerApiKeyCommands` | Consumed executable trusted configuration; reload, no authority granted by parsing |
| `defaultProjectTrust` | Consumed agent-directory-only policy; fresh trust on reload; explicit process decisions remain pinned |
| `sessionDir`, `tuiMode` | Consumed at startup only; no relocation or renderer replacement on reload |
| `compaction`, `branchSummary` | Consumed bounded policy; reload; navigation generation remains explicitly requested |
| `theme`, `themes` | Consumed native palette/source selection and live reload; explicit CLI/environment/manual selection retains its precedence |
| `quietStartup` | Consumed full/header/quiet startup policy; reload saves future preference, never replays welcome |
| `transport`, `httpProxy`, `httpIdleTimeoutMs`, `websocketConnectTimeoutMs`, `retry` | Consumed provider/agent policy; reload, with existing scope/deadline rules |
| `packages`, `extensions`, `skills`, `prompts`, `enableSkillCommands` | Consumed bounded trust-gated resource discovery/activation; reload |
| `hideThinkingBlock`, `doubleEscapeAction`, `treeFilterMode` | Unsupported stored-only; no toggle/tree UI consumer |
| `fullscreenExitOutput`, `fullscreenScrollbar`, `fullscreenCopyOnSelect`, `fullscreenWheelScrollLines` | Unsupported stored-only; no implied mouse/selection/exit-transcript implementation |
| `editorPaddingX`, `outputPad`, `autocompleteMaxVisible`, `showHardwareCursor` | Unsupported stored-only; native fixed layout/cursor behavior remains |
| `images.autoResize` | Effective for new model-owned prompt/post-hook tool data-images before persistence; false preserves supported-format original data. Virtual prompts use [last-successful physical/default limits](./providers.md#routed-image-policy-04b-partial), tools the current physical responder. Attachment-path/limit reconciliation remains04b; no history rewrite or terminal rendering authority |
| `terminal` (showImages, imageWidthCells, clearOnShrink, showTerminalProgress, hyperlinks, images, trueColor), `images.blockImages`, `markdown` (codeBlockIndent, mermaid) | Unsupported stored-only fields/groups; no protocol negotiation/rendering/image blocking authority |
| `cacheWarming` | Consumed per provider turn; default `streaming`, optional `off`/`idle`, potentially billable economic/time-bounded replay; see [dispatch policies](./model-dispatch-policies.md) |
| `showCacheMissNotices` | Consumed for bounded active-branch historical cache notices at startup and idle prompt boundaries in both hosts; reload affects subsequent presentation, never erases regular scrollback or disables billable warming |
| `lastChangelogVersion`, `collapseChangelog`, `enableInstallTelemetry`, `enableAnalytics`, `trackingId`, `deviceId`, `warnings.anthropicExtraUsage` | Unsupported stored-only; no implied update, telemetry or billing-warning implementation |

Pinned Pi `src/core/settings-schema.ts` uses these same presentation-field names; common spelling does not transfer defaults, transport timeouts, privilege or executable authority. Its `queueMode`/`websockets` legacy intent has the documented native migrations; `$schema` is editor metadata, not behavior. Pi's `"disabled"` timeout literal is not native validation, and native bounds/global-only rules and package/resource dialects still apply. No Pi settings-file import is added.

Each configured unsupported top-level field produces a fixed value-free warning on interactive startup/reload, even when set to `false`; nested values are never printed. `/settings` marks it `unsupported by CLI (stored only)` with source scope. The command distinguishes the **saved** theme/mode from the actual active palette and startup-selected renderer. Headless channels receive no new unsupported-terminal banner. Unknown/invalid field diagnostics, project trust and schema behavior are unchanged; no settings are deleted or rewritten.

## Critical flows and invariants

1. Capture paste bytes before decoder/action dispatch → bound/normalize/sanitize complete text → insert once into the draft → explicit Enter alone admits commands/provider work. A paste is one undoable edit. Never feed embedded LF to `readline.write`.
2. Regular readline uses `historySize:0` and application history: Node 24 otherwise normalizes/reverses LF entries. Publish owned `line`/`cursor` using their writable runtime properties (Node types mark them readonly), then call public `prompt(true)`; do not call private readline methods. Fullscreen uses the same editor model with host-owned rendering.
3. Suspend draft/undo before passive view → use separate modal input/history → restore exact suspended state; retirement cannot publish late editor replacement.
4. Enable bracketed paste only after interactive driver admission; disable during external editor handoff and before owned cleanup. Fullscreen resize listener is released by the input owner. No terminal sequences enter print/JSON/RPC.

## Associated tests

- `packages/cli/src/tui/terminal-settings.test.ts`: implemented warming/notice modes are not stored-only warnings; `cli/cache-notices-process.test.ts` verifies actual regular/fullscreen historical visibility without provider work.
- `packages/cli/src/tui/editor-state.test.ts`: grapheme deletion/movement, word/newline/undo/redo/caret and bounds; `fullscreen-input.test.ts` and `utils/terminal-actions.test.ts`: host actions, history, cancellation and retirement.
- `packages/cli/src/utils/keypress-gate.test.ts`: actual readline no-dispatch fragmented UTF-8/control paste, whole oversized rejection, unfinished retirement and ordinary theme filtering.
- `packages/cli/src/tui/fullscreen-ui.test.ts`: actual multiline frames, narrow/short resize/cell bounds, streams/panels and cleanup; `terminal-text.test.ts`: control filtering and huge grapheme width controls.
- `packages/cli/src/cli/keybindings-process.test.ts`: both genuine PTYs, exact Unicode/multiline persisted input, undo/redo, resize/history, remapped words, active-versus-stored settings and reload, plus existing action/view/trust/headless controls.
- `packages/cli/src/cli/{keybindings-escape-process,keybindings-scroll-process,theme-sources-process,editor-theme-validation-process}.test.ts`: real escape/queue/scroll/source/reload and invalid palette controls; `utils/theme-schema.test.ts`: all 58 tokens and real palette loads.
- `packages/cli/src/tui/{theme-manager,theme-input-filter}.test.ts`: safe bounded probes and report filtering; `tests/functional-parity/installed-executable.test.ts`: genuine packed PATH-bin hosts, exact multiline/Unicode/undo/resize, passive view/reload and byte-exact schemas outside checkout.

## Common Changes

- Add an editor operation in `editor-state.ts`, declare its native action/default in `terminal-actions.ts`, and exercise both actual PTYs; update the 29-action inventory/page expectations deliberately, not by weakening assertions.
- Support a stored-only setting by implementing its actual consumer and lifecycle in both applicable hosts, removing only its matching unsupported entry, then testing dispatch/reload/negative authority. Never equate JSON-schema acceptance with implementation.
- Extend terminal protocols only with explicit negotiation, bounds, cancellation and cleanup tests; keep terminal-generated input separate from pasted or untrusted provider text.

## Related Domains

- [CLI interface](./cli-reference.md): invocation, queues, sessions and command routing.
- [Terminal themes](./themes.md): palette formats, safe probes and trusted reload.
- [Native extension contract](./native-extension-contract.md): plain-text panels and unsupported foreign renderers.
