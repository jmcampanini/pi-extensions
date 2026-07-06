# interactive-subagents

Spawn sub-agents as **real, visible pi sessions in tmux panes**. The parent
session's model calls a `subagent` tool that returns immediately; the child
runs in its own pane where you can watch it or take it over; when it finishes,
its result is steered back into the parent conversation asynchronously.

Design is derived from a full dissection of
[HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents)
(analysis in `.sandbox/analysis/`), rebuilt deliberately smaller. This is a
fresh design — the older `subagent/PLAN.md` (in-process, synchronous MVP) is
superseded and was deleted.

## Core commitments

1. **Children are real terminal sessions.** Full `pi` processes in tmux panes,
   not in-process sub-loops. You can watch and type into any child.
2. **The filesystem is the only IPC.** Session `.jsonl` files, an `.exit`
   sidecar, artifact files. The pane's screen is the crash-detection channel
   of last resort.
3. **The LLM stays in the loop.** Results arrive as steered messages
   (`pi.sendMessage(…, { triggerTurn: true, deliverAs: "steer" })`) that wake
   the parent model. The prose of those messages is the protocol.

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
- **Two session modes.** `fork` (child session seeded with the parent's
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
| `<child-session>.jsonl.meta` | parent (at launch) | launch metadata (name, agent, tools, model, system-prompt file, auto-exit) so `subagent_resume` reapplies the child's identity |
| `artifacts/<sid>/interactive-subagents/…` | parent | task files (`@file` delivery), system prompts, launch scripts |
| pane screen | child's shell | `__SUBAGENT_DONE_<code>__` sentinel — crash net |

User-facing configuration (config.ts) resolves defaults < config file < env:

| Config key (file) | Env override | Default | Purpose |
|---|---|---|---|
| `layout` | `PI_SUBAGENT_LAYOUT` | `window` | Pane layout: `main` (main-vertical — parent stays big, children stack in a side rail, re-flows on spawn/exit), `window` (all children in a dedicated tiled sibling window named `<current window>-subagents`), `off` (plain right-split in place, no re-flow) |
| `mainWidth` | `PI_SUBAGENT_MAIN_WIDTH` | `60%` | Width of the parent pane in `main` layout (a tmux width: `60%` or an absolute column count) |
| `shellReadyDelayMs` | `PI_SUBAGENT_SHELL_READY_DELAY_MS` | `500` | Pause after creating a pane before typing the launch command (raise it if a slow shell drops the command) |

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
| `PI_SUBAGENT_ID`, `PI_SUBAGENT_ACTIVITY_FILE` | *(reserved for v2 liveness)* |

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

### v1 — the primitive (this version)

- `index.ts` — orchestrator: `subagent`, `subagents_list`, `subagent_resume`
  tools; per-child registry + watcher; steer-back delivery; dumb widget
  (name + elapsed time, no state machine); /subagents-running jump picker (Enter =
  go to the child's pane across windows, z = go + zoom) and
  /subagents-available overview widget.
- `tmux.ts` — pane create/type/read/close; bash-script command transport;
  the exit poller (sidecar → screen sentinel → pane-closed grace).
- `session.ts` — fork seeding; summary extraction (last assistant message,
  with the `stopReason: "error"` → `errorMessage` fallback).
- `implant.ts` — child-side: `subagent_done`, `caller_ping`, auto-exit.

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

### v2 — liveness

- `activity.ts`: implant-side recorder (pi lifecycle events → atomic
  tmp+rename JSON snapshot with `(updatedAt, sequence)` ordering + run-id
  ownership) and parent-side validating reader.
- `status.ts`: pure state machine — `starting / active / waiting / stalled`
  with a 60s watchdog. Only *invalid/missing/stuck-at-starting* snapshots can
  stall; a valid `active` snapshot never ages out (long tool runs are fine).
- Widget upgrades to real states (`active · bash 7m`); edge-triggered
  stalled/recovered steer messages, suppressed for interactive
  (non-auto-exit) children.

### v3 — interrupt

- `subagent_interrupt`: send Escape to the pane (turn-level abort; session
  and pane survive) + the sequence-fenced local status override so a stale
  pre-interrupt snapshot can't flip the widget back to `active`.

## Verification

Each version lands with a scripted end-to-end proof (detached tmux session,
`pi -ne -e interactive-subagents/index.ts`, a hidden `test-echo` agent def,
assertions on the steered `subagent_result` in the parent session file), plus
a `caller_ping` → `subagent_resume` round-trip test.
