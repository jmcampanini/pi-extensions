# interactive-subagents

A pi extension that spawns sub-agents as real pi sessions in tmux panes: the parent model calls a tool that returns immediately, and the child's result is steered back into the conversation asynchronously.

**Requirements:** pi running *inside* tmux (e.g. `tmux new -A -s pi 'pi'`). tmux merely being installed is not enough — the tools error out otherwise.

## Calling

The extension registers three caller-side tools:

- **`subagent`** — spawn a child pi session in a new tmux pane to work on a task.
- **`subagents_list`** — list the available agent definitions usable as the `agent` param.
- **`subagent_resume`** — reopen a finished child (by `id`, or `sessionPath` after a pi restart) to answer a question, retry, or send follow-up work.

`subagent` and `subagent_resume` are **fire-and-forget**: they return immediately with a "started" status, and the child's result arrives as a steered message when it exits. The model must never poll — no sleeping, no reading the child's session file.

| `subagent` param | Meaning |
|---|---|
| `name` | Display name (widget + pane title) — required |
| `task` | The task prompt — required |
| `agent` | Agent definition to load defaults from (see `subagents_list`). **Default: `worker`** — there is no agent-less spawn; if `worker.md` doesn't exist, the spawn errors telling you to create it |
| `context` | `"fresh"` or `"forked"` (default `"fresh"`) |
| `model` | Model override — `provider/model`, or a bare id if unambiguous among configured providers; validated like the agent's `models` list (errors fast otherwise) |
| `thinking` | Thinking/effort level override (`off`–`xhigh`); defaults to the agent definition's `thinking:` value |
| `tools` | Comma-separated tool allowlist, e.g. `read,bash` |
| `cwd` | Child working directory (default: parent session's cwd) |
| `autoExit` | `true` (default) = exit when its turn completes; `false` = stay open for a human |

Explicit params beat agent-definition frontmatter, which beats built-in defaults.

```js
subagent({
  name: "recon",
  task: "Map where exit detection lives in ./src; report file:line pointers.",
  agent: "scout",
})
// → Sub-agent "recon" started (id 3f2a91bc, fresh context).
//   Its result will arrive automatically — do not poll.
```

**The help loop:** a blocked child calls `caller_ping` and exits; the parent is woken with the question and answers via `subagent_resume({ id, message })` — the child's original system prompt, tools, model, and thinking level are restored automatically from its launch metadata. The `id` is in-memory only; after a pi restart, pass `sessionPath` from the result/ping message instead.

## Session context: fresh vs forked

`context: "fresh"` (the default) starts the child with a clean context. `context: "forked"` seeds the child's session file with a snapshot of the parent conversation, so the child starts knowing everything the parent knows and reuses the provider prompt cache — good for follow-up work on the current discussion. Forking needs the parent's session file on disk, so it fails on the very first turn of a brand-new session (pi hasn't written the file yet).

## Pane layout (tmux)

Children are always created detached — a spawning child never steals your focus. Arrangement is controlled by the `layout` setting (see [Configuration](#configuration); `PI_SUBAGENT_LAYOUT` overrides it):

| Value | Behavior |
|---|---|
| `main` | tmux `main-vertical`: parent pi stays a fixed-width pane on the left, children stack in a right rail. Re-flows on every spawn and exit so survivors reclaim freed space. |
| `window` (default) | All children live in a dedicated tiled sibling window named `<parent window>-subagents`, reused across spawns (survives `/reload`). |
| `off` | Plain right-split off the parent pi's pane. No re-flow — each spawn just narrows the row. |

In `main`, the `mainWidth` setting sets the parent pane's width — a percentage like `60%` (default) or absolute columns like `120`. Layout application is best-effort: if a tmux layout command fails, the spawn still succeeds with a raw split.

## Agent definitions

An agent definition is a Markdown file: optional frontmatter for settings, and a body that becomes the child's appended system prompt (`pi --append-system-prompt`). The `worker` agent is the **default** — a spawn that names no agent runs as `worker`, so `worker.md` should always exist. The **filename is the agent name** (`scout.md` → `agent: "scout"`); there is no `name:` key.

Definitions load from two places, most specific wins:

1. **Project**: `<cwd>/.pi/subagents/`. A project file **shadows** a global one with the same name — a repo can specialize `worker.md` or `scout.md` for its own conventions.
2. **Global**: `$PI_CODING_AGENT_DIR/subagents/`, defaulting to `~/.pi/agent/subagents/`.

| Frontmatter key | Meaning |
|---|---|
| `description` | Shown by `subagents_list` |
| `models` | Ordered, comma-separated model candidates; the first one usable **on this machine** wins, so one agent file works across computers. An entry is `provider/model` (exact) or a bare id like `gpt-5.5` — a bare id wins only when exactly one configured provider offers it (ambiguity fails that entry; no guessing, no fuzzy matching). If nothing is usable, the spawn errors immediately with per-entry reasons. Omit to inherit pi's default model. |
| `thinking` | Thinking/effort level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`), passed via `pi --thinking`. Works with or without `models`; the call's `thinking` param overrides it. Typos fail the spawn immediately. |
| `tools` | Comma-separated allowlist for `pi --tools` |
| `context` | `fresh` or `forked` (default `fresh`) |
| `auto-exit` | `true` (default) or `false` |

All keys are optional; a file without `---` fences is treated as all body. Parsing is line-based `key: value`, not full YAML.

The pre-rename `mode:` key (values `fork`/`fresh`) is gone. A file that still uses it — or that uses the old `fork` value under `context:` — shows a ⚠ problem in `/subagents-available` and fails the spawn with a migration message, rather than silently running with a fresh context.

Example (`~/.pi/agent/subagents/scout.md`):

```markdown
---
description: Fast read-only codebase recon with file:line pointers.
models: openai-codex/gpt-5.5, anthropic/claude-haiku-4-5
thinking: low
tools: read, grep, find, ls
auto-exit: true
---

You are a scout: investigate the codebase and return structured findings
another agent can use without re-reading everything. Every claim needs an
exact file path, with line numbers when you cite code.
```

## Also worth knowing

- **`/subagents-available` (human command).** Shows every known agent with full details — description, the model that wins on this machine, thinking, tools, context, validity problems, and the source file path — in a widget above the editor. Human-only and zero-token: it never touches the session or the model's context. Run it again (or send a message) to dismiss. The model's `subagents_list` tool is a terse view over the same inventory.

- **Live widget.** While children run, one line per sub-agent appears above the parent's editor: `[agent-type]  name` with a right-anchored elapsed clock, and nothing else — a row existing means it's running. Names that repeat the agent type (`Scout: Auth` next to `[scout]`) are de-duplicated for display. The right edge is reserved for v2's live activity states.
- **`/subagents-running` (human command).** Opens a picker over the running children: up/down to choose, **Enter** jumps to its pane (switching tmux windows if needed), **z** jumps *and* zooms the pane (`prefix+z` un-zooms), **x** stops it (the model is told it was stopped by the user), Escape cancels.
- **No recursion.** Children never get the spawn tools — the extension detects child mode via `PI_SUBAGENT_SESSION` and registers nothing. Depth is hard-capped at 1.
- **How children end.** Auto-exit children close when their turn completes; interactive ones (`autoExit: false`) stay open until the model calls `subagent_done`. Either can `caller_ping` the parent.
- **Watch or take over.** Every child is a real pi process in a visible pane — watch it, or just start typing to steer it. Escape in an auto-exit child keeps its pane open for inspection.

## Configuration

Settings resolve in three layers — later wins:

**defaults** < **config file** < **environment variables**

The config file is `subagents.json` in pi's config root (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent/`) — the same root the agent definitions live under. Missing file = all defaults. A **malformed** file (bad JSON, unknown keys, invalid values) fails the extension at **load time** with an error naming the file and the offending key — fix it and `/reload`.

| Key | Env override | Default | Purpose |
|---|---|---|---|
| `layout` | `PI_SUBAGENT_LAYOUT` | `window` | Pane layout: `main`, `window`, or `off` |
| `mainWidth` | `PI_SUBAGENT_MAIN_WIDTH` | `60%` | Parent pane width in `main` layout (tmux width: percentage or columns) |
| `shellReadyDelayMs` | `PI_SUBAGENT_SHELL_READY_DELAY_MS` | `500` | Pause after opening a pane before typing the launch command — raise it if a slow shell (direnv etc.) drops the command |

```json
{
  "layout": "window",
  "mainWidth": "60%",
  "shellReadyDelayMs": 500
}
```

Env vars are validated as strictly as the file. Use the file for your stable, dotfiles-managed baseline and env vars for per-project (direnv) or one-off overrides.
