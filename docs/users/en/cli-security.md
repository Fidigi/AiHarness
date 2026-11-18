# CLI security, privacy warnings and terminal guidance

Use the CLI as a least-privileged account with protected agent/session directories. Project trust authorizes executable resources and tools; it does **not** create an OS sandbox. See the [operator runbook](./operations.md) for host preparation, MCP and recovery.

## Privacy warnings and output channels

| Surface | Notice and action |
|---|---|
| Interactive `/share [hours]` | A fixed privacy warning appears **before the request**. Review the active session before invoking it: this creates a public link, not an access-controlled backup. |
| Interactive `/export <format> [path]` | A fixed warning appears before destination resolution/publication for a supported export. Review the resulting file before sending it elsewhere. |
| `ai-harness export ...` | Warning on **stderr**, fixed success acknowledgement on stdout; no transcript on either channel. Help also describes the risk. Usage/selection/trust failures do not imply publication. |
| RPC `export_html` | Successful correlated `data` retains `path` and adds `warnings: string[]`. This notice accompanies the result, **not a pre-write confirmation or new event**. The explicit request authorizes the local export; clients must present the warning before offering to share its result. |
| `/bug [description]` | A fixed warning precedes the issue URL. The command prepares a URL containing your description plus Node/platform metadata; it does not submit it. Review the complete URL before opening/submitting. |

The notices contain no session text, credentials, paths or endpoint configuration. Interactive hosts can provide a separate warning sink; a synchronous sink error stops the slash operation before its share request/export write. Notices do not ask a confirmation question, silently approve trust or guarantee that an unknown secret was removed. Quiet startup does not disable them. General billing-warning preferences are not implemented by these privacy notices.

Registered credentials and known encodings are redacted where configured, but arbitrary private text, source code, personal data, customer data or previously unknown credentials may remain. HTML escaping prevents markup execution in the shared renderer; it does not make a conversation public-safe. A private file's mode is not encryption or a complete backup policy.

## Offline, proxy and network controls

| Control | Actual scope |
|---|---|
| `--offline`, `AI_HARNESS_OFFLINE=1\|true\|yes` | Immutable process-only suppression of automatic provider discovery, credential commands/cache consumption and OAuth refresh. Explicit prompts/authentication/share/package/MCP/tools/extensions still retain their ordinary authority. |
| `transport` | Provider transport choice (`auto`, `sse`, `websocket`, `websocket-cached`), not a global routing rule for all processes. |
| Agent-directory-only `httpProxy` | Shared provider HTTP(S)/WebSocket network policy. Do not assume it proxies npm, arbitrary tools, MCP subprocesses or the CLI share endpoint. |
| Provider request/idle/handshake deadlines and retry settings | Bounded provider work and value-free network failures; not physical settlement of a noncooperative extension. |
| `/share` server URL | HTTPS, or direct loopback HTTP only; no userinfo/query/fragment, no redirects, bounded lifetime/response. Invalid input refuses instead of downgrading to insecure remote HTTP. |
| Actual network prohibition | Apply OS/container/firewall rules and protect proxy configuration outside editable projects. Offline mode is **not a firewall**. |

See [provider configuration](./user-guide.md) for exact settings, defaults and source precedence. `/settings` reports supported effective sources without exposing proxy values. Never paste proxy URLs containing credentials into reports; fixed network errors deliberately omit remote bodies, headers and addresses. Restart to change the process-only offline choice; interactive `/reload` refreshes supported provider settings, not system network isolation.

## Shell aliases, profiles and executable selection

- Direct `!`/`!!` commands and model shell tools run real unattended host processes after their trust checks. `!!` excludes output from model context, **not** from persistence, terminal history or retained full-output files.
- Do not assume an interactive shell alias is present in a tool subprocess. The POSIX/default override path uses `-lc`, so login profiles can run code and can change PATH/functions. Review and protect those profiles outside the project. Do not source an untrusted project's startup script to repair a missing alias.
- Use explicit, protected executable paths for sensitive operations; inspect what a short name resolves to before relying on it. `shellPath` chooses the executable; trusted `shellCommandPrefix` is evaluated by that shell before commands. A prefix is executable code, not a literal argv array or security policy. Keep secrets out of it.
- Package `npmCommand` is different: an executable-plus-literal-prefix array, not shell syntax. An alias string or shell pipeline is not an equivalent configuration; use the [npm command procedure](./npm-command.md).
- Quote filenames for the actual shell. Unix, CMD and PowerShell have different quoting/expansion rules. Credential-like environment variables are filtered from child processes, but that does not remove files, network rights or every secret in profile/configuration text.

For a trusted POSIX workspace, `!!command -V git` can inspect command resolution without sending its output to the model. It still executes the selected shell and persists a command result; inspect the result locally rather than attaching it unreviewed.

## Windows and terminal security matrix

This is implementation/operating guidance, **not physical Windows/macOS/terminal certification**.

| Environment | Supported boundary and safe fallback |
|---|---|
| POSIX host | Default shell is `$SHELL` or `/bin/bash`; configured overrides use `-lc`. Process-group termination/escalation is best effort, not hostile-descendant containment. |
| Native Windows direct shell | Without `shellPath`, use `COMSPEC`/`cmd.exe` with `/d /s /c`. Cancellation attempts `taskkill.exe /T` then escalation/fallback; this is not proof that every detached descendant has settled. |
| Native Windows PowerShell | The dedicated `powershell` coding tool is Windows-only. Do not assume direct `!` uses PowerShell; a `shellPath` override uses the `-lc` argument convention, so do not substitute an incompatible executable blindly. |
| WSL/remote host | Paths, shell, credentials, callback listeners and permissions belong to the Node/AiHarness host, not the browser/client OS. Do not reuse host paths or trust decisions by display label. |
| Fullscreen terminal | Requires input/output TTY and raw-mode support. Unsupported requests fall back to regular mode. Use `--tui-mode regular` if terminal integration or modified-key handling is unsuitable. |
| Redirected print/JSON/RPC | No interactive terminal or startup banner. Read stdout continuously; JSON/RPC is LF-framed. Diagnostics/warnings must not be parsed as assistant text or injected as raw protocol records. |
| Terminal output | Untrusted control sequences are filtered; this is not a guarantee for every emulator, hyperlink, image protocol, clipboard/selection or physical keyboard. Do not paste unreviewed output as shell commands. |
| Export permissions | CLI exports request private `0600` files; RPC HTML also sets that mode. On Windows verify real ACLs and storage/sharing policy separately; POSIX mode bits do not certify Windows confidentiality. |

Use Escape/Ctrl+C to request interruption and inspect the resulting state. Network closure, logical cancellation and physical process/provider settlement are distinct. Do not treat an acknowledgement as a refund, rollback or proof that a child no longer runs.

## Safe diagnostics and incident recovery

1. Keep original failures, stable error code, version, operation and time. Describe canonical cwd/scope only after deciding that the path itself is safe to disclose.
2. Review settings/instruction/resource diagnostics and `/bug` descriptions locally. Value-free settings diagnostics can still reveal private paths or field names; redaction is not a universal content classifier.
3. Remove tokens, master keys, proxy credentials, raw MCP configuration/arguments, authorization callback URLs and unreviewed transcripts. Check terminal scrollback, shell history and process listings too; avoid putting API keys directly in argv.
4. Prefer a minimal mock reproduction and an explicitly reviewed excerpt. Never dump the entire environment, credential store, journal or full-output file into a report merely because the CLI redacts known secrets.
5. After an export/share error or lost response, inspect canonical server state/the selected local file before retrying. An operation may have published already; RPC HTML can rewrite its target, and no cross-process transaction/rollback is promised. Share expiry is not remote credential revocation.

See [standalone export/authentication](./standalone-operations.md), [session backup and recovery](./operations.md#5-sessions-interruption-and-recovery), [English user index](./README.md) and the [French security guide](../fr/cli-security.md).
