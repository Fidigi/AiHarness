# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Project initialization with monorepo structure
- Core package with types, providers, sessions, and utils
- CLI package with command handler and TUI components
- Web package with React interface (Sidebar, ChatView, Settings)
- Comprehensive test suite:
  - Unit tests for all core packages
  - E2E tests with Playwright
- Documentation structure

### Planned
- [ ] Real AI provider integrations (OpenAI, Anthropic APIs)
- [ ] Persistent session storage (SQLite/PostgreSQL)
- [ ] WebSocket streaming support
- [ ] Plugin system
- [ ] Custom skills framework
- [ ] Prompt template editor
- [ ] Dark/Light theme toggle for web
- [ ] Mobile responsive improvements

---

## [0.1.0] - 2024-XX-XX

### Added
- Initial project setup
- Basic CLI interface with command system
- Web interface skeleton with React components
- Session management (in-memory)
- Provider abstractions (stub implementations)
- Test infrastructure with Vitest and Playwright
