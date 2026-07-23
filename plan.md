# Plan: replace the screen-sentinel crash net with `pane_dead_status` (#66)

This plan was produced by an interview walking every design branch with the repo owner.
Every decision below is settled — do not re-litigate them; implement as specified. Where
the plan says "verified", it means verified empirically against tmux 3.7b on this machine
during planning.

All paths are relative to the repo root. The change is confined to `interactive-subagents/`.

## 1. Background and problem

Since #60, subagent panes are launched from a staged bash script whose first line turns on
`remain-on-exit` for the pane. A finished child therefore leaves a *dead pane* behind, and
tmux itself records how the pane's process ended in `#{pane_dead}` / `#{pane_dead_status}`.

The extension predates that: its "crash net" (the fallback exit detector for children that
die without ever running our extension code) is a *screen sentinel* — the launch command
ends with `; echo '__SUBAGENT_DONE_'$?'__'`, and the poller regex-scans `capture-pane`
output for `__SUBAGENT_DONE_<code>__`. That is now a second, textual way of learning a fact
tmux already knows. This change replaces the sentinel with the pane's dead status and
deletes the sentinel machinery entirely.

Current exit-detection anatomy (read these before coding):

- `interactive-subagents/protocol.ts` — `SENTINEL_ECHO_SUFFIX` (line ~69), `SENTINEL_REGEX`
  (line ~71), and the "channel 3" doc section describing them.
- `interactive-subagents/tmux.ts` — `pollForExit` (~line 352): per-second loop checking
  (1) the `.exit` sidecar, (2) the sentinel via `readScreen(paneId, 5)`, (3) pane-gone
  (detected by `capture-pane` *throwing*) plus a 5-tick grace period. Also `readScreen`
  (~line 320) and `stageLaunchScript` (~line 306).
- `interactive-subagents/launch.ts` — `buildLaunchCommand` appends the suffix (~line 141).
- `interactive-subagents/harnesses.ts` — claude-code launch and resume commands append the
  suffix (~lines 242, 256).
- `interactive-subagents/watcher.ts` — consumes `ExitResult` (`failed` computation ~line
  480, `failureReason` prose ~lines 503–508).

## 2. Decisions and why

### D1 — Compat mode: clean break

The only place the old form outlives the diff: children launched by the OLD code that are
still running when the user `/reload`s into the new code. Their staged scripts end with the
sentinel echo, so their script always exits 0 — if such a child *crashes* nonzero during
that overlap window, the new poller reads `pane_dead_status=0` and misreports the crash as
"completed (no final message)". Normal completions are unaffected (the sidecar still wins).

**Decision:** accept that. No transitional sentinel fallback, no compat guard. The sentinel
lives only in git history and the commit message. Exposure is one reload window of a
dev-installed extension, and the misread is mild.

### D2 — Signal death becomes a first-class, distinctly-reported failure

Verified: when the pane's process is killed by a signal (SIGKILL, OOM), tmux reports
`pane_dead=1` with an **empty** `pane_dead_status` (tmux only reports a status for normal
exits). Today this case is an *infinite poll loop*: no sentinel is ever printed, the dead
pane still answers `capture-pane`, no sidecar exists — the watcher hangs until session
shutdown. The issue claimed the swap buys "no capability"; this is the exception.

**Decision:** dead pane + empty status → a failed result with a distinct message saying the
process died without reporting an exit status. This closes the hang and tells the parent
model the truth. It travels as a **new `ExitResult` reason `"killed"`** (see D3).

### D3 — New union member, not reuse

`ExitResult` is a typed contract; a distinct condition gets a distinct discriminant.
Reusing `"error"` would collide with the watcher's `provider/agent error:` prose prefix;
reusing `"pane-closed"` would conflate "pane vanished" with "pane dead in place" — exactly
the distinction this change sharpens.

**Decision:**

```ts
export type ExitResult =
	| { reason: "done" | "exited" | "aborted"; exitCode: number }
	| { reason: "ping"; exitCode: number; pingMessage: string; pingName?: string }
	| { reason: "error" | "pane-closed" | "killed"; exitCode: number; errorMessage: string };
```

`"killed"` carries `exitCode: 1` and an `errorMessage` along the lines of:
`"The subagent's process died without reporting an exit status (killed by a signal or the system)."`

### D4 — Close the sidecar-vs-crash-net race at the moment of death

Each tick checks the sidecar first, then the crash net. If the child writes its sidecar and
exits in the milliseconds between those two reads within one tick, the poller would return
the crash-net verdict and strand the sidecar. For `{type:"done"}` that is harmless (the
summary comes from the session file), but an `{type:"error"}` sidecar racing a clean exit-0
would misreport a failure as "completed". The sentinel era had the identical window.

**Decision:** when the query first observes `pane_dead=1`, re-read the sidecar once before
returning the crash-net verdict; if present, the sidecar wins. This makes the documented
rule "the sidecar is the child's most precise word" true at the moment of decision, not
just at tick boundaries.

### D5 — No `exit $?` line needed

The issue proposed ending the launch script with `exit $?`. Verified: a bash script already
exits with its last command's status, and with the echo suffix removed the launch command
*is* the last line of the staged script — `pane_dead_status` carries pi/claude's exit code
with no extra line. **Decision:** just drop the suffix; add nothing.

### D6 — Sweep: delete `readScreen`; `protocol.ts` becomes a two-channel contract

- `pollForExit` was `readScreen`'s only production caller. Nothing in the extension shows
  dead-pane content to anyone (the watcher closes the pane the moment it detects an exit).
  **Delete `readScreen`.** Tests that need pane content call `capture-pane` themselves.
- The sentinel earned its place in `protocol.ts` because launch command and poller regex
  had to agree — a real parent↔child shared artifact. `pane_dead` is tmux-observed state,
  not a contract between our two processes. **`protocol.ts` documents two channels** (env
  vars + `.exit` sidecar); the crash net is documented where it lives, on `pollForExit` in
  `tmux.ts`.

### D7 — Dedicated direct tests for `pollForExit`, with an injectable tick

`pollForExit` currently has zero direct tests; the priority ordering and grace path are
pinned only by prose. The issue explicitly says exit detection deserves tests dedicated to
it. The poller ticks at a hardcoded 1s with a 5-tick pane-gone grace, which would make a
direct suite take 6+ wall-clock seconds.

**Decision:** add `tickMs?: number` (default `1000`) to `pollForExit`'s options — an honest
seam in the style of the existing `onTick` — and write a direct integration suite against a
real isolated tmux server (see §6).

### D8 — Verification: `make test` plus a live smoke

See §8. The plan is only done when the live smoke has demonstrated the new crash net in a
real pi parent.

## 3. The new crash-net mechanism (specification)

### 3.1 The dead-state query (new helper in `tmux.ts`)

One tmux invocation per tick:

```
tmux display-message -p -t <paneId> "#{pane_dead},#{pane_dead_status}"
```

Interpreted as a tri-state. Suggested shape (keep it simple):

```ts
type PaneDeadState =
	| { state: "alive" }
	| { state: "dead"; exitCode: number | null } // null = died without a status (signal)
	| { state: "gone" };
```

Parsing rules (all verified on tmux 3.7b):

| Observation                          | Meaning | Notes |
|--------------------------------------|---------|-------|
| output `0,`                           | alive   | live pane: `pane_dead` is `0`, status empty |
| output `1,<digits>`                   | dead, exit code `<digits>` | normal exit; code propagates from the script's last command (D5) |
| output `1,` (empty status)            | dead, `exitCode: null` | signal death → `"killed"` (D2) |
| command **throws**                    | gone    | pane id no longer exists |
| output where `pane_dead` is not `0`/`1` (e.g. `,`) | gone | verified: on 3.7b, `display-message` against a vanished pane does **not** error — it succeeds and expands the formats to empty strings. Both "throws" and "unparseable" must map to gone, so the code is robust across tmux versions. |

Trim the trailing newline; split on the first comma. A dead pane with a non-empty,
non-numeric status should not occur; treat it like the empty-status case.

The "gone" mapping is safe to be generous because the pane-gone path has a 5-tick grace
period behind it — a transiently weird read cannot instantly fail a child.

### 3.2 `pollForExit` per-tick algorithm (replaces the current step 2/3)

Per tick, in order:

1. `signal.aborted` → return `{ reason: "aborted", exitCode: 0 }` (unchanged).
2. Read+delete+interpret the `.exit` sidecar → return it if present (unchanged).
3. Query the dead state:
   - **alive** → reset the pane-gone tick counter; fall through to `onTick` + sleep.
   - **dead** → re-read the sidecar once (D4); if present, return it. Otherwise:
     - `exitCode` numeric → `{ reason: "exited", exitCode }` (unchanged semantics: the
       watcher treats code 0 as success, nonzero as failure).
     - `exitCode` null → `{ reason: "killed", exitCode: 1, errorMessage: <D3 text> }`.
   - **gone** → exactly the current pane-gone branch, unchanged: late-sidecar check, then
     increment the counter, and after `PANE_GONE_GRACE_TICKS` (still 5) return
     `{ reason: "pane-closed", exitCode: 1, errorMessage: "The subagent's pane closed without reporting a result." }`.
4. `onTick`, sleep `tickMs` (new option, default 1000).

The doc comment on `pollForExit` becomes the canonical crash-net description: re-derive the
priority list (sidecar → pane dead → pane gone + grace) and explain the death-tick sidecar
re-check and the signal-death case. Keep the narrative style of the existing comment.

### 3.3 Launch commands

- `launch.ts` `buildLaunchCommand`: remove `+ SENTINEL_ECHO_SUFFIX` (the join is the whole
  command). Update the function's and the file-header's prose that mentions the sentinel.
- `harnesses.ts` `claudeCodeProfile.buildLaunchCommand` and `buildResumeCommand`: same
  removal, both sites; remove the `SENTINEL_ECHO_SUFFIX` import.
- `stageLaunchScript` and its `remain-on-exit` guard line are **unchanged** — the guard is
  now load-bearing for the crash net (without it a dead pane would vanish instantly and
  every exit would fall to the pane-gone grace path). Worth one sentence in its comment.

### 3.4 Watcher

`watcher.ts` changes are minimal:

- `failed` (~line 480): `"killed"` already lands failed via `exitCode !== 0`, but add it to
  the explicit reason list for clarity alongside `"error"` and `"pane-closed"`.
- `failureReason` (~lines 503–508): `"killed"` uses `result.errorMessage` directly, same as
  `"pane-closed"` (both are in the union arm carrying `errorMessage`, so TS narrowing
  works). Do NOT route it through the `provider/agent error:` prefix.
- `result.reason` already flows into the message `details` verbatim; `"killed"` appearing
  there is intended.

### 3.5 Deletions (the clean-break sweep)

Delete, and then sweep the extension for stragglers:

- `SENTINEL_ECHO_SUFFIX` and `SENTINEL_REGEX` (`protocol.ts`), the entire "channel 3"
  section, and the quote-split explanation. Rewrite the file header from three channels to
  two (env vars, sidecar).
- `readScreen` (`tmux.ts`), and the "reading screens" section around it. Update the
  file-header prose ("read its screen") and the one-line module index for tmux.ts in
  `index.ts` (~line 27: "panes: stage/create/read/close + the exit poller").
- Every prose mention of the sentinel / `__SUBAGENT_DONE_` across the extension
  (`launch.ts` header and `buildLaunchCommand` docs, `harnesses.ts` import, test comments).
- Sweep check: `grep -ri "sentinel\|SUBAGENT_DONE" interactive-subagents/` afterwards. The
  only survivors should be unrelated test fixtures that use the word "sentinel" generically
  (`available-status-test.ts` "RUNTIME STATUS SENTINEL", `result-message-test.ts`
  "TAIL_SENTINEL") — leave those alone.

## 4. File-by-file change map

| File | Change |
|---|---|
| `interactive-subagents/protocol.ts` | Delete channel 3 (suffix, regex, prose); rewrite header to a two-channel contract |
| `interactive-subagents/tmux.ts` | New dead-state query helper (§3.1); rewrite `pollForExit` step 2/3 (§3.2); add `tickMs` option; add `"killed"` to `ExitResult`; delete `readScreen`; update header + doc comments |
| `interactive-subagents/launch.ts` | Drop the suffix from `buildLaunchCommand`; prose updates |
| `interactive-subagents/harnesses.ts` | Drop the suffix from launch + resume commands; remove import |
| `interactive-subagents/watcher.ts` | `failed` + `failureReason` handle `"killed"` (§3.4) |
| `interactive-subagents/index.ts` | Module-index one-liner for tmux.ts |
| `interactive-subagents/tests/poll-for-exit-test.ts` | **New** — direct `pollForExit` suite (§6.1) |
| `interactive-subagents/tests/tmux-test.ts` | Sentinel assertions → dead-status assertions (§6.2) |
| `interactive-subagents/tests/launch-test.ts` | Drop suffix/quote-split assertions; fix exact-command strings |
| `interactive-subagents/tests/harnesses-test.ts` | Same as launch-test |
| `interactive-subagents/tests/claude-harness-e2e-test.ts` | Sentinel greps → dead-status checks (§6.3) |

Nothing else changes. Explicitly out of scope: `PANE_GONE_GRACE_TICKS` value, the
`remain-on-exit` staging mechanism, the sidecar protocol, the watcher's delivery/steer
machinery, and any renames beyond the deletions listed.

## 5. Behavioral expectations (the contract, stated as observable outcomes)

For a child launched by the new code:

1. **Graceful completion** (implant/hook writes `.exit`): unchanged — sidecar wins, result
   delivered as today. The stranded-race variant (sidecar written in the same tick the pane
   dies) now also resolves to the sidecar (D4).
2. **Crash with exit code N ≠ 0** (pi/claude dies before writing a sidecar): poller returns
   `exited/N`; watcher reports a *failed* result with `failureReason: "exit code N"`.
3. **Clean exit 0 with no sidecar** (e.g. user quits an interactive child): `exited/0`;
   watcher reports *completed*, summary extracted from the session file, or
   "(the subagent produced no final message)". Unchanged semantics.
4. **Signal death** (pane process killed; pane dead, empty status): poller returns
   `killed/1` with the D3 message; watcher reports a *failed* result carrying that message
   verbatim. Previously: infinite hang. This is the one deliberate behavior change.
5. **Pane vanishes** (kill-pane, tmux dies): unchanged — 5-tick grace re-checking the
   sidecar, then `pane-closed/1` failure.
6. **Parent reload/shutdown**: unchanged — `aborted`.

## 6. Test plan

Tests are standalone node scripts (hand-rolled `ok`/`eq`, nonzero exit on failure) run by
`make test`, which auto-discovers `*/tests/*-test.ts`. Follow the isolated-tmux-server
pattern from `tmux-test.ts`: private `-L` socket, `-f /dev/null`, stand-in binaries on a
prepended PATH, `.sandbox/` for scratch (repo convention — not `/tmp`), skip cleanly when
tmux is absent, kill-server + env restore in `finally`.

### 6.1 New: `tests/poll-for-exit-test.ts` (direct `pollForExit` suite)

Drive the real `pollForExit` with a short tick (e.g. `tickMs: 25`) against real panes.
Each scenario stages a script via `stageLaunchScript` + `createPane` (so `remain-on-exit`
is on, exactly as production):

1. **Crash exit code**: pane script's last command exits 23 → resolves
   `{ reason: "exited", exitCode: 23 }`.
2. **Signal death**: pane script sleeps; SIGKILL the pane's process (`#{pane_pid}`) →
   resolves `reason: "killed"`, `exitCode: 1`, message mentions dying without an exit
   status.
3. **Sidecar wins on a dead pane**: write a `{type:"error"}` sidecar at
   `<sessionFile>.exit`, let the pane die with exit 0 → resolves `reason: "error"` with the
   sidecar's message, sidecar file deleted, and NOT `exited/0`. (This exercises the
   sidecar-priority-over-crash-net ordering; the intra-tick re-check branch (D4) is the
   same `readSidecar` call reached a few ms earlier — do not build an artificial seam to
   hit it separately.)
4. **Pane gone, late sidecar**: kill-pane, then write a `{type:"done"}` sidecar after ~2
   ticks → resolves `done` (grace period delivered it).
5. **Pane gone, silence**: kill-pane, write nothing → resolves `pane-closed` after the
   grace period, and only after (assert it did not resolve early).
6. **Abort**: abort the signal mid-poll → resolves `aborted`.

Use a real `AbortController`. Assert timing loosely (counts of ticks, not wall-clock
precision).

### 6.2 `tests/tmux-test.ts`

- Keep: remain-on-exit assertion, per-layout pane creation, kill-pane checks, the
  hostile-default-shell check, `waitForDeadPane`.
- Replace "sentinel preserves the fast crash exit code" with an assertion through the new
  dead-state query (stand-in pi exits 23 → dead with exit code 23).
- Drop "dead pane remains readable" and the `readScreen` import (the helper no longer
  exists); the launch script no longer carries a suffix (`stageLaunchScript("pi", ...)`).

### 6.3 Other test updates

- `launch-test.ts` / `harnesses-test.ts`: remove `SENTINEL_*` imports; update the
  exact-command equality strings (no trailing suffix); replace "ends with the sentinel
  suffix" / "does NOT match the poller regex" with an assertion that the built command does
  **not** contain `__SUBAGENT_DONE` (pins the deletion).
- `claude-harness-e2e-test.ts`: replace both sentinel greps with: wait for the pane to be
  dead (the file already has `waitForDeadPane`-style logic or can borrow it), then assert
  `pane_dead_status` is `0` via `display-message`. Test-local `capture-pane` calls for
  other assertions are fine — only the production helper is deleted.

## 7. Conventions for the implementer

- **Code style**: the repo owner is newer to TypeScript — keep the code simple and direct.
  This extension's files carry rich section-level narrative doc comments (see `tmux.ts`,
  `protocol.ts`); match that idiom. Comments explain *why*, at section level; no
  line-by-line narration, and no comments about this diff itself ("now uses pane_dead").
- **Commit message**: this contains a breaking change handled as a clean break. The body
  must state the mode, note the reload-overlap window from D1 as the change record, and
  declare: `Manual update steps: none.`
- Run `make check` / `make test` (see `Makefile`) before declaring done.

## 8. Definition of done — agent-verified workflow

The change is done only when all of the following have been executed and pass:

1. `make test` — full suite, including the new `poll-for-exit-test.ts` and all updated
   tests, on a machine with tmux installed (the tests self-skip without tmux, which does
   NOT count as verification).
2. Sweep check from §3.5 comes back clean.
3. **Live smoke** (the end-to-end proof, run by the implementing agent):
   - Set up an isolated pi home: a fresh directory used as `PI_CODING_AGENT_DIR` with the
     user's auth and model config copied in, and NO packages/extensions installed (this
     avoids double-registering the globally-installed copy of this extension). Configure a
     cheap model as the default. Use `.sandbox/` for all scratch files.
   - Inside a tmux session, run a parent pi with `-e interactive-subagents/index.ts` and
     drive it (send it a prompt) to spawn a subagent.
   - **Scenario A — completion**: give the child a trivial task; expect the parent
     conversation to receive the normal `subagent_result` completed message (sidecar path,
     proving no regression). Verify by grepping the parent session `.jsonl` for the
     `subagent_result` entry.
   - **Scenario B — the new crash net**: spawn another child with a long-running task; find
     its pane's process (`tmux list-panes -F '#{pane_id} #{pane_pid}'`) and SIGKILL it
     mid-run; expect the parent conversation to receive a *failed* `subagent_result` whose
     failure reason is the D3 "died without reporting an exit status" message. This proves
     the whole chain live: script exit propagation, dead-status query, `"killed"` contract,
     watcher prose.
   - Tear down the tmux session and isolated home afterwards.

If any step cannot be run (e.g. no auth available), stop and report — do not substitute a
weaker check and call it done.
