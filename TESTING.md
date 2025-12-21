# Testing Guidelines

- Prefer focused unit/integration tests (Vitest) for known, user-reported issues.
- Use Playwright only when it reliably reproduces a user-described UI bug; avoid adding tests that "discover" new issues.
- When delegating tests to codex-cli, run it in the background and only read the final report; do not stream partial output into the main context.
- Keep test runs targeted to the affected area; avoid broad suites unless explicitly requested.
- Clean up transient test artifacts (reports, prompts, result folders) after use.

