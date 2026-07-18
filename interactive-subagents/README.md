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

Use `/subagents-available` to confirm that `worker` is available and comes from the expected source. A project-local definition can shadow the global file. Then ask the parent to make this minimal call:

```js
subagent({
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

- **`subagent`** starts a child. `name` and `task` are required. Calls can choose an agent, context, model, thinking, tools, directory, worktree, and exit behavior. Call values override agent definitions. Explicit `worktree: true` cannot be combined with `cwd`.
- **`subagents_list`** reports definitions, problems, live children, run economics, and results still being delivered. Use it for selection or diagnosis, not polling.
- **`subagent_resume`** handles help, retries, and follow-up while restoring launch identity. Use `id` in the same parent process, including after `/reload`; after restart use `sessionPath`. Autonomous resume requires a message. Message-free resume requires an effective `autoExit: false` for human control.

A blocked child calls `caller_ping` and exits. Its question wakes the parent, which answers with `subagent_resume({ id, message })`.

## Agent definitions and trust

Definition filenames are agent names; their Markdown bodies extend the child system prompt. `<cwd>/.pi/subagents/` shadows `$PI_CODING_AGENT_DIR/subagents/`, normally `~/.pi/agent/subagents/`. A repository can replace `worker`, so inspect `.pi/subagents/` in untrusted repositories.

Optional frontmatter keys are `description`, `models`, `thinking`, `tools`, `context`, `auto-exit`, `worktree`, `harness`, and `harness-pass-through`. Omitted model, thinking, and tools settings inherit Pi defaults; the other defaults are `fresh`, `true`, `false`, and `pi`. A model list is tried in order until a usable exact match is found (external harnesses instead take the first entry verbatim; see External harnesses). Call values override frontmatter, which overrides built-in defaults.

## External harnesses

An agent definition can run its children as a different command-line coding tool instead of Pi. Two frontmatter keys control this:

- `harness:` names the tool. Absent or `pi` keeps today's behavior. `claude-code` runs the child as Claude Code. Unknown values make the agent unspawnable, loudly.
- `harness-pass-through:` is a raw string of extra command-line flags appended verbatim to the launch command. Tool-specific flag knowledge lives here, not in the extension. It is also honored for `pi` children, with the same append-verbatim semantics.

For external agents the other keys are reinterpreted in the tool's own vocabulary: the first `models:` entry is passed verbatim as the tool's model name (no Pi registry lookup), `tools:` becomes the tool's allowed-tools list using its own tool names (`--allowedTools` for Claude Code), and `thinking:` maps to the tool's effort setting (`--effort`; Pi's `minimal` maps to `low`, `low` through `max` pass through, and `off` is rejected because Claude Code silently ignores out-of-range values). `context: forked` is not supported: a Pi conversation cannot be transplanted into a different tool.

A Claude Code recipe:

```markdown
---
description: Claude Code worker for bounded edit tasks.
harness: claude-code
models: claude-sonnet-5
thinking: medium
tools: Read,Edit,Write,Bash
harness-pass-through: --permission-mode acceptEdits
---
You are a careful worker. Verify your changes before reporting.
```

Choose the `--permission-mode` value for whether a person is present (`acceptEdits` suits unattended edit work; see Claude Code's own documentation for the available modes). Nothing is installed into the external tool; each launch configures per-run lifecycle notifiers on the command line, which report liveness and the final message back through this extension's own sidecar files. The child's final reply arrives as the result; `subagent_resume` reopens the tool's own session by its recorded id. External children never appear in Pi's session picker, and the result message's session reference is a resume handle, not a readable transcript.

Caveat: on the tool's first use in a directory it may show a one-time setup or trust dialog that intercepts the initial task; the child then idles and is reported as stalled. Open the pane, answer the dialog once, and retry (or pre-trust the directory by running the tool there manually once). Trust is inherited from ancestor directories, so worktrees and subdirectories of an already-trusted repository start cleanly.

Observability caveat: Claude Code fires no lifecycle notifier when a human interrupts a turn in the pane, so an interrupted external child can keep reading as `active` (with its last tool shown) until its next completed turn. This is display-only; supervision and completion detection are unaffected.

Intentionally not included in v1: tools beyond Claude Code (the profile registry accepts more later), per-run cost and context-size reporting, mid-run help requests (`caller_ping`), forked context, the in-pane identity banner, and pane-content-based liveness for tools without lifecycle notifiers.

## Parallel edit safety

Never give parallel children overlapping write scopes in one checkout. Assign disjoint files or use `worktree: true`.

The built-in creator makes a worktree under `<repo>/.pi/worktrees/` on a `pi/<name>` branch. Custom creators may use another location or detached HEAD.

Cleanup favors leftovers over lost work. `auto` removes only a successful, provably unchanged worktree. Files, commits, failure, stop, crash, or unverifiable state keep it. Results report the location, optional branch, and outcome for inspection or merging.

## Observe, control, and receive results

The live display and `subagents_list` show `starting`, `active`, `waiting`, or `stalled`. Stalled means liveness reports stayed missing, unreadable, or stale for 60 seconds, or a prompted run never started. It is a warning, not completion; supervision continues. A valid `active` report does not age out because a long tool may emit no events. `delivering` means the child exited and its result awaits a parent turn boundary.

- `/subagents-available` toggles the zero-token definition overview.
- `/subagents-running` uses arrows or `j`/`k` to select, Enter to visit, `z` to visit and zoom, `x` to stop, and Escape or Ctrl+C to cancel.
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
| `worktreeCreateCommand` | Built-in Git creation under `.pi/worktrees/` |
| `worktreeCleanupCommand` | Built-in Git removal and branch deletion when applicable |
| `worktreeCleanupMode` | `auto` (`never` always keeps worktrees) |

This README owns design intent, operating decisions, and stable user-facing contracts. Source files and tests own exact mechanics and rendering, Git owns shipped history, and issues own future work.
