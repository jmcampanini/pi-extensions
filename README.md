# pi-extensions

Same Pi. Fresh slice.

Rebuilding my Pi experience, one deliberate extension at a time.


## Extensions

- **[codex-web-search](extensions/codex-web-search/README.md)** adds a `web_search` tool that fetches cited source data from the web with `codex exec`.
- **[model-allowlist](extensions/model-allowlist/README.md)** uses Pi's `enabledModels` list to limit the models exposed in Pi and T3.
- **[subagent](extensions/subagent/README.md)** delegates tasks to separate Pi sessions with background execution and optional worktree isolation, and turns itself off under T3 Code.
- **[t3-full-access](extensions/t3-full-access/README.md)** skips T3 Code's approval prompts for Pi tools.


## Development

Run `mise run check` to run type checking, tests, TypeScript linting and formatting checks, Markdown linting, and workflow linting. The checks leave source files unchanged.

- `mise run lint-typescript` runs type-aware Oxlint checks.
- `mise run lint-fix` applies safe lint fixes.
- `mise run format-check` checks TypeScript formatting without writing files.
- `mise run format` formats TypeScript with Oxfmt. Run it after applying lint fixes.

Linting and formatting cover `extensions/**/*.ts` and `vitest.config.ts`. TypeScript uses tabs and a 120-column formatting target. Markdown keeps the conventions in `.markdownlint-cli2.jsonc`; Oxfmt excludes Markdown, configuration, and generated files.

The npm lockfile pins Oxlint, its `oxlint-tsgolint` type-aware engine, and Oxfmt. Dependabot groups their updates with TypeScript because the type-aware engine embeds a specific TypeScript version. Review that version and Oxlint's peer requirement when updating the group; `.npmrc` disables npm's peer-dependency enforcement.
