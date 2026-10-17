# Bounded ordinary provider-request admission — 2026-10-17

Status: **bounded runtime/browser qualification; exact-index/postcommit admission required for repository acceptance**. Evidence ID: `E-AH-PROVIDER-REQUEST-01`. Parent: `8753ec92b658c1416d26ac37d3aeac49ab2a4ae3`.

This is a bounded continuation of [compaction generation](compaction-generation.md), not completion of `CLI-SES-07` or the audit. All **152 requirements retain their status and order: 97 DONE / 55 PARTIAL**. The exclusions below remain required work.

## Delivered boundary

Sixteen Core implementation/test files are byte-identical to the frozen, separately qualified V14 sources. No V15 implementation is imported.

- The shared ordinary turn owns model-bearing messages and recognized options **before extensible JSON redaction and again afterwards**. It captures provider/redactor bindings, retains legitimate awaited start-observer mutations, and prepares an independent payload for each ordinary retry. Retained redactor aliases cannot mutate final dispatch. Authentic signals and caller-owned mutable arrays/maps remain compatible.
- Recognized fields must be passive own-data or genuinely absent. Inherited recognized fields/accessors refuse unread; unrelated legacy getters/serializers stay unread. Non-callable own `toJSON` data remains valid. Plain/null-prototype JSON, pristine finite Dates and dense model arrays use bounded preparation/measurement: depth 32, 65,536 nodes and 64 MiB. Initial local refusals are lifecycle-quiet; later admitted refusals pair start/error and are not retried. Ordinary transport retries remain three attempts, 500 ms initial, 5,000 ms cap, without a new transient-error classifier.
- Optional numeric request budgets and known manager policies account for the projected **current messages, system prompt and tool declarations**, not historic billed usage, IDs, timestamps or private metadata. The policy is explicitly `canonical-json-utf8/4-v1`, a bounded heuristic, not native/vendor tokenization. Known window/reserve changes withdraw admission; equivalent values and title changes conserve it. Automatic manager settings select own-data `enabled`, `reserveTokens` and `keepRecentTokens`; unrelated legacy getters do not suppress valid ordinary replies.
- Output reservation is the maximum of configured reserve, separately retained **pre-redaction explicit maximum**, and final effective output. Redaction cannot erase that earlier ceiling. Output alone beyond the owned window refuses before provider/HTTP work, without a needless summary.
- An internal WeakMap supplies native output preparation only for exact first-party `AnthropicProvider` instances. It adds no mandatory public provider/store method or DTO and does not change Core API 1/JSONL schema 2. Structural, extension and subclass providers remain unchanged and uncertified. The configured native fallback model is captured passively before callbacks; explicit post-hook model selection retains precedence.
- Native preparation shares the actual Anthropic thinking implementation/constants: default 1,024; numeric budget 2,048 plus explicit maximum 64 expands output to 3,072; adaptive high without an explicit maximum uses 9,216; adaptive explicit 64 stays 64. Used numeric maps are owned after awaited observers. Off/adaptive unused maps stay opaque and unread; caller maps remain mutable and unfrozen.

See [Providers](../../../ai/topics/providers.md) and [Sessions](../../../ai/topics/sessions.md) for owning code and compatibility boundaries.

## Permanent regression coverage

Seven new test leaves contain **235 genuinely new cases**, not the extra existing provider cases selected by the broader owner configuration:

| Test leaf | Cases |
| --- | ---: |
| `agent/provider-request-estimate.test.ts` | 29 |
| `agent/provider-request-budget.test.ts` | 36 |
| `sessions/session-compaction-policy-settings.test.ts` | 27 |
| `agent/provider-request-options.test.ts` | 59 |
| `agent/provider-request-payload.test.ts` | 18 |
| `agent/provider-request-options-flow.test.ts` | 27 |
| `providers/provider-output-budget.test.ts` | 39 |

Paths are relative to `packages/core/src/`. Four new internal helpers and these seven leaves accompany five modified owners. The integration map is `/tmp/aih-provider-request-integration-v14-map.json`.

## Preserved original observations

| Frozen experiment prefix under `/tmp/` | Original observation; not acceptance |
| --- | --- |
| `aih-compaction-full-wire-v2` | 48 observations: 32 defects/16 positive controls; the later DEC96 residual separately retains 24/16/8. |
| `aih-provider-request-policy-authority-v1` | 64 observations: 32 defects/32 positives in accepted/V4 profiles, actual Node 24/26 and memory/native stores. |
| `aih-provider-output-policy-v1` | Actual built-in OpenAI loopback HTTP: 48 observations, 24 defects/24 positives. The original absolute-path host-oracle failure remains separately from corrected v2 admission. |
| `aih-native-output-projection-v1` | Actual built-in Anthropic loopback HTTP: 56 observations, 24 defects/32 positives in accepted/V12 profiles. The impossible default/thinking output alone exceeds the declared window, independently of input-token heuristics. |
| `aih-provider-unknown-window-v1` | All 56 assertions were contaminated by legitimate legacy eager automatic compaction; these are **not 56 product defects**. The fixture admission preserves summary 1 in every observation. |
| `aih-provider-unknown-window-v2` | Only `keepRecentTokens` changes 1→100 to retain tiny histories, without disabling automatic compaction. 56 observations: 20 defects/36 positives; V14 retains eight budget-dispatch defects. The original host getter-counter oracle fails `2 !== 0`; corrected v2 admission changes no product observations. |

Development V1/V2/V5/V7/V8/V9/V10/V13/V15 artifacts remain versioned outside the checkout: missing type roots; lint escape; literal Node 26 compiler 134 `FATAL ERROR: Zone Allocation failed - process out of memory`; readonly-map TS2540; artifact-prefix oracle; Server compound139 `Segmentation fault (core dumped)` with the failed subcommand unidentified; generic mock TS2345; unsupported `isTransientError` fixture TS2353; and V15 `prefer-const` fixture lint1. V15's 31 new cases and Node 26 gates were not executed. No V16 was launched. Later passes neither erase these failures nor establish their causes.

## Fresh integrated Docker qualification

Evidence prefix: `/tmp/aih-provider-request-root-v1`. Product commands execute through Make inside Docker, with no source overlays.

| Complete configuration | Actual result |
| --- | --- |
| Fresh test-image build; workspace `npm run typecheck` |0; parity declarations included |
| Retention-only canonical-equivalent CI `npm test` | **313 leaves/4,496 tests pass**, 766.32s; actual start/wait/Make/outer collection 0 |
| Node 24.15.0 strict25/lint and direct controls | 0; **365 direct observations** |
| Fresh Node 26.12.0 workspace builder and COPY comparison | 0 |
| Complete Node 26 owner command | **73 leaves/1,636 tests pass**, 107.08s; strict/lint 0 |
| Complete Node 26 direct controls | **365 observations**, 0 |
| Independent Node 26 installed whole-v3 configuration | **All 43 pass**, 76.46s; container/Make/copy 0 |
| Production build and smoke | 0; **377 observations** including the separate title and HTTP-result markers |
| Emitted-file comparison |18 identical JS/declaration files in LTS,Node26 and production; SHA256 `29049bebc3e608803429b63abaddc3994d9faad9f294aa5e3200db6f5f6503f6`|
| Runtime admission |`-runtime-admission-v3.exit=0`; runtime qualified, not a global/release admission|

The default count already includes 69 runtime parity cases: 26 reviewed public protocol cases and 43 genuine installed-executable cases. They are not 69 additional unique cases. Each 365-control profile consists of 311 established generation/lifetime observations plus 12 full-wire, 16 known-policy, 12 actual OpenAI and 14 actual Anthropic observations. Outside-root copied Core/dependency-linked consumers are not genuine packed-installed acceptance; the 43-case installed configuration is separate.

Actual loopback bodies/events prove only the exercised built-in HTTP serialization and dispatch. Across the native control profiles, impossible output and recognized-output accessors refuse with provider 0/HTTP 0; valid controls use actual HTTP; recognized getter reads 0, summary 0 and new user input 1. No live-vendor or tokenizer claim follows.

### Two failed whole installed configurations remain failed

The original Node 26 installed command is **42 pass/1 fail/43**, 75.98s: `compaction-window-public.ts` compiler child 1, literal `TypeError: Cannot read properties of undefined (reading 'toString')` at `_tsc.js:61572:34`, through installed-test503:20/136:91. Its enclosing container 1/Make 2/extra-campaign 1 remains failed despite the preceding complete 73-owner and 365-direct commands passing.

Independent installed whole-v2 is **42 pass/1 fail/43**, 75.88s: a different `session-navigation-public.ts` case returns child code:null with no reported signal or diagnostic, through installed-test545:20/136:91. Full collection exits 0. No native-signal, timeout, OOM, flaky-test or compiler-cause diagnosis is established.

Whole-v3 uses the same immutable builder image, CI flag, Git bootstrap, whole 43-case command, source/compiler/Node/resources/assertions/deadlines. It admits **all 43**, never either failed configuration's 42 passing cases. Its later pass does not erase or diagnose either failure. Two earlier queued browser wrappers exited at prerequisites **before any browser command/container**; these are not browser test failures.

### Source and environment scope

The full filtered COPY snapshot has 2,232 entries: 1,536 immutable and 696 original generated inputs. Both fresh images match non-generated path/type/mode/hash/symlink data, including `.git` and nested SDK README. Original generated artifacts remain separately from 287 LTS/448 Node 26 replacements. Replacement metadata hashes are retained in the runtime admission. Generated extras and the full environment are **not certified**. Forty-eight selected host inputs, frozen harnesses and archives are conserved; containers report `Mounts=[]`.

Immutable images:

- Test/LTS: `sha256:65f99ec259917cc9226dfc1b5cde4922d9b859f9493a6f04ffb613673cfbf21f`.
- Node26 builder: `sha256:41116e663658fbcb6a965b3a3afff50970db0aa25cf45d437670d12e0f52af21`.
- Production: `sha256:2f2e155f802662cf7dbe722b462cbd32dd3db62ed06f2065c8aeefb110f4dac0`; logs, copied roots, bodies and states in `-production-controls-*`.

The production watchdog remains independently **unhealthy**, failing streak 2. The separately exercised health/HTML/JavaScript HTTP 200 and clean Server exit 0 do not establish watchdog health, deployment or live-vendor acceptance.

## Browser and exact repository admission

The first actual full canonical `make test-e2e E2E_ARGS=` invocation (`-canonical-v3-*`) remains **failed**: actual Make2/container wait1/outer driver1,542 pass/two fail,all nine original HTML reports collected. Standard364/365 times out after30,000ms at `visual.spec.ts:753:5`/776:19 waiting for the About heading (`8324bb52c49185e48ff4-8ab5c71645227e34e4bc`). Pane13/14 loses its worker at `pane-lifetime.spec.ts:15:1`,literal `code=null, signal=SIGSEGV`,duration0/workerIndex−1 (`66506c64e09f71f6233e-a918975b04a57b0596e7`). No cause is established.

The first independent **entire standard** configuration also remains failed:364/365,15.2m,a different worker SIGSEGV at `visual.spec.ts:572:5` (desktop-light message metadata). Its now-passing About case is not borrowed. Independent **entire pane** passes14/14,12.5s;independent **entire standard-v2** passes365/365,15.2m. Neither changes source,assertions,worker count1,retries0,resources or deadlines. New configurations start only after complete prior outer collection.

Admitted coverage is **544 from nine complete passing configurations**:seven original configurations165 + independent pane14 + independent standard365. The original failed configurations'364/13/364 passing subsets are never admitted. `-original-browser-admission.exit=0` verifies the original failures/collection;`-browser-admission.exit=0` verifies exact whole-case identities,one attempt,zero skips/flaky/report errors and the same immutable image/source hashes. `canonicalCommandPassed` remains **false**. No later pass diagnoses an earlier failure.

After all runtime/browser collection,`-freeze-retirement.json` records source conservation and no active relevant container. Repository acceptance additionally requires the exact **23-path** allowlist/candidate/index/tree,all152 original requirements/status/order and historical records,all55 remaining IDs,14 topics/15 estimates within10%,links/versioning/whitespace,staged and postcommit verification. The final records are `-final-{matrix-admission,inventory,candidate,staged-admission,postcommit-admission}.json` and associated actual command logs/exits. Post-staging Git is not claimed equal to the original build context. The first pre-staging documentation check remains failed with six ignored-link violations:the new receipt existed but was not yet tracked. Force-staging that explicit ignored receipt,not changing the links or product source,is the required remedy;the final staged check must cover it. These gates concern only this bounded commit,not release or the full goal.

## Explicit remaining requirements

Initial unknown manager windows still lose later-known budget authority; legacy unknown-window automatic-compaction behavior is intentionally preserved. Effective post-hook model capacity, known text combined with unknown media, all native/provider dialects, ordinary CLI/RPC budget composition, useful atomic request-aware compaction/rebuild and bounded genuine-overflow handling remain open. Unknown media is not zero; this implementation only retains independently known non-message overhead when media is unknown.

Complete renderer/hooks/provenance, general prestart source/publication authority, shadowed cancellation internals, actual noncooperative physical settlement/administrative capacity, and once-per-**actual-settled-attempt** accounting remain open. Refusing publication is not usage deduplication: an invalid native response can settle twice. No new mandatory borrowed-resource/store capability, vendor tokenizer, healthy production watchdog, physical-device, remote Pages, release or global-goal acceptance is claimed.
