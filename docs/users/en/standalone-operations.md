# Standalone authentication and session export

These commands exit before agent, provider, extension and terminal startup. `ai-harness --help` adds links to `auth --help` and `export --help`; existing package/MCP help and actions remain unchanged.

### Provider credentials

```sh
ai-harness auth --help
ai-harness auth list --json
ai-harness auth login openai --timeout 120
ai-harness auth logout openai
```

`auth list` lists stored credential metadata and whether operator device-flow configuration is present. It never reveals keys/tokens, executes credential commands, refreshes credentials or contacts a provider. It does not claim to list effective environment/command credentials. `--json` is valid only for `list`.

Login uses the existing operator-configured HTTPS device flow. For the selected lowercase provider identifier, configure `AI_HARNESS_OAUTH_<PROVIDER>_DEVICE_URL`, `_TOKEN_URL`, `_CLIENT_ID`, and optionally `_SCOPE`. There are no bundled provider registrations, automatic browser opener, browser callback or PKCE login in this command. `AI_HARNESS_MASTER_KEY` must enable the existing independent encrypted `credentials.enc` store; without durable encryption, login and logout fail before network access. The existing pre-trust data-directory policy applies; project-controlled agent directories cannot supply their own credential store.

Authorization instructions and the user code appear on stderr, not stdout. Codes changed by terminal formatting, UTF-8 encoding or known-secret redaction are refused before instructions, polling or credential publication; the operator is never asked to enter silently altered characters. Device codes, tokens and the complete authorization URL/query are not printed. After encryption succeeds, stdout contains only a fixed success acknowledgement. Ctrl+C/SIGTERM cancels initial authorization, token response bodies and polling; `--timeout` is an integer from 1 to 300 seconds (default 300), additionally limited by the device code's lifetime. The overall login deadline uses a monotonic clock: a wall-clock rollback cannot extend it. Transport deadlines/listeners/timers are cleaned up. An already-started Core durable write is not a cancellable transaction: cancellation does not promise rollback of encrypted state that has already committed.

Logout deletes local stored provider credentials, not issuer-side tokens or environment/command credentials. Exit codes: 0 success/help, 2 usage, 1 operational failure, 124 deadline, 130 cancellation.

### Session export

```sh
ai-harness export --help
ai-harness export --session conversation-id --format html --output ./conversation.html --approve
ai-harness export --session ./sessions/conversation.jsonl --format jsonl --output ./conversation.jsonl --approve
```

`--session`, `--format` and `--output` are mandatory for an export. Select an exact ID, unambiguous ID prefix or existing `.jsonl` session path. No selector creates a session. ID lookup inventories only filenames/metadata and opens the selected body, not every session. Store selection follows `--session-dir`, `AI_HARNESS_SESSIONS_DIR`, then trusted settings `sessionDir`, then the existing personal-session default. A selected existing storage directory grants input authority only. Path-selected sources must be inside that store or the current workspace; workspace-local sources do not require the default store to exist. Links and files outside those allowed input roots are refused.

Output must be explicitly named inside the current workspace and have the matching `.html`, `.jsonl`, `.json` or `.md` suffix. The workspace needs an effective saved allow or process-only `--approve`; `--no-approve` refuses, and opposing trust flags conflict. Output does not inherit input-store authority. Existing ordinary files are atomically replaced with mode 0600; symbolic/hard links and linked parents are refused. The input cannot be replaced by the output.

[IMPORTANT] Existing Core session-store reads may enforce private source-directory/file modes. Source bytes are not rewritten by projection normalization; unsafe original permissions are not preserved.

Exports reuse the existing slash-command exporter and Core stable writer. HTML is standalone and escaped; JSON/Markdown retain their existing projection semantics. JSONL is one message per line, not a complete v2 session journal or backup of abandoned branches. JSON provides the richer active-session projection. Shared serialization removes provider-config secret fields; the shared redactor copies/scrubs known environment and encrypted provider credentials. This is not automatic detection of every arbitrary secret in conversation text.

Only a fixed publication acknowledgement reaches stdout, never the transcript/title/path. Failures return 1 without success confirmation; publication failure does not imply unchanged disk. Check the selected output if publication fails. Help/success returns 0; malformed/unknown/conflicting arguments return 2 before startup.

This contract does not provide browser/PKCE provider login, broader provider interoperability, complete journal backups or cross-platform distribution guarantees.

## Related documentation

- [User guide](./user-guide.md)
- [Package command policy](./npm-command.md)
- [French version](../fr/standalone-operations.md)
