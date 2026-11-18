# Remediation 06 — timeout investigation and explicit qualification blocker

**Historical disposition:** the later [user non-reproduction instruction/remediation07](../remediation-07/README.md) supersedes the BLOCKED status below. These observations/receipts are preserved, not a current blocker.

This follows [source-6 complete gate failures](../remediation-05/README.md), not a new remediation implementation or a successful full-suite retry. No production/test repository file, dependency, runtime flag, assertion or deadline changed in this investigation. Only temporary Docker test overlays add numerical phase observations.

## PERF-02: the two root timeouts

The existing `openrouter-completions.test.ts` contains 386 cases. Two full-root cases exceeded their original5s budgets: `nvidia/nemotron-3-ultra-550b-a55b:free` and `prism-ml/ternary-bonsai-2-27b`. Each case already checks direct/mixed owners, chat/stream,108 whole requests, private tool/final replay, credential redaction, restart, edits/clones and compaction. No new acceptance test or relaxed deadline is needed. The missing evidence is **where** the original time was spent, not another unchanged pass.

A [temporary overlay generator](./make-openrouter-timing-diagnostic.mjs) instruments those existing cases with cumulative phase/wall/CPU observations and a4800ms observer under the unchanged5000ms deadline. It logs only public model IDs, enumerated phase labels, counts and numeric resource data, never request bodies/credentials. The checked-in application/test sources remain unchanged. Both frozen images receive identical diagnostic test bytes; the original test bytes are also identical before/after. [Hashes, immutable images and full observations](./openrouter-timing.json) identify the experiment.

| Selected existing case | Before PERF-02 (lot2b) | Current runtime (source6) |
|---|---:|---:|
| NVIDIA | 382.27ms | 386.95ms |
| Prism | 324.65ms | 332.75ms |

[Before log](./openrouter-timing-before.txt), [exit0](./openrouter-timing-before-exit.txt), [Docker state](./openrouter-timing-before-state.json); [after log](./openrouter-timing-after.txt), [exit0](./openrouter-timing-after-exit.txt), [Docker state](./openrouter-timing-after-state.json). Each image selects exactly two cases; **384 filter-unselected** cases are not coverage. Both run serially with `--network=none` against the existing loopback HTTP fixture and disposable stores/synthetic credentials, without personal stores or live-service modes.

The timeout is **not reproduced or explained**. These single isolated observations neither diagnose suite-order/load/engine behavior nor prove absence of a regression. There is no speedup claim. The original failed full-root receipt remains failed; no case or criterion closes from these observations. No speculative provider/metadata/timeout change follows them.

Reproduction from the checkout (Linux `/tmp`, Docker), preserving the emitted product in each image:

```bash
mkdir -p /tmp/architecture-remediation-05
node docs/audit/architecture/evidence/remediation-06/make-openrouter-timing-diagnostic.mjs
# For each immutable image in openrouter-timing.json:
# docker create --network=none IMAGE npm exec vitest -- run \
#   packages/core/src/providers/openrouter-completions.test.ts \
#   -t 'compares independently.*(nvidia/nemotron-3-ultra-550b-a55b:free|prism-ml/ternary-bonsai-2-27b)$'
# docker cp /tmp/architecture-remediation-05/openrouter-timing-diagnostic.test.ts \
#   CONTAINER:/app/packages/core/src/providers/openrouter-completions.test.ts
# docker start -a CONTAINER
```

## Blocking boundary / owner / resumption trigger

The audit remains unqualified. Its ten open criteria are now explicitly **BLOCKED**, not DONE, GAP ACCEPTED or abandoned. This is a shared **final-validation blocker**, not a claim that every individual implementation has a defect or that native instability caused the browser assertions/timeouts.

1. **Runner/toolchain owner:** investigate the actual native terminations. The strongest source boundary is the [manifest/lock-only `npm ci --ignore-scripts` segmentation fault](../remediation-05/dependency-diagnostic-build.txt), without any application execution. Production dependency installation remains failed. Resolve that outside an architecture-only product patch; do not silently change supported Node/JIT/dependencies, restart unrelated live containers or waive a gate.
2. **Owning validation/remediation owner:** preserve and investigate the two5s timeouts, two browser assertions, page/worker exits and empty-disposition CLI/compiler failures. The new diagnostics do not assign their causes. Propose a product correction only when an existing requirement and reproducer support it.
3. **Resumption trigger:** a supported runner/toolchain able to execute the unchanged required dependency/build steps, plus a concrete diagnostic/correction for the remaining failed acceptance; then validate actual current sources through the required Docker targets, without unchanged green-seeking retries or larger budgets.

There is no missing product decision to invent and no safe evidence-backed application change identified by this continuation. The goal stays open. Latest [status consistency](./status-consistency.json): six DONE/ten BLOCKED,37.5% closed; none of the ten criteria is waived.
