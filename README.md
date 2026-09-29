# 🚀 AiHarness

**Unified AI Agent Platform** — Combining the power of a CLI terminal agent and a modern web interface in one cohesive tool.

## 📋 Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Getting Started](#getting-started)
- [Development](#development)
- [Testing](#testing)
- [Project Structure](#project-structure)
- [Contributing](#contributing)
- [License](#license)

## ✨ Features

### Unified Platform
- **CLI Interface** — Full terminal-based AI agent with command system and TUI components
- **Web Interface** — Modern React web app for chatting with AI models
- **Shared Core** — Common types, providers, and utilities across both interfaces

### AI Integration
- Multi-provider support (OpenAI, Anthropic, Google, Local)
- Streaming responses
- Session management
- Model selection

### Extensibility
- Plugin/Extension system
- Custom skills
- Prompt templates
- Configurable keybindings (CLI) & themes (Web)

## 🏗 Architecture

```
AiHarness/
├── packages/
│   ├── core/           # Shared types, providers, utilities
│   ├── cli/            # Terminal interface package
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
| `@ai-harness/web` | React web application with Zustand state management |

## 🚀 Getting Started

### Prerequisites

- Node.js >= 18.0.0
- pnpm (recommended) or npm/yarn

### Installation

```bash
# Clone the repository
git clone https://github.com/Fidigi/AiHarness.git
cd AiHarness

# Install dependencies
pnpm install

# Build all packages
pnpm build
```

## 💻 Development

### Start CLI in development mode

```bash
pnpm dev:cli
```

### Start Web interface in development mode

```bash
pnpm dev:web
```

### Run both simultaneously

```bash
pnpm dev
```

## 🧪 Testing

AiHarness uses a comprehensive testing strategy:

### Unit Tests (Vitest)

Run all unit tests across packages:

```bash
pnpm test
```

Watch mode for continuous testing:

```bash
pnpm test:watch
```

With coverage report:

```bash
pnpm test:coverage
```

### End-to-End Tests (Playwright)

Run E2E tests:

```bash
pnpm test:e2e
```

Open Playwright reporter:

```bash
npx playwright show-report
```

### Test Structure

```
packages/
├── core/src/
│   ├── types/index.test.ts       # Type validation tests
│   ├── providers/index.test.ts   # Provider implementation tests
│   ├── sessions/session-manager.test.ts  # Session management tests
│   └── utils/index.test.ts       # Utility function tests
├── cli/src/
│   ├── commands/handler.test.ts  # Command handler tests
│   └── tui/terminal-ui.test.ts   # Terminal UI tests
└── web/src/
    └── store/session-store.test.ts  # State management logic tests

e2e/
└── examples.spec.ts              # Playwright E2E test suite
```

## 📁 Project Structure

### Core Package (`packages/core`)

- **Types** — Shared TypeScript interfaces and enums
- **Providers** — AI provider implementations (OpenAI, Anthropic)
- **Sessions** — Session/conversation management
- **Utils** — Helper functions (ID generation, formatting, etc.)

### CLI Package (`packages/cli`)

- **Commands** — Command handler with built-in commands (/help, /new, /list, etc.)
- **TUI** — Terminal UI components for display and interaction

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
