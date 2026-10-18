# Installed-consumer child signal evidence

> **Status: PARTIAL — receipt delivered; full qualification FAILED** (2026-10-18)
>
> Narrow WEB-OPS-04 / A3-WEB-29 observational correction included with this record, parent `f11941a`. No native failure diagnosis or criterion/release closure.

## Contract

The private process helper from `tests/functional-parity/installed-executable.test.ts` is moved into `tests/functional-parity/installed-process.ts` so real child controls do not depend on the installed-consumer setup. Its default 20-second deadline, existing call-specific deadlines, combined 1 MiB byte limit, stdin/EPIPE handling, kill-on-failure behavior and exact `{ code, stdout, stderr }` result are preserved. Every existing installed assertion is unchanged.

On signalled close, it logs only a fixed `[installed-process] Native child termination.` message and the actual `{ code, signal }` to the **test runner** diagnostic channel. It does not mutate the captured child's stdout/stderr, append fake compiler output, expose argv/input/environment/output in that receipt, normalize success or change product APIs. Ordinary numeric exits emit no signal receipt. Existing startup errors keep their previous behavior; this increment does not claim new startup-error receipts.

The missing signal in the MCP parity failure remains unavailable. Future raw metadata cannot retrospectively determine its cause, nor establish that separate compiler, CLI worker or browser crashes share a cause.

## Differential evidence

| Run | Actual result | Evidence |
|---|---|---|
| Source extraction comparison against `f11941a` | Original function body/defaults and byte limit identical before adding the receipt (only module export added) | `/tmp/aih-a3-installed-receipt-extraction.log` |
| Original extracted runner plus four real-process controls, Docker overlay on `aih-a3-git-context:test` | **2 failures / 2 controls passed**, exit 1. Exact captured channels/null code pass; only receipt assertions fail | `/tmp/aih-a3-installed-receipt-red.{log,exit}` |
| Candidate runner, same controls/image | **4/4 passed**, exit 0. Actual SIGTERM/SIGINT receipts and ordinary exits 0/7; exact streams and legacy three-field result retained; fixed receipt excludes synthetic private data | `/tmp/aih-a3-installed-receipt-green.{log,exit}` |

No existing assertion, selector, snapshot, flag, retry, quota or deadline changed. These iteration overlays are not fresh qualification.

## Qualification

Three changed TypeScript inputs were frozen before the serial chain (`/tmp/aih-a3-installed-receipt-sources.sha256`):

```text
f2ab9010bc9cdf0f236ff5e478799cf1bd22a8d7f9d19fee73ba2f88c42469f4  tests/functional-parity/installed-executable.test.ts
4434832abe51704a78e3582fd0e26518a500e02038399101148b36c637c77060  tests/functional-parity/installed-process.ts
6a68252b4806618f56315cf6352b0e4fe5ba8f4b5da50da674c288dfc407f787  tests/functional-parity/installed-process.test.ts
```

The separately included SDK README remains `c34253aae578f995a8a1b9b62387deb8e65750b769b3db388524bab888935687`. All four hashes match actual image `sha256:6e55cb5acb9e2acba721027a91bd4d9d151bd4fad2411bd24201d38b00580e5e` and `.git` is absent (`/tmp/aih-a3-installed-receipt-image-source-check.log`).

| Gate | Actual result | Evidence |
|---|---|---|
| `make typecheck IMAGE_TYPECHECK=aih-a3-installed-receipt:test` | **Passed**, Make 0, all workspace and parity declarations; fresh image also runs 4/4 packaging and 19/19 dispatcher controls | `/tmp/aih-a3-installed-receipt-typecheck.{log,exit}` |
| Fresh independent native controls in that image | **4/4 passed**, exit 0 | `/tmp/aih-a3-installed-receipt-focused.{log,exit}` |
| `make test-parity IMAGE_TEST_RUN=aih-a3-installed-receipt:parity` | **3 files / 131 passed**, Make/runner 0; 111.22 s. All existing 101 installed consumers and 26 public goldens unchanged | `/tmp/aih-a3-installed-receipt-parity.{log,exit}` |
| `make test IMAGE_TEST_RUN=aih-a3-installed-receipt:full` | **FAILED**, 344 files / 5,164 tests passed, 1 file / 1 test failed; 801.54 s; Make 2 / runner 1. Existing `module-entry-process.test.ts`, `print: environment main, ordinary startup`: child code null / SIGSEGV at `invoke` line 27. This receipt comes from that leaf's existing runner, not the new installed helper. Entire installed consumer 101/101 and independent receipt controls 4/4 pass; no failed-case rerun or workaround | `/tmp/aih-a3-installed-receipt-full.{log,exit}` |

Typecheck, parity and full tags resolve to the same actual image ID, and final source/SDK manifest checks pass. The new full native SIGSEGV remains unexplained, not attributed to module selection, this extraction, Node version or a shared historical cause. The earlier four MCP failed commands and historical runtime failures remain failed evidence; current successful typecheck/parity runs do not diagnose or retrospectively replace them. E2E is not rerun by this private test-helper increment: its latest complete result remains 568 passed / 3 failed. Production/deployment, remote CI and physical qualification are not claimed.
