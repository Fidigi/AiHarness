# Operator runbook

This runbook covers the shared CLI/Web deployment and the MCP/code-mode delta. It complements the [user guide](./user-guide.md), [container guide](./containerization.md) and [architecture decisions](../../contributors/en/architecture-decisions.md). Procedures describe implemented AiHarness behavior, not complete upstream parity or certification of your deployment.

## 1. Prepare and verify the host

1. Run AiHarness as a dedicated, least-privileged OS account. Keep its private data, credentials, trust store and installed code **outside directories editable by agents**.
2. Choose allowed workspace roots and an existing default directory. A root grants path reach, not project trust. Do not expose the home or filesystem root merely to suppress a path error.
3. Supply credentials through a secret manager or the process environment. Use a stable, protected `AI_HARNESS_MASTER_KEY` when encrypted persistence is needed; generating a new key on every restart loses access to earlier encrypted records.
4. Keep the default loopback binding for a local installation. Before remote exposure, configure authentication, HTTPS at a trusted reverse proxy, allowed origins and proxy-level limits. Do not use the insecure-remote override as a production remedy.
5. Start the service, check its logs without copying secret values, then verify the shell, API authorization and an explicit mock conversation independently. HTTP200 alone is not a health, tool, vendor or deployment acceptance test.

Example local launch, after provisioning the environment:

```sh
ai-harness-web --hostname 127.0.0.1 --port 3080 --no-open
```

For source development, API3099 and Vite3080 are separate processes; the production launcher serves one port. See [launch modes](./user-guide.md#launching-from-sources), rather than proxying a development server as a production artifact.

| Configuration | Operational boundary |
| --- | --- |
| `AI_HARNESS_DATA_DIR` | Server-owned data directory; default `~/.ai-harness`. It is not an allowed workspace root. |
| `AI_HARNESS_AGENT_DIR` | CLI/RPC settings, resources and credentials. Pre-trust resolution refuses project-controlled directories or selects an independent fallback. |
| `AI_HARNESS_SESSIONS_DIR`, CLI `--session-dir` | Session storage/lookup, not output-write or workspace authority. |
| `AI_HARNESS_DEFAULT_CWD`, `AI_HARNESS_ALLOWED_ROOTS` | Initial canonical cwd and allowed roots. Restart after changing the server environment. |
| `AI_HARNESS_AUTH_TOKEN`, `AI_HARNESS_ADMIN_TOKEN` | Separate user/admin roles; a lone auth token also has admin capabilities. |
| `AI_HARNESS_MASTER_KEY` | Durable encrypted provider/MCP credentials. Keep it separate from data backups and project files. |
| `AI_HARNESS_ALLOWED_ORIGINS` | Additional accepted origins, not authentication or permission to bypass HTTPS. |
| `AI_HARNESS_DEFAULT_PROVIDER`, `AI_HARNESS_DEFAULT_MODEL`, `AI_HARNESS_DEFAULT_THINKING`, `AI_HARNESS_DEFAULT_TOOL_PRESET`, `AI_HARNESS_AUTO_COMPACTION` | Server environment overrides; visible as locked effective values rather than editable browser defaults. |
| `AI_HARNESS_OFFLINE` / CLI `--offline` | Suppresses automatic CLI discovery and credential work. **Not a network firewall**, not Web offline mode. |

The exact grammar, defaults and additional controls remain in [configuration](./user-guide.md#agent-settings) and [network listening](./user-guide.md#network-listening). Provider-specific keys belong to the selected integration; do not put them in screenshots or issue reports.

## 2. MCP: configure, test, authorize, then use

| Operation | Does not imply |
| --- | --- |
| Inventory or paste Preview | Connection, command evaluation, OAuth, trust grant or credential initialization |
| Save/import/Edit/Enable/exposure | A healthy or active runtime; a timed-out response may follow a committed write |
| Explicit Test | Tool invocation, persistent session connection, sign-in or credential publication |
| Explicit Sign in / CLI `mcp login` | Tool authorization, issuer revocation support or safe third-party code |
| Connected session host | A sandbox or per-call user approval |

1. In **Settings → MCP servers**, select the exact global/project row and verify the masked target. Project bodies require a saved allow; selecting a folder or observing an empty folder's implicit safe status is insufficient.
2. Preview the original paste using the intended foreign/AiHarness syntax. Review destination, variable names and every secret/trust confirmation. Prefer protected environment references. Project imports refuse remaining literal secrets; reserved AiHarness authentication/master-key references are not eligible.
3. Save one entry. **Edit replaces the whole entry**: include every field to retain. After any failure, timeout or stale revision, reload canonical inventory before retrying. Do not assume rollback or repeat an uncertain write blindly.
4. Choose Test only if you intend to execute the configured stdio process or contact its HTTP endpoint. Review counts, working directory, bounded diagnostics and current exposure. Configuration edits invalidate old Test/runtime status.
5. For `needs-auth`, explicitly sign in. The loopback callback listens on the AiHarness host, not the browser's machine. When needed, paste the complete redirected URL unchanged into the sign-in panel; never paste an access token. Stable encrypted storage is required.
6. Run a prompt only after choosing least-privileged exposure and preset. Direct tools can be declared immediately; deferred tools require search before a later declaration; code-mode tools stay script-only. Hidden tools are unavailable to declaration, discovery and nested execution. Read-only hints come from the server and cannot make a dishonest tool safe.
7. Disable/remove unused entries. Undo is bounded and temporary. Logout removes local credentials and retires local connections; use the issuer separately for remote revocation.

CLI administration and passive refresh use the same Core contracts:

```sh
ai-harness mcp login documentation --no-open --timeout 120
ai-harness mcp logout documentation
```

Ordinary CLI/RPC/Web prompts may reuse or refresh existing OAuth state, but never start interactive sign-in. Renaming an MCP server or changing its URL changes credential identity. See [MCP configuration and OAuth](./user-guide.md#mcp-configuration).

## 3. Tools and code mode

- Review **Tools and presets** for the selected project. The effective tool list intersects current registration, preset, scoped settings and active allowlists; finding a tool is not authority to call it.
- Check the cached code-mode health result, choose the desired global/project policy and permit the helper plus intended nested tools. Chat-only disables it; read-only still applies to nested calls. An unavailable helper is not repaired by widening workspace roots.
- The QuickJS guest has bounded memory, execution, calls and results, with no ambient Node/files/network. **Host tools, MCP processes and trusted extensions retain real OS/network privileges**. Use process/container isolation for those privileges.
- Script store changes publish only on success and follow the session branch. Already executed host calls or billed model helpers are not rolled back/refunded if later code fails. Never use the store as a secret vault.
- Inspect Process/code-mode cards for nested status, truncation and incomplete cost. A known subtotal is not a complete total. Reconnect display does not make running progress crash-durable.

See [code mode](./user-guide.md#code-mode) and [Web reply/progress limits](./web-replies.md).

## 4. Workspaces, files and access

1. Verify canonical cwd before granting trust. Nearest saved allow/refusal applies; explicit child refusal can override a parent allow. Browser capabilities and path confinement are separate from that trust decision.
2. If the default directory is unavailable, select an existing allowed directory. No arbitrary first root is selected. A browser cannot widen `AI_HARNESS_ALLOWED_ROOTS`; correct host configuration and restart instead.
3. Treat **New folder** as one direct-child creation. Review explicit upload collision policy; never assume overwrite. Opening a file or displaying a tool-produced path does not grant arbitrary server-file access.
4. For linked directories, grant the exact requested consent and separately review source trust. Consent is bounded read access, not write/execute permission or a new global root. Revoke it when no longer needed.
5. Distinguish `!`/`!!` session commands from PTY terminals: the former persist bounded results and differ in model-context inclusion; the latter are interactive host processes. Stop the owned process rather than merely closing a network connection.
6. Treat downloaded files, retained full-output files and exported transcripts as sensitive. Redaction recognizes registered credentials, not every possible secret in arbitrary text.

See [linked directories](./linked-directories.md), [file-pane recovery](./workspace-loading.md) and [file/terminal behavior](./user-guide.md#explorer-git-and-files).

## 5. Sessions, interruption and recovery

- A new Web draft persists on first send. Runs are detached: tab navigation or SSE disconnect does not stop them. Reconnect retrieves canonical state plus bounded sequenced replay; an evicted cursor requires a snapshot, not invented missing events.
- Use **Stop** for the current run and inspect its resulting phase. Cancellation request, logical withdrawal, durable publication and physical settlement of noncooperative work are distinct. An already admitted captured save can finish; a lost HTTP response does not prove it did not commit.
- Branch ancestry follows parent links. Clone/fork/history-edit actions have different semantics; verify destination before sending. Compaction preserves journal history while reducing effective model context; context estimates are not billed usage or exact system/tool/media wire sizes.
- Do not repeatedly retry impossible context/output requests. Check selected model and known limits, reduce the request or explicitly compact a useful prefix. Unknown limits stay unknown; complete model/media admission and automatic overflow recovery are not certified.
- Before migration, restoration or bulk cleanup, stop **all** CLI/server writers and back up the effective data, agent and session directories coherently. Include configuration, trust, journals and encrypted credentials, preserving restrictive permissions. Keep the master key separately. Restore into a separate protected directory and verify selected sessions before reopening writers.
- JSONL export is message-only, **not a complete journal backup**. Keep original `.jsonl` files for complete persisted history. Volatile runs, dialogs, replay journals and temporary Undo state are not rebuilt as active work after restart.

See [sessions](./user-guide.md#sessions-and-files), [standalone export](./standalone-operations.md) and [session SDK ownership](../../contributors/en/session-sdk.md).

## 6. Models, settings and reload scope

| Change | Apply/recovery rule |
| --- | --- |
| Server environment, bind/auth/data roots/master key | Restart the responsible host; do not expect a browser refresh to change process configuration. |
| Web global/project/session settings | Use the visible scope/provenance. Inherit/Auto removes an override; environment wins. Refresh canonical state after uncertainty. |
| CLI interactive settings/resources | Inspect `/settings`; use `/reload` for supported settings/resources. Session directory and renderer kind require restart. |
| RPC settings | Restart for startup defaults/resources; idle `reload_context_settings` rereads only `compaction` and `branchSummary`, not arbitrary executable resources. |
| Web package/executable resources | Install/activate is not execution. Explicitly reload the correct session/workspace generation. Passive catalog reads do not install or import code. |
| Optional Settings/explorer/dialog import failure | Use the local Close action; copy unsent text before explicit page reload/retry. Do not change host trust to fix a client asset failure. |

Select an actually available, enabled model for its provider. Refresh discovery explicitly when appropriate; published/configured fallback is not a guarantee that the remote model exists or that unknown prices/limits are zero. Keep compatible-provider credentials server-side. General provider rename is not an ordinary supported operation: restricted exclusive-host mode is OFF by default and has a separate [recovery contract](../../contributors/en/server-architecture.md#restricted-provider-rename). Never force-clear its intent online.

Review [resource batch outcomes](./resource-batches.md), [settings loading](./settings-loading.md) and [model configuration](./user-guide.md#configuring-web-ui). Executable provider/extension code is trusted host code, not a second sandbox.

## 7. Incident checklist

| Symptom | Safe first response |
| --- | --- |
|401/403 or Origin refusal|Check user/admin identity, proxy origin and the requested capability; do not disable authentication.|
|Project locked or path refused|Verify cwd, allowed roots and saved nearest trust; inspect metadata before approving resources.|
|MCP configured but unavailable|Select the current row, review explicit Test/needs-auth/exposure and then a prompt; do not expect inventory GET to connect.|
|Secret storage unavailable|Verify stable master key, private writable independent directory and permissions; never fall back to project plaintext.|
|Timed-out mutation or disconnected client|Reload canonical state first; distinguish no response from no publication.|
|Missing run/progress after restart|Inspect persisted journal, not a fabricated live run; replay and pending interactions are bounded volatile state.|
|Unknown cost or oversized context|Keep unknown/incomplete labels; do not substitute zero or vendor-token certainty.|
|Health endpoint200 but failed watchdog or vendor call|Investigate each observed check independently; do not promote HTTP200 into overall health.|

Collect version, operation, scope/canonical cwd, stable error code, time and redacted logs. Never attach tokens, master keys, raw MCP configuration/arguments, authorization callback URLs or unreviewed transcripts. Preserve failed outcomes before retrying; a later pass does not diagnose an earlier crash.

For updates, review release metadata and back up before an explicit upgrade; release checking does not install binaries. The [static demo](./static-demo.md) is synthetic and separate from an authenticated live backend. A Pages workflow, local build, desktop emulation or passing browser matrix does not prove remote publication, physical-device behavior or live-provider acceptance.

## Related documentation

- [English user index](./README.md) / [French runbook](../fr/operations.md)
- [Developer architecture decisions](../../contributors/en/architecture-decisions.md)
- [Detailed Web/server architecture](../../contributors/en/server-architecture.md)
