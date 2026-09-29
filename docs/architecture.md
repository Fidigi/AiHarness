# Architecture Documentation

## Overview

AiHarness is built as a **monorepo** with three main packages:

```
packages/
├── core/     # Shared library (types, providers, utils)
├── cli/      # Terminal interface
└── web/      # Web application
```

## Package Dependencies

```
cli ──→ core
web ──→ core
```

Both `cli` and `web` depend on `core`, but they don't depend on each other. This allows:
- Independent development of CLI and Web interfaces
- Shared types and logic across both platforms
- Easy testing with proper isolation

## Core Package Structure

### Types (`src/types/`)
Centralized TypeScript definitions used across all packages:
- `Message` - Conversation message structure
- `Session` - Session/conversation management
- `ProviderConfig` - AI provider configuration
- `AppConfig` - Application-wide settings

### Providers (`src/providers/`)
Abstract interface for AI providers with concrete implementations:
```typescript
abstract class AiProvider {
  abstract chat(messages: Message[]): Promise<string>;
  abstract streamChat(...): Promise<void>;
}
```

Supported providers (to be implemented):
- OpenAI (GPT-4, GPT-3.5)
- Anthropic (Claude)
- Google (Gemini)
- Local models (Ollama, llama.cpp)

### Sessions (`src/sessions/`)
Session management with in-memory storage:
```typescript
class SessionManager {
  create(options?): Session;
  get(id: string): Session | undefined;
  list(): Session[];
  addMessage(sessionId, message);
  delete(id: boolean);
}
```

### Utils (`src/utils/`)
Shared utility functions:
- `generateId()` - UUID generation
- `formatDate()` - Date formatting
- `truncate()` - Text truncation
- `sleep()` - Promise-based delay

## CLI Package Structure

### Commands (`src/commands/`)
Command handler with extensible command system:
```typescript
interface CommandEntry {
  name: string;
  description: string;
  usage?: string;
  handler: (args, sessionManager) => Promise<string>;
}
```

Built-in commands:
- `/help` - Show available commands
- `/new [title]` - Create new conversation
- `/list` - List all conversations
- `/switch <id>` - Switch to different conversation
- `/delete <id>` - Delete a conversation
- `/clear` - Clear current conversation
- `/provider` - Show/change AI provider
- `/model` - List available models
- `/config` - View configuration
- `/export [format]` - Export conversation
- `/quit` or `/exit` - Exit application

### TUI (`src/tui/`)
Terminal UI components for display and interaction:
```typescript
class TerminalUI {
  welcome();
  displayUserMessage(content);
  displayAssistantMessage(content, stream?);
  displayCommand(name, output);
  showError(message);
  showHelp();
}
```

## Web Package Structure

### Components (`src/components/`)
React components:
- `Sidebar` - Session list and navigation
- `ChatView` - Main chat interface
- `SettingsView` - Application settings

### Store (`src/store/`)
Zustand state management for sessions and providers.

## Testing Strategy

### Unit Tests (Vitest)
- Run across all packages
- Fast execution with in-memory mocks
- Coverage reporting

### E2E Tests (Playwright)
- Cross-browser testing (Chrome, Firefox, Safari)
- Component interaction tests
- Responsive design verification
