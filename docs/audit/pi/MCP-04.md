# MCP-04 — Owned extension MCP servers

This is the native dynamic-registration contract for [AUDIT-5](AUDIT-5.md), extending [MCP-01 configuration/OAuth](MCP-01.md), [MCP-02 exposure/selection](MCP-02.md) and [MCP-03 resources/results](MCP-03.md). It is an additive AiHarness extension API, not Pi compatibility or implicit high-level SDK hosting. Actual qualification and retained failures are recorded separately in AUDIT-5 §6.

## Public registration and ownership

A trusted executable extension receives these API-1 methods:

```ts
const dispose = api.registerMcpServer('docs', {
  command: 'node', args: ['/operator-owned/docs.mjs'], exposure: 'direct',
});
// Either removes only this owner's current registration:
api.unregisterMcpServer('docs'); // boolean
// A disposer removes only the exact registration it created:
dispose();
```

- Configuration uses exported `McpServerRuntimeConfig` and the existing strict native schema, including transport, timeout reductions, exposure, original-name overrides and OAuth. Own-data copying rejects accessors, cycles and non-data values before admission; configuration is bounded to 256 KiB and 32 registrations per registry. Mutating the caller's object cannot change the accepted binding.
- The registry supplies the actual loaded-extension object as owner, not an extension-selected ID argument. A foreign owner cannot overwrite or unregister an occupied name. The same owner may replace it; every successful registration gets a fresh UUID/config key, and an old disposer cannot remove its replacement.
- Unload, failed registration and managed replacement remove all owned registrations. Retained APIs reject registration/unregistration after retirement. Failed same-workspace loader replacement may restore the previous factory under a new generation: previous executors and credentials do not regain authority.
- Registrations are process-local, not persisted into `mcp.json`. Extensions are privileged Node code; registration validation is not a sandbox, download mechanism or guarantee against arbitrary extension side effects.

## Files, provenance and fresh authority

`packages/core/src/mcp/registered-servers.ts` owns metadata/resolve/withdrawal; `extension-registry.ts` owns extension lifetime; `module-loader.ts` supplies source provenance. Factories cannot choose that provenance through the public registration methods.

| Boundary | Native rule |
|---|---|
| File precedence | Any admitted homonymous file entry wins, including disabled or invalid entries. A malformed/inaccessible existing configuration file conservatively blocks registrations rather than becoming a fallback path. Native global/project file precedence is unchanged. |
| Inventory | Passive cloned/redacted descriptors include `registration.extensionId`, UUID and `shadowedByFile`. No peer, login, refresh or import is triggered by inventory or registration. Shadowed entries remain visible but cannot be Tested or authenticated as the effective binding. |
| Loader workspace | Both global and project loaded registrations belong to their loader workspace generation. A different workspace cannot borrow them. Project registrations additionally recheck the loader trust callback and persisted native trust; stdio working-directory trust remains independently required. |
| Workspace reload | `ExtensionModuleLoader.reload(cwd?)` retires the previous workspace generation before discovering the next one. A failed rebind cannot restore executable ownership from the old root. Concurrent different-root rebind is refused until the generation settles. Same-root rollback remains supported. |
| Low-level composition | Explicit `ExtensionRegistry.load()` without loader source remains global operator composition. Callers explicitly pass `registry.mcpServers` into `McpSessionHostOptions.registeredServers`; `createAgentSession` does not start or discover MCP automatically. |
| Authorization | Native allowlists/exclusions, presets/read-only, four exposure modes and exact/ordered-star original-name overrides remain final authority. Registration is not model call permission. Resource helpers keep their host-owned read-only classification; ordinary tools need their own read-only hint. |

## Immediate withdrawal, explicit reconnection

Registry notifications synchronously remove every affected session record, abort its connection lifetime, withdraw tools/status and discard retained binary content **before** awaiting transport cleanup. Replacement does not automatically reconnect: the next explicit preparation or Test must resolve a fresh target.

Target resolution rechecks registration UUID/owner, current files, original workspace and trust around asynchronous work. Captured executors, late connections and in-flight tool/resource responses cannot publish after withdrawal. Registered ordinary tools compose caller and connection cancellation and validate before and after results. A retired connection's late close cannot remove its replacement. Already-admitted remote effects and arbitrary Node side effects cannot be rolled back.

Credentials use the existing encrypted native OAuth store with target identity `extension:<registration UUID>`, in addition to the native URL/identity checks. A registration never borrows credentials from a homonymous file, another owner or a previous generation. Replacing a registration does not migrate credentials; retired flows cannot publish late writes. Logout/flow cancellation use the selected generation identity. Status and diagnostics expose no configuration secret values.

## Native hosts and management

| Surface | Contract |
|---|---|
| CLI interactive / RPC / Server | Composition roots explicitly inject the registry into their MCP host. Emitted print/JSON/RPC startup loads native trusted extensions as usual. CLI shell management without extension startup remains file-only. |
| Regular/fullscreen `/mcp` | Host inventory shows extension owner and shadowing. Test/login/logout are explicit; file-only editing is refused for registration-only targets, with no `mcp.json` rewrite. |
| HTTP | Authenticated inventory/Test/OAuth resolve the current host target. File actions reject registration-only selectors; a real homonymous file remains file-manageable. Workspace rebind passes the new cwd to the shared loader. |
| Built Web EN/FR | Show owned-server help and disable edit/toggle/remove/exposure/group actions for registrations. Test/OAuth remain explicit for eligible unshadowed entries. Existing inert media/download behavior is unchanged; reload withdraws old content. |

## Requirement-to-evidence map

Existing extension, host, exposure, OAuth, CLI and Server coverage is reused. The added cases cover missing registration ownership, retirement and public-host boundaries, not a replacement test framework.

| Requirement | Concrete evidence |
|---|---|
| Own-data schema/bounds, owner conflicts, replacement, stale disposer/API, passive secret-free inventory | `packages/core/src/mcp/registered-servers.test.ts` (13 cases) and `registered-servers.ts`; registry ownership/cleanup in `packages/core/src/extensions/extension-registry.ts` |
| Real resource-only stdio, all-session withdrawal before slow cleanup, retained content, file precedence, in-flight/late connection fencing | `registered-servers.test.ts`, existing `fixtures/resource-server.mjs` and host/resource families |
| Loader rollback, successful/failed reload, workspace isolation and fresh trust | `registered-servers.test.ts`; independently real global/project extension HTTP Test/content/reload/workspace rebind in `packages/server/src/api/mcp-content-http.test.ts` |
| Four exposure modes, selected/excluded names and read-only policy | `registered-servers.test.ts`, unchanged owning exposure/runtime tests and emitted CLI scenarios |
| File/owner/generation OAuth isolation and late-write refusal | `packages/core/src/mcp/oauth-provider-factory.test.ts`; shared factory/flow/logout adapters |
| Actual emitted print/JSON/RPC in global/project files and global/project extensions | `packages/cli/src/cli/mcp-resources-process.test.ts`, `fixtures/mcp-resources-probe.mjs` (12 scenarios) |
| Genuine installed public declarations plus actual stdio, ownership and unload | `tests/functional-parity/installed-executable.test.ts`, case `hosts and withdraws owned MCP registrations through installed declarations and actual stdio` |
| Genuine Server/static Web, EN desktop / FR mobile, registration controls, real Test/download and reload revocation | `e2e/mcp-resources-live.spec.ts`; existing inheritance/OAuth/exposure/selection suites remain separate |

No MCP Apps, implicit binary fetching, automatic SDK hosting, unchanged Pi extension compatibility, live vendor/public CIMD acceptance, hostile descendant-process guarantee, physical-memory erasure or cross-OS certification is added. Scoped functional closure does not close QUA-01.
