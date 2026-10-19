# Instructions

Read docs/ai/project-map.md before working in the repository. It is the canonical navigation guide for the platform, its subsystems, documentation status, and validation workflow.

## Keep Test Work Focused

- Before adding tests, identify the existing coverage and state the specific behavior that is not covered.
- Add only the tests needed to cover that gap; reuse existing scenarios and fixtures where appropriate.
- Refactor only duplication encountered within the current task's scope. Do not turn a focused change into a general test-suite rewrite or a new test framework.
- Preserve distinct CLI, API, and browser evidence when those boundaries require separate coverage.
