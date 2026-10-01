# 🚀 AiHarness

[![CI](https://github.com/Fidigi/AiHarness/actions/workflows/ci.yml/badge.svg)](https://github.com/Fidigi/AiHarness/actions/workflows/ci.yml)

**Unified AI Agent Platform** — Combining the power of a CLI terminal agent and a modern web interface in one cohesive tool.

## 📋 Table of Contents

- [Features](#-features)
- [Documentation](#-documentation)
- [Architecture](#-architecture)
- [Getting Started](#-getting-started)
- [Development](#-development)
- [Testing](#-testing)
- [Project Structure](#-project-structure)
- [Contributing](#-contributing)
- [License](#-license)

## ✨ Features

### Unified Platform
- **CLI Interface** — Full terminal-based AI agent with command system and TUI components
- **Web Interface** — Modern React web app for chatting with AI models
- **Shared Core** — Common types, providers, and utilities across both interfaces

### AI Integration
- Multi-provider support (OpenAI, Anthropic, Google, Azure OpenAI, Vertex AI, AWS Bedrock, Local)
- Streaming responses
- Session management
- Model selection

### Extensibility
- Plugin/Extension system
- Custom skills
- Prompt templates
- Configurable keybindings (CLI) & themes (Web)

## 📖 Documentation

Le [guide utilisateur complet](docs/users/fr/user-guide.md) décrit l’installation, la configuration des providers, le CLI, l’interface Web, la persistance et la sécurité.

Documentation complémentaire :

- [Extensions CLI](docs/contributors/fr/extensions-cli.md)
- [Extensions Web](docs/contributors/fr/extensions-web.md)
- [Internationalisation Web](docs/contributors/fr/i18n.md)
- [Conteneurisation](docs/users/fr/containerization.md)
- [Architecture](docs/contributors/fr/architecture-overview.md)

## 🏗 Architecture

```
AiHarness/
├── packages/
│   ├── core/           # Shared types, providers, utilities
│   ├── cli/            # Terminal interface package
│   ├── server/         # API, sessions, credentials, SSE/WebSocket
│   └── web/            # Web interface package
├── e2e/                # End-to-end tests (Playwright)
├── docs/               # Documentation
└── Configuration files
```

### Packages

| Package | Description |
|---------|-------------|
| `@ai-harness/core` | Shared types, AI providers, session management, utilities |
| `@ai-harness/cli` | CLI interface with command system and TUI components |
| `@ai-harness/server` | Express API, persistent sessions, SSE and WebSocket transport |
| `@ai-harness/web` | React web application with Zustand state management |

## 🚀 Getting Started

### Prerequisites

- Node.js 22.22.2+, 24.15.0+ or 26+
- npm 12.1.0+

### Installation

```bash
# Clone the repository
git clone https://github.com/Fidigi/AiHarness.git
cd AiHarness

# Install dependencies
npm install

# Build and link both commands globally from this checkout
npm run link:global

# Start the terminal or Web application
ai-harness
ai-harness-web
```

## 💻 Development

### Start CLI in development mode

```bash
npm run dev:cli
```

### Start the complete Web application

```bash
ai-harness-web
```

This serves both the API and Web UI, then opens <http://127.0.0.1:3080>. Command-line options override their environment equivalents.

| Option or environment variable | Purpose | Default |
|---|---|---|
| `--help`, `-h` | Print startup help and exit | — |
| `--port <port>`, `-p <port>` or `AI_HARNESS_WEB_PORT` | HTTP port (`PORT` and `WEB_PORT` are aliases) | `3080` |
| `--hostname <host>`, `-H <host>` or `AI_HARNESS_WEB_HOSTNAME` | Listening address (`WEB_HOSTNAME` is an alias) | `127.0.0.1` |
| `--no-open` or `AI_HARNESS_WEB_NO_OPEN=1` | Do not open a browser | Browser opens |

Example: `ai-harness-web -p 8080 -H 0.0.0.0 --no-open`. Before listening on a non-loopback address, configure `AI_HARNESS_AUTH_TOKEN` and use a trusted HTTPS reverse proxy or VPN.

Without the global link, run `npm run web` from the repository root.

For server hot reload during development:

```bash
npm run dev:web
```

See the [English user guide](docs/users/en/user-guide.md#using-the-web-interface) for provider and production configuration.

### Run CLI and Web simultaneously

```bash
npm run dev
```

## 🧪 Testing

AiHarness uses a comprehensive testing strategy:

### Unit Tests (Vitest)

Run all unit tests across packages:

```bash
npm test
```

Watch mode for continuous testing:

```bash
npm run test:watch
```

With coverage report:

```bash
npm run test:coverage
```

### End-to-End Tests (Playwright)

Run E2E tests:

```bash
npm run test:e2e
```

Open Playwright reporter:

```bash
npx playwright show-report
```

### Test Structure

```
packages/
├── core/src/       # Providers, sessions, extensions and utility tests
├── cli/src/        # Commands, TUI, resources, RPC and security tests
├── server/src/     # API, WebSocket, credentials and Web launcher tests
└── web/src/        # Store and API integration tests

e2e/
└── examples.spec.ts              # Playwright E2E test suite
```

## 📁 Project Structure

### Core Package (`packages/core`)

- **Types** — Shared TypeScript interfaces and enums
- **Providers** — OpenAI, Anthropic, Gemini, Azure, Vertex, Bedrock, local and mock
- **Sessions** — Persistent JSONL sessions, branches, summaries and compaction
- **Utils** — Helper functions (ID generation, formatting, etc.)

### CLI Package (`packages/cli`)

- **Commands** — Session, provider, model, branch, import/export and extension commands
- **TUI** — Regular and fullscreen terminal interfaces
- **Resources** — Skills, prompt templates, extensions and project trust
- **Automation** — JSONL RPC mode and model tool loop

### Server Package (`packages/server`)

- **API** — Chat, provider configuration and persistent sessions
- **Streaming** — SSE and WebSocket transports
- **Launcher** — `ai-harness-web` serves the API and production Web bundle together

### Web Package (`packages/web`)

- **Components** — React components (Sidebar, ChatView, Settings)
- **Store** — Zustand state management for sessions and providers
- **Styles** — CSS with dark theme by default

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

**Built with ❤️ using TypeScript, React, and modern tooling**
