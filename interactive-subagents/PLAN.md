# interactive-subagents

Spawn sub-agents as **real, visible pi sessions in tmux panes**. The parent
session's model calls a `subagent` tool that returns immediately; the child
runs in its own pane where you can watch it or take it over; when it finishes,
its result is steered back into the parent conversation asynchronously.

Design is derived from a full dissection of
[HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents),
rebuilt deliberately smaller.

## Core commitments

1. **Children are real terminal sessions.** Full `pi` processes in tmux panes,
   not in-process sub-loops. You can watch and type into any child.
2. **The filesystem is the only IPC.** Session `.jsonl` files, an `.exit`
   sidecar, artifact files. The pane's screen is the crash-detection channel
   of last resort.
3. **The LLM stays in the loop.** Results arrive as steered messages
   (`pi.sendMessage(…, { triggerTurn: true, deliverAs: "steer" })`) that wake
   the parent model. The prose of those messages is the protocol. Delivery is
   observed, not assumed: the extension watches `message_end` for its own
   sends and keeps the child's widget row visible (`delivering`) until the
   message lands.

## Scope decisions (locked)

- **tmux only.** Thin backend module; no cmux/zellij/wezterm.
- **No Claude Code backend.** pi children only.
- **Agent definitions are files; filename = agent name** (no frontmatter
  `name` key). Global dir (`$PI_CODING_AGENT_DIR/subagents/`, default
  `~/.pi/agent/subagents/`) plus project-local `<cwd>/.pi/subagents/` —
  project shadows global. No trust gating: what a repo's `.pi/subagents/`
  contains is the user's responsibility. Nothing bundled.
- **`worker` is the default agent.** A spawn without `agent` runs as
  `agent: "worker"` through the identical machinery — there is no "bare"
  spawn. Missing `worker.md` is a loud spawn error, not a fallback.
- **Two starting contexts.** `forked` (child session seeded with the parent's
  conversation minus the in-flight turn — preserves provider prompt-cache
  affinity) and `fresh` (clean context; pi creates the session file).
- **No recursion.** Children never get the spawn tools (the extension detects
  it is running inside a subagent via `PI_SUBAGENT_SESSION` and skips
  registering them). Depth is hard-capped at 1.
- **No workflow/plan features.** The subagent primitive only.

## The contract (all versions)

Files, per child:

| Path | Written by | Purpose |
|---|---|---|
| `<child-session>.jsonl` | parent (fork seed) + child (transcript) | context, result extraction, resume anchor |
| `<child-session>.jsonl.exit` | child implant | typed exit intent: `{type: "done" \| "ping" \| "error"}` — one-shot, parent deletes on read |
| `<child-session>.jsonl.meta` | parent (at launch) | launch metadata (name, agent, tools, model, thinking, system-prompt file, auto-exit, worktree snapshot) so `subagent_resume` reapplies the child's identity |
| `<child-session>.jsonl.activity` | child implant | liveness snapshot (atomic tmp+rename overwrite, `(updatedAt, sequence)` ordering, run-id ownership) — read by the parent's poll tick; kept after exit (it carries the closing context/cost numbers), cleared by the next (re)launch into that session |
| `artifacts/<sid>/interactive-subagents/…` | parent | task files (`@file` delivery), system prompts, resume follow-up messages, launch scripts |
| pane screen | child's shell | `__SUBAGENT_DONE_<code>__` sentinel — crash net |

User-facing configuration (config.ts) resolves defaults < config file < env:

| Config key (file) | Env override | Default | Purpose |
|---|---|---|---|
| `layout` | `PI_SUBAGENT_LAYOUT` | `window` | Pane layout: `main` (main-vertical — parent stays big, children stack in a side rail, re-flows on spawn/exit), `window` (all children in a dedicated tiled sibling window named `<parent window>-subagents`), `off` (plain right-split in place, no re-flow) |
| `mainWidth` | `PI_SUBAGENT_MAIN_WIDTH` | `60%` | Width of the parent pane in `main` layout (a tmux width: `60%` or an absolute column count) |
| `shellReadyDelayMs` | `PI_SUBAGENT_SHELL_READY_DELAY_MS` | `500` | Pause after creating a pane before typing the launch command (raise it if a slow shell drops the command) |
| `worktreeCreateCommand` | `PI_SUBAGENT_WORKTREE_CREATE_COMMAND` | `git worktree add` under `.pi/worktrees/` | Shell command (via `bash -c`, parent cwd, `PI_SUBAGENT_WORKTREE_NAME` in env) that creates a worktree; must exit 0 and print the directory as the last non-empty stdout line |
| `worktreeCleanupCommand` | `PI_SUBAGENT_WORKTREE_CLEANUP_COMMAND` | `git worktree remove` + branch delete | Shell command (gets `PI_SUBAGENT_WORKTREE_DIR` / `PI_SUBAGENT_WORKTREE_BRANCH`, branch empty when detached) that removes a finished child's worktree |
| `worktreeCleanupMode` | `PI_SUBAGENT_WORKTREE_CLEANUP_MODE` | `auto` | `auto` removes a worktree only when the child succeeded AND it is clean (no uncommitted/untracked files, HEAD still on the base commit — committed work counts as dirty); `never` always keeps |

The file is `$PI_CODING_AGENT_DIR/subagents.json` (default
`~/.pi/agent/subagents.json`). Missing = defaults; malformed =
the extension refuses to LOAD, naming the file and key (deliberate fail-fast,
per the same philosophy as model resolution). Loaded once at import; edits
take effect on `/reload`.

Env vars (parent → child, prefixed onto the launch command because tmux panes
run a fresh shell and inherit nothing):

| Var | Purpose |
|---|---|
| `PI_SUBAGENT_SESSION` | where the implant writes the `.exit` sidecar |
| `PI_SUBAGENT_NAME` | display name (ping messages) |
| `PI_SUBAGENT_AUTO_EXIT=1` | child exits when its turn completes (autonomous agents) |
| `PI_CODING_AGENT_DIR` | propagated when the parent has a custom config root |
| `PI_SUBAGENT_ID` | 8-char run id minted per launch — stamps liveness-snapshot ownership |
| `PI_SUBAGENT_ACTIVITY_FILE` | absolute path of the liveness snapshot the implant's recorder writes |

## Known v1 limitations

- **"Credentials configured" ≠ "calls will succeed."** Model selection
  (`models:` list) picks the first entry whose provider has auth configured
  (`modelRegistry.hasConfiguredAuth`), but an account-level problem — e.g.
  Anthropic subscription OAuth without extra usage enabled — passes that
  check and only fails at request time, leaving the child pane showing the
  provider error. v2's stall watchdog will surface that; v1 can't detect it
  locally.

- **Auto-exit children exit on the first errored turn.** pi's own auto-retry
  might have recovered a transient provider error (429/overload), but the
  implant can't see pi's retry decision from `agent_end`, so it reports the
  failure immediately; the parent can always `subagent_resume` to retry.
  Revisit in v2, where the stall watchdog makes waiting out retries safe.
- **No recursion, by design** — children never get spawn tools in v1.

## Versions

### v1 — the primitive (shipped)

One file per job; `index.ts` only wires them into pi:

- `protocol.ts` — the parent↔child contract: child env vars, the `.exit`
  sidecar shape, and both halves of the exit sentinel.
- `config.ts` — layered settings (defaults < `subagents.json` < env),
  validated at extension load (fail-fast).
- `models.ts` — first-usable-model resolution for `models:` candidate lists.
- `agents.ts` — agent definition files (frontmatter parsing,
  project-shadows-global lookup) and the inventory built from them.
- `worktree.ts` — git worktree isolation: runs the user-pluggable
  create/cleanup commands, the dirty check, and the end-of-run keep/remove
  policy (see the README's "Worktree isolation" section for the contract).
- `session.ts` — pi session `.jsonl` handling: fork seeding; summary
  extraction (last assistant message, with the `stopReason: "error"` →
  `errorMessage` fallback).
- `tmux.ts` — pane create/type/read/close; bash-script command transport;
  the exit poller (sidecar → screen sentinel → pane-closed grace).
- `launch.ts` — the ONE builder for a child's launch command, plus the
  `.meta` launch-metadata sidecar.
- `state.ts` — shared runtime state: running children, delivering children
  (result in flight), the resume ledger, /reload-safe teardown.
- `widget.ts` / `running-widget.ts` — pure renderer / stateful controller for
  the running widget (liveness segment plus the delivering exit state).
- `watcher.ts` — per-child supervision and the steered result/ping messages.
- `implant.ts` — child-side: `subagent_done`, `caller_ping`, auto-exit.
- `tool-subagent.ts`, `tool-resume.ts`, `tool-list.ts` — one file per
  model-facing tool.
- `command-available.ts` — /subagents-available overview widget (zero-token).
- `command-running.ts` — /subagents-running picker (Enter = go to the child's
  pane across windows, z = go + zoom, x = stop — the model is notified).

Seams reserved so v2/v3 are additions, not rework:

- `pollForExit` accepts an `onTick` callback (v1 passes nothing; v2 attaches
  snapshot observation there).
- All child env vars flow through one `buildChildEnv()` function.
- The `RunningSubagent` record and registry exist from day one.

Deliberate improvements over the reference implementation:

- Clean auto-exit **writes a `done` sidecar** (reference relied on the screen
  sentinel for that path). Rule of thumb: every intentional exit writes a
  sidecar; the screen sentinel only catches crashes.
- A killed pane with no sidecar resolves as a **failure after a short grace**
  (reference looped forever).
- `subagent_resume` **reapplies the whole identity envelope** — a `.meta`
  sidecar written at launch records the child's system-prompt file, tools,
  model, and auto-exit, and resume restores them automatically (the reference
  silently dropped all of it, so resumed agents lost their identity and
  restrictions).
- **Resume by short id.** Results and pings say `subagent_resume({ id:
  "a55ba067", … })` — resolved through an in-session ledger — instead of
  making the model copy a long session path out of prose (the reference's
  approach, kept only as the `sessionPath` fallback for after restarts).
- Watchers **skip steering after shutdown abort** (reference attempted to
  steer into a dying session).

### v2 — liveness (shipped)

- `activity.ts`: implant-side recorder (pi lifecycle events → atomic
  tmp+rename JSON snapshot with `(updatedAt, sequence)` ordering + run-id
  ownership) and parent-side validating reader. The snapshot carries the
  state inputs (current tool name + start time from
  `tool_execution_start`/`_end`, turn boundaries from
  `agent_start`/`agent_settled`) and the child's context economics, refreshed
  from each `turn_end` message's `usage`: context tokens in use, the model's
  context window, and cumulative cost.
- `status.ts`: pure state machine — `starting / active / waiting / stalled`
  with a 60s watchdog. Only *invalid/missing/stuck-at-starting* snapshots can
  stall; a valid `active` snapshot never ages out (long tool runs are fine).
- Widget upgrades to real states plus fixed-width context tokens on the
  right edge (`bash 7m · active ·  84k · 03:12`); edge-triggered stalled/recovered
  steer messages, suppressed for interactive (non-auto-exit) children.
- `subagents_list` reports each child's context tokens/window and cost, so
  the parent model can decide when a child is too full to keep resuming.

### v2.1 - observed delivery (this version)

- `delivery.ts`: a `message_end` listener that observes this extension's own
  `subagent_result` / `subagent_ping` messages landing in the parent
  transcript, matched by customType plus `details.id` (the stalled/recovered
  liveness steers share the id shape and are deliberately excluded).
- Exited children move from `running` to a `delivering` map at exit
  detection, BEFORE any send or await (on an idle parent the landing event
  fires within microtasks of the send), and their widget row stays visible -
  restyled `delivering`, clock frozen at exit - until the message lands.
- Escape while the parent streams drops queued steers silently, so a
  `delivering` row that never clears is the deliberate, honest signal of a
  lost result. No re-send, no coalescing (out of scope); /reload clears it.
- `subagents_list` gains a "Finished, result on its way" section so a child
  is never invisible between exit and delivery.

### v3 — interrupt

- `subagent_interrupt`: send Escape to the pane (turn-level abort; session
  and pane survive) + the sequence-fenced local status override so a stale
  pre-interrupt snapshot can't flip the widget back to `active`.

## Verification

Two layers:

- **Unit tests** (`tests/*.ts`, run with `node --experimental-strip-types`)
  cover the pure leaf modules: config layering and fail-fast, model
  resolution, widget rendering, fork cut-point selection, agent-definition
  parsing/shadowing, delivery matching (customType + id narrowing, fakePi
  listener round trip), and the exact launch-command bytes.
- **E2E scripts** (`.sandbox/e2e-*.sh`) prove the real thing: each starts a
  detached tmux session, launches an interactive
  `pi -e interactive-subagents/index.ts` parent, writes throwaway agent
  definitions (e.g. an echo agent in `~/.pi/agent/subagents/`), and greps the
  parent session `.jsonl` for the steered `subagent_result` /
  `subagent_ping` entries. The suite covers spawn/echo, the `caller_ping` →
  `subagent_resume` round trip, fork seeding, model fallback + fail-fast,
  config load failure, the layout strategies, the human commands, the
  running picker (jump/zoom/stop), project-local agents, and the delivering
  widget state (a row survives a mid-turn exit and clears when the result
  lands).
