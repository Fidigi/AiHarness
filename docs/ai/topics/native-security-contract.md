# Native Security Contract v1

> **Navigation:** See [`project-map.md`](../project-map.md) for repository boundaries and Docker validation.

## Overview

This map owns native trust/resource precedence, credential lifecycle and browser/proxy admission. It supplements [security implementation details](./security.md), not Pi file, authentication or execution compatibility. Core API major 1 and native JSONL v2 remain unchanged; no Pi `auth.json`, `mcp-auth.json` or project-selected secret store is consumed.

## Main Entry Points

| File | Responsibility |
|---|---|
| `packages/core/src/security/{project-trust,workspace-manager}.ts` | Canonical roots, bounded resource inspection and nearest saved decision |
| `packages/core/src/{config/agent-settings,prompts/instruction-context}.ts` | Source admission, validated settings merge and instruction composition |
| `packages/core/src/{tools/workspace-tools,extensions/extension-registry}.ts` | Fresh host-owned authorization for native mutations |
| `packages/core/src/{providers/credentials,security/credential-store}.ts` | Secret ingress, resolution, encryption, refresh generations and exact-value publication |
| `packages/cli/src/{index,rpc/rpc-server}.ts`, `packages/core/src/sdk/agent-session.ts` | Native host composition; SDK opts into tools/resources explicitly |
| `packages/server/src/security/request-security.ts`, `index.ts` | Origin/Host, roles, cookies, capabilities, upgrades and public-link origin |

## Public Contracts and Interfaces

### Trust and resource map

`WorkspaceManager` first confines canonical paths to host-selected roots. Neither a trust decision nor a linked-directory read consent enlarges those roots. `resolvePreTrustAgentDirectory` rejects a workspace-controlled/symlinked agent directory as pre-trust authority; the Server alone explicitly trusts its administrator-owned data directory.

| Field/resource | Admission and precedence |
|---|---|
| `trust.json` | Independent agent/data directory; process override, nearest exact/ancestor saved allow/refusal, resource-free CLI operation, global default, then interactive ask/headless refusal. Child refusal overrides parent allow; removing the parent removes inheritance. Process overrides/temporary answers do not persist. |
| Agent `settings.json` | Independent trusted directory; bounded, no-follow, schema-validated user layer. Project-controlled overrides cannot select credentials/executables before trust. |
| Project `.ai-harness/settings.json` | Body unread until project-resource trust. Project wins scalar/array values and deep-merges objects; `packages`, `extensions`, `skills`, `prompts`, `themes` concatenate global then project. Modifier-only `defaultTools` extends global selection; a concrete list replaces it. Explicit native CLI options override settings where supported. |
| `cacheWarming`, `defaultProjectTrust`, `httpProxy`, `deviceId` | Global-only fields: rejected/omitted from project scope, not project policy authority. Parsing is not a promise that a host implements every setting. |
| `sessionDir`, `providerApiKeyCommands`, model/transport/tool settings | Project values require the same body gate. A project cannot move the pre-trust credential/trust store. Credential commands execute only under the selected host's explicit resolution policy; offline startup suppresses them. |
| `SYSTEM.md`, `APPEND_SYSTEM.md` | Explicit input first, otherwise trusted project `.ai-harness` file, otherwise independent agent file; base falls back to the native default. CLI text-or-file flags intentionally allow an operator file read; Web values are literal, not paths. |
| Context files | Agent context first, then trusted filesystem ancestors from root to cwd. Per directory use the first of `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`. Duplicate paths are removed. Before trust only bounded metadata is inspected, never project/ancestor bodies. |
| Skills, prompt templates, themes | Project body reads require trust, even for explicit paths. Settings/automatic/package selectors only narrow admitted resources. No-follow regular-file/bounds checks remain; `--no-skills`/`--no-prompt-templates` suppress discovery, not trusted explicit selections. |
| Extensions, packages | Admit the project generation/enable only after trust; regular nonlinked bounded modules/manifests. Loaded third-party JavaScript remains privileged, not sandboxed or forcibly unloaded by a later trust change. |
| MCP project config/targets/OAuth | Require a fresh **persisted** allow, not resource-free/process-only trust. Inventory is passive; explicit Test/sign-in/tool use have separate fresh-target, capability and bounded-resolution gates. |
| Session history/loadouts | Historical prompts, schemas and metadata are provenance, never executable authority. Native context edits do not rewrite raw history or grant tools. |

Instruction rendering is base, `<addendum>`, project-context blocks, then `<cwd>`. This is composition order, not a guarantee against model prompt injection. Default bounds are 256 KiB/file, 2 MiB aggregate and 64 context files; files must pass stable regular/nonlinked UTF-8 checks. Provider options remain ephemeral except the separately private native [loadout provenance](./session-context-state.md).

### Fresh execution authorization

`ExtensionRuntimeContext.isProjectTrusted?(cwd)` is an additive host callback returning a boolean/Promise. When supplied, native `write`, `edit` and `bash` prefer it over the legacy `projectTrusted` snapshot. Writes/edits check again before stable-file publication; shell checks before dispatch, including direct RPC bash. Abort remains authoritative. CLI direct `!`/`!!` also resolves fresh trust.

CLI/JSON/RPC use Core's resource-sensitive decision and independent trust store. Core runtime/SDK use the host's fresh canonical callback; SDK defaults to refusal and registers no executable tools implicitly. Web requires a saved allow even for an empty workspace and rechecks through its runtime callback. The optional legacy boolean remains source-compatible for trusted library callers; it is not live revocation by itself.

Revocation prevents newly admitted native mutations/execution through that gate, not rollback of prior filesystem/network effects, termination of already dispatched processes, or expulsion of privileged code. Already read prompts cannot be withdrawn from a provider. Stable-file checks are not OS-atomic hostile-writer exclusion.

### Credential lifecycle and export scope

- `ProviderCredentialService.setApiKey/setOAuth` default to persistent writes. Missing encrypted storage rejects with value-free `storage-unavailable`; there is no implicit memory fallback. A trusted owner may explicitly pass `persist=false` for process-local state.
- Resolution priority remains environment, trusted command, explicit memory, encrypted store. A winning encrypted resolution reloads durable bytes rather than serving an externally revoked snapshot; a winning memory/environment source does not require a healthy store.
- Deletion/replacement/synchronization retires pending resolutions through per-provider generations. Refresh writes compare the original encrypted value under the store lock; fresh random revisions from cooperating native credential-service writers defeat identical logout/relogin ABA. A losing resolver rejects with `credential-changed`, never publishes its token, and still registers newly received token values for redaction. Already returned/physically dispatched credentials cannot be recalled.
- AES-GCM store envelope/credential schema v1 remain readable; revision is private optional record metadata, not a new plaintext store or browser DTO. MCP retains its separate URL/name identity, revocation marker and guarded flow lifecycle. Logout is local deletion, not an issuer revocation request or a promise to erase environment/command credentials.
- **Export decision:** retain metadata/status/login/local logout and the exact existing local-TTY `/credential reveal <provider>` exception. Add no bulk/raw credential export, print flag, RPC/SDK/HTTP/browser reveal or Pi plaintext writer. Session exports/shares are redacted transcripts, not credential backups. Trusted low-level Core `resolve/reveal` remains credential-owner access, not a new AgentSession or remote export endpoint.
- Register actual configured/resolved credentials at ingress, including rejected late refresh results. Independently buffered streaming channels scrub before emission/persistence. Browser caches strip key-like fields but are not value recognizers; the server must scrub known values first. Arbitrary unknown sensitive prose still requires review before sharing.

### Browser/proxy deployment

Anonymous protected requests are refused when authentication is configured. A distinct user token has chat/session/read capabilities; admin additionally gets writes, terminal, configuration, credentials and packages. A lone auth token retains native admin fallback. Capabilities do not replace canonical workspace/project trust. `chat` grants execution through the trusted workspace's admitted tools/preset; it is not read-only tenancy or OS isolation from the server user.

Without configured tokens, requests lacking Origin require a loopback Host or a Host explicitly admitted by configured expected origins. Browser Origins must match a configured canonical origin or the request's same-host loopback origin. Forwarded Host/IP/proto headers never grant a role, expand roots or bypass Origin. Authenticated non-browser clients retain the existing no-Origin Host contract; credentials are still required on protected routes. Host checks counter browser rebinding, not untrusted socket access or the explicit insecure non-loopback bind override.

For an HTTPS reverse proxy:

1. Keep the backend on loopback/private transport and prevent direct untrusted access. Configure authentication, `AI_HARNESS_ALLOWED_ORIGINS` and a canonical `AI_HARNESS_PUBLIC_URL`; keep Origin intact. No wildcard/reflective CORS or implicit Express `trust proxy` is enabled.
2. Proxy WebSocket upgrades and streaming without buffering; enforce connection/body/rate limits upstream. Application rate limiting uses the actual Express peer, so proxied clients share the proxy's quota; spoofed `X-Forwarded-For` cannot obtain a new quota.
3. Set `AI_HARNESS_TRUST_PROXY=1` **only** behind a proxy that overwrites `X-Forwarded-Proto` and blocks backend bypass. This flag only permits HTTPS recognition for Secure cookies; it does not trust forwarded Host/IP or authorize requests. Without opt-in, a forged proto header cannot create that authority.
4. Browser login exchanges the token for a random HttpOnly/SameSite=Strict cookie, Secure when HTTPS is recognized. Cookie values never contain the bearer; logout invalidates the in-memory session. The explicit compatibility bearer remains confined to per-tab sessionStorage.
5. Public share links derive only from canonical public URL or admitted loopback origin, never an arbitrary/forwarded Host. Share pages remain intentionally public bounded inert snapshots, not authenticated session APIs. File-manager opening additionally requires actual loopback peer/Host.

Package/resource catalogues and exact `GET /api/mcp` do not install packages, resolve MCP command-backed values, connect servers, invoke tools or initiate OAuth. MCP GET also bypasses credential-store initialization. This is not a global no-I/O/no-command promise for every GET: other protected routes may lazily initialize administrator-configured provider credentials/session storage (including configured credential commands/refresh); explicit model discovery and Git reads have their own active boundaries. Authentication/Origin precede that bootstrap, and capability/trust checks precede protected actions/streaming/upgrades. WebSocket query credentials are rejected and bearer subprotocols are never reflected.

## Critical Flows

1. Inventory metadata → canonical decision → admitted resource bodies → current native tool selection → fresh mutation check → guarded publication/dispatch.
2. Resolve actual secret → register redactor → use provider/child → independent stream redaction → safe journal/API/share/export; refresh publishes only if its original credential identity remains current.
3. HTTP/upgrade → Origin/Host → authentication/capability → canonical workspace/trust → operation. Proxy headers are not an extra authentication channel.

## Associated Tests

- Core `security/{project-trust,workspace-manager,credential-store}.test.ts`, `config/agent-settings.test.ts`, `prompts/instruction-context.test.ts` and `sdk/agent-session.test.ts`: roots, inheritance/defaults/refusals, unread project bodies and explicit SDK ownership.
- `packages/core/src/tools/workspace-tools.test.ts`, `packages/cli/src/cli/trust-revocation-process.test.ts`, `packages/server/src/web-server.test.ts`, and genuine installed consumers: stale true contexts, pre-publication/abort checks, real print/JSON/RPC/SDK and HTTP revocation during a provider turn.
- `packages/core/src/providers/credential-lifecycle.test.ts`: explicit persistence/memory policy, stale memory/encrypted refresh, independent writers/identical relogin and external snapshot revocation. Existing provider/MCP/OAuth suites retain encryption, endpoint, cancellation and value-free failure controls.
- `packages/server/src/api/credential-privacy-http.test.ts`: actual configured local provider receives the selected Authorization value, echoes it across SSE chunks, and parent/child results, journals, replay, shares and both exports remain scrubbed with public text conserved. `e2e/live-server.spec.ts` separately configures a real encrypted credential, admits a value-bearing message through actual HTTP and verifies the built browser's rendered history, nonempty storage cache and reload omit the value.
- CLI `cli/{export-command,startup-credential-arity-process}.test.ts`, Core `providers/credentials.test.ts`, server `runtime/terminal-runtime.test.ts` and Web `store/session-store.remote.test.ts`: genuine credential ingress/export, encoded/error/fragmented channels, PTY and browser-cache controls.
- Server `security/request-security.test.ts`, `web-server.test.ts`, `api/{websocket,workspace-file-manager,mcp-oauth-routes}.test.ts`, `runtime/terminal-runtime.test.ts`: Host/Origin/role/upgrade negatives, real proxy cookie/link/logout, passive inventories, PTY/file/package gates and filtered environments.

## Common Changes

- New resource/setting: update Core inventory and schema/source gate together; test unread bodies before any credential/executable work.
- New credential/channel: register at ingress, preserve explicit persistence and refresh ownership, and test actual values through the public boundary rather than only manually seeded redactors.
- New route/proxy behavior: extend capability/Origin/Host negatives and a real HTTP/upgrade control; never infer privilege from forwarding headers.

## Related Domains

- [Security implementation](./security.md) — detailed MCP/package/path and residual OS/network exposure
- [Server API](./server-api.md) — protected route families and transport lifetimes
- [Session SDK](./session-sdk.md) — caller-owned provider/store/registry and explicit discovery
- [Providers](./providers.md) — native transports and credential composition
