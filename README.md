# pi-extensions

Same Pi. Fresh slice.

Rebuilding my Pi experience, one deliberate extension at a time.


## Extensions

- **[codex-web-search](extensions/codex-web-search/README.md)** adds a `web_search` tool that fetches cited source data from the web with `codex exec`.
- **[model-allowlist](extensions/model-allowlist/README.md)** uses Pi's `enabledModels` list to limit the models exposed in Pi and T3.
- **[subagent](extensions/subagent/README.md)** delegates tasks to separate Pi sessions with background execution and optional worktree isolation, and turns itself off under T3 Code.
- **[t3-full-access](extensions/t3-full-access/README.md)** skips T3 Code's approval prompts for Pi tools.


## Development

The `oxlint-tsgolint` engine embeds its own TypeScript version. Because `.npmrc` disables peer-dependency enforcement, check that version and Oxlint's peer requirement when updating the dependencies.
