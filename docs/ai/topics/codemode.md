# Bounded QuickJS Code Mode

> **Navigation:** See [`project-map.md`](../project-map.md), [`security.md`](./security.md), [`cli-reference.md`](./cli-reference.md), and [`server-api.md`](./server-api.md).

## Overview

Core owns `packages/core/src/tools/{codemode,codemode-worker,tool-search}.ts`. CLI, JSON, RPC and detached Web runs use the same prompt-local loadout and tool loop. The worker is trusted Node infrastructure; user source is evaluated **only in QuickJS**, never in Node `eval`, `Function`, or `vm`.

`codemode` is an inactive-by-default synthetic model-only helper, not a registry mutation. CLI opt-in is `--tools codemode,<permitted nested tools>` or `defaultTools` containing `codemode`; existing allowlists replace defaults and still apply. Trusted agent settings support `codemode.mode` (`on`/`only`) and `codemode.inlineBudget` (0–3000 estimated tokens). Web Settings › Tools exposes Automatic/Always on, presentation and budget at global/project scope. Automatic activation needs eligible indirect tools; merely allowing the helper does not activate it in Web Automatic mode. Empty allowlists, exclusions, chat-only and no-builtins/no-tools remain authoritative.

The Server runs a bounded fixed-script self-test at service construction and caches it per process. `GET /api/tools` reads the cached result without starting a script. Failed/unavailable health disables Web sandbox execution. Inline declarations are capped at four characters per configured estimated token; this is a presentation estimate, not a tokenizer or authority boundary.

## Main Entry Points

| File | Responsibility |
|---|---|
| `packages/core/src/tools/codemode.ts` | Host ceilings, worker lifecycle, redacted bridge and authenticated store metadata |
| `packages/core/src/tools/codemode-worker.ts` | Trusted worker infrastructure and isolated QuickJS guest execution |
| `packages/core/src/tools/tool-search.ts` | Selected prompt-local namespace, live nested authorization and active-branch restoration |
| `packages/core/src/config/codemode-limits.ts` | Trusted configuration validation/copies, unchanged defaults and absolute ceilings |
| `packages/core/src/providers/{specialized-models,classification-questions}.ts` | Credential-private SDK/guest models, finite questions/distributions, live availability and deadlines |
| `packages/web/src/components/CodemodeCard.tsx`, `packages/web/src/components/codemode-state.ts` | Specialized presentation and replay-safe nested state |
| `packages/server/src/api/tool-routes.ts` | Cached health and canonical scoped settings/readback |

## Guest Contract

The tool input is exactly `{ "code": "async JavaScript body" }`. Scripts can use:

- `await tools.<provider-safe-name>({...})`: returns redacted tool text; tools may have real side effects.
- `Promise.all()` / `Promise.allSettled()` for parallel work within the host concurrency budget.
- `ALL_TOOLS`, `searchTools(query, { limit?, namespace? })`, `describeTool(name)` and `describeNamespace(name)` for bounded eligible metadata.
- `text(value)`, `console.log/info/warn/error/debug`, `return` and `exit()` for bounded output/completion.
- `await image({mediaType,data})` attaches a validated PNG/JPEG/WebP data image to the outer result. At most four attachments; their data-URL UTF-8 bytes share the aggregate output budget. Text remains plain text; images use existing native blocks, not guest HTML/renderers. Attachments appear in Web/history/provider projection; no new inline terminal image protocol is implied.
- `store(key, jsonValue)` and `load(key)` for branch-local JSON values; `store(key, undefined)` deletes a key.

Guest bootstrap recursively freezes the listed intrinsic graphs/prototypes, including named constructors, QuickJS-specific `InternalError`, accessor functions and async/generator/iterator prototypes, before running user code. A real post-gate inventory exposed the engine-specific constructor omitted by `ed3e89c`; the follow-up adds it and strengthens the same public freeze scenario without changing sandbox budgets. Bridge serialization/store/error handling retains the original Object/JSON/Error even when a script shadows global bindings; this does not freeze every script-created object. Trusted callbacks construct native guest Errors through a retained constructor, preserving exact limit/nested-refusal diagnostics despite frozen Error.prototype. The retained handle lasts only for that disposable worker/VM.

There is no guest Node/process/require, filesystem, network, timer or module-loader capability. The dependency is resolved from Core's installation, not the selected workspace. `models.getModelsOfType`, `getAvailableOfType` and `getModelOfType` expose bounded descriptors of the current provider and explicitly host-authorized auxiliary providers, optionally including non-secret name/API/context-window/pricing metadata. `models.classify({model,input,labels})` returns `{label,usage?}`; `models.generateImages({model,prompt,count?,size?})` returns `{images:[{mediaType,data}],usage?}` with base64 data. Requests accept no credential, endpoint, header or host-signal fields. Model IDs must match the live catalogue and kind again after any hook. The configured chat model supplies a virtual JSON-label classifier; OpenAI Chat providers expose native `dall-e-2`/`dall-e-3` (not Azure), mock supplies a fixture image, and typed extensions may implement native methods. No upstream API naming/schema compatibility or complete provider breadth is claimed.

The exported Core `SpecializedModels` SDK uses the same contract with host-only `{signal}` options. Model calls have a 10-second deadline including cancellable `before:model` hooks. Code mode installs this dedicated hook through the shared tool loop: native/virtual model requests are not conversational `before:provider` turns. Hooks receive the operation AbortSignal and a context whose notifications/interactions cannot publish after it settles. Their output/usage persists once on the outer tool result, not as extra assistant turns. Direct SDK users can provide the optional bounded hook callback. Inputs are 32 KiB; labels are 1–100 unique strings (500 bytes each); image counts are 1–4, decoded output is capped at 8 MiB and accepts PNG/JPEG/WebP signatures only. Remote image URLs are never followed. Image data additionally consumes the guest's 256 KiB cumulative nested JSON limit; oversized images fail rather than escaping that budget. Built-in requests reuse provider network policy and credentials; no key crosses into QuickJS.

Auxiliary authority is opt-in: public `SpecializedProviderSource` returns a live readonly map of operator namespaces to existing provider instances. Supply it as the fourth `SpecializedModels` constructor argument, `ExtensionRuntimeContext.specializedProviders` or `AgentRuntimeOptions.specializedProviders`; no metadata constructs a provider or resolves credentials. Current-provider IDs remain unchanged. Auxiliary IDs are `namespace::native-id`, distinct from slash-bearing native IDs, and dispatch to that exact instance with its physical model/API. Namespaces do not become pricing identities. The aggregate ceiling remains100 descriptors; ambiguous IDs fail closed. Availability is rechecked after hooks, and retired/replaced auxiliary instances cannot publish a completed answer; observed failed-call usage is still recorded once. Existing signals/deadlines remain authoritative, not a new immediate upstream-retirement subscription.

Native CLI auxiliary sources are actual configured TypeSafe, OpenRouter, OpenCode and Workers AI mixed instances, never names or Mock factories. Custom Server/Settings admits those dialects plus native OpenAI R/D. For example, select `typesafe::jev-latest`, `openrouter::google/gemini-2.5-flash-image` or `<custom-id>::native-id` from returned metadata. No TypeSafe chat row/discovery, guest scalar API, legacy OpenAI image fallback or arbitrary credential-provider exposure is introduced. See [host composition](./providers.md#native-auxiliary-specialized-services).

### Native classifier questions and provider/input map

`SpecializedModels.classifyQuestions` and `models.classifyQuestions` accept `{model,state,questions,images?}`; the original label classifier is unchanged. `state` is owned JSON. Each named question has `prompt` plus `type: 'boolean'`, `type: 'choice', choices: string[]`, or `type: 'score', values: number[]`. Scores use an explicit finite numeric domain, not an unbounded scalar. Answers are `{answers:{id:{value,probabilities:[{value,probability}]}},usage?}`. Every allowed value must occur once, probabilities must be finite in [0,1] and sum to 1 within 0.000001. Missing/duplicate/foreign/malformed distributions fail; scalar confidence never becomes a fabricated distribution. Virtual-chat probabilities are model-reported, **not calibrated confidence**, a safety decision or a dedicated classifier service. The finite native TypeSafe bridge instead consumes service probabilities, including the exact binary complement; it does not certify calibration. Direct host SDK `classifyNativeQuestions` on TypeSafe, Cloudflare, OpenAI Decisions and OpenRouter classifiers has a separate scalar/result contract documented in [providers](./providers.md#native-typesafe-classifier-sdk-subset); this method is not exposed in QuickJS or through `SpecializedModels`.

Bounds: 16 questions; 2–16 distinct choices/scores each; 500-byte choices; finite scores within ±1,000,000; 4,096-byte prompts; combined JSON state/questions and answer JSON each ≤32 KiB. Native `before:model` receives the same classifier kind and can distinguish `questions` from `input`; the bridge copies/revalidates requests, live availability and image capabilities after it returns. All questions use one model call/one usage record. The host bridge forwards the resolved descriptor's optional physical API, not a new guest field or caller override. Explicit mixed `OpenAiMixedProvider` uses it to distinguish the overlapping native D `gpt-6-luna` from virtual R `gpt-6-luna:classifier`, preserving different prices without changing finite/native scalar contracts. Separate static conversation declarations now supply OpenAI R,OpenRouter A/C and Cloudflare C names/capabilities/limits/base prices to offline/RPC/Server/Import; they do not expand the two/83/four specialized descriptors. OpenRouter21 ambiguous zero-only tables remain unpriced and these views omit tiers; existing operation-owned accounting remains authoritative. Luna R272,000 and native D922,000 context remain distinct, and only the configured virtual R plus native D descriptors are available. See [adapter-owned metadata](./providers.md#adapter-owned-static-conversation-metadata); operator overrides and guest budgets stay authoritative. Its actual-adapter CLI/RPC compaction/statistics/status lookup does not infer classifier reserves, expand guest descriptors or replace D/T/I/S limits with conversation windows.

| Capability | Supported native input/provider | Retained difference |
|---|---|---|
| Virtual labels, boolean, finite choice/score | Configured conversational provider's virtual JSON classifier, including built-ins, native extensions, explicit Cerebras C and separate/mixed Cloudflare C SDKs (virtual C remains distinct from native S) | Not Pi's question ABI or calibrated probabilities; other dedicated classifier transports remain missing |
| Native Jev finite questions/labels | Explicit `TypesafeProvider` SDK/standalone or native CLI/custom Server/Settings auxiliary composition; native `noul`/choice, numeric finite domains lowered to choices | Text only; decoded answer failures retain usage via `SpecializedModelError`, not Pi's full result ABI; no guest scalar-score exposure or TypeSafe chat routing; see [TypeSafe hosts](./providers.md#native-typesafe-host-composition) |
| Native Cloudflare finite questions/labels | Explicit classifier-only `CloudflareWorkersAiProvider` or mixed `CloudflareWorkersAiMixedProvider` SDK/standalone guest or explicit custom host, three pinned text classifiers and native Cloudflare envelopes | Same finite guest contract; separate direct native scalar/result SDK, physical known prices and failed-answer usage; no automatic gateway/account qualification; see [Cloudflare custom host](./providers.md#explicit-cloudflare-custom-host-composition) |
| Native Decisions finite questions/labels | Explicit `OpenAiDecisionsProvider` or mixed `OpenAiMixedProvider` SDK/standalone guest/custom host; pinned GPT-6 Luna text/image input and named predicate/choice answers | Native scores remain a separate direct SDK contract; base descriptor prices versus observed tier-aware cost, unchanged four-image/guest bounds and no automatic built-in/subscription composition; configured virtual R remains distinct in the explicit custom host; see [Decisions SDK](./providers.md#native-openai-decisions-classifier-sdk-subset) |
| Native OpenRouter finite questions/labels | Explicit `OpenRouterClassifiersProvider` SDK/standalone guest or mixed `OpenRouterProvider` custom host; 21 pinned System One classifiers with direct scalar results kept separate | Every image refuses despite six declared image-input profiles; eighteen nonzero price tables versus three ambiguous zero fallbacks, decoded failed-call usage and no OAuth/account qualification; see [OpenRouter classifiers](./providers.md#native-openrouter-classifier-sdk-subset) |
| Classifier image input | Published `imageInput: true` model metadata on OpenAI/Azure, Anthropic, Gemini/Vertex and Bedrock; extensions may explicitly advertise it | Unknown/text-only/local/mock models do not silently acquire vision; validated images really enter adapter message blocks |
| Image generation | OpenAI Chat `dall-e-2`/`dall-e-3`, mock/native extensions, explicit `OpenRouterImagesProvider` SDK/standalone guest and mixed `OpenRouterProvider` custom host | OpenRouter finite route is prompt-only, count one/omitted, size omitted; distinct direct text/image SDK, 61 pinned image projections and no account qualification; see [native images](./providers.md#native-openrouter-image-sdk-subset). No remote URL download, full media/resizer or complete Pi catalogue; Azure excluded |
| Guest image presentation | `await image(generated.images[0])`; same output/call budgets and native outer result blocks | No guest-defined markup; binary results still consume cumulative nested JSON before presentation |

Guest example (inside `{code: ...}`):

```js
const model = await models.getModelOfType('classifier');
const result = await models.classifyQuestions({model: model.id,
  state: {message: 'Approved'},
  questions: {approved: {type: 'boolean', prompt: 'Does the message approve?'}}});
text(result.answers.approved);
const painter = await models.getModelOfType('image');
if (painter) await image((await models.generateImages({model: painter.id, prompt: 'A pixel'})).images[0]);
```

## Resource and Policy Bounds

| Resource | Hard default ceiling |
|---|---|
| Whole hosted operation, including indirect preparation | 10 seconds |
| QuickJS allocation / stack | 32 MiB / 256 KiB |
| Interrupt-handler fuel | 10,000 callbacks (not a JavaScript instruction count) |
| Bridge operations / simultaneous host calls | 64 / 4 |
| Source / one nested JSON input / aggregate script output | 64 KiB each |
| Cumulative successful nested-result JSON | 256 KiB |
| Guest output records / eligible tool snapshot | 1,000 / 2,000 |
| Store keys / one value / complete committed store | 128 / 64 KiB / 256 KiB |
| Active workers per process | 8 |

### Trusted configurable reductions and precedence

Defaults are also the absolute safety ceilings: `timeoutMs` 10,000; `memoryBytes` 33,554,432; `calls` 64; `outputBytes` 65,536. Trusted settings can reduce these four values to positive safe integers, never increase them. Other resource ceilings remain fixed. Too-small VM allocations may fail initialization rather than granting additional memory. `validateCodemodeLimits` rejects unknown keys, accessors, nonintegers, zero/negative/oversized values and returns a copy; `resolveCodemodeLimits` fills defaults. Loadouts pin an owned validated snapshot; guest input accepts only `code`. A JavaScript `// @options` comment is inert, not a settings channel; raw-source tool input, guest `limits/options`, Pi heap/output/timeout annotations and arbitrary option keys are unsupported.

| Host | Trusted configuration and precedence |
|---|---|
| CLI print/JSON/RPC/regular/fullscreen | `settings.json` → trusted project `.ai-harness/settings.json`, merging `codemode.limits` per field; untrusted project settings are not read. Existing interactive reload/next-loadout rules apply; RPC uses its startup snapshot. No new CLI flag or environment channel |
| Core/SDK | Explicit `createAgentToolLoadout({codemode:{limits}})` / `AgentRuntime.start({codemode:{limits}})`; no implicit high-level AgentSession tool/config discovery. `runCodemode({limits})` retains its lower-level host-only reductions/clamping for all existing resource keys |
| HTTP/Web | Admin-only `PATCH /api/tools` accepts `codemodeLimits` at global/project scope; `GET` returns effective four values. Existing admin `/api/configuration` session scope also applies. Higher scoped objects replace the whole lower object; omitted members use defaults. `null` resets the scoped key. Effective scoped values take priority over trusted agent-file `codemode.limits`, then defaults. The agent run body/guest cannot override them; existing Settings UI remains activation/mode/inline-budget only |

Native trusted agent-file example:

```json
{"codemode":{"limits":{"timeoutMs":1000,"memoryBytes":16777216,"calls":8,"outputBytes":4096}}}
```

Apply HTTP reductions with the usual admin capability/Origin and exact project cwd/ID; include the existing `enabledTools`, `toolPreset`, `powershellEnabled` fields alongside `codemodeLimits`. Invalid HTTP values reject atomically. Agent-file validation instead reports the precise diagnostic and retains valid siblings/earlier layers, following the existing settings contract. Neither project overrides nor native extensions are an administrator sandbox: only approved project files and privileged configuration clients are trusted here.

The worker also has Node heap/stack resource limits and an empty inherited environment. A host timer terminates it on deadline, fuel/output failures or cancellation, and forwards an abort to outstanding tools. Capacity remains occupied until awaited physical worker termination, not merely logical script settlement. Output is accumulated as bounded records and joined/redacted once at settlement; no growing prefix is repeatedly rebuilt. An indirect source ignoring abort cannot indefinitely retain preparation. A trusted host tool ignoring abort may finish later, but cannot publish late sandbox output/store or notifications. OS-level containment of that tool is outside QuickJS.

Hidden and model-only tools never enter the nested namespace. `codemode`, `tool_search`, and `spawn_subagent` are excluded even if mislabeled by a trusted registration. Current static/dynamic policy is recomputed before **every** nested operation, including queued calls, and a host-owned admission callback rechecks cancellation/name/owner/implementation after nested `before:tool` hooks and call observers, immediately before effects. Dynamic MCP candidates have already passed the session host's fresh read-only annotation filter; invocation rechecks the latest `readOnlyHint`. Discovery results, source text, guessed names or persisted metadata cannot grant permission. Static selected tools win name collisions.

`direct` tools may be declared normally and called through scripts; `model-only` controls stay top-level; `deferred` tools become directly declared only after authenticated discovery for the next provider turn; `codemode` tools remain **script-only**, even after search; `hidden` tools are neither declared nor nested-callable. `only` removes nested-callable direct declarations, not model-only controls. MCP servers and trusted extensions remain ordinary privileged host/remote code: sandboxing JavaScript does not sandbox them or make dishonest read-only annotations safe.

## Persistence and Failure

The common extension before-hook/event pipeline wraps nested tools. Full nested tool results are not independently inserted as top-level provider messages. Host-issued IDs `${outerToolCallId}:${bridgeOperationId}` correlate running/completed/failed/cancelled calls exclusively to their outer invocation; metadata/search operations consume budget but do not create execution cards. Events use `tool.progress` with `kind: codemode`, and active snapshots retain at most 64 nested calls. Shared provider/tool and outer/nested code-mode durations use monotonic elapsed time, rounded to nonnegative integer milliseconds, so wall-clock regressions cannot create invalid persisted messages or discard a progress snapshot. JSON/RPC carry the same IDs through `tool_execution_update`; interactive renderers show correlated status while print stdout stays final-text-only. Late results/notifications cannot modify settled metadata. The outer result carries bounded duration, model usage, known cost subtotal, explicit `costComplete`, nested statuses and authenticated store metadata with `engine: QuickJS`. Usage persists and enters session/server totals once, including completed requests in a failed or interrupted script. A native `SpecializedModelError` can retain already decoded numeric accounting despite rejected answers: the SDK sanitizes its message and code mode attributes its usage once to the failed model call, not a fabricated successful answer. An ordinary error's arbitrary `usage` field is ignored; guest handling changes script/store success, not whether the observed call was billed. On parent-run abort, the shared loop appends one error result with `metadata.interrupted: true`, retains authenticated completed-call accounting, removes pending store changes and stops before another tool or provider request. Durable cleanup does not reuse the aborted execution signal or trigger compaction; the detached journal publishes `run.stopped` only after the result, and a replacement run cannot start before cleanup settles. Calls completing after sandbox settlement cannot add usage or output; unknown usage from a cancelled remote request is not invented. Only results issued by the loadout's private WeakSet can supply that metadata.

Store changes publish only on successful script completion, after JSON size checks and credential redaction. Failure/cancellation leaves the previous store intact; calls already performed are **not rolled back**. Restore follows only the active session parent chain (including resume, fork and compaction), not a sibling branch. Session metadata/output is sensitive user data, not a secret vault. Web lazily loads the specialized card and its scoped CSS, keeping the existing entry/CSS budgets. It renders plain-text script/output, duration, cost completeness and a scrollable twelve-call preview with an omitted count; legacy/foreign/malformed metadata falls back to generic tool blocks. Replay rejects crossed parents, duplicate IDs, terminal resurrection and nested top-level promotion. Tool changes/reload retain model-only declarations, pending parent interactions and independent child-agent controls; terminal runs cancel remaining interaction requests.

## Critical Flow

The shared loadout prepares eligible indirect metadata under the operation deadline, starts one worker and sends bounded JSON metadata/store. QuickJS requests cross the host bridge; host queue admission and dispatch both recheck current policy, then invoke the normal hosted executor. Success publishes redacted output and authenticated store metadata; any failure terminates the worker and aborts outstanding calls before releasing worker capacity. The tool loop persists only the outer result, and restoration walks only the active session chain.

## Associated Tests and Validation

Use the repository's Docker-only workflow:

- `make typecheck`, `make test`: budgets, isolation, async/parallel calls, live policy, queued revocation, cancellation, redaction, transactional/branch store, hosted tool-loop metadata, CLI execution outside the installation and HTTP scoped settings.
- `make test-e2e E2E_ARGS='e2e/codemode.spec.ts e2e/codemode-live.spec.ts --retries=0'`: two isolated real worker/provider/hooks/browser image/reload journeys (success/error) with exact usage, three live HTTP output/deadline/Stop checks, plus intercepted scoped save/readback, failed health, restrictions, axe, overflow and reviewed desktop/mobile Light/Dark baselines.
- `make lint-docs`; `git diff --check`.

`packages/core/src/tools/codemode-intrinsics.test.ts` subclasses real Workers to observe creation through exit, eight-worker abort/deadline storms, non-interruptible computation, frozen graphs/global shadowing, exact errors, visible schema constraints and rejected hosted options. `packages/cli/src/cli/codemode-intrinsics-process.test.ts` and its genuinely installed public consumer cover actual Core/print/JSON/RPC channels, nested effects and success-only store results. These tests add no budget/runtime flag and do not replace failed aggregate receipts.

`packages/core/src/config/{codemode-limits,agent-settings}.test.ts` covers trusted ceilings/snapshots/project precedence; `providers/classification-questions.test.ts` covers finite questions, distributions, errors/cancellation and guest accounting. `providers/specialized-models.test.ts` captures actual label/question vision payloads for six built-in adapters (OpenAI/Azure, Anthropic, Gemini/Vertex, Bedrock), image generation bodies and post-hook capability withdrawal; fixtures are not live-vendor certification. The installed public declaration/runtime consumer and extended process probe cover configured output, actual image blocks and physical worker exits, including abort/deadline, outside the checkout.

`packages/core/src/providers/cerebras.test.ts` and its installed public consumer separately verify the explicit two-profile C SDK's configured virtual label classifier, physical cache prices and absence of inherited DALL-E. Its readonly public profiles/static conversation metadata do not add a native classifier, expand configured virtual descriptors, alter guest hooks/budgets, certify failed-chat billing or qualify automatic hosts/accounts; see [Cerebras](./providers.md#native-cerebras-chat-completions-sdk-subset).

`packages/core/src/providers/openrouter-classifiers.test.ts` and its installed public consumer separately cover native System One bodies, all-image refusal, conservative zero-price/failed-call accounting and finite guest execution; catalogue declarations grant no image capability or automatic host authority.

`packages/core/src/providers/openrouter-images.test.ts` and its installed public consumer separately cover the actual native image API, direct versus finite results, disjoint cache accounting/ambiguous zero-price refusal, once-only failed guest billing and bounded image publication. Existing guest budgets remain unchanged. The [explicit OpenRouter custom host](./providers.md#explicit-openrouter-custom-host-composition) exposes 21 native T, 61 native I and one configured virtual A/C classifier within the unchanged 100-model ceiling. `packages/server/src/api/openrouter-http.test.ts` separately exercises real native A/C tool continuations through HTTP, T/I guest calls, image publication, success-only store and once-only outer accounting; static metadata is not account qualification.

`packages/server/src/api/cloudflare-http.test.ts` exercises native C continuations with two S guest calls and authenticated outer accounting. The [explicit Cloudflare custom host](./providers.md#explicit-cloudflare-custom-host-composition) exposes three native S descriptors plus only the configured C virtual classifier, independently of a pending conversation's per-call model. Separate raw-reference host controls cover all three S profiles, configured virtual C and decoded failed-S billing with no failed store; no guest ABI/budget or account certificate is added.

`packages/core/src/providers/openai-decisions.test.ts` and its genuine installed consumer separately cover actual native text/image bodies, finite domains, tier-aware failed-call accounting and direct scalar results; they do not add automatic conversational classifier composition.

Relevant tests are `packages/core/src/providers/specialized-models.test.ts`, `packages/core/src/agent/runtime.test.ts`, `packages/web/src/components/codemode-state.test.ts`, `packages/core/src/tools/{codemode,tool-search}.test.ts`, `packages/cli/src/cli/invocation.test.ts`, `packages/server/src/api/tool-settings.test.ts`, and `e2e/codemode.spec.ts`. MCP-specific nested safety also lives in `packages/core/src/mcp/session-host.test.ts`.

## Common Changes

### Change a guest capability or ceiling

Update `packages/core/src/tools/{codemode,codemode-worker}.ts` together. Keep host and guest bounds aligned, reject larger injected limits, and add budget/abort/leak regressions in `codemode.test.ts`.

### Change selection, exposure or settings

Update `packages/core/src/tools/tool-search.ts`, live MCP policy and each CLI/RPC/Server adapter. Preserve script-only/model-only boundaries and branch authentication; extend scoped HTTP tests and Light/Dark mobile/desktop browser proofs.

## Related Domains

- [`security.md`](./security.md) — host trust, credentials and privileges outside QuickJS
- [`cli-reference.md`](./cli-reference.md) — CLI/JSON/RPC activation and adapters
- [`server-api.md`](./server-api.md) — scoped settings and sandbox health
