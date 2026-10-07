# AiHarness Public Contract Policy

## Purpose

AiHarness evaluates functional parity through behavior that it owns. A reference product may motivate a capability, but it does not define AiHarness package names, command spelling, JSON envelopes, session files, extension modules, or TypeScript declarations. Public probes must run without importing reference packages.

This policy covers the executable CLI, print output, JSON and RPC automation, the session journal, the extension API, and the exported `@ai-harness/core` entry point.

## Contract Families

| Family | Current contract | Compatibility marker |
|---|---|---|
| CLI invocation | `ai-harness` arguments, exit status, stdout and stderr roles | Package release version from `ai-harness --version` |
| Print mode | One final assistant response on stdout | CLI release and golden scenarios |
| JSON mode | LF-delimited lifecycle records | `session.version: 3` in the first record |
| RPC mode | Canonical `{type,id}` requests and correlated response/event records | Canonical envelope; no separate in-band version yet |
| Session persistence | AiHarness JSONL metadata and parent-linked entries | `SESSION_SCHEMA_VERSION` (`2`) |
| Extension factories | `ExtensionAPI`, registrations, hooks and lifecycle cleanup | `api.version` and `AI_HARNESS_EXTENSION_API_VERSION` (`1`) |
| Core entry point | Runtime values and TypeScript declarations exported by `@ai-harness/core` | `AI_HARNESS_CORE_API_VERSION` (`1`) |

The old RPC `{id,method,params}` envelope is migration input, not the preferred contract. Its fixture prevents accidental removal before an announced migration. It does not require new commands to support both shapes.

## Compatibility Rules

Within a current contract major version:

- additive optional fields, events, methods, and exports are allowed;
- existing required input and documented output meaning must remain stable;
- stdout framing and stream ordering must remain valid;
- persisted current and documented legacy data must remain readable;
- extensions must continue to receive an API version they can inspect before registering behavior;
- secrets must not become observable in output, fixtures, diagnostics, or session data.

A removal, rename, changed required type, incompatible event meaning, or unreadable persisted shape is a breaking change. It requires all applicable work in one delivery:

1. increment the owning contract marker or introduce explicit negotiation;
2. provide a bounded migration or a deliberate rejection with a stable diagnostic;
3. add positive and negative fixtures for old and new behavior;
4. update English and French documentation;
5. record the compatibility decision in the relevant audit or release notes.

Package semver and contract markers serve different purposes. A package release can change without changing an interface major, while one release may intentionally advance a specific persisted or wire contract.

## Output Channels

Print stdout contains only the final response. JSON and RPC stdout contain only LF-delimited JSON objects. Diagnostics, warnings, and accidental extension writes belong on stderr. A process exit code is part of the invocation contract.

Golden comparison canonicalizes only volatile values: temporary roots, UUIDs, timestamps, measured durations, generated workspace IDs, and JSON object-key order. It does not remove event order, record count, values, errors, usage, exit status, framing, or channel assignment.

## Functional-Parity Harness

The harness lives in `tests/functional-parity/` and is discovered by the root Vitest configuration. Its checked-in manifest maps scenarios to `CLI-RUN-*`, `CLI-SES-03–04`, `CLI-EXT-02`, and `CLI-AUT-*`. Coverage mapping means that a public boundary is exercised; it does not by itself mark every behavior inside an audit criterion complete.

The fixture groups are:

- process invocations for CLI parsing, print, package help, JSON, and RPC;
- positive and negative JSON/RPC transcripts, including stdout-noise isolation;
- current, legacy, branched, and malformed session JSONL;
- valid and invalid native extension modules plus one RPC interaction;
- positive and negative TypeScript probes and a built-package runtime probe.

The SDK probes resolve only the built `@ai-harness/core` package entry point. Extension fixtures receive the AiHarness factory argument and do not import another extension API. An automated import allowlist fails if a public fixture starts depending on another package interface.

Run the focused suite through Docker:

```bash
make test-parity
```

The same scenarios run under `make test`; `make typecheck` also type-checks the harness and compiles its positive/negative consumer probes during execution.

## Changing a Golden Contract

There is no implicit snapshot-update mode. To change a golden file:

1. identify whether the difference is semantic or merely volatile;
2. extend canonicalization only for a genuinely non-contractual value;
3. edit the smallest fixture deliberately;
4. inspect the complete positive and negative diff;
5. run `make test-parity`, then the validation required by the project map;
6. document a breaking change or migration when the old behavior was public.

Do not copy outputs, schemas, declarations, or fixtures from a reference package. Express the desired behavior through AiHarness inputs and expected AiHarness results.

## Related Documentation

- [CLI extension development](./extensions-cli.md)
- [Architecture overview](./architecture-overview.md)
- [AI-agent CLI reference](../../ai/topics/cli-reference.md)
- [Sessions and persistence](../../ai/topics/sessions.md)
