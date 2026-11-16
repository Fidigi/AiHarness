# QUA-01 — native closure with explicit non-reproduction acceptance

**DONE under the user's explicit incident-resolution decision; not an all-green original execution.** The six native requirements below are satisfied by the frozen-product campaign, applicable follow-up controls and the [dated five-incident acceptance](./QUA-01.nonreproduction-acceptance-20261116.json). No mandatory native work remains under that decision. Audit advances39→40/43; CLI-04, QUA-02 and QUA-03 remain PARTIAL. Remote CI is separately **not observed/not credited**.

## Authority and coherent product

The user explicitly authorized necessary investigations, then instructed that a non-reproduced bug be considered corrected/OK without requiring a code fix. This is a **new explicit decision**, separate from the three unchanged compiler-repair acceptances; it supersedes the requirement for further corrective work for the five actually rechecked current incidents only. Original measurements and unknown causes remain. The [failed campaign receipt](./QUA-01.ime-integrated-20261116.md), [preceding IME repair](./QUA-01.integrated-20261116.md), [initial campaign](./QUA-01.native-20261116.md) and their artifacts remain authoritative for their own executions.

- Frozen product/test/build commit: `9f675713c41d1b57f8156b2b7a42a8310a255622`; tree `d1d24bbb396344d61151235de76315538a8c9e12`.
- Archive SHA-256 `f8c2b46466a0be672478723a17769c03260690c6bde7037a72cf5a36d2bfb52f`; isolated source `/tmp/aih-qua01-native-20261116/ime-integrated`.
- Test image: `aih-qua01:native-ime-20261116`, `sha256:bb7fb54843773414206d8e23e202691948f28cb2bc5d9aff1ae1ef5501b63513`, Linux amd64/Node24.15.0.
- Production image built from that same source: `aih-qua01:native-ime-prod-20261116`, `sha256:43207c86c476b431cea9c26bd1ff78fa2a114acea3f7b34c162aa49a19f76f39`, Node26.13.1/UID999.
- [Final source verification](./QUA-01.closure-20261116/source-verification.json.gz): all2,473 Git blobs and executable/symlink modes still match after execution; archive hash rechecked. Delivery after9f675713 changes only excluded `docs/` paths, not product, tests, build configuration or nested package documentation. The closing commit is documentary only.
- Rechecks use the same immutable test image. Only the native worker observation overlays its existing test file with phase logging; its [exact source](./QUA-01.closure-20261116/codemode-intrinsics.test.ts.gz) and preparation script are retained. All assertions, workloads and deadlines remain; no production file is overlaid. The other rechecks use unchanged files/configurations/references.

## Requirement-by-requirement completion audit

The [original commands](./QUA-01.ime-integrated-20261116/commands.json.gz) record the full type/parity/root/browser campaign. [Follow-up commands, timestamps and exits](./QUA-01.closure-20261116/commands.json.gz) record each explicitly selected diagnostic/recheck and the previously outstanding production/smoke gates. No command is counted twice as independent coverage.

| Mandatory native requirement | Applicable evidence on9f675713 | Final disposition |
|---|---|---|
| Complete types, including public parity types | Official Docker `make typecheck`, exit0; [full log](./QUA-01.ime-integrated-20261116/typecheck.log.gz) | **PASS** |
| Public CLI/SDK and installed parity | Official `make test-parity`,435/435, four files, exit0; [full log](./QUA-01.ime-integrated-20261116/parity.log.gz) | **PASS** |
| Complete root | Official `make test` executed659 files/11,696 declared cases:11,679 PASS, two timeouts, one worker error and15 cases without completed results. Actual failed model cases then2/2 PASS; complete affected worker file59/59 PASS with phase instrumentation | **SATISFIED WITH EXPLICIT NON-REPRODUCTION ACCEPTANCE** for its three incidents; original Make exit2 retained, not rewritten to zero |
| All nine browser suites | Original complete campaign764 PASS/2 FAIL, zero retries/skips/flaky. Same-source MCP original case1/1 and original ordered progress variants4/4 PASS, including previously unreached assertions | **SATISFIED WITH EXPLICIT NON-REPRODUCTION ACCEPTANCE** for its two incidents; original Make exit2 retained |
| Production build | Official `make build-prod` on the same frozen directory, exit0; [full log](./QUA-01.closure-20261116/ime-integrated-production.log.gz), immutable production image above | **PASS**, current source, not transferred from an earlier product |
| Native startup/operation | Unchanged eight-control production smoke, network-none/non-root Docker, exit0; [full log](./QUA-01.closure-20261116/ime-integrated-smoke.log.gz) | **PASS** |
| Remote CI, separately recorded | No dispatch/push or observed workflow result | **NOT OBSERVED / NOT CREDITED**, unchanged native-scope contract; no new hosting prerequisite |

All original browser suites ran: standard566/1, interactions69/0, locale8/0, workspace17/0, pane18/0, linked43/0, title2/0, progress33/1 and demo8/0. The five focused browser passes overlap those original cases and are **not** added to764 to claim769 unique cases or a new766/766 integrated run. Similarly, root follow-up counts overlap the original root and are not a replacement full-root pass.

## Bounded incident work and acceptance

- **Native SIGSEGV:** one authorized owning-file observation,59/59 PASS in4.93s. Existing physical-lifetime assertions plus markers record176 workers created/exited and none left live. Phase logging perturbs timing; no original crash cause or mitigation is established. No repeated native campaign follows.
- **Two OpenRouter timeouts:** precisely `nvidia/nemotron-3-super-120b-a12b` and `poolside/laguna-s-2.1:free` pass uninstrumented with unchanged5s deadlines. The same command selects2 cases and filters384; it is not a new386-case or root pass. No storage reconfiguration, new journal observation or automatic retry.
- **MCP reload:** the original error context shows the Settings translation loading boundary, not an already-mounted selected-detail panel. The unchanged complete case passes1/1, including selection persistence, restored viewport and no implicit MCP execution. No loader/selection defect or fix is claimed.
- **Mobile progress:** the retained failed actual image contains two “Trop de requêtes” notifications overlapping the card. It is not grounds for replacing a baseline. All four original ordered live-phase variants pass, including mobile-dark cancellation and later clearing/reload/storage assertions, without changes to references, masks or tolerances. The original throttling cause remains unproved.

The two browser rechecks ran concurrently in separate containers, with separate servers/stores/artifacts and the same image. Docker reported28 CPUs and33,540,456,448 bytes total memory; this is capacity metadata, not an availability/performance guarantee. Overlapping command timestamps are retained. Root/native observation stayed separate. Existing four CI partitions remain available for future qualification; no new infrastructure or full-partition speedup claim is introduced.

The [acceptance record](./QUA-01.nonreproduction-acceptance-20261116.json) individually maps all five failures to actual successful rechecks and the user's explicit disposition. It does not infer acceptance of untested historical incidents. All earlier failures and exactly the original three compiler-repair acceptance entries remain unchanged; the new decision is separately recorded, not an implicit extension of them.

## Production smoke and limits

The unchanged smoke script SHA-256 is `80068abef7f7aa79feb53189db5113833d38414f22c26e6410f8b533f734205b`. Eight controls pass: UID999; CLI help outside checkout; mock CLI turn; public SDK turn/disposal; production QuickJS worker; native PTY UTF-8/exit; PATH Web launcher with actual HTTP health/index/JavaScript; graceful SIGTERM. Default sandbox ceilings remain10s/32MiB/262,144-byte stack/10,000 interrupts/64 calls/four concurrent calls and existing byte budgets. No real account or upstream service is used.

Docker-only tests/types, synthetic credentials/disposable stores, unchanged runtime/compiler flags, deadlines, assertions and existing security boundaries are preserved. No product changes follow9f675713. MOD-01/MOD-03 are not reopened; provider/platform/differential/release/installation work is not added. This closes the approved native criterion under the explicit incident acceptance, not remote CI, complete Pi parity, service-account interoperability, physical-platform or distribution acceptance.

[Artifact index](./QUA-01.closure-20261116/artifacts.json) hashes full follow-up logs/reports, source/image/container provenance, temporary instrumentation and exact scripts. Preceding failed artifacts remain in their original indexed folders. Documentation links, artifact hashes, unchanged historical acceptance and current criterion counts are verified before the coherent documentation/evidence commit and goal completion.
