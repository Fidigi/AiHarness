# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A new `@ai-harness/server` package with an Express API, health checks, provider configuration, persistent session routes, and production static Web serving.
- The `ai-harness-web` launcher, which serves the API and built React application from one process and supports configurable host, port, and browser opening.
- Real provider integrations for OpenAI, Anthropic, Google Gemini, Azure OpenAI, Google Vertex AI, AWS Bedrock, and local OpenAI-compatible servers, plus a mock provider for development and tests.
- Streaming chat over Server-Sent Events and WebSocket, including usage metadata, cancellation, retries, and normalized model tool calls.
- JSONL session persistence shared by the CLI and server, with metadata, message, compaction, and branch-summary entries.
- Session branching, cloning, tree navigation, deletion with forks, summaries, token estimation, and context compaction.
- A fullscreen terminal interface with transcript scrolling, history, completion, external-editor integration, themes, and extension panels.
- CLI commands for session inspection and naming, search, import/export, branching, compaction, sharing, bug reports, provider login, reasoning level, tools, extensions, trust, and resource reloads.
- Session exports in JSON, JSONL, Markdown, and standalone HTML formats.
- A JSONL stdin/stdout RPC mode for headless session, provider, and chat automation.
- A CLI extension system supporting commands, tools, providers, text UI panels, lifecycle events, cleanup, and transforming or cancellable hooks.
- Automatic model tool execution with persisted tool calls/results, cancellation support, and a bounded execution loop.
- Markdown skill and prompt discovery from user and project directories, including prompt arguments and model-invocable skills.
- Project trust management for executable project extensions and OAuth device-flow support for providers.
- Server-backed Web session hydration and persistence, provider settings, SSE/WebSocket selection, authentication token handling, light/dark themes, and responsive layouts.
- Expiring public session links and encrypted-at-rest provider credential storage when a master key is configured.
- Optional user and administrator Bearer authentication for API and credential-management operations.
- Docker test and production images, a non-root production runtime, health checks, and Make targets for containerized validation and lockfile generation.
- Expanded Vitest coverage across all four packages and Playwright coverage for primary Web journeys, responsive layouts, unavailable APIs, and basic accessibility.
- User, architecture, extension, containerization, and AI-agent project documentation.

### Changed

- Migrated repository tooling to npm 12 workspaces with a single root `package-lock.json` as the dependency source of truth.
- Updated the supported runtime to Node.js 22.22.2+, 24.15.0+, or 26+, and refreshed TypeScript, Vitest, Playwright, React, Vite, Zustand, and related dependencies.
- Reworked the provider contract to return structured responses, expose usage and tool calls, accept chat options and abort signals, and support native streaming.
- Replaced in-memory-only sessions with asynchronous persistence-aware session management while retaining an explicit no-session CLI mode.
- Expanded the CLI from a basic command shell into regular, fullscreen, and RPC execution modes.
- Made the server the source of truth for Web sessions and moved real Web provider calls behind the server API.
- Updated build scripts so shared core artifacts are built before dependent packages and executable entry points receive the required permissions.

### Security

- The server binds to loopback by default and supports separate user and administrator authentication tokens.
- Web credentials can be encrypted before persistence and remain memory-only when no master key is configured.
- Project extensions require explicit trust, while user-requested extension paths remain opt-in.
- HTML exports and public share pages escape conversation content before rendering.

### Removed

- Removed the package-local core lockfile in favor of the single npm workspace lockfile at the repository root.
- Removed the obsolete roadmap checklist that listed already implemented features as planned work.

## [0.1.0] - 2026-09-29

### Added

- Initial TypeScript monorepo with shared core, CLI, and React Web packages.
- Shared message, session, provider, prompt, skill, keybinding, and application configuration types.
- Stub OpenAI and Anthropic providers with simulated streaming.
- In-memory session management.
- Basic CLI commands and readline terminal interface.
- Initial Web chat, sidebar, settings, Zustand store, and styling.
- Vitest and Playwright test infrastructure.
