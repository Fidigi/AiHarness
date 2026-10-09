# Installed CLI and local archive contract

## Distribution boundary

`@ai-harness/core` and `@ai-harness/cli` are currently **private** npm packages. This prevents registry publication, not `npm pack` or installation of local archives. This guide proves the locally installed executable contract (CLI-RUN-01); it does **not** claim a published npm release, hosted download, global installation, or public-registry distribution. A criterion requiring public registry availability remains partial until a separately authorized release changes that distribution policy.

Do not remove `private`, change dependencies/engines/metadata, or publish merely to make this test pass. A genuine manifest blocker needs a coordinator-reviewed patch. Missing offline dependencies are not automatically manifest defects.

## What the regression proves

[`tests/functional-parity/installed-executable.test.ts`](../../../tests/functional-parity/installed-executable.test.ts) creates its artifact/build/consumer roots under the system temporary directory and asserts that the artifact root is outside the checkout. It:

1. Copies Core/CLI into an independent build tree, excluding existing `dist`, `node_modules`, and incremental build records. Runs each package's actual build script, not the root build/postbuild scripts.
2. Runs genuine `npm pack --json --offline --ignore-scripts` for both built packages. This is not a hand-made archive or `pack --dry-run`.
3. Installs literal absolute Core/CLI tarball paths in a disposable consumer with `npm install --offline --ignore-scripts --no-audit --no-fund --omit=dev`. A separate disposable package with pre/post-install scripts verifies that arbitrary dependency lifecycle scripts stay disabled.
4. Checks the installed Core/CLI directories are not symlinks, all installed links stay inside the consumer, and every packed `dist` file is byte-identical to the independently built artifact. npm's final consumer lock must resolve Core/CLI to the actual local archives.
5. Invokes **`ai-harness` through PATH**, with only the consumer's `.bin` ahead of Node/system directories. Verifies its real target, executable mode, and shebang. CLI probes do not launch a source file, `dist/index.js` directly, `tsx`, `npm link`, or a workspace alias.
6. Checks exact built-in help/version and unknown-option exit/stdout/stderr, user/trusted-project generated extension help, contributed values, and installed mock print/JSON/RPC. Existing reviewed protocol goldens and their narrow canonicalizer are reused unchanged; record order, values, framing, channels and exits remain assertions.
7. Runs Node and TypeScript NodeNext consumers of the installed public `@ai-harness/core` entry: fresh CommonJS entry reload with changed option metadata, a minimal useful session prompt/disposal, positive/rejected loader constructor calls, and the QuickJS isolation self-test.

Built-in `--help`/`--version` do not execute extensions. `--help-extensions` deliberately loads eligible code; project extensions need trust (`--approve` is process-only). Unknown flags can require extension discovery to distinguish contributed options, so this test does not promise they never execute eligible user code. Extensions are trusted host Node code, not sandboxed code.

## Exact offline dependency distinction

This is a hybrid **real copied installed dependencies + existing offline npm cache** proof, not a clean registry dependency-resolution proof:

- The production closure is copied from genuine installed packages in the Docker image, preserving nested versions and dereferencing copies. CLI-local installed dependencies must remain available: the root Chalk version can differ from the CLI's required version.
- Only those copied dependencies' genuine `node_modules/.package-lock.json` records seed the disposable consumer lock. Workspace dev/extraneous flags are removed because the new consumer declares those packages itself. No Core/CLI entry is seeded: npm must unpack both new archives and create their bin.
- `@types/node` and its required declarations support the small SDK type probe; the compiler stays a Docker test tool, not a claimed production dependency.
- `_cacache` from the already-existing npm cache is copied into the disposable cache. npm can reinstall copied dependencies owning bins (for example `which`) from those cached tarballs. Registry URLs in the copied lock/cache are cache keys; `--offline` plus Docker `--network none` prevents registry/network access. Nothing populates the cache from the network during validation.
- An offline image without that closure/cache fails rather than fabricating packages, changing archive manifests, silently enabling scripts, or falling back to online installation.

`AIH_INSTALLED_NPM_CACHE` selects the existing cache; otherwise the test uses the runner's home `.npm`. Optional `AIH_INSTALLED_EVIDENCE_DIR` must be outside the checkout and retains the complete Core/CLI pack file inventories, dependency source paths, actual install arguments/result and artifact roots. Temporary consumers are deleted after the suite.

## Runtime artifact inventory

Core's archive must include `dist/index.js`, emitted public declarations, the extension loader, `dist/tools/codemode.js` and `dist/tools/codemode-worker.js`. The worker source is emitted JavaScript containing the sandbox worker program; it is not a separate unbuilt TypeScript worker. The copied QuickJS packages contain their JS/WASM assets, which the installed public sandbox self-test actually resolves and runs without ambient Node/network/timer capabilities.

CLI's archive must include executable `dist/index.js`, emitted runtime modules and `scripts/copy-assets.mjs`. That script currently creates `dist` and applies mode `0755` to the bin; no missing CLI asset-copy operation has been reproduced. Core does not currently have a copy-assets script. No build-script change is required by this proof.

There is currently no narrow package `files` allowlist: npm also packs package source/tests, source/declaration maps and build metadata. The evidence inventory records these, rather than claiming a curated public release archive. Packaging cleanup and public publication are separate decisions.

## Focused Docker validation

Use an already provisioned offline worker image containing the candidate source, genuine installed production/development dependencies, CLI-local dependencies and a built Core entry for the existing invocation tests. Prepare it without network access; do not use the live dirty checkout as the consumer. The installed suite independently rebuilds Core/CLI even if the image has `dist` for the invocation suite.

```bash
docker run --name aih-installed-cli-proof --network none --read-only \
  --cpus=1 --memory=1536m \
  --tmpfs /tmp:rw,exec,size=768m \
  --tmpfs /app/node_modules/.vite-temp:rw,size=16m \
  --tmpfs /app/node_modules/.vite:rw,size=16m \
  -e HOME=/tmp/runner-home \
  -e AIH_INSTALLED_NPM_CACHE=/root/.npm \
  -e AIH_INSTALLED_REQUIRE_READ_ONLY_SOURCE=1 \
  --mount type=volume,source=aih-installed-cli-evidence,target=/evidence \
  -e AIH_INSTALLED_EVIDENCE_DIR=/evidence \
  ai-harness:installed-cli-worker \
  ./node_modules/.bin/vitest run \
  tests/functional-parity/installed-executable.test.ts \
  packages/cli/src/cli/invocation.test.ts --maxWorkers=1
```

The source/image filesystem is read-only; only disposable `/tmp`, bounded Vitest cache mounts and the evidence volume are writable. `AIH_INSTALLED_REQUIRE_READ_ONLY_SOURCE=1` additionally asserts that opening the existing server-owned entry for writing fails with `EROFS`, without writing any data or creating a source-tree probe. Each child has a combined 1 MiB stdout/stderr budget and deadline (20 seconds normally, 60 seconds for builds/install/type tools); setup and multi-process probes have separate bounded suite deadlines. No globals, production/native-PTY/full-parity runs or baseline updates are needed for this narrow contract. Keep the finished container while exporting `/evidence/inventory.json` with `docker cp`; the volume retains evidence after shutdown, unlike tmpfs. Remove the disposable container/volume when the review is complete.

Related: [public contract policy](./public-contract-policy.md), [extensions](./extensions-cli.md), [session SDK](./session-sdk.md), [French version](../fr/installed-cli.md).
