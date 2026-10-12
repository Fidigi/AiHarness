# Static Demonstration

> **Navigation:** See [`project-map.md`](../project-map.md) for repository boundaries and Docker validation. The real application architecture remains in [`web-app-architecture.md`](./web-app-architecture.md).

## Purpose and boundary

`demo/` is an independently deployable AiHarness-owned React/Vite static application, not a screenshot or a second server runtime. It demonstrates synthetic models, tools, conversations, source files, Git changes and terminal output without an account, provider credential or backend. It intentionally does not import `App`, the API client, session store, Core runtime, Node tools or PTY client.

Browser-safe product reuse:

- `MarkdownContent` / `MarkdownContentRenderer` for sanitized Markdown and lazy rich rendering;
- `I18nProvider` for that renderer's existing translated controls;
- `composerKeySubmits` for IME-safe Ctrl/Command+Enter behavior;
- `useFocusTrap` for Reset dialog Escape, Tab cycling and invoker restoration;
- Core `Message` and `ModelCatalogEntry` as erased TypeScript contracts.

The demo shell is English. It does not claim complete product settings/localization coverage. All fixtures are authored and synthetic; no real conversation capture, session JSONL, credential, personal path or host output is bundled. The virtual `/demo/garden-board` path is a label, never host authority.

## Main Entry Points

| Path | Ownership |
|---|---|
| `demo/src/App.tsx`, `demo/src/{state,fixtures}.ts` | Synthetic UI, bounded memory state and authored fixtures; `App.tsx` is the UI entry |
| `demo/scripts/{build,artifact,serve}.mjs` | Base-safe static assets, bounded artifact validation and whitelist preview |
| `demo/run-docker.sh`, `demo/scripts/{validate,export}.sh` | Isolated Docker validation and generated-output publication |
| `.github/workflows/demo-pages.yml` | Build-only PR validation and separately admitted Pages deployment |

## Demonstrated behavior

| Surface | Working behavior | Explicit limitation |
|---|---|---|
| Chat | Two initial conversations, local new sessions, model selection, bounded prompt submission, read/bash result disclosures, fixed response replay, Stop before completion | Responses do not interpret input or invoke an LLM; no real streaming or detached run |
| Models | Two invented mock catalogue entries and per-session selection | Context/capability labels are illustrative; no provider discovery, prices, credentials or sign-in |
| Tools | `read`, `edit`, `bash` toggles affect simulated tool results and fixed edit preview | Not a real registry, MCP host, QuickJS engine or execution permission |
| Files | Five bundled synthetic files, source/Markdown/image preview | No host browsing, upload or arbitrary editing |
| Git | Preview/revert welcome-line change, shared file/diff/terminal status | No real repository, subprocess, commit or push |
| Terminal | Exact `help`, `pwd`, `ls`, `cat README.md`, `git status`, `git diff`, `npm test` fixture outputs; clear history | Arbitrary commands, paths, operators and substitutions are refused, not executed; independent from Chat's bash toggle |
| Appearance | Light/Dark, responsive desktop/mobile layouts, semantic keyboard-accessible controls | Theme is temporary, not a saved production preference |

All prompts, sessions, toggles, terminal history and edits live only in React memory. Reload resets them. Limits are 12 sessions, 80 recent messages per session, 2,000 prompt characters, 200 command characters and 20 terminal history entries. Reset explicitly confirms discarding temporary state. Browser storage is not used for prompts or credentials; the shared locale provider may read an existing non-secret locale preference. Visitors are told not to enter private information.

## Build, base and static hosting

No package or dependency addition is necessary. The demo uses the root lockfile's existing React, Vite, TypeScript, Playwright and Markdown dependencies. It is not a new npm workspace. Run from the repository root, with Docker available:

```bash
# Builds the repository test image, unit-tests/typechecks/builds the demo,
# runs the isolated Chromium suite and exports demo/dist and test evidence.
bash demo/run-docker.sh

# A deeply nested base is also supported; slash termination is mandatory.
DEMO_BASE=/preview/AiHarness/ bash demo/run-docker.sh

# Generate baselines only after intentional UI changes, then review and rerun
# without --update-snapshots. No retries or relaxed screenshot tolerances.
bash demo/run-docker.sh --update-snapshots=all
```

`demo/scripts/build.mjs` validates `DEMO_BASE`, builds Vite, generates `.nojekyll`, `demo-manifest.json` and a scoped service worker, and validates the entire artifact. After successful validation, the Docker helper copies into a fresh staging directory and replaces only generated `demo/dist/`; it never merges old hashed chunks. Required publication failure fails the command. An original build/test failure retains its exact exit code and does not publish a failed build. Reports are optional. Linked destinations/children and hardlinked files are rejected rather than followed. Explicit snapshot updates export only added or byte-changed, bounded demo PNGs, never an old baseline tree. `/` and slash-delimited alphanumeric/underscore/hyphen segments are allowed. URLs, missing leading/trailing slash, dot segments, encoded input, duplicate slashes, backslashes, fragments, queries and shell-shaped values fail closed. Invalid repository identities or unsupported repository-name characters likewise fail before deployment.

Upload **the contents of `demo/dist/`** to the configured base, not the source directory or the repository. The manifest records the base, synthetic marker, content-derived revision and asset inventory. Script, favicon, stylesheet, font, image, lazy-chunk and service-worker URLs are base-relative. Hash routes such as `/AiHarness/#/files/workspace-review` need no server history fallback. A bare `/AiHarness/` entry and the base's `index.html` must be served by the static host. The trailing-slash URL is canonical. Root and deeply nested builds are unit-tested; the browser suite uses the configured base.

For a local static preview after the helper completes (serving is not a host-side test):

```bash
# Use a disposable container and the already generated artifact. This helper
# binds loopback by default; DEMO_HOST explicitly enables Docker port forwarding.
docker run --rm -p 127.0.0.1:4173:4173 -e DEMO_HOST=0.0.0.0 \
  -v "$PWD/demo:/app/demo:ro" -w /app node:26-bookworm-slim \
  node demo/scripts/serve.mjs
```

Open `http://127.0.0.1:4173/AiHarness/` for the default helper base. `serve.mjs` is a whitelist-only development static host, not a backend: unknown paths and `/api/*` return 404 and non-GET/HEAD methods return 405. Use the generated bundle on a normal HTTPS static host for production; no Node process is needed there.

## Offline and network policy

The HTML CSP forbids connections (`connect-src 'none'`), object/embed content and form submissions, and restricts scripts/fonts/images/workers to local static assets. No external CDN, model API, analytics, fetch-based mock server or credentials are needed.

The generated service worker precaches **all** public assets, including lazy Markdown/diagram chunks and fonts. “Offline ready” appears only after installation. Offline interactions and reload then work without a backend. First load still requires the static host, HTTPS or localhost, and a browser with service-worker/cache support. Failed installation is reported rather than claiming offline reload. No session/prompt/API response is cached. Fetch handling serves only enumerated same-origin assets and the exact base entry, and never substitutes the shell for arbitrary routes. Cache cleanup removes only older revisions belonging to this demo's base-derived prefix, not another app's caches. Browser “clear site data” removes the asset cache.

## GitHub Pages workflow

`.github/workflows/demo-pages.yml` builds and tests pull requests, relevant main-branch pushes and manual dispatches in Docker. It derives `/AiHarness/` from `GITHUB_REPOSITORY` (or `/` for an owner/organization `*.github.io` site), validates it, and uploads only the validated static output using `actions/upload-pages-artifact`. It separately uploads Playwright evidence for seven days.

Safety properties:

- Top-level authority is `contents: read`; checkout does not persist Git credentials.
- No `pull_request_target`, deployment secret or environment authority is given to PR code.
- Only a successful build on `refs/heads/main`, for a push or a manual dispatch with `deploy: true`, enters the deployment job.
- Only that job receives `pages: write` and `id-token: write`, in the `github-pages` environment; it deploys the already-built artifact, never checks out/runs application code.
- Per-ref concurrency does not cancel an in-flight deployment. Both jobs have bounded timeouts.
- Tests have one browser worker, zero retries and the established 2% visual ceiling; bundle checks retain the real Web entry/eager/async/CSS ceilings (150/180/500 KiB gzip, 504/1,600 KiB raw JS, 64 KiB raw CSS). The complete offline artifact is additionally capped at 10 MiB.

The repository owner must already have GitHub Pages configured to use **GitHub Actions**, and may configure environment approvals. This implementation does **not** change GitHub settings, enable Pages automatically, push commits or deploy remotely during local validation. Custom-domain/root-base arrangements need an explicitly validated build base rather than silently assuming a repository path. Workflow syntax/policy and its Docker build/test/export command are tested locally; an actual GitHub-hosted deployment has not been performed.

## Validation evidence and maintenance

- `demo/tests/demo.test.mjs`: strict bases/Pages identity; representative known-secret-shape positive and negative cases; synthetic fixture credential-field checks; fixed edit/diff/terminal refusal; bounded local turns; real `/` and `/preview/AiHarness/` builds; exact push/PR dependency triggers and positive/negative deployment authority checks. Secret scanning is supplemental, not proof of detecting arbitrary credentials; authored fixture provenance, static dependencies and absence of credential inputs are the primary boundary.
- `demo/tests/export.test.mjs`: disposable filesystem publication and Docker-command fault injection inside Docker, exact failure codes, required/optional export behavior, stale-chunk removal, link/size/depth rejection and baseline delta/concurrent-preservation tests. The normal helper itself exercises actual Docker build/create/start/copy/publication.
- `e2e/demo.spec.ts` using `demo/playwright.config.ts`: static request/base confinement and missing-route checks; models/tools/sessions and injection-as-text; file/image/Git/terminal flows; offline reload with all views; Stop; hash restoration; Reset keyboard/focus behavior.
- Four Light/Dark desktop/mobile journeys run axe (WCAG 2/2.1 A/AA) and horizontal-overflow checks on Chat, Files, Git, Terminal, Models, Tools and Reset. Twenty-eight Docker-generated reviewed baselines live under `demo/visual-baselines/`.
- The isolated configuration starts only `serve.mjs`; it does not start Express, Vite's production application, any model, a shell tool or a real workspace. The normal application suite skips these eight static-host cases rather than mistakenly running them against its backend. Successful visual comparisons also retain 28 current captures in generated test results for review. Current repository font policy is tested in Docker.
- `demo/run-docker.sh` keeps output/report/snapshots under owned `demo/` paths, uses uniquely named image/container resources and preserves the original failed-command exit code. Required dist or requested delta export failure propagates after successful validation; optional report export does not change the result. Snapshot deltas are copied back only on an explicit update invocation. The CI command does not update them. Publication assumes a trusted, nonconcurrently-mutated host checkout: link rejection and stable bounded container reads are not a hostile-host race-proof sandbox. Generated directory replacement uses two renames (with rollback on the second failure), not an atomic exchange; do not concurrently publish the same output directory.

When fixtures change, keep file/Git/terminal projections coherent, ensure all data is synthetic, run the artifact scanner and review the four visual variants. Do not add a live API path, credential form, unrestricted command matcher, local persistence of prompts, or external asset dependency.

## Common Changes

- Change fixture behavior in `demo/src/{fixtures,state}.ts` together with the Files/Git/Terminal projections in `App.tsx`; preserve authored synthetic data, bounded memory and exact command refusal.
- Change bases/assets in `demo/scripts/{base-path,build,artifact}.mjs`; rerun the Docker helper at `/`, `/AiHarness/` and a deep base, including offline lazy views and actual exported-artifact validation.
- Change UI or shared Markdown/focus/fonts: generate captures in Docker, inspect every changed capture and rerun without updates. Never relax budgets or screenshot tolerances.
- Change deployment policy in `.github/workflows/demo-pages.yml` with the exact parsed policy/truth-table assertions in `demo/tests/demo.test.mjs`; local proof does not authorize changing GitHub settings or remote deployment.

## Related Domains

- [Production Web architecture](./web-app-architecture.md) — reused renderer/focus boundaries, not a production demo mode.
- [Security](./security.md) — real workspace/credential authority remains absent from the demo.
- User walkthroughs: [English](../../users/en/static-demo.md) / [French](../../users/fr/static-demo.md).
