# interactive-subagents

`interactive-subagents` gives Pi visible, controllable parallelism by running bounded tasks as real Pi sessions in tmux panes.

## Design goals

- Keep delegation observable: watch a child or type in its pane to take over.
- Return results and help asynchronously so the parent stays responsive.
- Make context and filesystem isolation deliberate choices.
- Provide one primitive, not a workflow engine. Use it for independent work, not trivial, tightly coupled, or critical-path tasks. Children cannot spawn children.

The parent assigns work, the child owns its conversation and pane, and the result returns to the parent on its own, waking it in a new turn. Ending the parent turn is how the model waits: while children run it works only on tasks that need nothing from them, and when its next step depends on a result it says what it is waiting on and ends its turn. This waiting contract is stated positively everywhere the model reads it - the tool texts and a static block injected into the parent's system prompt alongside the agent catalogue.

## First run

Requirements are Node.js 22.19 or newer, Pi, and tmux 3.0a or newer. The parent must run inside tmux with a persistent session. Installation alone is insufficient, and spawning fails without a parent session file.

Child panes inherit the tmux server's environment directly; they do not run interactive shell startup files. Ensure `pi` and every configured external harness binary are on the tmux server's `PATH`, restarting the server after PATH changes when necessary.

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
  context: "new",
  autoExit: true,
  worktree: false,
});
```

This uses the listed `worker` in the parent's working directory with explicit new context, automatic exit, and no worktree. It returns `started`; the answer arrives on its own in a new parent turn.

## Choose where context comes from

| Need | Choice |
| --- | --- |
| A self-contained task | Use `context: "new"`, the default. Project files and instructions still load. Include the objective, paths, facts, constraints, edit permission, output, and verification in the task. |
| Parent discussion or decisions would be difficult or lossy to restate | Use `context: "forked"`. It copies completed parent history as of the moment the child launches - immediately when a concurrency slot is free, or when a queued launch starts. That history goes to the child's selected model and provider, so do not fork unnecessary or sensitive context. A first-turn fork may fail before the parent session is written. |
| Follow-up depends on a child's findings or tool history | Use `subagent_resume` to continue that child's conversation. |
| A human should drive the pane | Set `autoExit: false`. The child normally finishes by calling `subagent_done`, or can ask for help with `caller_ping`. |

## Model-facing tools

Parent operations use the singular `subagent` namespace: model tools follow `subagent_<operation>`, and slash commands follow `/subagent-<operation>`. Creation is `spawn` because it launches an existing agent definition as an independent child process and session; it does not create a definition.

- **`subagent_spawn`** starts a child. `name` and `task` are required. Calls can choose an agent, context, model, thinking, tools, directory, worktree, and exit behavior. Call values override agent definitions. For Pi-harness agents, `model` takes an exact id from the usable-models list at the end of the parent's system prompt (see below); external harnesses use their own model names. When `model` is omitted, the agent definition's model choice applies; without one, the child harness selects normally. A wrong Pi model id fails immediately with the usable ids in the error, so a nickname guess corrects itself in one step. Explicit `worktree: true` cannot be combined with `cwd`. Returns `started`, or `queued` at the concurrency limit (see Concurrency and the launch queue). Its rendered call always names the model state and effective context (`new` or `forked`): Pi children without a selected model say `inherits model`, unresolved Pi selections briefly say `model resolving`, successful selections settle to canonical `provider/model`, external children without a selection say `model harness default`, and historical rows that predate persisted model metadata say `model unknown`. It also exposes effective non-default launch behavior when the child is interactive (`autoExit: false`), uses a worktree, or uses a non-`pi` harness, whose exact name is shown.
- **`subagent_available`** reports the fresh definition inventory: each agent's source and routing markers, its `details` (or full `description` when `details` is absent), effective model and launch configuration, and definition problems, followed by the parent's current model and the full usable Pi model list. The current model appears only here, live on every call, so a `/model` switch never rewrites the cached system prompt. Use it to select an agent, pick a model, or diagnose definitions; it does not report child runs.
- **`subagent_status`** reports every unresolved child instance, including queued launches and results still being delivered. Model output is a flat labeled list with each short id first and that instance's exact current state (`queued`, `starting`, `active`, `waiting`, `stalled`, or `delivering`), never an aggregate summary. Its collapsed TUI call puts the configured expansion-key hint beside `subagent status`, followed by a blank line and every concise `id · agent · name · state` row; expansion reveals the detailed guidance. Use it for one-shot lifecycle diagnosis; while any child is unresolved, its model output ends with a standing reminder that results arrive on their own and a waiting parent should end its turn.
- **`subagent_cancel`** resolves one short `id` against its current lifecycle state and cancels work that has not run or asks a running child to stop. It returns immediately: `cancelled` guarantees that no result will arrive, while `stopping` means a stopped notice arrives on its own like any result. A running stop may leave partial work, and any worktree is kept. Interactive children may have a human working in their pane, so cancel an `autoExit: false` child only when the user clearly wants that.
- **`subagent_resume`** handles help, retries, and follow-up while restoring launch identity. Use `id` in the same parent process, including after `/reload`; after restart use `sessionPath`. Autonomous resume requires a message. Message-free resume requires an effective `autoExit: false` for human control. A resume opens a new pane and process, so it consumes a concurrency slot exactly like a spawn and can return `queued` the same way.

A blocked child calls `caller_ping` and exits. Its question wakes the parent, which answers with `subagent_resume({ id, message })`.

The parent needs no discovery round trip: its system prompt ends with a compact catalogue of the effective agents for the working directory, one line per agent with its `description` and routing markers (`default`, `interactive`, `external: <name>`, `new-only`, or `not spawnable`), then the usable Pi model ids, then the static waiting contract (results arrive on their own; ending the turn is how the model waits). The model list is the session's scoped models (Pi's `enabledModels` setting or `--models` flag, the same set `/scoped-models` shows) as exact `provider/model` ids; an unscoped session lists every model whose provider has credentials, bounded to 20 rows plus a `+N more` pointer. The list names Pi models only: external-harness agents take `model` verbatim in their own tool's names. The contract text never changes, so it adds no prompt-cache churn beyond the catalogue's own. Each injected description is flattened to one line and truncated to 200 characters with an ellipsis, so a definition cannot grow the parent's context; the source text stays intact for the detailed surfaces. The catalogue is a snapshot taken at session start (including `/reload`, `/new`, and `/resume`) and refreshed whenever `subagent_available` or `/subagent-available` computes a fresh inventory. A snapshot that lags a mid-session file edit blocks nothing, because `subagent_spawn` reads definitions from disk at call time.

## Agent definitions and trust

Definition filename stems are agent identifiers; their Markdown bodies extend the child system prompt. Identifiers are non-empty, contain no whitespace, and occupy at most 20 terminal display columns. Task display names remain free-form and may contain spaces. Only definition files with valid identifiers are discovered, and explicit invalid `agent` values are rejected. `<cwd>/.pi/subagents/` shadows `$PI_CODING_AGENT_DIR/subagents/`, normally `~/.pi/agent/subagents/`. A repository can replace `worker`, so inspect `.pi/subagents/` in untrusted repositories.

Optional frontmatter keys are `description`, `details`, `models`, `thinking`, `tools`, `context`, `auto-exit`, `worktree`, `harness`, and `harness-pass-through`. Omitted model, thinking, and tools settings inherit Pi defaults; the other defaults are `new`, `true`, `false`, and `pi`. A model list is tried in order until a usable exact match is found (external harnesses instead take the first entry verbatim; see External harnesses). Call values override frontmatter, which overrides built-in defaults.

`description` is the compact routing text: one sentence for the parent's injected catalogue, where it renders bounded to 200 characters. `details` is an optional expanded explanation for humans and explicit discovery, shown untruncated by `subagent_available` and beneath the description headline in `/subagent-available`. When it is absent, `subagent_available` shows the full `description` instead and the overview keeps its headline-only card, so description-only definitions work unchanged.

## External harnesses

An agent definition can run its children as a different command-line coding tool instead of Pi. Two frontmatter keys control this:

- `harness:` names the tool. Absent or `pi` keeps today's behavior. `claude-code` runs the child as Claude Code. Unknown values make the agent unspawnable, loudly.
- `harness-pass-through:` is a raw string of extra command-line flags appended verbatim to the launch command. Tool-specific flag knowledge lives here, not in the extension. It is also honored for `pi` children, with the same append-verbatim semantics.

For external agents the other keys are reinterpreted in the tool's own vocabulary: the first `models:` entry is passed verbatim as the tool's model name (no Pi registry lookup), `tools:` becomes the tool's allowed-tools list using its own tool names (`--allowedTools` for Claude Code), and `thinking:` maps to the tool's effort setting (`--effort`; Pi's `minimal` maps to `low`, `low` through `max` pass through, and `off` is rejected because Claude Code silently ignores out-of-range values). External sub-agents are new-only; `forked` is a Pi-harness capability because a Pi conversation cannot be transplanted into a different tool.

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

## Concurrency and the launch queue

At most `maxConcurrentSubagents` children run at once (default 9 - the most panes the dedicated tmux window tiles legibly). The limit counts every child holding a pane: autonomous, interactive, and external-harness children alike, from spawns and resumes. Children whose result is still `delivering` have already released their pane and do not count.

A launch past the limit is queued, not rejected: the tool call returns `queued` immediately with the child's id, and the launch starts automatically, in call order, as running children exit. A queued entry is pure data - no worktree, session file, or pane exists until it actually starts - so cancelling it (with `subagent_cancel` or `x` in `/subagent-status`) cleans up nothing and guarantees that no result will arrive. Fan-out needs no batching logic: issue all the spawns at once and the queue self-batches through the limit. One semantic difference from an immediate start: a `forked` child copies the parent conversation at launch time, so a fork that waited in the queue sees the parent as of when it actually started.

Because side effects wait for the slot, a queued launch can fail when it finally starts (its directory vanished, tmux refused a pane). The failure arrives as a message naming the child, the error, and what to do - the entry is removed and nothing half-started is left behind. Both launch tool descriptions advertise the effective configured limit, and `/reload` preserves the queue along with running children; quit, `/new`, and `/resume` discard it.

## Parallel edit safety

Never give parallel children overlapping write scopes in one checkout. Assign disjoint files or use `worktree: true`.

The built-in creator makes a worktree under `<repo>/.pi/worktrees/` on a `pi/<name>` branch. Custom creators may use another location or detached HEAD.

Cleanup favors leftovers over lost work. `auto` removes only a successful, provably unchanged worktree. Files, commits, failure, stop, crash, or unverifiable state keep it. Results report the location, optional branch, and outcome for inspection or merging.

## Observe, control, and receive results

The live display and `subagent_status` expose exact lifecycle states. Running children are `starting`, `active`, `waiting`, or `stalled`. Stalled means liveness reports stayed missing, unreadable, or stale for 60 seconds, or a prompted run never started. It is a warning, not completion; supervision continues. A valid `active` report does not age out because a long tool may emit no events. `delivering` means the child exited and its result awaits a parent turn boundary. `queued` means the launch is waiting for a concurrency slot and has not started.

Cancellation resolves the id's state when the action executes; callers do not choose between cancel and stop variants:

| State at cancellation | Behavior | Result word |
| --- | --- | --- |
| `queued` | Remove the launch before it has side effects. | `cancelled` |
| `starting` | Prevent and unwind a launch that has not registered; if its child process is already registered, ask it to stop instead. | `cancelled`, or `stopping` if already running |
| `active`, `waiting`, or `stalled` | Ask the running child to stop; a repeated request is a successful no-op while it is stopping. | `stopping` |
| `delivering` | Reject the request because the result is already on its way and cannot be revoked. | error |
| Already cancelled, completed, or unknown | Reject the stale or unknown id. | error |

`cancelled` means the work never ran, or its launch was fully prevented: no subagent result will ever arrive. `stopping` is asynchronous: it returns immediately, partial work may remain, and exactly one stopped notice arrives on its own. Stopped worktrees are kept for inspection or resumption, and the notice gives the relevant resume and worktree guidance. A stopped notice says either “Stopped by the user.” or “Stopped because you cancelled it.” so human intervention is distinguishable from the model's own request; if both request a stop, the first requester remains attributed.

Human controls use the same lifecycle-aware operation. This includes `x` on a launch still shown as `starting`, not only queued and running children. Because an interactive (`autoExit: false`) child may have a human actively working in its pane, stop it only when the user clearly intends that work to end.

- `/subagent-available` toggles the zero-token definition overview: one card per agent, then a Models section listing the usable ids with the parent's current model marked.
- The compact widget shows at most `widgetMaxRows` detailed rows ordered by attention: delivering, stalled, waiting, starting, active, then queued, with launch order inside each group. When rows are hidden, a final summary reports `+N more` and nonzero hidden stalled, waiting, and queued counts in that order. Marker columns appear only when used by a visible row, in `e`, `f`, `i`, `w` order: external harness, forked context, interactive (`autoExit: false`), and worktree. Unbracketed agent identifiers and marker letters render as secondary metadata; `e` replaces the compact widget's full harness suffix.
- `/subagent-status` is the bounded-height, live, scrollable show-all/control view for every compact-widget state. While open, it hides the compact widget and takes its place; closing it restores the widget. It reuses the widget's agent, marker, plain task text, activity, status, context, and right-aligned clock layout without a redundant heading, adding only a selection gutter and control chrome. A blank line separates the rows from the selected row's footer, which names its exact external harness when applicable and advertises only valid actions. The view refreshes while open and keeps selection on the same child as rows move. Use arrows or `j`/`k` to select. Running rows support Enter to visit, `z` to visit and zoom, and `x` to stop; queued rows support `x` to cancel; starting rows support `x` to cancel the launch or stop a child that has just registered. Delivering rows remain visible but have no action. Escape or Ctrl+C closes the view.
- Type directly in a child pane to take over. Escape during an automatic turn keeps the pane open; automatic exit remains armed for the next completed turn.
- Expand compact tasks and results with Pi's configured tool-expansion key, Ctrl+O by default.

Completion, failure, user stop, and help are explicit. Results include resume guidance and available context use and run cost.

Results reach the parent through Pi's steering queue. Under Pi's default `steeringMode` setting, `"one-at-a-time"`, queued results deliver one per turn boundary, so several children finishing while the parent is working arrive spread across its following turns, each answered separately. Set `steeringMode` to `"all"` in Pi's settings to receive every queued result at the next boundary at once.

A successful `/reload` preserves running children, pending cleanup and delivery, and short ids within the same parent Pi process. If the replacement extension fails to load, preserved children are stopped after a 30-second handoff timeout. Quit, `/new`, `/resume`, `/fork`, crashes, and process restarts do not reconstruct live supervision, though session files and retained worktrees survive where possible. If sending a result throws, the next normally completed parent run or a later successful `/reload` retries it. Escape can drop a result queued behind a streaming parent, leaving its row in `delivering` temporarily. After the next normally completed parent run proves the queued copy is gone, the extension redelivers it; each row clears when its result actually lands, without duplicating outcomes.

## Configuration

Settings resolve from built-in defaults, then `$PI_CODING_AGENT_DIR/subagents.json`, then environment overrides. Invalid files or configured values prevent the extension from loading; fix the reported problem and run `/reload`.

| Key | Default |
| --- | --- |
| `layout` | `window` (`main` and `off` are also valid) |
| `mainWidth` | `60%` |
| `maxConcurrentSubagents` | `9` (`1` through `9`; further launches queue) |
| `callPreviewLines` | `3` (start and resume calls, `0` through `20`) |
| `resultPreviewLines` | `3` (completed, failed, and stopped results, `0` through `20`) |
| `widgetMaxRows` | `5` (positive integer; compact-widget detailed-row cap) |
| `worktreeCreateCommand` | Built-in Git creation under `.pi/worktrees/` |
| `worktreeCleanupCommand` | Built-in Git removal and branch deletion when applicable |
| `worktreeCleanupMode` | `auto` (`never` always keeps worktrees) |

Preview limits count visual lines after sanitized, whitespace-flattened text wraps to the current terminal width. A value of `0` removes the preview. Collapsed results keep status and elapsed time in the header, then the preview, then a final footer with available context/result sizes and the configured expansion-key hint. Results add an ellipsis when the line limit hides more preview text; start and resume calls rely on the configured expansion-key hint instead. Persisted result previews keep at most 2,000 source code points plus an ellipsis, so that storage ceiling can be reached before a high visual-line limit on a very wide terminal. Expansion preserves the complete existing content, including Markdown rendering for results. Expanded results show any stop notice or failure first, then the response, a muted `result details` divider, an aligned status/identity/capabilities/metrics table, and finally worktree, session, and resume guidance. The model-facing result envelope remains metadata-first and includes available model and effort values, non-default mode flags, and tool restrictions before the response.

Every key has a matching environment override named `PI_SUBAGENT_` plus the key in SCREAMING_SNAKE (for example `PI_SUBAGENT_MAX_CONCURRENT_SUBAGENTS` and `PI_SUBAGENT_WIDGET_MAX_ROWS`):

```json
{
  "callPreviewLines": 3,
  "resultPreviewLines": 3,
  "widgetMaxRows": 5
}
```

For a denser widget, put `{"widgetMaxRows": 3}` in `subagents.json` or launch Pi with `PI_SUBAGENT_WIDGET_MAX_ROWS=3`; the environment wins over the file. Use `/subagent-status` whenever the summary reports hidden rows.

This README owns design intent, operating decisions, and stable user-facing contracts. Source files and tests own exact mechanics and rendering, Git owns shipped history, and issues own future work.
