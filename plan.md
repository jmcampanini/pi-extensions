# External harnesses for interactive-subagents (issue #49)

This document is self-contained. A fresh agent should be able to implement the
feature from this file alone, without reading any other planning notes.

## Intent

`interactive-subagents` currently runs each child as a real `pi` session inside a
tmux pane, supervised by generic machinery: it creates the pane, tracks liveness
through small sidecar files, delivers the child's result back to the parent
conversation, cleans up, and supports resume.

Issue #49 asks for children that are a *different* command-line coding tool
(starting with Claude Code) rather than `pi`. The agreed approach: add
first-class support for other tools through a small per-tool **profile**, while
the existing supervision machinery stays generic and unchanged. Claude Code is
the only tool implemented in v1. The design is shaped so a second tool (e.g.
Codex) can be added later as another profile without touching the core.

Guiding principle the user cares about: keep the per-tool knowledge **outside**
the core extension (in a profile plus documentation), and keep the amount of
setup that must be configured on the external tool as small as possible. Nothing
is installed into the external tool; everything is configured per-launch on its
command line.

## How a Claude Code child runs (the mechanism)

1. **Launch it as its normal interactive terminal program in the pane**, passing
   the task as a command-line argument. This reuses the extension's existing
   "stage a bash script, then run `bash <script>`" path, so the only thing ever
   typed into the pane is `bash <script>`. The task text rides on the launch
   command line (via a file argument), not through keystrokes.

2. **Configure a set of lifecycle notifiers for this one run** using Claude
   Code's `--settings` option (which accepts a JSON string or a file path). A
   lifecycle notifier is a small command the tool runs at defined moments. Claude
   Code's own documentation calls these "hooks". We register four, each pointing
   at one dependency-free node script we ship, with its arguments baked in:
   - when a prompt starts,
   - when a tool starts,
   - when a tool finishes,
   - when a turn completes.

3. **Each notifier updates the same small sidecar files the supervisor already
   polls.** The turn-completion notifier additionally receives the child's final
   message directly on its standard input (Claude Code passes a
   `last_assistant_message` field in the stdin payload). We take the result
   verbatim from that payload. As a result, the extension only ever reads and
   writes its **own** sidecar files next to the child's anchor path; it never has
   to locate or open the tool's session-history storage. This is simpler and
   keeps file access narrow.

4. **Completion is a file appearing**, exactly as today: the completion notifier
   writes the result file and a session-id file, then writes a one-shot
   completion marker last. The supervisor sees the marker, reads the result file,
   closes the pane, and delivers the result to the parent. Auto-exit semantics
   fall out naturally: the parent closes the pane on the first completed turn.

5. **Resume** relaunches the tool with its own resume flag plus the same
   lifecycle settings, using the session id captured on the first run.

## Facts verified on this machine (Claude Code 2.1.214)

These were confirmed empirically and should be treated as ground truth for v1.

- `--settings <file-or-json>` accepts either a path or an inline JSON string.
  Lifecycle notifier commands with baked-in arguments work.
- All four lifecycle events fire, in order (prompt-start, tool-start, tool-end,
  turn-complete). Each receives a JSON object on standard input containing at
  least `session_id`, `cwd`, and `hook_event_name`.
- The turn-complete payload additionally includes `last_assistant_message`
  (the child's final message) and `session_id`. This is the sole source we use
  for the result and the resume id. No session-history file is opened.
- `--effort` accepts exactly: `low, medium, high, xhigh, max`. An out-of-range
  value only prints a warning and silently falls back to the default. Therefore
  the profile must validate the effort mapping itself and fail the spawn loudly
  on an unmappable value, rather than relying on the tool to reject it.
- `--append-system-prompt-file <path>` exists; prefer it over passing prompt text
  inline, to avoid shell-escaping multi-line text.
- `--allowedTools <list>` works alongside `--settings` without interference.
- On first use in a directory, the tool may show one-time setup dialogs that can
  intercept the initial command-line task (so the child sits idle at an empty
  prompt). The launch must account for this so the passed-in task actually runs
  (e.g. pre-trusting the working directory, or a settings value that avoids the
  one-time gate). Treat this as an open item to resolve at launch time.

## Agent-definition frontmatter

Agent definitions are `<name>.md` files with frontmatter. Add two keys and reuse
existing ones:

- `harness:` — which tool runs the child. Absent or `pi` = today's behavior
  (unchanged). `claude-code` = run a Claude Code child. Unknown value = a loud
  problem (same mechanism the code already uses for invalid frontmatter).
- `harness-pass-through:` — a raw string of extra command-line flags appended
  verbatim to the launch command. This is where tool-specific flag knowledge
  lives, kept out of the core. Documentation gives per-tool recipes. Example for
  Claude Code: set the approval mode with `--permission-mode acceptEdits` for
  unattended edit work; choose the value appropriate to whether a person is
  present (see the tool's own documentation for the available values). Allowed
  for `pi` children too, appended verbatim, for uniform semantics.
- `models:` — for external tools, the first entry is passed verbatim as the model
  name. There is no model-registry resolution for external tools (their model
  names are their own).
- `thinking:` — reused. For Claude Code it maps to `--effort`, with validation
  (see the effort fact above). Suggested mapping: `minimal -> low`;
  `low`/`medium`/`high` pass through; anything unmappable is a loud problem.
- `tools:` — for external tools, passed as the tool's allowed-tools list
  (`--allowedTools` for Claude Code), using the tool's own tool names.
- `context: forked` — not supported for external tools; fail loud. A pi
  conversation cannot be transplanted into a different tool.

## Sidecar contracts

External children reuse the per-child "anchor" path the extension already mints
for a child, but for an external child **no `pi` session file is created** (so it
never appears in `pi`'s session picker). Sidecars sit next to the anchor, exactly
like the existing ones:

- `<anchor>.activity` — the liveness snapshot, in the existing v1 schema, written
  by the notifiers with atomic writes (temp file + rename). The run id stamped
  into it is the launch id, giving the same ownership check the code already does.
- `<anchor>.result` — the child's final message, taken verbatim from the
  turn-complete notifier's stdin payload.
- `<anchor>.exit` — the one-shot completion marker, written last.
- `<anchor>.harness.json` — small JSON holding the external tool's own session id,
  read on resume. (Only the id; nothing else is persisted.)
- `<anchor>.meta` — the existing launch-metadata file plus new fields: the harness
  name, the pass-through string, and the working directory (external children have
  no session header to read the directory back from).

Lifecycle-event to snapshot mapping (one node script, event name as an argument):

- prompt-start → mark the snapshot as "in a run" (this arms the status machine).
- tool-start / tool-end → add or remove an active-tool entry and advance the
  snapshot's ordering counter.
- turn-complete → mark "run finished"; for autonomous children also write the
  result file and the session-id file, then write the completion marker last
  (order matters — the marker is the signal the supervisor waits for).

Concurrent notifier invocations (parallel tools) race the read-modify-write of
the snapshot; last-write-wins is acceptable because ordering stays monotonic
through the snapshot counter, and the worst case is a momentary flicker of one
tool entry.

## Implementation outline (file by file)

1. **New `interactive-subagents/harnesses.ts`** — the profile seam.
   - A profile type with: build-launch-command, build-resume-command,
     map-effort, map-tools, and the completion-instruction text appended to a
     fresh task.
   - A registry containing the `claude-code` profile. Add a comment noting that
     more tools can be added here later, and that a tool without per-tool
     lifecycle events would instead detect liveness from pane-content changes.
   - Claude Code launch shape (assembled through the existing command builder so
     the completion marker suffix stays consistent):
     `cd <cwd> && claude --settings '<lifecycle json>' [--model <first models entry>]
     [--effort <mapped thinking>] [--allowedTools <tools>]
     [--append-system-prompt-file <path>] <pass-through> "$(cat <task file>)"`
     plus the existing completion-marker suffix.
   - Resume shape:
     `claude --resume <session id> --settings '<lifecycle json>' ["$(cat <message file>)"]`.
   - Provide both completion-instruction variants: for autonomous children,
     "your final reply ends the session"; for human-driven children, the run ends
     when the person closes the terminal program, and the last completed turn's
     files already hold the result — the instruction text must not mention any
     `pi`-only completion tools, which external children do not have.

2. **New `interactive-subagents/claude-hook.mjs`** — a small, dependency-free node
   script the lifecycle notifiers call (it must run outside `pi`). One subcommand
   per lifecycle event, implementing the mapping above, using atomic writes with
   the same temp-file-plus-rename approach the existing snapshot writer uses.

3. **`agents.ts`** — parse and validate the two new frontmatter keys; carry them
   in the agent inventory; show the harness name in the human-facing overview as a
   noteworthy (non-default) attribute, the same way "forked" is shown.

4. **`tool-subagent.ts`** — when the harness is external, take a branch that:
   skips `pi`-session seeding and forking; skips model-registry resolution (pass
   the first `models` entry verbatim); lets the profile validate effort; builds
   the launch command from the profile; and records the extended metadata. Carry a
   `harness` field on the running-child record.

5. **`watcher.ts`** — for external children, read `<anchor>.result` instead of the
   `pi`-session summary (a missing file uses the existing "produced no final
   message" handling). Generalize the "not started yet" wording so it is not
   `pi`-specific. Everything else is unchanged.

6. **`tool-resume.ts`** — an external branch handling four places that currently
   assume a `pi` session file exists on disk:
   - the guard that requires the session file to exist: when it is missing, read
     `<anchor>.meta` first and proceed if the harness is external; keep the guard
     for `pi` children;
   - skip the display-name backfill for external children (it reads the missing
     anchor file);
   - do not re-resolve the model through `pi`'s registry (external model names
     are not in it); pass the requested or recorded model verbatim to the profile;
   - take the working directory from `<anchor>.meta` (external children have no
     session header), including the "directory no longer exists" check.
   The external session id comes from `<anchor>.harness.json`; if it is absent,
   fail loudly explaining the child never completed a turn. Clear the result,
   activity, and completion-marker files before relaunch.

7. **Display touches** — `running-widget.ts`, `tool-list.ts`, `result-content.ts`:
   show the tool name for external children; suppress the per-run cost line for
   external children (their snapshots carry no cost, and printing a zero would be
   misleading — cost reporting for external tools is intentionally deferred);
   adjust the "session" wording in the result envelope so it reads as a resume
   reference rather than a readable file.

8. **`README.md`** — a new "External harnesses" section: the two new frontmatter
   keys, the Claude Code pass-through recipe examples, and what external children
   intentionally do not include in v1 (see Out of scope).

Style: follow the repository's conventions — straightforward TypeScript,
section-level comments that explain *why* a non-obvious choice was made, semantic
theme tokens for any terminal text, and no em dashes in prose.

## Tests

Tests are plain node files under `interactive-subagents/tests/`, run by
`make check` (no test framework; each file runs under `node
--experimental-strip-types`). Mirror the existing style (byte-exact assertions
for command construction).

- `harnesses-test.ts` — exact launch and resume command bytes, including the
  completion-marker suffix, pass-through placement, and quoting; the effort
  mapping including unmappable values; the tools mapping.
- `agents-test.ts` additions — the two new frontmatter keys, project-over-global
  shadowing, and the problem cases (unknown harness; `forked` with an external
  harness).
- `claude-hook-test.ts` — run `claude-hook.mjs` as a subprocess with fixture
  stdin payloads: assert the activity snapshot parses with the right run id and
  advancing counter; assert the result file matches the payload's final message
  (including a multi-part message); assert the session-id file; assert the
  completion marker is written last.
- End-to-end with a stand-in tool on PATH — a small bash script named like the
  external tool that parses `--settings`, calls `claude-hook.mjs` with fixture
  payloads exactly as the real tool would (prompt-start, tool-start/end,
  turn-complete carrying a final message), then exits. This exercises the whole
  launch-to-result lifecycle the supervisor consumes, with no login required.

## Verification (end to end)

1. `make check` — typecheck, all unit tests, and the stand-in end-to-end test,
   all green.
2. A live smoke test, driven and confirmed end to end: in a dedicated tmux
   session, start a real parent `pi`; define a test agent with
   `harness: claude-code` and an inexpensive model; give it a task whose answer is
   easy to check (e.g. "state this repository's default branch in your final
   message"). Confirm: the pane opens and runs the real tool; on completion the
   pane closes; the parent receives the delivered result containing the expected
   answer; the result and session-id sidecars exist. Then run a resume with a
   follow-up message and confirm the answer round-trips.
3. If any step of the live smoke cannot be automated (for example, a one-time
   interactive setup dialog appears), stop and ask the user to complete that one
   step, rather than working around it.

## Operational lessons from the exploratory run

- Use a dedicated tmux server (`tmux -L <name>`) for smoke tests, end the pane
  command with a keepalive (`; sleep 300`), and redirect the tool's error output
  to a file. A bare pane that errors vanishes instantly and hides the cause;
  these three habits made failures visible.
- Regenerate any per-run settings file at launch; do not assume one written
  earlier still exists.
- Account for one-time setup dialogs on first use in a directory — they can
  intercept the initial task so the child never starts.
- The child's final message arrives directly on the completion notifier's
  standard input, so result capture needs nothing beyond that payload and the
  extension's own sidecar files.
- Validate the effort mapping in the profile: an out-of-range value is silently
  ignored by the tool, so relying on the tool to reject a bad value would hide
  the mistake.

## Testing-model rule

When launching test children, use an inexpensive model tier only. Do not launch
premium models for throwaway verification.

## Out of scope for v1 (recorded, not built)

- Additional tools beyond Claude Code (Codex and others): the profile registry is
  designed to accept them later, noted with a comment, but no second profile ships
  in v1.
- Pane-content-change liveness (only needed for a future tool that lacks per-tool
  lifecycle events).
- A "ask the parent for help mid-run" flow for external children.
- Per-run cost and context-size reporting for external children.
- Forked context for external children.
- An identity banner inside the external child's pane.

## Scratch artifacts

The exploratory run left throwaway files under `.sandbox/` (already gitignored).
They can be deleted; nothing in the implementation depends on them.
