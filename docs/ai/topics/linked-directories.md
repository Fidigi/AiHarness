# Linked-Directory Consent

> **Navigation:** See [project-map.md](../project-map.md) for ownership and Docker validation.

## Overview

Core owns exact source/link/target-bound read consent. Server adds independent fresh persisted source trust, capabilities/Origin and registered-secret redaction. Web owns escaped metadata, confirmation, revision-bound browsing and optional modal lifetimes. Ordinary file-name activation and mentions retain existing in-root policy; a separate visible link-review button opens source metadata, never implicit consent. A refused ordinary symbolic-link read may also open metadata only while that connected invoker still owns current focus; aborted/replaced reads and newer composer intent cannot do so. New explicit link-read admission retires older metadata presentation before any response/import await, so old readiness cannot cancel its successor. Consent is never execution authority.

## Main Entry Points

| Path | Responsibility |
|---|---|
| `packages/core/src/security/linked-directory-consent.ts` | Metadata inventory; exact consent; Linux descriptor access and fresh pre-open guards |
| `packages/core/src/security/linked-directory-store.ts` | Private no-follow hashed document, lock and atomic publication |
| `packages/core/src/security/linked-directory-{types,helpers}.ts` | Public selectors/errors, hidden characters and bounded JSON syntax |
| `packages/core/src/index.ts` | Public class/error/types; Core API marker remains 1 |
| `packages/server/src/runtime/linked-directories-service.ts` | Independent source trust and secret filtering |
| `packages/server/src/runtime/services.ts` | Private data-directory composition; protected session/trust roots |
| `packages/server/src/api/{linked-directories-routes,workspace-routes}.ts` | Strict HTTP shapes, lazy mount and disabled-service refusal |
| `packages/web/src/components/{LinkedDirectoryBoundary,LinkedDirectoryModal}.tsx` | Local optional JS/CSS failure/loading, latest lifetime and ready focus trap |
| `packages/web/src/components/{Sidebar,WorkspacePanel}.tsx` | Narrow invokers and navigation/folder retirement |
| `packages/web/src/services/linked-directories.ts` | Authenticated bounded no-store client, abort/deadline and value-free failures |

## Public Contracts and Invariants

`LinkedDirectoryConsent` takes an initialized `WorkspaceManager` and absolute private `storeDirectory`, optional protected paths/home. `list(cwd, directory = '.')` returns metadata and opaque revision. `setConsent(selector, allowed, confirm: true)` binds one grant to fresh identities. `browse(access, authorize?)` and `read(access, authorize?)` re-admit before the target root and every descendant handle, before enumeration/body access, and before returning. The host callback must read fresh policy, not a cached decision.

Selectors contain only `cwd/directory/id/revision`; access adds relative `path`. Inventory reports `restriction: 'scoped-files-only'`, exact display inputs, allowed/reason and truncation. No API accepts browser target paths, trust flags or transcript-derived authority. Grants never enter allowed roots or general tools/Git/PTY/MCP/instruction/agent/provider-maintenance boundaries.

Inventory/consent inspects target metadata only, never target handles/names/bodies. In-root links retain default policy. Broad/protected targets, linked canonical components and non-Linux access are refused. Nested links, special files, hard-linked files, NUL/binary/invalid UTF-8 and unstable identities fail closed. Limits: bodies 2 MiB, lists 500, paths 4,096 bytes/64 components; v1 store 128 KiB/256 grants. `<dataDir>/linked-directories.json` contains hashed bindings/generation, not paths/bodies/secrets. Parent/files must be private, owned and stable; cooperating operations serialize. Stale locks are not guessed away.

[WARNING] This is not OS isolation or a global filesystem freeze, immunity to inode reuse/bind mounts or hostile same-UID writers. Revocation cannot erase delivered content. Registered-secret redaction is not arbitrary secret discovery.

## Critical Flows

1. GET `/api/workspaces/linked-directories?cwd=...&directory=.`: authenticated `workspace:read`, canonical source, metadata only. Secret-bearing metadata is masked and ineligible.
2. POST `/api/workspaces/linked-directories/consent`: `workspace:write`, safe Origin, strict selector plus boolean `allowed` and literal `confirm: true`. Fresh locked revision/identity, atomic hashed update; no trust mutation.
3. GET `/browse` or `/content`: additionally `files:read`, separate fresh persisted source allow, unredacted target/path and repeated Core guards. Sensitive descendant names are masked/blocked; bodies redacted before response.
4. Replacement/revocation refuses old selectors. Web clears stale content on failure, reloads metadata, clears confirmation and aborts retired results. Acknowledged revocation serializes behind cooperating in-flight access and blocks later reads.
5. Optional JS/CSS loading stays local/nonmodal with Close/IME-safe Escape and live composer/Stop. Late readiness retires an old open intent if focus moved elsewhere; consent/error focus returns are epoch-bound and never override newer focus. Rejection is cached until explicit page reload with unsent-text warning. Navigation, folder/source changes, close/newer invokers retire intent. Only the ready modal traps focus; its local capture also leaves composing/legacy-229 Escape to the IME without invoking the ordinary document trap. Reuse accepted generic focus ownership, never transplant App/mobile/dialog fixes.

Fixed no-store failures: invalid request 400, unsafe target 403, stale/consent/source-trust required 409, size 413, unavailable/busy/platform 503. See [security](./security.md) for independent trust and middleware.

## Associated Tests

- `packages/core/src/security/linked-directory-consent.test.ts` — metadata-only inventory/consent, exact identity/revision, replacement/revocation, general-tool denial, private store/bounds and second authorization rejection with zero forbidden descendant opens.
- `packages/core/src/security/linked-directory-helpers.test.ts` and `packages/core/src/security/workspace-manager.test.ts` — hidden characters/JSON depth, configured-root authority and bounded paths.
- `packages/server/src/runtime/linked-directories-service.test.ts` — fresh source trust, active-secret target/descendant blocking.
- `packages/server/src/api/{linked-directories-routes,workspace-routes-linked-disabled}.test.ts` — roles/Origin, exact keys, redacted failures, independent trust and disabled integration.
- `packages/web/src/services/linked-directories.test.ts` and `packages/web/src/components/linked-directory-{messages,boundary-messages}.test.ts` — selectors, bounds/cancellation, parallel EN/FR and escaped literals.
- `e2e/linked-directories.spec.ts` — nine original genuine real-server consent/trust/content/revocation/replacement/focus journeys and one appended ordinary in-root link regression, eight unchanged goldens.
- `e2e/linked-modal-boundary.spec.ts` — 22 unchanged real production JS/CSS lifetime cases plus eleven appended IME/newer-focus regressions, including ready source edits, legacy keyCode 229 and a delayed ordinary-read refusal that retains newer composer focus/draft; controlled APIs here do not replace real-server journeys.
- `e2e/{workspace-asset-load,pane-lifetime,settings-locale-asset-load,defaults,live-server,visual}.spec.ts` — retained accepted pane/focus, locale/default and historical/live controls.

## Common Changes

- Change identity/access in Core; retain admission before every handle, forbidden-open negative and independently packed strict public declarations/runtime. Never weaken guards for incorrect Docker UID construction.
- Change adapter/client shapes together; preserve exact keys/revision and separate persisted source trust. Never add grants to roots or execution scanners.
- Change optional presentation only in the owning boundary/modal/invoker lifetime. Run production asset and original pane/lifetime/locale/live bodies without new waits, masks, PNG replacements or altered options.

## Related Domains

- [Security](./security.md) — roots, trust, guards and redaction
- [Server API](./server-api.md) — middleware and composition
- [Web application](./web-app-architecture.md) — optional assets and focus lifetimes
- [English operator guide](../../users/en/linked-directories.md) / [French operator guide](../../users/fr/linked-directories.md)
