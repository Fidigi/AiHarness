# Configuring the package command

CLI and Web package install, check and update actions share Core's `npmCommand` policy. Put it in the independent agent directory's `settings.json` (`AI_HARNESS_AGENT_DIR` for CLI, `AI_HARNESS_DATA_DIR` for Server), or in an approved workspace's `.ai-harness/settings.json`:

```json
{
  "npmCommand": ["./npm-wrapper", "literal-prefix-argument"]
}
```

The first item is an executable, not a shell command. Remaining items are literal arguments before AiHarness's install/view arguments. A relative executable path resolves from the declaring settings directory; a bare name uses PATH. With no configured command, Core uses `npm`. The selected command also installs Git package dependencies; Git itself remains `git`.

## Selection and safety

- An eligible project command replaces the global command. Unapproved project settings are not opened. Invalid or unreadable winning/higher settings block execution without falling back to global/PATH; a clean approved project command may replace an invalid global layer.
- Arrays have 1–64 nonempty primitive-string items, at most 4,096 UTF-8 bytes each and 32 KiB total. Sparse arrays, numeric accessors/inherited slots, controls/format characters and an executable beginning with `-` are refused. Custom iterators are not executed.
- The declaring project—not the target package's scope—must remain canonical and authorized before each npm/Git process, including after a lock wait. Installing globally does not authorize a project-selected wrapper.
- CLI `--approve`/`-a` or an explicit session-only approval can authorize that exact source for the process without saving trust, even over a saved refusal. `--no-approve` takes priority over saved approval. Without an explicit choice, Core checks fresh saved trust at every process boundary; a default or cached allow is not an override.
- Server captures fresh eligible settings separately for each operation and accepts no HTTP command/trust override. Its project source always requires fresh saved approval. Concurrent workspace requests do not mutate a shared runner.

Catalogue reads and reloads remain passive. CLI `/reload` refreshes command selection; Server resolves it for every explicit operation. An admitted operation keeps its copied command but rechecks source authorization. Malformed command policy returns `INVALID_PLUGIN_NPM_COMMAND`; refused source authority returns `PROJECT_TRUST_REQUIRED`. Checks return fixed per-package error outcomes.

## Limits

The runner uses no shell, filters inherited secrets/Node/npm/Git configuration, ignores stdin, bounds output and deadlines, and preserves lifecycle-script suppression, staging, locks and rollback. Shell-looking prefix arguments remain literal. A wrapper is nevertheless privileged host code: it can implement its own behavior and is not sandboxed. Do not include secrets in arguments.

Trust checks are not an OS-atomic trust-read/spawn transaction or executable-byte pin. Revocation cannot withdraw an already running process. Linux process-tree behavior and disposable wrappers are tested; no cross-platform execution matrix or live registry endpoint is claimed.

See the [user guide](./user-guide.md) for package actions and the [French guide](../fr/npm-command.md) for the same policy.
