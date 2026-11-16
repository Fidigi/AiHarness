# QUA-01 — post-IME frozen campaign, incomplete

**Status: PARTIAL; goal incomplete; audit39/43.** This receipt supersedes the [previous campaign](./QUA-01.integrated-20261116.md) as the latest executed-input authority, without transferring its passes or erasing any failure. The verified IME repair passes in the complete browser campaign. Root and browser gates still fail. This follow-up only preserves evidence and updates documentation; it performs no new test, diagnostic or mitigation.

## Frozen inputs

- Commit `9f675713c41d1b57f8156b2b7a42a8310a255622`; tree `d1d24bbb396344d61151235de76315538a8c9e12`. Clean checkout archived before execution, including accumulated fixture/reference repairs and the monotonic IME guard.
- Archive SHA-256 `f8c2b46466a0be672478723a17769c03260690c6bde7037a72cf5a36d2bfb52f`; isolated source `/tmp/aih-qua01-native-20261116/ime-integrated`.
- Test image `aih-qua01:native-ime-20261116`, immutable manifest `sha256:bb7fb54843773414206d8e23e202691948f28cb2bc5d9aff1ae1ef5501b63513`. All four executed gate build logs export this same manifest. Existing Linux amd64/Node24.15.0 Docker toolchain, unchanged flags/dependencies/deadlines/budgets.
- [Post-run source verification](./QUA-01.ime-integrated-20261116/source-verification.json.gz): all2,473 Git blobs and executable/symlink modes match, zero source drift. Git remains the source inventory; no additional exhaustive inventory.
- Disposable/synthetic HOME, accounts and stores; simulated upstreams and actual local process/HTTP/browser boundaries. No personal-store, real-account, pi/qwen-moe, host or Node/V8 intervention.

## Requirement audit

[Exact commands, timestamps and exits](./QUA-01.ime-integrated-20261116/commands.json.gz) bind every execution to the frozen directory and image. Each selected gate ran once, without automatic retry.

| Required gate | Official entry | Applicable result |
|---|---|---|
| Complete typechecks, including public parity types | `make typecheck` | **PASS**, exit0 |
| Public CLI/SDK parity | `make test-parity` | **435/435 PASS**, four files, exit0 |
| Complete root | `make test` | **FAIL**, Make exit2:11,679 PASS, two5s timeouts, one worker SIGSEGV;15 of11,696 declared cases have no completed result in the summary |
| All nine browsers | `make test-e2e E2E_ARGS='--all-suites --reporter=line,json'` | **764 PASS / 2 FAIL**, zero retries/skips/flaky; Make exit2 |
| Production build | `make build-prod` | **NOT RUN on9f675713**; previously announced, still outstanding |
| Native startup/operation smoke | Existing eight-control production smoke | **NOT RUN on9f675713**; previously announced, still outstanding |
| Remote CI, recorded separately | Existing workflow | **NOT OBSERVED / NOT CREDITED**; no push/dispatch or new hosting requirement |

Production and smoke passed on the earlier product version, not this one. Those results are not substituted here. Following failed root/browser gates and the user's elapsed-time concern, the assistant proposed preserving the bilan and pausing further execution; this receipt records that checkpoint, not a user waiver or completed qualification.

## Failed root: cause unknown, no native replay

The unchanged `packages/core/src/providers/openrouter-completions.test.ts:45` whole-case5s deadline fails for:

- `nvidia/nemotron-3-super-120b-a12b`
- `poolside/laguna-s-2.1:free`

Vitest also reports a worker **SIGSEGV during started state** while running `packages/core/src/tools/codemode-intrinsics.test.ts`. Its summary is657 passed files, one failed file and one worker error across659 files. Fifteen cases lack a completed result; they are not credited as passed or silently excluded. Full [root output](./QUA-01.ime-integrated-20261116/root.log.gz) is retained.

These are execution failures of undetermined cause, not demonstrated fixture/product defects. No relation between the timeouts, signal, prior incidents or IME change is established. There is no owning-file replay, runtime flag change, deadline increase, native diagnosis or new incident acceptance. The exactly three historical acceptances do not cover this signal. A native diagnostic investigation requires distinct explicit authorization; earlier bounded storage permission is not reused.

## Browser disposition

| Suite | PASS | FAIL |
|---|---:|---:|
| standard |566|1|
| interactions |69|0|
| locale |8|0|
| workspace |17|0|
| pane |18|0|
| linked |43|0|
| title |2|0|
| progress |33|1|
| demo |8|0|

All nine reports and the [dispatcher result](./QUA-01.ime-integrated-20261116/browser-suites.json.gz) are preserved. The reinforced CJK/IME case passes with retry0, as do the earlier nine maintained visual references. The two new failures remain unresolved:

1. `e2e/mcp-selection.spec.ts:28`: after navigation to `/settings`, the selected `Server details: Global configuration / local-tools` region is not found within the unchanged5s assertion. Later viewport/storage assertions are not reached. [Error context](./QUA-01.ime-integrated-20261116/mcp-error-context.md.gz). No causal fixture/product classification is demonstrated.
2. `e2e/tool-progress.spec.ts:308` through capture helper line253: `generic-progress-cancelled-mobile-dark.png` differs by2,107 pixels. [Expected](./QUA-01.ime-integrated-20261116/progress-expected.png), [actual](./QUA-01.ime-integrated-20261116/progress-actual.png), [diff](./QUA-01.ime-integrated-20261116/progress-diff.png) and [error context](./QUA-01.ime-integrated-20261116/progress-error-context.md.gz) are retained; the raw progress report includes the actual public-agent-state attachment. No reference replacement, tolerance change or causal visual explanation is claimed. Assertions following this failed capture are not credited.

No targeted rerun or new correction follows these two failures in this checkpoint. They remain failed native browser controls, not scope exclusions.

## Stop boundary and possible later execution

The user asked whether splitting/parallelizing could reduce elapsed time. The existing `.docker/e2e-suites.mjs` and CI workflow already provide four `--ci-partition=N/4` browser partitions. A future justified campaign can reuse those with identical frozen inputs and independent checkout/container/artifact/store ownership. Never run concurrent Make E2E targets in one shared checkout. Available CPU/memory and partition balance determine the benefit; no local or remote speedup has been measured here. Root remains sequential under its existing policy. This is not a new infrastructure project or a reason to rerun failed gates unchanged.

No complete rerun or Node/V8 investigation is initiated. Necessary remaining work is explicit: resolve the failed root/browser gates within authorization, then obtain all mandatory applicable evidence, including production and smoke, on coherent identified inputs. The earlier root pass and current browser improvements cannot be assembled into global success. Restricted native investigation needs a separate decision; no broader historical experiments are reopened. MOD-01/MOD-03 remain closed, and QUA-02/03/CLI-04 scope is unchanged.

[Artifact index](./QUA-01.ime-integrated-20261116/artifacts.json) contains compressed and uncompressed hashes for the full logs, reports and provenance, plus original PNG hashes. Documentation links/diffs and artifact integrity are checked before the evidence commit. This administrative preservation is not technical completion; QUA-01 and the active goal remain incomplete.
