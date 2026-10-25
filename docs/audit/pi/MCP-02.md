# MCP-02 — Native exposure and selection

This is the native exposure contract for [AUDIT-5](AUDIT-5.md), extending the [MCP-01 configuration/lifecycle contract](MCP-01.md). It preserves the approved direct default and native authorization, not Pi's default or its `--tools` exception. Execution receipts belong to AUDIT-5 §6; scenario descriptions below are not standalone qualification claims.

## Exposure is presentation, not permission

| File exposure | Model declarations | Discovery and nested execution |
|---|---|---|
| Missing / `direct` | Eligible tools are declared immediately after bounded startup. No file migration occurs. | May be nested only through an enabled, selected code-mode helper and current authorization. |
| `codemode` | Never declared as a direct tool, including after search or restored activation. | Searchable metadata; script-only through the selected helper. Enabling a server does not override a disabled helper. |
| `deferred` | Withheld until explicit `tool_search` activation; usable only on a later provider turn. | Search and nested calls retain the same selection policy. A forged same-response call is refused. |
| `hidden` | Neither declarations nor discovery nor code-mode inline metadata. | Not model-callable. Wholly hidden servers do not connect for prompts unless a non-hidden override makes them eligible. Explicit administrator Test remains a separate capability-listing operation with no tool calls. |

`toolExposure` addresses **original remote names**, not generated `mcp__...` names. Exact own keys win; otherwise the first matching `*` pattern in property order wins; otherwise the server default applies. Only `*` is special. Targetless trusted project controls inherit the target but replace an explicitly supplied tool map. Malformed/untrusted configuration cannot grant authority.

The host/model selection contract is independent:

- Generated names are subject to the native preset, replacement allowlist, exclusions, extension ownership and current connection binding. An explicitly empty allowlist disables all tools, including discovery/code-mode helpers. Explicit replacement can override default/no-tools choices, but not exclusions or read-only/chat-only policy.
- CLI `--tools` / `--exclude-tools` use native literal/star selection and ordered exact adjustments, not Pi's exemption. Patterns re-resolve against current MCP metadata; a late tool cannot escape an exclusion. Model declarations and each nested call are independently checked.
- Read-only sessions require the remote `readOnlyHint`; disappearance or loss of the hint withdraws an old binding. This is an operator/server trust signal, not a proof that arbitrary remote code is pure.
- Search/restored branch activation carries names, not authority. Current metadata, hidden/read-only/exclusion checks and static-owner collisions are reapplied. The provider's declared-call snapshot prevents search-plus-call escalation in the same response.
- A prompt-local descriptor keeps its executor identity across passive metadata reads. A different remote descriptor/connection rotates that identity, so a nested before-hook replacement is refused rather than executing a new implementation under an old admission.
- File changes are revalidated at prompt preparation, and native local mutations retire affected process-local connections. Remote tool-list updates refresh future declarations and remove unsafe bindings. No automatic retry follows a possibly effectful tool call.

## Applicable host and help surfaces

| Surface | Native contract |
|---|---|
| Standalone CLI | `ai-harness mcp --help` explains the missing-field default, four modes, original-name matching and final authorization. `mcp list` remains passive; `mcp exposure` writes only explicit local intent. |
| Regular/fullscreen terminal | `/help` explains the same default and final filters; `/mcp exposure` shares the shell/Core writer. No model request is needed for management. |
| Print/JSON/RPC | The same Core loadout and CLI selectors govern actual provider declarations, search activation, script bridging and refused forged calls. |
| Web Settings | Exposure controls display canonical native inventory/Test values, not a browser matcher. EN/FR accessible descriptions and hover help explain modes and final filters. Explicit global/project writes preserve target scope; reads and exposure edits do not connect or invoke tools. |
| Public Core SDK | `McpSessionHost` is an explicit low-level transport host; `createAgentToolLoadout` composes selection/discovery/code-mode policy. Low-level `execute` is not a model authorization facade: callers must retain the loadout and declared-call gate. The high-level `createAgentSession` still does not load MCP files, credentials or transports automatically, and gains no new options. |

## Requirement-to-evidence map

Existing scenarios are reused; added cases cover missing defaults, late metadata, stable hosted admission and native help rather than a second selection framework.

| Requirement | Concrete scenarios |
|---|---|
| Missing/direct default and all four modes | `packages/core/src/mcp/tool-exposure-runtime.test.ts`: real stdio effects through the selected loadout, explicit nonempty/empty allowlists, excluded mutation, script-only behavior and forged restored names. `packages/core/src/mcp/tool-exposure-patterns.test.ts` conserves bounded exact/ordered-star matching. |
| Hidden/read-only/excluded/late tools | `packages/core/src/mcp/session-host.test.ts`: held indirect metadata, hidden and read-only filtering before discovery, exclusion after metadata arrival, stable executor identity and refused before-hook replacement with no denied nested effects; existing update case withdraws an old read-only binding. `packages/core/src/tools/tool-search.test.ts` covers same-response refusal, activation authenticity and restoration; `packages/core/src/tools/codemode.test.ts` rechecks nested authority after hooks. |
| Actual CLI and public Core boundary | `packages/cli/src/cli/mcp-pattern-process.test.ts` / `fixtures/mcp-pattern-probe.mjs`: both scopes, real public Core and emitted print/JSON/RPC with a disposable wire provider; native declarations and actual remote effect logs, not mocked selection success. Existing packed/installed pattern consumers remain separate public-package evidence. |
| Help and settings | `packages/cli/src/cli/mcp-command.test.ts`, `packages/cli/src/tui/{terminal-ui,fullscreen-ui}.test.ts`: actual help renderers. `packages/web/src/components/settings-locale.test.ts` preserves the historical locale inventory with exactly the new EN/FR help literals projected into the eager set. `e2e/mcp-inheritance-live.spec.ts`: actual emitted Server/static Web, EN/FR omitted-field direct readback and all explicit project exposure modes with no extra peer start/effect. `e2e/mcp-exposure.spec.ts`: exact-only edits, canonical inherited display, keyboard/axe and Light/Dark desktop/mobile capture comparisons (failures remain separately recorded in AUDIT-5). |

MCP-03 resources/rich payloads, MCP-04 extension registration, SDK automatic hosting, live vendors and physical/platform certification remain separate. This contract does not waive a failed broader gate or close QUA-01.
