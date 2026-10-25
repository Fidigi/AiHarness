# MCP-03 — Native resources and rich results

This is the native resource/payload contract for [AUDIT-5](AUDIT-5.md), extending [MCP-01 configuration/lifecycle](MCP-01.md) and [MCP-02 exposure/selection](MCP-02.md). It adds no MCP App runtime or automatic high-level SDK hosting. Executed receipts and unsuccessful gates belong to AUDIT-5 §6; scenarios below are not whole-platform qualification.

## Server-bound resource operations

A connected resource-capable peer supplies these host-owned read-only helpers, including when it advertises no tools capability. `tools/list` is not sent to a resource-only peer.

| Generated model name for server `docs` | Original policy name | Input |
|---|---|---|
| `mcp__docs__list_mcp_resources` | `resources/list` | Optional opaque `cursor` |
| `mcp__docs__list_mcp_resource_templates` | `resources/templates/list` | Optional opaque `cursor` |
| `mcp__docs__read_mcp_resource` | `resources/read` | Required concrete `uri` |

Normal namespace normalization/collision rules still apply. There is no caller-controlled server, transport, local path or alternate URL parameter. Unknown arguments fail before the peer request. A `file:` URI is data sent to that selected peer, never a request for the host to read its own filesystem.

- Each list call requests exactly one page. The host does not recursively fetch a catalogue. Cursor and URI limits are 4,096 UTF-8 bytes; pages are bounded to 1,000 entries and 256 KiB before projection, with the stricter structured-result ceiling below still applying. An immediately repeated next cursor is refused; longer cycles require additional explicit calls under native call/turn budgets.
- Project files/overrides retain persisted project trust. Global operator configuration retains the existing global-host policy; resource revalidation does not invent a project-trust requirement for an otherwise eligible global SDK binding. Native model runtime trust, allowed roots and active selection remain independent requirements.
- Resources/templates expose only admitted URI/template, name, title, description and MIME metadata. Unsafe entries are counted as omitted. Templates remain inert metadata, including a variable-expanded base URI: the host neither expands them nor treats listing as read authority.
- All four exposure modes, original-name exact/ordered-star overrides, allowlists, exclusions, restored activation and code-mode policy apply to the helpers. Protocol resource reads are host-owned read-only operations; ordinary remote tools still require their own `readOnlyHint` in read-only sessions. Neither is a sandbox for a malicious configured peer.
- Calls revalidate the exact session/connection and current target file/trust both before and after the response. A changed target or released/disabled session withdraws unpublished results. Caller cancellation, connection lifetime and the native per-server request ceiling are composed; `timeout` can only reduce that ceiling. No automatic retry follows a read or tool call.

## Owned payloads, not executable applications

`packages/core/src/mcp/resource-content.ts` admits copied plain data, not getters or remote executable metadata. Tool results and embedded/read resources share this formatter.

| Payload | Native result |
|---|---|
| Text and text resources | Credential-redacted bounded text, using existing inert transcript/Markdown presentation |
| `structuredContent` | Copied/redacted JSON retained as structured tool-result data and rendered through the existing owned-result pipeline |
| PNG/JPEG/WebP | Strict base64, aggregate size and existing generated-image signature validation; owned `image` blocks, not remote image URLs |
| Audio and other binary | Copied process-local bytes; opaque `mcp-content:<UUID>` reference, size and inert MIME label, never a local pathname |
| Resource link | Validated textual URI; no host fetch or application embedding |
| MCP App metadata, UI resources or HTML/XHTML media | No app metadata/bridge execution; `ui:`, `javascript:`, `data:`, `blob:`, credential-bearing URIs and HTML/XHTML resources are refused |

Known MCP credentials and the optional live `McpSessionHostOptions.redactText` host credential scrubber apply before admission, including decoded binary/base64. CLI, RPC and Server supply their live credential scrubbers. A retained read rechecks current known credentials, not just those known at capture. This is not malware scanning, steganography detection or certification of image decoders. MIME parameters are not retained as download authority.

Defaults are hard bounds, not new user-tunable budgets: 4 MiB total raw result, 64 content items, 2 MiB aggregate decoded binary, 128 KiB structured JSON and 64 Ki characters text. Binary references survive text clipping. All payloads validate before binary retention. Empty binary resources are valid; invalid image headers and unsafe/oversized payloads are not.

Code-mode nested results remain strings. The existing owned-result pipeline preserves redacted structured JSON in those strings and forwards admitted image blocks to the outer result under the unchanged code-mode output/image ceilings. The guest never needs raw image bytes. Printing/returning a nested binary reference makes it visible; ignoring a result does not publish an automatic attachment. Reduced output budgets still fail closed.

## Retention and native adapters

The host retains at most 64 binary entries / 16 MiB total, with a ten-minute read expiry and oldest-entry eviction. Bytes are copied on store/read and carry SHA-256/size metadata. Ownership is per host, session and physical connection generation; a late close from a retired connection cannot evict a replacement's artifact. Close/release/disable/shutdown discard that owner's entries. Restart does not restore bytes: history may retain an expired reference, not a durable download grant or secret file.

| Surface | Contract |
|---|---|
| Public Core SDK | Explicit `McpSessionHost` preparation/execution and `readRetainedContent(sessionId, id, signal?)`; caller composes model authorization as in MCP-02. No implicit discovery/hosting is added to `createAgentSession`. |
| Print / regular / fullscreen CLI | Existing final-answer/transcript policy is preserved. Tool text/reference markers use the existing pipeline; no new terminal graphics protocol or audio player is promised. `mcp --help` documents helper names/policy keys. |
| JSON events | Existing v3 `toolResult` content includes image blocks and `details.structuredContent`; no binary paths or executable app fields. |
| JSONL RPC | Additive operator command `read_mcp_content` accepts only `type`, optional correlation `id`, and explicit UUID `reference`. It uses the current session, never a request-selected session/URI/path. Success returns base64 `data`, `mediaType`, `size` and `sha256`. EOF/navigation/callback replacement withdraw unpublished reads. This is not a model tool. |
| HTTP | `GET /api/mcp/content/:sessionId/:id` requires native `workspace:read`, a real session and eligible canonical workspace, then the current host binding. Missing/expired/withdrawn references return generic 404. Bytes are always `application/octet-stream`, fixed attachment filename, `no-store`, `nosniff` and CSP sandbox. |
| Built Web | Tool-message opaque references produce explicit authenticated same-origin download links with existing EN/FR Download labels. Images and structured text use the existing rich transcript and reload path. No iframe, automatic remote link fetch, audio autoplay or MCP App bridge is added. |

## Requirement-to-evidence map

Existing exposure, session-host, command, terminal, RPC and Server tests are reused. New scenarios cover the previously absent resource/media boundaries rather than introducing a second test framework.

| Requirement | Owning evidence |
|---|---|
| Resource-only peers, both scopes, real pagination/templates/text/image/audio | `packages/core/src/mcp/resources.test.ts`, real stdio `fixtures/resource-server.mjs`; separate optional resource connection contract in `resource-tools.ts` |
| Exposure/restoration/exclusions/read-only and nested media budgets | `resources.test.ts`, existing `session-host.test.ts`, `tool-exposure-runtime.test.ts` and `tools/codemode.test.ts` |
| URI/server arguments, template metadata, count/bytes/TTL/ownership, unsafe media/secrets/accessors | `packages/core/src/mcp/resource-content.test.ts` |
| Fresh target/trust, held real-read cancellation, connection generation and newly known credentials | `resources.test.ts`; `packages/server/src/api/mcp-content-http.test.ts` independently exercises real authenticated HTTP, foreign session, invalid ID and withdrawn project trust |
| Real emitted print/JSON/RPC, global/project scope, actual provider-visible images/structured text and RPC binary retrieval | `packages/cli/src/cli/mcp-resources-process.test.ts`, `fixtures/mcp-resources-probe.mjs`, disposable HTTP `resource-provider.mjs`; existing pattern process controls remain independent |
| RPC current-session arguments and EOF withdrawal | `packages/cli/src/rpc/rpc-controller.test.ts` |
| Genuine Server/static Web, EN desktop / FR mobile, images/structured text/reload, real download, auth/owner/stale refusal and no App execution | `e2e/mcp-resources-live.spec.ts`; existing inheritance/OAuth/selection/exposure journeys retain their separate assertions and visual failures |

MCP-04 dynamic registration, foreign Pi compatibility, automatic SDK hosting, real vendor/server interoperability, hostile descendants, physical memory erasure, cross-OS/hardware and complete platform qualification remain separate. No older receipt or targeted green result closes QUA-01.
