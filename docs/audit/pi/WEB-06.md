# WEB-06 — Native child-agent contract

Scope: AiHarness child agents, not a Pi-core command or Pi Web extension loader. The existing version-1 `subagents.json`, `explore`/`general`/`plan` profiles, linked native journals and authenticated routes remain authoritative. No foreign profile import, implicit adaptation, external account or cross-platform qualification is introduced.

## Profiles and authority

Global settings are defaults; canonical workspace IDs select full project overrides. Profile/settings writes require configuration capability and publish the new in-memory state only after atomic persistence succeeds. Built-ins may be edited/duplicated, not deleted. Explicit HTTP `null` clears model/thinking overrides; omitted fields remain unchanged and stored JSON still omits cleared overrides. Engine/profile flags are actual booleans.

Child admission requires fresh workspace trust, an enabled engine/profile, capacity and valid depth. Core owns a cloned last-admitted parent delegation policy, including non-persisted model/thinking selections. Profile model/thinking overrides win; tool/skill/extension lists only intersect inherited selections. Empty **profile** lists inherit; empty **effective** lists deny all. Exclusions and code-mode reductions remain inherited. Chat-only wins over read-only; Explore/Plan retain their read-only ceiling even after editing their tools. Platform-owned tools keep the shared Core extension-selection semantics; an extension allowlist is not an MCP-server allowlist.

MCP configuration/trust is freshly resolved for each child's own session host. Read-only selection removes mutating MCP tools; an empty tool selection starts no MCP peer. A model asking for an undeclared write cannot execute it. Neither parent transport objects nor deferred activation metadata are copied. Authorized shell/extensions still execute as the Server OS user: these filters are not an OS/filesystem/network sandbox.

## Bounds and lifecycle

| Boundary | Native bound/behavior |
|---|---|
| Stored profiles | 50 per scope; existing version-1 format retained |
| Active children | Candidate scope's 1–16 limit, default 4, checked against process-wide nonterminal children |
| Delegation | Root depth 0; children at 1–3; depth 3 excludes `spawn_subagent` without a static registry allowlist |
| Task / profile rounds | 100,000 JS string units / 1–32 tool rounds |
| Inherited context | Latest 40 user/assistant plain-text messages, at most 120,000 string units; fresh linked IDs and lineage marker only |
| Results | Output/error snapshots at most 16,384 string units; long output has an explicit truncation marker; complete child journal remains readable |
| Registry | 200 retained snapshots; newest-admission display/oldest-terminal eviction do not rely on reversible wall-clock values; attention and run records are process-local |

Inherited context never copies empty/rich-only placeholders, rich blocks, tool calls/results, binary bodies or private provider/request metadata. Fresh parent links and an explicit inherited leaf keep the delegated task last even with coarse or foreign future timestamps, rather than replaying an inherited parent task. Pending starts observe parent cancellation, explicit Stop, closed runtime and replaced/in-place-changed parent scope/selection/run identity before model admission. A queued/active Stop acknowledges `phase: stopping`; it does not release concurrency until Core settles owned execution. Shutdown withdraws pending admission and awaits accepted runs. Admitted history/writes are not rolled back.

Synchronous delegation waits under the parent's signal; parent Stop stops the child. Accepted background work survives parent completion, page reload and view changes. Terminal snapshots publish one completion/failure event (stopped completion uses native `subagent.failed`), then attention remains until acknowledgment. Acknowledgment publishes an update. Restart preserves child journals and parent links, not live runs, attention, ephemeral parent SDK selections or automatic resumption.

## Web ownership and recovery

The panel is lazy, with local translated asset failure rather than loss of the composer. Its lifetime includes parent, canonical workspace, and full route address. Retired reads/Stop/ack requests are aborted; late results cannot publish into a replacement view. Revision guards surround mutation admission and completion; an older poll cannot restore acknowledged attention, and a late Stop acknowledgment cannot resurrect an already observed terminal child. Stopping disables repeated Stop; uncertain operations are never automatically replayed. Fixed EN/FR errors do not display private transport diagnostics. Settings editors are scope-keyed; failed writes retain the last known configuration and explicit Refresh rereads authority.

## Requirement-to-evidence map

| Requirement | Owning evidence |
|---|---|
| Native format, scopes, persistence failure, booleans, clearing overrides | `subagent-service.test.ts`, Web `api.test.ts`; genuine scoped Settings duplicate/edit/clear/delete journey in `subagent-lifecycle-live.spec.ts` |
| Owned parent policy, independent copies, empty denials, Explore/Plan ceilings, depth, sanitized/ordered context, reversible clock and held parent-selection change | `subagent-runtime.test.ts`, `skill-catalog.test.ts`, Core selection/search and runtime/prestart tests |
| Auth/role/Origin/fresh trust, actual MCP reads/refused writes/no empty-selection connection | `subagent-lifecycle-http.test.ts`, real local MCP peer and emitted Server; existing `web-server.test.ts` |
| Physical settlement/capacity, pending cancellation, sync parent Stop, background Stop | Runtime held-tool/start controls; actual HTTP parent/child cancellation; real browser background survival and Stop |
| Parent notifications, acknowledgment, linked history, restart and result | Four emitted Server/static-Web EN/FR Light/Dark desktop/touch journeys; HTTP cold-journal readback |
| Retired poll/Stop, stale acknowledgment, optional asset refusal | Four controlled browser lifetime regressions plus a refused actual emitted panel chunk; separate from real HTTP authority proof |
| Responsive presentation | Four reviewed new native panel captures (unrelated surrounding UI isolated during capture), axe and overflow; twelve unchanged existing Settings/panel visual cases and existing chat/Settings child journeys |

Executed commands, immutable input hashes, failures and final verdicts are recorded in [AUDIT-5](./AUDIT-5.md) and local `test-results/pi-audit-web06-20261024/`. These scoped checks do not replace full unit/parity/all-browser qualification, prove remote backup, or close QUA-01.
