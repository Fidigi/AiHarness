# QUA-02 — repaired-source acceptance evidence and reproduced MCP blocker

**PARTIAL — one reproduced visual incident awaits correction evidence or explicit user decision.** Audit closure remains40/43. This is a current Web-delta qualification, not reopening QUA-01/MOD-01/MOD-03 or qualifying CLI-04/QUA-03. The [pilot](./QUA-02.differential-20261116.md), its failed executions and four rejected narrow terminal frames remain historical, unchanged evidence.

## Requirement audit

| Requirement | Applicable current evidence | Remaining mandatory work |
|---|---|---|
| Approved platform/browser/viewport/theme matrix | [User decision](./QUA-02.matrix-approval-20261116.json): Linux x64/Chromium,1440×900/820×1180/390×844 × light/dark; six cells actually executed | Windows/Edge/Safari are optional availability-based follow-up and explicitly unverified; physical mobile was explicitly declined as a milestone blocker, not passed |
| Bounded pinned differentials |12/12 actual app/cell journeys: send/settle/persist/reload, paginated history, theme persistence, workspace file and real PTY, isolated per application/cell | No missing selected journey; no vendor/account or exhaustive provider/model claim |
| Individual visual/reference review |48 new original PNGs and24 individually examined pairs; all24 bounded presentations accepted, including four repaired narrow terminal states; all original baselines/comparators retained | **MCP own-reference mismatch reproduces4664pixels/4% against unchanged2% tolerance. OPEN, not accepted by these Appearance/other pairs** |
| Relevant fixed-protocol performance | Existing performance2/2 PASS;20 mounted messages/320,647.368ms diagnostic cached-viewport restoration; exact bundle sizes/hashes and original limits retained | No percentile/SLA, upstream or real-server latency improvement asserted |
| Native browser/HTTP boundaries | Real browser→application HTTP/SSE, native stores, workspace file reads and PTYs; native existing MockProvider, Pi one actual synthetic loopback model request/cell. Full disjoint browser inventory executed | Current MCP failure still needs its explicit disposition; simulated performance routes do not replace real-boundary evidence |

The user's scope approval does not waive bugs. A reproduced failure is not covered by the non-reproduction rule. No unavailable platform, unexecuted case or missing requirement becomes a pass.

## Frozen inputs and environments

- Product/test/build commit `07bceeca6342d9add499cf10a521cce0649c7f0c`, tree `8333b8a72d6a503781039e0d2ea7abc610966ab6`. All2550 Git blobs/modes verified, no later non-doc delta; archive SHA256 `4e251b77dc9489ff8012c3726717798435165b6cbc97d1a79a2c23b3e392c96d`. Both changed files read back byte-identical from the final container. Documentary delivery does not qualify changed product bytes.
- Types/owning/root image `sha256:44f92c315e2f5f6473e56a06eb61bf4a0e844234f58a1f750ffee35342aafb11`; frozen-archive browser partition image `sha256:05c947dfcdb0f1925bc2383d8c59e5f59882534c89d6791829677450207fc690`. Same product inputs, not a claim of identical complete images.
- Final collector `sha256:a15bf787ea18b855bedd5c88c365ea503d5617a09fc989fcd511c81823c66879` inherits44f92c and copies only the frozen reference tree and temporary acceptance spec. Spec SHA256 `72f1f4a0afcf3891397db4371394a110f2c6777781db14b319a33f95bc2bc5ec` fixes narrow explorer withdrawal and normal xterm pointer access before execution.
- Unchanged reference image `sha256:2d291cd9a43500455e460b5da35ab71ec486b769e14734ae4057420b4394974f`: Pi Web0.12.2 source `b017cd48425d05aa4952051db2e4fc031c134094`, exact-lock published Pi1.2.0 dependencies. Pi Git source `06a466935536f8c9bcacb2d5efc0fc021be1bdff` is separately pinned; no source-reproducible published SDK build claim.
- Node24.15.0/npm12.1.0/Playwright1.63.0, actual Chromium156.0.8078.79 on Debian12/Linux x64. Windows-looking fixture UA is not Windows certification. No Windows/macOS/Safari runner, Edge binary or remote browser resource was exposed; no new browser/dependency installation is inferred.
- Synthetic/disposable accounts, credentials, HOME, stores and workspaces only. Final differential uses task-owned `Internal:true` Docker networking, loopback services and no published ports/external route. No personal store, live account, protected pi/qwen-moe container, host/dependency patch or publication. No new runtime/compiler flag, assertion, deadline, budget or security policy.

[Artifact index](./QUA-02.validation-20261116/artifacts.json) binds original commands/times/exits, image/source manifests, complete reports/error contexts/PNGs/traces, fixed protocols, measurements and individual review. Full command lines and output ownership are retained there; all product tests/typechecks use official Docker workflows. Local execution is not remote-CI success; matching-source remote CI remains unobserved/uncredited, not a new hosting prerequisite.

## Actual commands and results

| Control | Command / actual result | Disposition |
|---|---|---|
| Focused repair gates | `make typecheck IMAGE_TYPECHECK=aih-qua02:overlay-candidate-20261116`; `make test-e2e … E2E_ARGS='e2e/terminal-controls.spec.ts --reporter=line,json --trace=on'` | Complete types and owning9/9 PASS. Existing actual-PTY case is strengthened, not duplicated; old-product RED retained in pilot |
| Full root, alone | `make test IMAGE_TEST_RUN=aih-qua02:overlay-root-20261116` | **11694 PASS/2 FAIL**,659files, zero resultless cases, Make exit2. Current qwen/vl8b whole-case5s timeout and emitted CLI native Anthropic/OpenRouter RPC child SIGTRAP remain original failures |
| Exact current root controls | Original `npm test -- <owning file> -t <exact case>` once each, same image/inputs/flags/limits | Core1/1 PASS395ms (all108 loopback/body/replay/privacy checks); CLI1/1 PASS421ms (child0/no signal, metadata/wire/journal/privacy checks). Scoped explicit user-rule resolution, not compiler waivers, causal repair or integrated-root green;385/7 filtered cases are not new passes |
| Four original local partitions | Existing `make test-e2e … E2E_ARGS='--ci-partition=N/4 --reporter=line,json'`, separate archives/containers/servers/stores/artifacts | p1:141/1 standard+69 interactions; p4:141 standard+34 progress+8 demo PASS. p2 Web/p3 Core compiler SIGSEGV before browsers:372 cases initially unexecuted, no credit by absence |
| Current preparation controls/first missing browser executions | One unchanged p2 then p3 full owning partition, serial; p3 starts only after classification of the independent MCP reproduction | p2:141/1 standard+18 pane+43 linked; p3:142 standard+8 locale+17 workspace+2 title PASS. Both original compiler phases complete without signal; current scoped non-reproduction dispositions, not historical-waiver inheritance |
| Complete disjoint browser selection | Four standard shards plus every dedicated owning configuration exactly once, same source | **764 PASS/2 FAIL/766**, zero skipped/flaky/retries, no unexecuted owning suite. Composite of recorded executions, not one globally green campaign; owning9, targeted follow-ups and the final two trace-enabled performance observations overlap this inventory and are not added as unique cases |
| Current chat failure control | Exact original `chat.spec.ts` return-to-bottom case once, trace for observation |1/1 PASS, unchanged5s/<96px assertions. User-rule resolution limited to this case; original p1 remains failed |
| Current MCP failure control | Exact original `mobile-keyboard.spec.ts` integrated no-intercepted-API case once, trace for observation | **0 PASS/1 FAIL**, same4664pixel mismatch. Functional keyboard/focus/viewport/real-HTTP guards pass before the final image assertion. Reproduction remains OPEN |
| Final differential/performance | `node .docker/run-e2e.mjs e2e/qua02-differential.spec.ts e2e/performance.spec.ts --reporter=line,json --trace=on --max-failures=1` | **14/14 PASS**, one worker/zero retries,12 complete paired cases+two unchanged performance cases; no pageerrors/console errors/in-case429/5xx for the12 completed paired cases |

Before that final execution, Docker start fails because the planned private bridge was absent: container stays **created**, all14 cases unexecuted. Preserve the failed launch, recreate only the protocol's task-owned `Internal:true` network, and use a new container for the first actual execution above. This is a demonstrated preparation correction, not a product fix or non-reproduction acceptance.

Root runs separately from browser controls; final performance/captures run after all partitions stop. Serial controls isolate known-sensitive execution, but do not prove contention caused any incident. No full-root/browser replay until green. Historical QUA-01/MOD decisions and exactly three historical compiler acceptances remain unchanged; the earlier pilot collector SIGSEGV retains its separate signal-only disposition.

## Individual current visual review and measurements

[Individual24-pair decisions](./QUA-02.validation-20261116/review/individual-review.json.gz) bind each original/pair SHA256 and its own observation; the [coverage record](./QUA-02.validation-20261116/review/coverage.json.gz) binds the12 actual outcomes. Native cards, typography, wrapped selectors, collapsed navigation, routed settings and bottom terminal differ intentionally from Pi's compact controls, modal settings and terminal tabs. No pixel identity, font normalization, forced click, hidden notification/error, baseline update or comparator relaxation. Mobile viewport observations are not OS-keyboard/device certification or whole-UI perfection.

| Cell | Conversation | History | Appearance | Workspace |
|---|---|---|---|---|
|1440/light|[accepted](./QUA-02.validation-20261116/review/1440-light-conversation-pair.png)|[accepted](./QUA-02.validation-20261116/review/1440-light-history-pair.png)|[accepted](./QUA-02.validation-20261116/review/1440-light-settings-pair.png)|[accepted](./QUA-02.validation-20261116/review/1440-light-workspace-pair.png)|
|1440/dark|[accepted](./QUA-02.validation-20261116/review/1440-dark-conversation-pair.png)|[accepted](./QUA-02.validation-20261116/review/1440-dark-history-pair.png)|[accepted](./QUA-02.validation-20261116/review/1440-dark-settings-pair.png)|[accepted](./QUA-02.validation-20261116/review/1440-dark-workspace-pair.png)|
|820/light|[accepted](./QUA-02.validation-20261116/review/820-light-conversation-pair.png)|[accepted](./QUA-02.validation-20261116/review/820-light-history-pair.png)|[accepted](./QUA-02.validation-20261116/review/820-light-settings-pair.png)|[repaired/accepted](./QUA-02.validation-20261116/review/820-light-workspace-pair.png)|
|820/dark|[accepted](./QUA-02.validation-20261116/review/820-dark-conversation-pair.png)|[accepted](./QUA-02.validation-20261116/review/820-dark-history-pair.png)|[accepted](./QUA-02.validation-20261116/review/820-dark-settings-pair.png)|[repaired/accepted](./QUA-02.validation-20261116/review/820-dark-workspace-pair.png)|
|390/light|[accepted](./QUA-02.validation-20261116/review/390-light-conversation-pair.png)|[accepted](./QUA-02.validation-20261116/review/390-light-history-pair.png)|[accepted](./QUA-02.validation-20261116/review/390-light-settings-pair.png)|[repaired/accepted](./QUA-02.validation-20261116/review/390-light-workspace-pair.png)|
|390/dark|[accepted](./QUA-02.validation-20261116/review/390-dark-conversation-pair.png)|[accepted](./QUA-02.validation-20261116/review/390-dark-history-pair.png)|[accepted](./QUA-02.validation-20261116/review/390-dark-settings-pair.png)|[repaired/accepted](./QUA-02.validation-20261116/review/390-dark-workspace-pair.png)|

The four formerly occluded native states now show the full terminal, actual PTY marker/prompt and genuine pointer access, with the transient explorer absent. Desktop Files behavior and saved preference remain unchanged. The repair does not copy Pi's geometry or alter process/HTTP/trust authority. All20 other comparisons were examined again, not silently inherited from the pilot.

Fixed protocol predates execution and reuses the existing320-message/virtual-height>5000/mounted<45/cache-secret-exclusion/4000ms delayed-session and2500ms post-domcontentloaded visibility bounds, plus terminal lazy-load assertions. Traces observe **20 mounted messages before and after reload** and **647.368ms reload-start→visible-assertion-end**. One instrumented fixture-backed sample at auxiliary1280×720/light, not real-server latency, a percentile or a measured gain over the historical657.274ms sample.

| Exact current bundle observation | Bytes | Unchanged limit |
|---|---:|---:|
|Entry raw/gzip|509955 /150281|516096 /153600|
|Eager gzip|162529|184320|
|Largest async JS raw/gzip|1522924 /464126|1638400 /512000|
|Largest CSS raw|59213|65536|

All original budgets PASS in the final build;28 JS chunks. Entry `index-CcRTEYiv.js` SHA256 `e24a0032df7456a03604dd5c96d715d3be0ba5761c9e6f37020c499ac526800a`; full asset hashes, metrics and raw traces are indexed. Exact sizes are read from final-container build-output copies without patching generated files.

## Sole current blocker and minimal decision

`mobile-keyboard.spec.ts:287/333/82`, `keyboard-live-mcp-mobile-light.png`: [expected](./QUA-02.validation-20261116/review/mcp/expected.png), [first actual](./QUA-02.validation-20261116/review/mcp/first-actual.png), [recheck actual](./QUA-02.validation-20261116/review/mcp/recheck-actual.png), [recheck diff](./QUA-02.validation-20261116/review/mcp/recheck-diff.png). Both executions report4664pixels/4%, exceeding the unchanged2% comparator. Text, focus, controls and synthetic preview URL remain visible; that observation does **not** turn the reproduced comparison into PASS.

A bounded read-only trace observation checks whether the fixture's existing fractional-origin translation is invalidated by capture scrolling. It sees `translate:0px0.421875px` and stable late `.settings-view` scrollTop10240, but does not demonstrate that origin invariant breaking or establish a rendering cause. Stop this hypothesis; no CSS/reference/assertion or product change is justified by it.

The user has been asked for either **explicit acceptance of this bounded readable visual exception for the milestone, without reference update or test-PASS claim**, or a distinct targeted investigation. No reply/waiver is assumed. Until correction evidence or that explicit decision, QUA-02 and the goal remain **PARTIAL/active**; do not mark DONE from the14/14 or documentation alone.
