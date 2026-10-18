# Checkout Git metadata exclusion from Docker context

> **Status: PARTIAL — context correction qualified** (2026-10-18)
>
> Narrow WEB-OPS-04 / A3-WEB-29 correction included with this record, parent `3f63f11`. No criterion closure, native crash diagnosis or release qualification.

## Contract

`.dockerignore` excludes the checkout `.git` name, whether it is a repository directory or worktree pointer file. This prevents staging/committing excluded documentation from altering copied Git metadata in either test or production builds. It does not exclude `.github`, change runtime Git tooling or remove Git repositories created by tests at runtime.

`.docker/test-build.test.mjs` checks `lstat('/app/.git')` rejects with ENOENT in the actual filtered image. Using `lstat` also rejects an accidentally copied symlink. The existing three packaging/emitted/public-help controls and nineteen dispatcher controls remain intact. Dockerfiles, dependencies, runtime/browser flags, retries, deadlines, quotas, snapshots and suite ownership are unchanged.

This corrects the context drift observed during the preceding MCP increment; it does not relabel that run as fully frozen. Its typecheck, parity, full and E2E gates remain failed. The preceding two images' 2,186 conserved non-Git/non-node_modules application files are evidence of equal product bytes, not equal whole context.

## Differential evidence

| Run | Actual result | Evidence |
|---|---|---|
| Parent `aih-a3-mcp-pattern:full`, only updated build-control file overlaid | **1 new failure / 3 unchanged controls passed**, exit 1. Checkout Git directory was present | `/tmp/aih-a3-git-context-red-directory.{log,exit}` |
| Same parent, synthetic worktree pointer in an unmounted disposable container | **1 new failure / 3 unchanged controls passed**, exit 1. Pointer file was present | `/tmp/aih-a3-git-context-red-pointer.{log,exit}` |

Both RED failures are the expected missing ENOENT rejection; emitted imports/declarations and outside-checkout CLI help pass. Pointer setup removes metadata only inside the disposable container, never the host checkout. This is causal guard evidence, not evidence about any native termination.

## Qualification

The two changed inputs were frozen before qualification (`/tmp/aih-a3-git-context-sources.sha256`):

```text
3804afb3494f617273a6c1816789723e4602a752b89a263084f7424b1b6dea95  .dockerignore
be14d16138e9fa579e97439effb62bf877d2afca3c85da767157afd6706469af  .docker/test-build.test.mjs
```

The separately included SDK README remains `c34253aae578f995a8a1b9b62387deb8e65750b769b3db388524bab888935687`. All three hashes match the actual built image (`/tmp/aih-a3-git-context-image-inputs.sha256`).

| Gate | Actual result | Evidence |
|---|---|---|
| `make build-test IMAGE_TEST=aih-a3-git-context:test` | **Passed**, Make 0. Fresh COPY and compile; actual filtered-context packaging **4/4**, dispatcher **19/19**. `.git` absent and `.github/workflows/ci.yml` present | `/tmp/aih-a3-git-context-build-test.{log,exit}` |
| `make build-prod IMAGE_PROD=aih-a3-git-context:prod` | **Passed**, Make 0. Fresh builder COPY and complete Core/CLI/Server/Web compile/bundle budgets; final production image is byte-identical to the preceding production image, `sha256:5f55fafc405ac04cff218e6adf15ba6e5d6614f4f21d833ba2ee0d715bbb0dca` | `/tmp/aih-a3-git-context-prod.{log,exit}` |
| `make build-test IMAGE_TEST=aih-a3-git-context:after-docs` after staging excluded documentation | **Passed**, Make 0; Git index demonstrably changed, both frozen build inputs and SDK README stayed identical. All fourteen cacheable steps including COPY hit cache; before/after actual image ID is **`sha256:885300172b8b848899e5b3426d07fa257a49a24965eda91ee7d56dd1ebf59acb`**. This is identity proof, not a second execution of cached tests | `/tmp/aih-a3-git-context-{before,after}-staging-index.sha256`, `/tmp/aih-a3-git-context-{before,after}-docs-image.txt`, `/tmp/aih-a3-git-context-after-docs.{log,exit}` |

This validation is specific to build-context exclusion. It does not rerun or replace the MCP increment's failed typecheck/parity/full/E2E gates, and production success does not diagnose any earlier abort.
