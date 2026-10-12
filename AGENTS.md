# Build and verification

- This repository uses mise for tool versions and task execution. Run tasks with `mise run <task>`; do not call `node`, `npm`, `tsc`, `prettier`, or `oxlint` directly. `mise tasks` lists every task.
- Install local prerequisites with `brew install mise`, then run `mise trust` and `mise install` in this checkout.
- `mise.toml` pins Node; `mise.lock` records its checksums. Bump it with `mise upgrade --bump node`, run `mise lock` and `mise run check`, set `engines.node` in `package.json` to the same version, and commit all three files.
- `package.json` and `package-lock.json` pin the project tools (TypeScript, Prettier, Oxlint). `mise run install` runs `npm ci`; every other task depends on it, and mise skips it while `node_modules` is newer than the lockfile. Do not rely on global Prettier or Oxlint installations.
- Run `mise run check` before handing off changes. It checks formatting, type-aware lint, TypeScript compilation, and tests without rewriting files.
- Use `mise run fmt` to format tracked TypeScript files. Keep formatting out of `mise run check`.
- Keep Oxlint's correctness rules enabled. The Node test runner owns promises returned by imported `describe`, `it`, and `test` calls, so the test-only lint configuration permits those calls without awaiting them.

# When writing tests

- Tests are node:test files: `import { describe, it } from "node:test"` with `import assert from "node:assert/strict"`. One `describe` per unit under test, `it("behavior sentence", ...)` leaves with a few bare assertions; assertion messages appear only inside merged scenarios and loops.
- Never hand-roll assertion helpers, pass/fail counters, or `process.exit` - a top-level `process.exit(0)` makes `node --test` report a file as passing even when its tests fail. Skip unavailable-dependency tests with the `skip` option instead.
- Test files live at `<extension>/tests/<name>-test.ts` and stay standalone: both `mise exec -- node <file>` and `mise exec -- node --test <file>` work. `mise run test` runs `node --test "*/tests/*-test.ts"` with one process per file, in parallel - mutate `process.env` before a dynamic `await import(...)` only at module top, and clean up in `after()` hooks.

# When designing Pi TUI surfaces

- Prefer Pi's native presentation patterns. Use the default boxed shell when available; when self-rendering a card-like surface, start with `Box(1, 1)` and the matching theme background unless the design explicitly requires different spacing.
- Follow Pi's native tool typography using semantic theme tokens:
  - Render a tool keyword or title with `theme.fg("toolTitle", theme.bold(...))`.
  - Render its primary argument or path unbolded with `theme.fg("accent", ...)`.
  - Render secondary metadata unbolded with `theme.fg("muted", ...)`. For example, Bash renders ` (timeout 300s)` this way.
  - Use `theme.fg("dim", ...)` for tertiary previews, hints, and less important metadata.
  - Render tool body output with `theme.fg("toolOutput", ...)`.
- In TUI code, use semantic theme tokens rather than palette names or literal colors. Palette-specific mappings belong in theme JSON.
- Never truncate card text with pi-tui's `truncateToWidth` - it injects `\x1b[0m` resets that kill the enclosing background. Use `shared/text-fit.ts`: `fitText` on raw text before styling (the ellipsis inherits the style), `clampStyled` to hard-clamp an already-styled line.
