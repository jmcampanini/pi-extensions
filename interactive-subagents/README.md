# interactive-subagents

A pi extension that spawns sub-agents as real pi sessions in tmux panes: the parent model calls a tool that returns immediately, and the child's result is steered back into the conversation asynchronously.

**Requirements:** pi running *inside* tmux (e.g. `tmux new -A -s pi 'pi'`). tmux merely being installed is not enough — the tools error out otherwise.

## Calling

The extension registers three caller-side tools:

- **`subagent`** — spawn a child pi session in a new tmux pane to work on a task.
- **`subagents_list`** — list the available agent definitions usable as the `agent` param.
- **`subagent_resume`** — reopen a finished child (by `id`, or `sessionPath` after a pi restart) to answer a question, retry, or send follow-up work.

`subagent` and `subagent_resume` are **fire-and-forget**: they return immediately with a "started" status, and the child's result arrives as a steered message when it exits. The launch instructions remain in the model-facing tool result, but the successful result prose is hidden from the human transcript so the TUI shows only the compact call; launch errors remain visible. The model must never poll - no sleeping, no reading the child's session file. pi delivers steered messages only at the parent's next turn boundary, so when the parent is mid-turn a finished child stays on the live widget as `delivering` until its result message actually lands.

| `subagent` param | Meaning |
|---|---|
| `name` | Display name (widget + pane title) — required |
| `task` | The task prompt — required |
| `agent` | Agent definition to load defaults from (see `subagents_list`). **Default: `worker`** — there is no agent-less spawn; if `worker.md` doesn't exist, the spawn errors telling you to create it |
| `context` | `"fresh"` or `"forked"` (default `"fresh"`) |
| `model` | Model override — `provider/model`, or a bare id if unambiguous among configured providers; validated like the agent's `models` list (errors fast otherwise) |
| `thinking` | Thinking/effort level override (`off` through `max`); defaults to the agent definition's `thinking:` value |
| `tools` | Comma-separated tool allowlist, e.g. `read,bash` |
| `cwd` | Child working directory (default: parent session's cwd) |
| `worktree` | `true` = run the child in a fresh git worktree (own directory + own branch). Cannot be combined with `cwd` — the worktree *is* the child's working directory. See [Worktree isolation](#worktree-isolation) |
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

`context: "fresh"` (the default) starts the child without the parent conversation. Project files and instructions still load. Use fresh context for bounded, self-contained work, especially independent exploration, research, reviews, tests, and other tasks whose intermediate context should stay isolated. The task prompt must supply the objective, relevant facts and paths, constraints, whether edits are allowed, and the expected output or verification.

`context: "forked"` copies the completed parent conversation before the current turn, then gives the child the new task. Use it when the task materially depends on accumulated discussion, reads, or decisions that would be difficult or lossy to restate. It is also useful when several agents should try different approaches from the same conversational starting point. Forking imports irrelevant or stale context too, so task size alone is not a reason to choose it. The copied history is sent to the child's selected model and provider, including an explicit model override, so use fresh context when the parent history is unnecessary or sensitive.

Copied conversation entries remain byte-identical, but provider cache reuse is not guaranteed. A different child model, system prompt, or tool set can invalidate or limit a shared prefix, so treat caching as a possible optimization rather than a reason to fork. Forking needs the parent's session file on disk, so it fails on the first turn of a brand-new session before pi has written that file.

If a follow-up depends on a child's own previous findings or tool results, continue that child with `subagent_resume` instead of spawning a new child. In short: default to fresh; fork only when reconstructing the necessary parent context would be difficult or lossy; resume when the dependency is on the child's context.

## Children in pi's session picker

Child sessions are real pi sessions, so they show up in `pi --resume` next to your own. To keep them recognizable there, every child is seeded with a display name — **`subagent › <agent> › <name>`** — which the picker shows (in the "named" color) instead of the child's raw task text, and with a `parentSession` header pointer, which nests the child under the session that spawned it in the picker's default threaded view. Children spawned before this existed are backfilled: `subagent_resume` adds the name the first time it reopens one, unless the session already has a name (e.g. you renamed it in the picker yourself).

## Worktree isolation

Parallel children editing the same checkout can trample each other. Pass `worktree: true` (or set it in agent frontmatter; the param wins) and the child runs in a fresh git worktree — its own directory and its own branch. The spawn result and the final `subagent_result` message both name the path and branch, so the parent model knows where the work lives and can `git merge` it.

**Creation is a user-pluggable shell command** — `worktreeCreateCommand`, run via `bash -c` in the parent session's cwd. The contract:

- It gets `PI_SUBAGENT_WORKTREE_NAME` in its env (the spawn's `<slug>-<id>`, e.g. `auth-flow-3f2a91bc`).
- It must exit 0 and print the worktree directory as the **last non-empty stdout line** (relative paths resolve against the parent cwd — send tool chatter to stderr).
- Timeout: 120s, since creation may fetch from a remote.

The default is itself such a command, and doubles as documentation:

```sh
ROOT="$(git rev-parse --show-toplevel)" && WT="$ROOT/.pi/worktrees/$PI_SUBAGENT_WORKTREE_NAME" && mkdir -p "$ROOT/.pi/worktrees" && printf '*\n' >"$ROOT/.pi/worktrees/.gitignore" && git worktree add -b "pi/$PI_SUBAGENT_WORKTREE_NAME" "$WT" >&2 && echo "$WT"
```

That is: `<repo>/.pi/worktrees/<name>` on branch `pi/<name>`, with a `*` gitignore that makes `.pi/worktrees/` self-ignoring in the parent repo.

**Cleanup** runs when the child finishes, before the result message is sent, controlled by `worktreeCleanupMode`:

- `auto` (default): remove the worktree **only** when the child succeeded *and* the worktree is provably clean. "Dirty" means `git status --porcelain` is non-empty (uncommitted or untracked files) **or** HEAD moved off the commit the worktree was created on — a child that *committed* its work counts as dirty, because removing the worktree and its branch would destroy that work. A clean-but-failed child also keeps its worktree so `subagent_resume` still works, and if git itself can't answer, the worktree is kept — the failure mode is always a leftover directory, never lost work.
- `never`: always keep.

Removal runs `worktreeCleanupCommand` (also `bash -c`, parent cwd) with `PI_SUBAGENT_WORKTREE_DIR` and `PI_SUBAGENT_WORKTREE_BRANCH` in its env — the branch is an **empty string** when the worktree was on a detached HEAD. Timeout: 60s. The default removes the worktree and deletes the branch (skipping branch deletion when detached):

```sh
git worktree remove "$PI_SUBAGENT_WORKTREE_DIR" >&2 && if [ -n "$PI_SUBAGENT_WORKTREE_BRANCH" ]; then git branch -D "$PI_SUBAGENT_WORKTREE_BRANCH" >&2; fi
```

Both commands are config keys (see [Configuration](#configuration)), so any tool that owns your worktrees can plug in. With `grove`, for example:

```json
{
  "worktreeCreateCommand": "grove create \"$PI_SUBAGENT_WORKTREE_NAME\"",
  "worktreeCleanupCommand": "grove remove \"$PI_SUBAGENT_WORKTREE_DIR\""
}
```

This branches the child from the parent's current HEAD, which is usually what a helper sub-agent wants; add `--from-remote-primary` to base children on the remote's primary branch instead (fetches, so it needs network).

Worth knowing:

- Both commands must let their stdout/stderr **close when they exit**: a background process they leave attached to those pipes (a daemon started without `>/dev/null 2>&1`) stalls the spawn until the timeout fires.
- A child **stopped by the user** keeps its worktree — the work may be half-done.
- If pi itself crashes (or is killed) mid-child, cleanup never runs and the worktree stays behind under `.pi/worktrees/` — it's self-ignored and recorded in the child's `.meta` sidecar; remove it manually (`git worktree remove <dir>`).
- Resuming a child whose worktree was already removed fails with a clear error telling you to spawn a new sub-agent instead.

## Pane layout (tmux)

Children are always created detached — a spawning child never steals your focus. Arrangement is controlled by the `layout` setting (see [Configuration](#configuration); `PI_SUBAGENT_LAYOUT` overrides it):

| Value | Behavior |
|---|---|
| `main` | tmux `main-vertical`: parent pi stays a fixed-width pane on the left, children stack in a right rail. Re-flows on every spawn and exit so survivors reclaim freed space. |
| `window` (default) | All children live in a dedicated tiled sibling window named `<parent window>-subagents`, reused across spawns (survives `/reload`). |
| `off` | Plain right-split off the parent pi's pane. No re-flow — each spawn just narrows the row. |

In `main`, the `mainWidth` setting sets the parent pane's width — a percentage like `60%` (default) or absolute columns like `120`. Layout application is best-effort: if a tmux layout command fails, the spawn still succeeds with a raw split.

## Reload continuity

Running and finalizing children survive `/reload` in the parent. Existing panes and processes stay alive, while an exited child's enriched delivery record retains its pending exit, cleanup promise, and send ownership. The replacement extension republishes the widget and adopts each record under a new fenced generation. Repeated reloads still produce one cleanup and one eventual result per child; a send that threw can be retried by a replacement, while a send already accepted by pi is never duplicated.

This guarantee is deliberately limited to hot reload in the same parent pi process. Quit, `/new`, `/resume`, `/fork`, a parent crash, and a parent process restart remain destructive boundaries. Child session files still survive those boundaries and can be reopened by path, but live supervision is not reconstructed after a process restart. If a replacement extension fails to load and never adopts the children, a 30-second fallback closes their panes rather than leaving unsupervised processes running.

### Accepted delivery limitations

These are known, acceptable behaviors and should not be reported as errors:

- If `pi.sendMessage` throws, the enriched delivery record remains available for retry by the next successful `/reload`; there is intentionally no timer-based retry in the current implementation.
- If Pi accepts a queued steer and the user presses Escape before it lands, Pi can silently drop it. The frozen `delivering` row remains as the honest signal that delivery was lost; the extension intentionally does not resend an accepted message because that could duplicate a result that actually landed.

## Agent definitions

An agent definition is a Markdown file: optional frontmatter for settings, and a body that becomes the child's appended system prompt (`pi --append-system-prompt`). The `worker` agent is the **default** — a spawn that names no agent runs as `worker`, so `worker.md` should always exist. The **filename is the agent name** (`scout.md` → `agent: "scout"`); there is no `name:` key.

Definitions load from two places, most specific wins:

1. **Project**: `<cwd>/.pi/subagents/`. A project file **shadows** a global one with the same name — a repo can specialize `worker.md` or `scout.md` for its own conventions.
2. **Global**: `$PI_CODING_AGENT_DIR/subagents/`, defaulting to `~/.pi/agent/subagents/`.

| Frontmatter key | Meaning |
|---|---|
| `description` | Shown by `subagents_list` |
| `models` | Ordered, comma-separated model candidates; the first one usable **on this machine** wins, so one agent file works across computers. An entry is `provider/model` (exact) or a bare id like `gpt-5.5` — a bare id wins only when exactly one configured provider offers it (ambiguity fails that entry; no guessing, no fuzzy matching). If nothing is usable, the spawn errors immediately with per-entry reasons. Omit to inherit pi's default model. |
| `thinking` | Thinking/effort level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), passed via `pi --thinking`. Works with or without `models`; the call's `thinking` param overrides it. Typos fail the spawn immediately. |
| `tools` | Comma-separated allowlist for `pi --tools` |
| `context` | `fresh` or `forked` (default `fresh`) |
| `auto-exit` | `true` (default) or `false` |
| `worktree` | `true` = spawn this agent in a fresh git worktree by default (the call's `worktree` param overrides it, and so does an explicit `cwd` param — the child then runs there, with no worktree). Default `false`. See [Worktree isolation](#worktree-isolation) |

All keys are optional; a file without `---` fences is treated as all body. Parsing is line-based `key: value`, not full YAML.

An unknown `context:` or `worktree:` value shows a ⚠ problem in `/subagents-available` and fails the spawn, rather than silently running with a default the file didn't ask for.

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

## Liveness

While a child runs, its implant writes a small JSON snapshot — `<child-session>.jsonl.activity`, sibling of `.exit` and `.meta` — on every pi lifecycle event it records (run start/settle, tool start/end, turn end, model change, shutdown). The parent reads it once per second and derives one of four states, shown on the running widget's right edge and reported by `subagents_list`:

| State | Meaning |
|---|---|
| `starting` | pi is coming up in the pane, or the prompted run has not begun yet |
| `active` | mid-run; shown with the longest-running tool and context tokens when known: `bash 7m · active ·  84k` |
| `waiting` | idle after at least one completed run, or an interactive pane handed to a human |
| `stalled` | the 60s watchdog fired: the snapshot has been continuously missing/unreadable for 60s, or the prompted run never began within 60s of launch |

The widget has one more state the liveness watchdog never produces: `delivering` - the child's process has exited and its result message is queued behind the parent's current turn. The row's clock freezes at exit. On an idle parent it flashes for well under a second, but it can legitimately persist for a whole multi-tool turn (results deliver one per turn boundary). If you press Escape while the parent is streaming, pi silently drops queued messages - a `delivering` row that never clears means exactly that: the result was lost. `/reload` preserves that honest signal rather than guessing whether to resend. `subagents_list` reports these children under 'Finished, result on its way'.

When an **autonomous** child flips to stalled, the parent model is woken with a `subagent_stalled` steer — and with a `subagent_recovered` one if the child comes back. Stalled is a warning, not a failure: the child stays supervised and its result or failure message still arrives when it exits. Interactive (non-auto-exit) children never steer — a human is expected to be looking at the pane; the widget still shows their state. Stall steers stop after three episodes per child.

Every result message — completion, failure, or stopped-by-user — also carries the child's closing economics on one line when a liveness snapshot arrived: `Context: 84k/200k tokens (42%) · cost this run $0.31`. It sits directly before the resume/retry hint, so the model can tell, at the moment it decides whether to resume, when a child is too full to keep resuming. When a snapshot exists but no context share was ever reported (e.g. the child died before finishing a turn) the line reads `Context: unknown · cost this run $0.12`; when no snapshot ever arrived the line is omitted entirely, never guessed. Cost is scoped to **the run** (one pi process), not the session lifetime: a lifetime figure would count forked-in parent history as child spend. It visibly resets on each resume.

Two honest limitations, by design:

- **A frozen valid-`active` snapshot never stalls.** A child that wedges (or is SIGSTOPped) mid-run keeps reading `active` indefinitely: a 3-hour tool run with zero events is legal, so there is no heartbeat to age a valid snapshot against. The pane stays visible and the exit sentinel still catches real death.
- **A child clock stepping backwards defers acceptance.** Snapshots are ordered by the child's own clock, so if that clock steps back (e.g. an NTP step or a VM clock change), newer writes are time-stamped before the last accepted snapshot and read as stale until the clock catches up — after 60s of continuously stale reports the watchdog reports `stalled`, the correct loud failure, never an indefinite false `active`.

## Also worth knowing

- **`/subagents-available` (human command).** Shows one card per known agent in a widget above the editor: the description headline, the model that wins on this machine (or a red problem block when none would), where it came from (project/global), and only the non-default parts of its config — default run behavior and file paths are folded away (the name is the filename). Human-only and zero-token: it never touches the session or the model's context. Run it again (or send a message) to dismiss. The model's `subagents_list` tool is a terse view over the same inventory.

- **Live widget.** While children run or finished results remain queued, one line per sub-agent appears above the parent's editor: `[agent-type]  name` with a right-anchored elapsed clock; a row existing means it is running or just finished with its result message still queued (`delivering`, frozen clock). Agent tags are clamped to 12 display columns inside the brackets so long definition names do not shrink every child name. Names that repeat the full agent type (`Scout: Auth` next to `[scout]`) are de-duplicated for display. The right edge is `[tool duration · ]state · context · clock`: tool detail extends left without padding, state ends at the aligned context separator, and context uses three right-aligned whole-thousands digits plus `k` (`  6k`, ` 25k`, `106k`), saturating at `999k` so the cell never widens. Unknown context reserves the same blank width. Clocks share the widest current clock width, so context remains aligned after any child crosses one hour. On narrow terminals the tool drops before the name truncates; display-column-aware clipping keeps the state/context/clock core intact while it fits safely.
- **Parent task preview.** A `subagent` tool call shows a compact identity header, a blank line, and one dimmed line of the task in the parent transcript. The task line uses normal terminal word wrapping and has no truncation marker. Press **Ctrl+O** to expand the full task content and logical line structure. Normal terminal text rendering displays tabs as spaces and treats CR/CRLF as line breaks. This is display-only and does not add another message to model context.
- **Delivered result preview.** A completed, failed, or user-stopped `subagent_result` shows a status sentence and up to two lines from the child's final response by default. The three outcomes use distinct success, error, and warning styling. Press the configured tool-expansion key (**Ctrl+O** by default) to show the complete Markdown response, context and cost, worktree outcome, session path, and resume guidance; collapse it to restore the preview. This changes only the interactive display - the parent model, session file, JSON mode, and print mode retain the complete result. Help requests stay fully visible and actionable rather than collapsing.
- **`/subagents-running` (human command).** Opens a picker over the running children: up/down to choose, **Enter** jumps to its pane (switching tmux windows if needed), **z** jumps *and* zooms the pane (`prefix+z` un-zooms), **x** stops it (the model is told it was stopped by the user), Escape cancels. Only running children appear - a `delivering` child has no pane.
- **No recursion.** Children never get the spawn tools — the extension detects child mode via `PI_SUBAGENT_SESSION` and registers nothing. Depth is hard-capped at 1.
- **How children end.** Auto-exit children close when their turn completes; interactive ones (`autoExit: false`) stay open until the model calls `subagent_done`. Either can `caller_ping` the parent. The result message arrives at the parent's next turn boundary; the widget shows `delivering` until it lands.
- **Watch or take over.** Every child is a real pi process in a visible pane — watch it, or just start typing to steer it. Escape in an auto-exit child keeps its pane open for inspection.
- **Identity banner (inside the child).** Every child pins one line above its editor — `─ SUBAGENT · recon [scout] · auto-exit ───` — naming the child, its agent definition, and how the session ends. The mode is state-aware: `auto-exit` (closes itself when a turn completes), `interactive` (stays open until `subagent_done`), and after Escape in an auto-exit child it flips to `⚠ human driving — next completed turn exits & reports to parent` — a reminder that auto-exit is still armed while you type.

## Configuration

Settings resolve in three layers — later wins:

**defaults** < **config file** < **environment variables**

The config file is `subagents.json` in pi's config root (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent/`) — the same root the agent definitions live under. Missing file = all defaults. A **malformed** file (bad JSON, unknown keys, invalid values) fails the extension at **load time** with an error naming the file and the offending key — fix it and `/reload`.

| Key | Env override | Default | Purpose |
|---|---|---|---|
| `layout` | `PI_SUBAGENT_LAYOUT` | `window` | Pane layout: `main`, `window`, or `off` |
| `mainWidth` | `PI_SUBAGENT_MAIN_WIDTH` | `60%` | Parent pane width in `main` layout (tmux width: percentage or columns) |
| `shellReadyDelayMs` | `PI_SUBAGENT_SHELL_READY_DELAY_MS` | `500` | Pause after opening a pane before typing the launch command — raise it if a slow shell (direnv etc.) drops the command |
| `worktreeCreateCommand` | `PI_SUBAGENT_WORKTREE_CREATE_COMMAND` | `git worktree add` under `.pi/worktrees/` (exact string in [Worktree isolation](#worktree-isolation)) | Shell command (via `bash -c`) that creates a worktree and prints its directory |
| `worktreeCleanupCommand` | `PI_SUBAGENT_WORKTREE_CLEANUP_COMMAND` | `git worktree remove` + branch delete (exact string in [Worktree isolation](#worktree-isolation)) | Shell command that removes a finished child's worktree |
| `worktreeCleanupMode` | `PI_SUBAGENT_WORKTREE_CLEANUP_MODE` | `auto` | `auto` removes clean worktrees after a successful child; `never` always keeps them |

```json
{
  "layout": "window",
  "mainWidth": "60%",
  "shellReadyDelayMs": 500,
  "worktreeCleanupMode": "auto"
}
```

Env vars are validated as strictly as the file. Use the file for your stable, dotfiles-managed baseline and env vars for per-project (direnv) or one-off overrides.
