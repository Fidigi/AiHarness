# CLI privacy warnings and platform guidance acceptance

## Scope and result

Date: 2026-10-17. Parent: `94d32eebfd0a68724d73b162975612a06def1875`. Decision: DEC-99; evidence: E-AH-SEC-WARN-01. **Only CLI-SEC-07 closes.** The accepted matrix becomes **99 DONE / 53 PARTIAL / 152 (65.1%)**, CLI 47/40 and Web 52/13. Every other complete criterion row and every requirement's first sentence/order is conserved. The overall audit remains incomplete.

Requirement: “Provide offline/proxy/network controls, safe share/export warnings, shell-alias and Windows/terminal guidance, and diagnostics that disclose sensitive-content risk.”

| Clause | Delivered boundary and evidence |
| --- | --- |
| Offline controls | Existing process-local automatic-startup/reload suppression is retained, not a network firewall. The 19 CLI policy, 25 native process and six Core offline tests pass again; the whole installed suite also retains its offline contract. See [offline acceptance](./offline-startup.md). |
| Proxy controls | Existing provider-scoped proxy/transport/deadline settings remain owned by shared provider configuration; the guide explains their scope and distinguishes share/MCP/package traffic. Eight complete provider-network controls and the full default suite pass. |
| Network controls | Existing explicit-action, HTTPS/loopback, redirect-free, strict 1–168-hour share validation and bounded-response behavior are retained. Five invalid TTL cases have no request/notice; a valid share emits its notice before the authenticated request. Offline is not a firewall or credential-command sandbox. |
| Share warning | The fixed value-free notice discloses public-link, private conversation/tool output, unknown-secret, expiry and registered-redaction limits. It is emitted after target/TTL validation and before the request. A synchronous warning-sink throw prevents that request; this is not a transaction or physical-delivery guarantee. |
| Export warning | All four slash/native formats disclose private-content risk; standalone notices use stderr, with the exact fixed publication acknowledgement alone on stdout. Successful RPC HTML retains `path` and adds `warnings: string[]`, with no extra record/event or unframed text. Correlated RPC/redaction-on/off controls pass. Four real packed PATH-bin exports preserve source bytes, known-secret redaction and unknown private text. |
| Shell aliases | EN/FR guidance covers executable/PATH identity, aliases/functions, startup profiles, shell-specific quoting, protected absolute `shellPath`, code-bearing `shellCommandPrefix` and separate `npmCommand` policy. These are operating instructions, not sandbox or command-approval guarantees. |
| Windows/terminal guidance | EN/FR matrix documents native CMD `COMSPEC`/`/d /s /c`, dedicated PowerShell versus configured shell `-lc`, WSL/POSIX differences, `taskkill.exe /T` limits, TTY/raw-mode/fullscreen fallback, redirected JSON/RPC purity, VT/font/link/image limitations and POSIX 0600 versus Windows ACLs. No physical platform/terminal certification is inferred. |
| Diagnostic disclosure | `/bug` emits a fixed risk notice before returning its report URL. Known registered keys remain redacted; arbitrary private descriptions/logs may remain. Both guides require reviewing report text, URL, logs, metadata and attachments; uncertain share/export outcomes must be inspected before retrying. |

## Product contracts

`packages/cli/src/security/privacy-warnings.ts` owns three bounded, inert, fixed notices. They contain no transcript, title, URL, path or credential values. `CommandHandler` accepts an optional **synchronous** host `writeWarning` sink; ordinary terminal output is the default and standalone export supplies stderr. Sink exceptions use existing command-failure handling before share/export side effects. A notice is not confirmation, authorization, complete sanitization, billing-warning settings or a physical terminal-delivery barrier.

RPC `export_html` adds response data only after successful publication, not a pre-write handshake. It does not add raw stdout or a protocol event. As before, a failed/lost response does not prove unchanged disk. Public EN/FR guides document all channels and limits; regular/fullscreen help exposes the privacy-review guidance. Stale user-guide claims that slash exports default to `~/.ai-harness/exports/` are corrected to the active trusted workspace. The AI CLI topic also corrects the already-delivered provider-private classifier/image bridge description; no new helper implementation is claimed.

No Core API 1, JSONL schema 2, store/provider capability, dependency, lockfile or build configuration changes. Existing trust, export confinement/private modes, registered-credential redaction, explicit credential reveal, offline semantics, shell conventions, protocol framing and stdout acknowledgement remain intact. Configured billing warnings remain a separate incomplete CLI-CFG-10 concern; cross-platform descendant/race containment remains CLI-SEC-06 scope.

## Qualified source and execution

Authoritative prefix: `/tmp/aih-security-warnings-v2`; checkpoint `-CURRENT.md`. Fresh Make/Docker test image:

```text
sha256:90e80b3c4147ece797c3e8053beb0a9a2e0057e878f86a9e2064288841cb17ed
actual Node v24.15.0 / npm 12.1.0
```

Ten frozen inputs: six CLI production paths and four test paths, including the new privacy leaf and genuine installed leaf. `-inputs.json` and `-source/` preserve their original hashes/bytes; the focused wrapper verifies every COPY hash. Twelve corresponding emitted JS/declaration files are retained in `-emitted.json` and `-image-copied-root/`; as-built Git/Core/CLI/Server roots, original host generated/Git archives and subsequent typecheck replacements are retained separately. These are bounded artifacts, **not full build-context, original host-Git, post-staging Git or environment equality certification**.

All product commands run through Make/Docker with unchanged deadlines/resources and actual container exits, inspected states, events and complete outer artifact collections:

| Gate | Actual result |
| --- | --- |
| Fresh `make build-test` | 0 |
| Workspace typecheck, including parity declarations | 0 |
| Strict four owning test fixtures | 0 |
| Zero-warning lint of all ten changed TS inputs | 0 |
| Ten whole owning/control leaves | 274 passed, 26.00s |
| Whole standalone functional parity | Two leaves / 70 passed: 26 goldens plus 44 genuine packed installed cases; 87.40s |
| Whole default `npm test` | 314 leaves / **4,521 passed**, 735.92s; includes the same 70 parity cases, not 70 additional unique tests |
| Runtime/source/collection admission | 0; all relevant containers settled, no mounts, all outer copies complete before freeze retirement |

**25 unique additions:** 18 privacy-policy/order/refusal/failure/redaction controls; four native standalone format/channel cases; two RPC redaction-mode cases; one genuine packed installed four-format case. Native/installed exports prove actual publication, private mode, preserved source journal, fixed stderr/stdout and intentionally retained unknown private content. This is not arbitrary-secret sanitization.

The project-map CLI-only validation matrix applies: no shared lifecycle, Server/Web or browser behavior changes. No browser, production or Node26 suite is newly executed for this lot. Prior browser/compiler/native failures and the independently unhealthy production watchdog remain historical and are neither erased nor diagnosed by these passes. No remote vendor, deployed Pages, OS firewall or physical device claims follow.

## Original failed configuration retained

`/tmp/aih-security-warnings-v1` remains **FAILED / NOT PRODUCT ACCEPTED**. Build/typecheck/lint passed and all ten focused leaves/274 tests passed, but strict compilation exited 2, the container exited 1 and Make exited 2. Collection completed with copy0 before any correction. The original image, ten source snapshots, harness/config, logs/exits, states/events and retirement record remain available.

The original strict log contains six diagnostics:

```text
TS2353: 'parentEntryId' does not exist in type 'Message'.
TS2322: Type 'number' is not assignable to type 'void | Promise<void>'.
TS7006: Parameter 'name' implicitly has an 'any' type.
TS7006: Parameter 'result' implicitly has an 'any' type.
TS18048: 'stats' is possibly 'undefined'.
TS18048: 'stats' is possibly 'undefined'.
```

V2 corrects only two fixture files before its fresh freeze/build: an explicit legacy-field intersection preserves `parentEntryId` runtime bytes, the record sink returns void, hook arguments receive types and a missing statistics reply explicitly fails. Assertions are not weakened. V2's passes qualify V2 only; they do not retroactively admit V1 or establish causes of unrelated failures.

## Admission and related evidence

`-runtime-admission.json`, `-freeze-retirement.json`, exact candidate/allowlist/index/tree, final predictive/live documentation and whitespace logs, and staged/postcommit admission records bind this bounded delivery. All152 requirement sentences/order, other151 rows, historical decision/evidence/journal records, 53 remaining IDs, surface/family counts and 14 topics/15 navigation estimates are checked. New ignored acceptance documentation is explicitly staged. No full-goal completion is asserted.

- [Audit matrix](../AUDIT-2.md)
- [Completion review](./completion-review.md)
- [English CLI security](../../../users/en/cli-security.md)
- [French CLI security](../../../users/fr/cli-security.md)
- [Prior documentation delivery](./operator-architecture-documentation.md)
