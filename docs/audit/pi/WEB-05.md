# WEB-05 — Native interactive terminal contract

Scope: [AUDIT-5](./AUDIT-5.md), WEB-05. Retain native `node-pty`/xterm, UTF-8 byte cursors and per-workspace restoration. This is not Pi Web's UTF-16 protocol, a serialized terminal screen, a shell sandbox or whole-platform qualification.

## Ownership and replay

| Surface | Native contract |
|---|---|
| Process owner | Server `runtime/terminal-runtime.ts` owns detached PTYs. Hiding, changing tabs/workspaces or losing HTTP does not kill a shell. Explicit Delete removes its record and requests termination; Server shutdown removes all records. Completed retained IDs remain readable until removal/pruning |
| HTTP authority | `/api/terminals` requires the existing authenticated `terminal` capability and Origin policy. Canonical allowed-root resolution and fresh project trust gate creation, reads, input and resize. Administrative termination remains available for cleanup without granting new execution. Responses are no-store; SSE is no-store/no-transform |
| Cursor units | `offset`, `endOffset`, `lastOffset`, `oldestOffset`, query `after`, SSE IDs and fallback `Last-Event-ID` are nonnegative safe-integer **UTF-8 bytes of published, redacted output**. Never use JavaScript string length or convert a Pi cursor. UTF-16 is used only for the separately named string/chunk bound, not replay arithmetic |
| Event boundaries | Output spans `[offset, endOffset)`; byte length must equal the encoded payload. Exit has zero width and remains replayable at the final cursor. Expired, future and interior-event cursors reset to the oldest retained complete event rather than slicing a character. A coincidentally valid integer cannot identify its originating foreign protocol |
| Retention | Default two MiB and 4,096 events per record, twelve active PTYs, 100 retained records and 64 subscriptions per terminal. Output chunks contain at most 16,384 UTF-16 code units without splitting a surrogate pair. Existing runtime-option ceilings remain unchanged; the 4,096-event cap is fixed. Removal closes subscribed SSE leases and releases listeners |
| Browser projection | Lazy `services/terminal-replay.ts` validates matching IDs, byte lengths, bounds, statuses and optional exit metadata through the shared bounded SSE reader. `TerminalPanel` checks continuity, skips already consumed output and resets xterm with an EN/FR truncation notice before retained replay. Terminal status cannot be resurrected by a late running resize reply |

The buffer is bounded ANSI history, not a persistent screen or full transcript. Reset may lose older prompts, control-sequence context, cursor placement and application state. Browser xterm retains its existing 10,000-line scrollback. A tab/view remount starts a fresh renderer and rereads retained Server output; it does not deserialize an inactive screen.

## Input and view lifetime

- Serialize browser input in original order: at most 64 KiB per send, 256 KiB queued including in-flight input, and 64 pending sends. Refuse oversized paste as a whole, not an automatically chunked partial command. Preserve xterm bracketed-paste handling with `terminal.paste`; the owned Ctrl+Shift+V handler prevents the duplicate native browser paste.
- An uncertain/refused write disables input, aborts its owned transport and drops queued commands. Never resend the command; explicit Hide/Reopen is recovery, not rollback of already admitted shell input.
- Browser offline notification disables input. Online renews only the owned SSE subscription at its consumed byte cursor, including when the browser kept the previous socket alive; it never creates a PTY or resends input. Fresh running readiness restores controls. Permanent 403/404/409 stream refusal withdraws input and stops automatic reconnection.
- Canonical workspace ID/cwd/trust lifetime owns list/create/delete, input/resize, SSE, clipboard publication, xterm and resize observers. Abort/identity guards prevent old replies from adding tabs to a replacement workspace. Cancellation cannot undo an already admitted create/write; returning to its workspace discovers the actual running PTY.
- `sessionStorage` v1 holds only open/active/tab-ID metadata per workspace. Both App admission and panel parsing refuse more than 32,768 code units; panel reads at most twelve unique valid IDs of at most 200 code units each. Stored metadata grants neither trust nor process authority. Saved-open restoration does not silently replace expired IDs with a new shell; New terminal is explicit. Initial opening survives development StrictMode's retired hydration.
- Existing terminal-only themes, keyboard focus, touch modifiers/application-cursor keys and viewport controls remain independent of the application theme. Input is unavailable before readiness, after exit or after an uncertain write. No general editor or Pi panel-retention adaptation is introduced.

[IMPORTANT] An authorized terminal executes as the Server OS user. The environment allowlist prevents automatic inheritance of provider/server variables; it does not prevent an authorized shell from reading files accessible to that OS user, sourcing its login profile, accessing the network or launching descendants. Delete requests the native PTY's termination, not an OS-wide proof against deliberately daemonized or signal-resistant descendants.

## Requirement-to-evidence map

| WEB-05 requirement | Owning evidence |
|---|---|
| Native units, reset, exit and bounds | `packages/server/src/runtime/terminal-runtime.test.ts`: Unicode byte offsets, expired/future/interior-event reset, zero-width exit, surrogate-safe chunks, byte/event bounds, removal subscriptions and shutdown. `packages/web/src/services/terminal-replay.test.ts`: valid Unicode/readiness/exit and malformed, foreign or mixed-unit DTO refusal |
| Real HTTP/PTY lifetime | `packages/server/src/api/terminal-lifecycle-http.test.ts`: actual admin/Origin/trust refusal, 36,000-byte Unicode input with exact hash, no inherited provider/auth environment, oversized input refusal, resize, real exit 7, more than two MiB output/expired and future replay, stream removal and Linux shell/foreground-child termination. Existing `web-server.test.ts` retains native API/security regressions |
| Real browser PTY | `e2e/terminal-lifecycle-live.spec.ts`: emitted Server/static Web with normal auth/trust, EN desktop/FR touch, exact once-only bracketed Unicode paste/hash, oversize refusal, actual offline/online cursor renewal without duplicate output, physical exit, expired IDs and explicit replacement. Desktop holds a genuine admitted create across an in-app workspace switch, then restores independently owned processes |
| Input/recovery and metadata | `e2e/terminal-input-lifetime.spec.ts`: controlled serialized writes, failed-write queue withdrawal/no replay, explicit recovery, expired Unicode replay/reset/deduplication and oversized restoration refusal before process creation. These controlled cases are not PTY/auth/trust proof |
| Tabs, keys, themes and presentation | Existing `e2e/terminal.spec.ts` and `e2e/terminal-controls.spec.ts`: workspace restoration/isolation, real mobile-touch-to-PTY bytes, one-shot modifiers, application cursors, disabled states, storage denial/peer events, theme/viewport identity, EN/FR desktop/mobile Light/Dark axe/overflow and four unchanged captures. Native fixtures use byte cursors |
| Production native installation | Repository production Docker build installs runtime-only dependencies, retains the non-root user and native `node-pty` installation. The retained network-disabled production probe runs installed `ai-harness-web --help` outside the checkout cwd, actual trusted HTTP PTY/Unicode/exit/replay/removal and built static Web; exact image/command/results belong to the journal receipt |

## Qualification limits

Executed commands, exact frozen inputs, reviewed unchanged captures and retained failed attempts belong to the dated AUDIT-5 journal/local receipt. Linux Docker and Chromium desktop/touch emulation are not physical Android/iOS/Safari/macOS/Windows, public npm distribution, Pi differential/wire compatibility or complete QUA-01 acceptance. No credential import/export, security/budget/deadline/retry relaxation or native runtime-policy change is included.
