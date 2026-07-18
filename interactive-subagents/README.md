# interactive-subagents

`interactive-subagents` gives Pi visible, controllable parallelism by running bounded tasks as real Pi sessions in tmux panes.

## Design goals

- Keep delegation observable: watch a child or type in its pane to take over.
- Return results and help asynchronously so the parent stays responsive.
- Make context and filesystem isolation deliberate choices.
- Provide one primitive, not a workflow engine. Use it for independent work, not trivial, tightly coupled, or critical-path tasks. Children cannot spawn children.

The parent assigns work, the child owns its conversation and pane, and the result returns to the parent. Continue working or end the parent turn while waiting. Never poll, sleep, or inspect child sessions or panes programmatically for a result.

## First run

Requirements are Node.js 22.19 or newer, Pi, and tmux. The parent must run inside tmux with a persistent session. Installation alone is insufficient, and spawning fails without a parent session file.

Install the package, create the default agent definition in Pi's config root, and start Pi:

```sh
pi install git:github.com/jmcampanini/pi-extensions
PI_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$PI_AGENT_DIR/subagents"
cat > "$PI_AGENT_DIR/subagents/worker.md" <<'EOF'
You are a worker. Complete the assigned task carefully and report what you verified.
EOF
tmux new -A -s pi 'pi'
```

Use `/subagent-available` to confirm that `worker` is available and comes from the expected source. A project-local definition can shadow the global file. Then ask the parent to make this minimal call:

```js
subagent_spawn({
  name: "test map",
  task: "Inspect this repository's test setup and report the commands to run. Do not edit files.",
  context: "fresh",
  autoExit: true,
  worktree: false,
})
```

This uses the listed `worker` in the parent's working directory with explicit fresh context, automatic exit, and no worktree. It returns `started`; the answer arrives automatically.

## Choose where context comes from

| Need | Choice |
|---|---|
| A self-contained task | Use `context: "fresh"`, the default. Project files and instructions still load. Include the objective, paths, facts, constraints, edit permission, output, and verification in the task. |
| Parent discussion or decisions would be difficult or lossy to restate | Use `context: "forked"`. It copies completed parent history before the current turn. That history goes to the child's selected model and provider, so do not fork unnecessary or sensitive context. A first-turn fork may fail before the parent session is written. |
| Follow-up depends on a child's findings or tool history | Use `subagent_resume` to continue that child's conversation. |
| A human should drive the pane | Set `autoExit: false`. The child normally finishes by calling `subagent_done`, or can ask for help with `caller_ping`. |

## Model-facing tools

Parent operations use the singular `subagent` namespace: model tools follow `subagent_<operation>`, and slash commands follow `/subagent-<operation>`. Creation is `spawn` because it launches an existing agent definition as an independent child process and session; it does not create a definition.

- **`subagent_spawn`** starts a child. `name` and `task` are required. Calls can choose an agent, context, model, thinking, tools, directory, worktree, and exit behavior. Call values override agent definitions. Explicit `worktree: true` cannot be combined with `cwd`.
- **`subagent_list`** reports definitions, problems, live children, run economics, and results still being delivered. Use it for selection or diagnosis, not polling.
- **`subagent_resume`** handles help, retries, and follow-up while restoring launch identity. Use `id` in the same parent process, including after `/reload`; after restart use `sessionPath`. Autonomous resume requires a message. Message-free resume requires an effective `autoExit: false` for human control.

A blocked child calls `caller_ping` and exits. Its question wakes the parent, which answers with `subagent_resume({ id, message })`.

## Agent definitions and trust

Definition filenames are agent names; their Markdown bodies extend the child system prompt. `<cwd>/.pi/subagents/` shadows `$PI_CODING_AGENT_DIR/subagents/`, normally `~/.pi/agent/subagents/`. A repository can replace `worker`, so inspect `.pi/subagents/` in untrusted repositories.

Optional frontmatter keys are `description`, `models`, `thinking`, `tools`, `context`, `auto-exit`, and `worktree`. Omitted model, thinking, and tools settings inherit Pi defaults; the other defaults are `fresh`, `true`, and `false`. A model list is tried in order until a usable exact match is found. Call values override frontmatter, which overrides built-in defaults.

## Parallel edit safety

Never give parallel children overlapping write scopes in one checkout. Assign disjoint files or use `worktree: true`.

The built-in creator makes a worktree under `<repo>/.pi/worktrees/` on a `pi/<name>` branch. Custom creators may use another location or detached HEAD.

Cleanup favors leftovers over lost work. `auto` removes only a successful, provably unchanged worktree. Files, commits, failure, stop, crash, or unverifiable state keep it. Results report the location, optional branch, and outcome for inspection or merging.

## Observe, control, and receive results

The live display and `subagent_list` show `starting`, `active`, `waiting`, or `stalled`. Stalled means liveness reports stayed missing, unreadable, or stale for 60 seconds, or a prompted run never started. It is a warning, not completion; supervision continues. A valid `active` report does not age out because a long tool may emit no events. `delivering` means the child exited and its result awaits a parent turn boundary.

- `/subagent-available` toggles the zero-token definition overview.
- `/subagent-running` uses arrows or `j`/`k` to select, Enter to visit, `z` to visit and zoom, `x` to stop, and Escape or Ctrl+C to cancel.
- Type directly in a child pane to take over. Escape during an automatic turn keeps the pane open; automatic exit remains armed for the next completed turn.
- Expand compact tasks and results with Pi's configured tool-expansion key, Ctrl+O by default.

Completion, failure, user stop, and help are explicit. Results include resume guidance and available context use and run cost.

Results reach the parent through Pi's steering queue. Under Pi's default `steeringMode` setting, `"one-at-a-time"`, queued results deliver one per turn boundary, so several children finishing while the parent is working arrive spread across its following turns, each answered separately. Set `steeringMode` to `"all"` in Pi's settings to receive every queued result at the next boundary at once.

A successful `/reload` preserves running children, pending cleanup and delivery, and short ids within the same parent Pi process. If the replacement extension fails to load, preserved children are stopped after a 30-second handoff timeout. Quit, `/new`, `/resume`, `/fork`, crashes, and process restarts do not reconstruct live supervision, though session files and retained worktrees survive where possible. If sending a result throws, a later successful `/reload` can retry it. If Escape interrupts a streaming parent before an accepted queued result lands, Pi can drop it; a permanently `delivering` row is the signal. The extension does not resend accepted results because that could duplicate one that landed.

## Configuration

Settings resolve from built-in defaults, then `$PI_CODING_AGENT_DIR/subagents.json`, then environment overrides. Invalid files or configured values prevent the extension from loading; fix the reported problem and run `/reload`.

| Key | Default |
|---|---|
| `layout` | `window` (`main` and `off` are also valid) |
| `mainWidth` | `60%` |
| `shellReadyDelayMs` | `500` |
| `callPreviewLines` | `3` (start and resume calls, `0` through `20`) |
| `resultPreviewLines` | `5` (completed, failed, and stopped results, `0` through `20`) |
| `worktreeCreateCommand` | Built-in Git creation under `.pi/worktrees/` |
| `worktreeCleanupCommand` | Built-in Git removal and branch deletion when applicable |
| `worktreeCleanupMode` | `auto` (`never` always keeps worktrees) |

Preview limits count visual lines after sanitized, whitespace-flattened text wraps to the current terminal width. A value of `0` keeps only the collapsed header. Results add an ellipsis when the line limit hides more preview text; start and resume calls rely on the configured expansion-key hint instead. Persisted result previews keep at most 2,000 source code points plus an ellipsis, so that storage ceiling can be reached before a high visual-line limit on a very wide terminal. Expansion preserves the complete existing content, including Markdown rendering for results.

The matching environment overrides are `PI_SUBAGENT_CALL_PREVIEW_LINES` and `PI_SUBAGENT_RESULT_PREVIEW_LINES`:

```json
{
  "callPreviewLines": 3,
  "resultPreviewLines": 5
}
```

This README owns design intent, operating decisions, and stable user-facing contracts. Source files and tests own exact mechanics and rendering, Git owns shipped history, and issues own future work.
