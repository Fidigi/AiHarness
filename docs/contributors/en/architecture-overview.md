# AiHarness Architecture — Overview and Core Foundation

## Table of Contents

- [Overview](#overview)
- [Shared contracts (packages/core)](#shared-contracts-packagescore)
  - [Versioned sessions](#versioned-sessions)
  - [Shared agent runtime](#shared-agent-runtime)
  - [Providers, multimodal and metadata](#providers-multimodal-and-metadata)
  - [Workspace boundary](#workspace-boundary)
- [CLI (packages/cli)](#cli-packagescli)

## Overview

AiHarness is a strict npm workspaces monorepo of TypeScript/ESM composed of four packages:

```text
packages/
├── core/       # Contracts, providers, sessions, agent runtime and workspace security
├── cli/        # ai-harness command and terminal interfaces
├── server/     # HTTP/SSE/WS API, detached runtimes and Web launcher
└── web/        # React/Vite application
```

```text
CLI ───────────────┐
                   ├──> @ai-harness/core
Express Server ───┘          ▲
        ▲                      │ types only
        └── HTTP/SSE ─── Web React
```

The CLI and server share Core’s JSONL format and tool loop. The browser never loads Node modules from Core: it imports only their types and communicates with the server.

For more details on server architecture, see [server-architecture.md](./server-architecture.md).
For more details on Web application, see [web-architecture.md](./web-architecture.md).

## Shared contracts (packages/core)

### Versioned sessions

`Session` currently uses schema v2. It notably preserves:

- text, image, reasoning, tool call/result blocks and command entries;
- model, provider, duration, agent and usage/cost per message;
- cwd, workspace, Git branch, branch relations and active leaf;
- shell commands and their context inclusion policy;
- compaction metadata and cumulative usage.

The runtime manipulates `Date`. `serializeSession()` converts them to ISO 8601 for the API and `deserializeSession()` hydrates them client-side. `JsonlSessionStore` also reads legacy unversioned files. Provider keys resembling secrets are removed before write or serialization.

A JSONL v2 journal contains `metadata`, `message`, `command`, `compaction`, `branch_summary`, `custom`, `custom_message`, `context_edit` and `loadout` entries. Compaction reduces effective history without deleting the journal. Private custom data and loadouts stay outside browser DTOs; see [session context state](../../ai/topics/session-context-state.md).

### Shared agent runtime

`packages/core/src/agent/` contains:

- `tool-loop.ts`: multi-turn model/tool loop shared by CLI and server;
- `runtime.ts`: detached executions, stop, pre-delta retry and steer/follow-up queues;
- `events.ts`: bounded session journal with strictly increasing sequences and replay.

A run snapshot includes its phase, workspace, queues, last sequence number, and any partial assistant message. Events cover lifecycle, deltas, tools, commands, retry, queues and compaction. The runtime also exposes exact tool selection by preset (chat-only, read-only, etc.) so execution and capabilities panel share the same list.

### Providers, multimodal and metadata

Built-in providers are OpenAI/Azure, Anthropic, Google Gemini/Vertex, AWS Bedrock, local OpenAI-compatible and mock. Tool calls are normalized as well as reasoning deltas explicitly provided and input/output/cache counters. Image blocks are adapted natively to OpenAI (image_url), Anthropic (base64 source) and Gemini (inlineData) dialects.

Core owns published metadata and adapter-owned declarations in `packages/core/src/providers/{model-metadata,provider-model-metadata,model-catalog}.ts`. CLI and Server reuse that assembly; `packages/server/src/runtime/model-catalog.ts` adds host discovery/cache, operator overrides and scoped activation. A declaration is not proof of credentials or account entitlement. Core provides `AiProvider.getAvailableModels()` for bounded OpenAI-compatible, Anthropic and Gemini discovery; Azure retains no generic discovery assumption. Shared custom provider/model, OAuth status, resource registry, tool setting and extension interaction contracts remain in `packages/core/src/types/index.ts`, with no Core dependency on Server or React.

### Workspace boundary

`packages/core/src/security/` provides:

- `WorkspaceManager`: tilde expansion, realpath canonicalization, allowed roots, type control, Git detection and worktree operations;
- `ProjectTrustManager`: atomically persisted v2 allow/refuse decisions, resolved from the nearest canonical ancestor; legacy allow-lists migrate on mutation.

Trust resolution gates execution separately from allowed-root validation. CLI can admit a resource-free folder for the current process without saving approval; protected project bodies stay gated by resource trust. Web execution retains its explicit operation-trust gate. Saved refusals, process overrides and fresh resource inspection remain authoritative. Resolution rejects traversal, escaping symlinks, and destinations outside allowed roots. See [workspace trust](../../ai/topics/security.md).

## CLI (packages/cli)

The CLI offers regular/fullscreen terminal, final-text print, JSON event and JSONL RPC modes. It orchestrates sessions, providers, tools, skills, prompts, extensions and project trust. The historical tool loop now delegates to Core's shared engine so CLI and Web have the same persistence and cancellation rules.

Project extensions remain blocked until trust is granted. The CLI retains terminal orchestration, while Core’s bounded `ExtensionModuleLoader` is shared with Server: it rejects symlinks/modules over 5 MiB and supports managed generations with atomic replacement. Web administers packages and explicitly loads activated extensions during resource reload, never during a simple GET or installation. Loaded modules are trusted Node code in the host process; the loader is not a security sandbox.
