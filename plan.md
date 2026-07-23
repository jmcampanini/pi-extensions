# Plan: lifecycle-aware subagent cancellation (issue #81)

This plan implements `subagent_cancel` for the `interactive-subagents` extension. It was
produced by interviewing the maintainer through every design branch; the **Decisions**
section records what was chosen and why, and the rest specifies the contract, mechanism,
tests, and the final verification workflow. Follow the decisions as settled — do not
re-litigate them during implementation.

All file references are relative to the repository root. Read the referenced files before
editing them; their header comments carry load-bearing invariants.

## 1. Problem and intent

The parent model can spawn (`subagent_spawn`), resume (`subagent_resume`), and inspect
(`subagent_status`) subagents, but cannot cancel work that became obsolete or was launched
by mistake. Humans partially can — in the `/subagent-status` picker, `x` cancels a queued
entry or stops a running child — but:

- That ability is not exposed to the model at all.
- There is no shared primitive: the picker calls `cancelQueued()` and `child.abort.abort()`
  inline (`interactive-subagents/command-status.ts`).
- The **starting** window (concurrency slot claimed, launch pipeline mid-flight) is
  uncancellable by anyone — the picker shows "starting; controls available after start".

Goal: one lifecycle-aware cancellation primitive, exposed to the model as `subagent_cancel`
and to humans through the existing picker, that resolves the target's state at execution
time, returns immediately (never polls), and never leaks a claim, pane, session artifact,
or fresh worktree.

## 2. Existing machinery you will build on

- **Lifecycle states** (model-facing, from #79): `queued`, `starting`, `active`, `waiting`,
  `stalled`, `delivering`. `starting` covers two internal situations: a capacity claim
  whose launch pipeline is mid-flight (`pending` lifecycle in the widget projection), and a
  registered running child with no accepted activity snapshot yet. Only the claim window
  needs new machinery; the second is just a running stop.
- **Queued entries are pure data** (`interactive-subagents/capacity.ts`, invariant 1):
  cancel is a splice, nothing to roll back. `cancelQueued(id)` and
  `notifyQueueCancelled(...)` already exist.
- **Running stop already works end-to-end** (`interactive-subagents/watcher.ts`): setting
  `child.stoppedByUser = true` and firing `child.abort.abort()` makes `pollForExit` return
  `{ reason: "aborted" }` on its next ~1s tick; the watcher parks a delivery record and
  asynchronously sends a "stopped" result envelope with exactly-once delivery machinery
  (generations + `sendAccepted`). Aborted exits WITHOUT `stoppedByUser` take a silent
  cleanup path (no message) — that path currently only runs when a module generation dies.
- **The launch pipelines have boundary guards**: `assertLaunchStillWanted()` runs right
  before `createPane` in both `runSpawnLaunch` (`interactive-subagents/tool-spawn.ts`) and
  `runResumeLaunch` (`interactive-subagents/tool-resume.ts`), throwing `RequeueLaunch` or
  `AbandonLaunch`; `launchDequeued` (`interactive-subagents/capacity.ts`) dispatches on the
  error class. Both pipelines roll back their own side effects on a throw, and the caller
  releases the claim.
- **The `ledger`** (`interactive-subagents/state.ts`) retains every tracked child's
  id → session file forever, so "already finished" and "never existed" are distinguishable.
- **Everything lifecycle-critical lives on `globalThis`** so it survives `/reload`
  (`state.ts` reload state, `capacity.ts` capacity store). New cancellation state must
  follow the same pattern, including the upgrade-shim discipline at the top of `state.ts`.

Key timing fact (verified): Node is single-threaded and the launch pipelines run
synchronously except for `await createWorktree(...)` in worktree spawns. Any claim that is
observable from another synchronous context is therefore parked at a pre-guard await, which
is what makes the starting-window contract below sound.

## 3. Decisions and rationale

These were settled explicitly with the maintainer. Rationale is recorded so the
implementation can preserve intent when details need adjusting.

1. **Single id per call: `subagent_cancel({ id })`.** Matches `subagent_resume`'s
   per-instance shape and keeps each result's state-aware language unambiguous. pi executes
   parallel tool calls concurrently, so a mistaken fan-out is cancelled with several calls —
   no batch shape, no `sessionPath` fallback (cancellation only targets unresolved work,
   which always has a live id in `subagent_status`).

2. **Starting window resolves deterministically to `cancelled` via a tombstone.** The
   cancel primitive synchronously checks registries; if the id is claimed but not in
   `running`, the pipeline is parked at a pre-guard await, so setting a per-id cancellation
   tombstone *guarantees* the boundary guard fires and the launch unwinds. The tool returns
   `cancelled` immediately. Belt-and-suspenders: `trackChild` also checks the tombstone and
   silently aborts a child that slipped through (only possible if a future refactor adds a
   post-guard await), preserving "**cancelled ⟹ no subagent result will ever arrive**".
   Rejected alternatives: a third `cancelling` word (adds contract surface for a window that
   is synchronously resolvable), conservative `stopping` (would promise a stopped result
   that never comes), rejecting starting ids (leaves the issue's headline gap open).

3. **Track the requester.** Replace `RunningSubagent.stoppedByUser: boolean` with
   `stopRequester?: "user" | "model"` (internal rename, fully updated in this change; add a
   reload upgrade shim in `state.ts` mapping old records' `stoppedByUser: true` to
   `"user"`). The stopped envelope's notice reads "Stopped by the user." vs "Stopped because
   you cancelled it." — the model must be able to tell a human intervention (a signal to
   rethink) from the echo of its own cancel (expected). Stall steers stay suppressed for
   both requesters (`canSteer`). Model-initiated cancels of queued/starting entries send
   **no steered notice** — the tool result is the durable record; human-initiated ones keep
   steering (the model believes work is pending and must be told).

4. **The picker gains `x` on starting rows** and routes ALL cancel/stop actions through the
   shared primitive. The "starting; controls available after start" hint disappears.
   Delivering rows stay action-free.

5. **Interactive children (`autoExit: false`) are cancellable, with guidance.** The
   lifecycle table stays uniform; the tool description warns that interactive children may
   have a human at the pane and should be cancelled only when the user clearly wants it. No
   hard refusal, no `force` flag — worst case is recoverable (session survives, stopped
   result offers resume, worktrees kept).

6. **Idempotent stop, error the rest.** A cancel of a child already being stopped succeeds
   again with "stopping" prose (first requester's attribution is kept) — this forgives the
   benign race where the user pressed `x` moments before the model cancelled. Delivering,
   completed, already-cancelled, and unknown ids are distinct tool **errors** — those calls
   reflect a genuinely wrong belief about the world and deserve error salience.

7. **No seventh lifecycle state.** The model-facing state contract from #79 stays exactly
   six states. Presentation fix only: delivering rows carry "the exit was a stop" so human
   surfaces read "stopped", never "finished", while the stopped notice is queued (which can
   last minutes when the parent is mid-turn). The ~1s window between abort and the watcher
   noticing stays as-is.

8. **Verification = unit matrix + live smoke of the two deterministic flows** (queued
   cancel and running cancel), per section 9. Starting-window races are unit-tested, not
   live-tested.

No decision here is user-facing-breaking: one new tool is added, and all internal renames
are completed within this change (with reload shims for in-flight state).

## 4. The contract (API and expectations)

### 4.1 Tool registration

New file `interactive-subagents/tool-cancel.ts` (one file per model-facing tool, like the
other `tool-*.ts` files), registered from `index.ts` in parent mode only, alongside the
other `subagent_*` tools.

- Name: `subagent_cancel`, label "Cancel Subagent".
- Parameters: `{ id: string }` — the stable 8-char subagent id.
- Description must carry (they are prompts, not documentation — see `tool-spawn.ts` header):
  - It resolves the id's lifecycle state at execution time; the caller never chooses
    between cancel/stop variants.
  - The two result words: `cancelled` = the work never ran (or was fully prevented) and
    **no result will ever arrive**; `stopping` = a running child was asked to stop and its
    **stopped notice still arrives asynchronously** — do not poll or wait for it.
  - Partial work may remain after a running stop; worktrees are kept per the stopped-work
    policy and the stopped notice explains how to resume.
  - Interactive (`autoExit: false`) children may have a human working in their pane —
    cancel them only when the user clearly wants that.
- `renderCall`: follow the native tool typography (see `AGENTS.md`): bold `toolTitle`
  keyword ("cancel subagent"), the id unbolded in `accent`.
- `renderResult`: plain `toolOutput` text (error text in `error`), same shape as
  `tool-status.ts`'s fallback rendering. No custom card needed.

### 4.2 State resolution table

The primitive resolves in this order, in ONE synchronous pass (no awaits between the checks
and the state mutations — that atomicity is what makes the launch boundary deterministic):

| Check (in order) | Behavior | Tool result |
|---|---|---|
| `running.has(id)`, `stopRequester` already set or abort already fired | keep first requester; no-op | success: `stopping` — "already being stopped; the stopped notice will still arrive; do not poll." |
| `running.has(id)` | set `stopRequester`, `abort.abort()` | success: `stopping` — stopped notice arrives asynchronously; partial work may remain. |
| `deliveryRecord(id)` exists | reject | **error**: already finished; its result is on its way and cannot be revoked; wait for it. |
| `findQueued(id)` | `cancelQueued(id)` splice; record tombstone; steer notice only when requester is `user` | success: `cancelled` — never started, no result will arrive. |
| id in capacity claims (starting) | record tombstone (with requester); pipeline unwinds at its boundary guard | success: `cancelled` — launch is being unwound; it never ran and no result will arrive. |
| tombstone registry has id | reject | **error**: already cancelled; no result will arrive. |
| `ledger.has(id)` | reject | **error**: already finished and its result was delivered; nothing to cancel. |
| otherwise | reject | **error**: no subagent with this id; use subagent_status to list unresolved subagents. |

Result prose should follow the house style in `capacity.ts`'s "words the model hears"
section: name + id identity line, explicit "no result will arrive" / "stopped notice will
arrive" language, and the running/queued count line where it helps. The prose IS the
protocol (see `watcher.ts` header) — a result landing in a long transcript must carry
everything the model needs.

### 4.3 Guarantees (the safety/race requirements from the issue)

- **Non-polling**: the tool returns synchronously; it never waits for process exit or
  pipeline unwind.
- **Deterministic launch boundary**: exactly one of cancellation or registration owns a
  launch. Enforced by: (a) the synchronous single-pass resolution above, (b) the tombstone
  check added to the pipelines' boundary guard, (c) the tombstone check in `trackChild`.
- **`cancelled` ⟹ no subagent result ever arrives.** Queued: the spec is spliced before it
  has side effects. Starting: the guard unwinds the launch; in the (currently impossible)
  registration-wins race, `trackChild`'s check silently aborts through the no-message abort
  path.
- **`stopping` ⟹ exactly one stopped notice arrives.** Reuse the existing delivery-record
  machinery untouched — it already provides exactly-once across reloads.
- **Cancelling one id never affects another** launch, claim, pane, or worktree. All state
  mutations are keyed by id; add tests that a neighbor launch proceeds untouched.
- **No leaks on starting cancel**: the pipelines' existing rollback scopes already remove
  the session seed, `.meta`, activity/result sidecars, pane, and freshly created worktree.
  The cancel path reuses them via a new error class (below).

## 5. Mechanism (file-by-file)

Keep the code simple and use section-level comments explaining WHY (the maintainer is newer
to TypeScript; match the existing files' comment density and style).

### 5.1 `capacity.ts` — tombstone registry + `CancelLaunch`

- Add a tombstone registry to the `globalThis` capacity store:
  `cancelled: Map<string, { requester: "user" | "model"; at: number }>` (with a `??=`
  upgrade for stores created by older module generations, mirroring `state.ts`).
  Exported helpers: `recordCancellation(id, requester)`, `cancellationFor(id)`.
  Cleared at destructive session boundaries only (extend `clearQueueForShutdown`); it
  survives `/reload` by construction. Destructive clearing also fences every live claim as
  abandoned until its pipeline unwinds, so a failed-reload reaper cannot clear a tombstone
  and then let a late `RequeueLaunch` resurrect the cancelled work.
- New error class `CancelLaunch` alongside `RequeueLaunch`/`AbandonLaunch`, carrying the
  requester. Extend `assertLaunchStillWanted(launchGeneration, specId)` to throw it when
  the spec id is tombstoned. (Both call sites pass the spec id.)
- `launchDequeued`'s catch dispatches on it: release claim (already done), do NOT requeue
  or send a second notice, then `requestDrain` and `queueChangedHook` as the failure path
  does. The shared primitive owns the notice at cancellation time.
- **`drainQueue` and `armDrainHook` must skip tombstoned queue entries** (drop silently —
  drained user cancellations were already reported, inline cancellations surface through
  their tool call, and model cancellations need no steer). This closes the resurrection edge: a cancelled
  starting launch interrupted by `/reload` is requeued via `RequeueLaunch` and would
  otherwise relaunch after adoption.
- `PendingLaunch` gains `origin: "inline" | "drain"` so the shared primitive can notify a
  user cancellation synchronously for a drained launch. An inline launch gets no steer —
  the awaiting spawn/resume tool call itself surfaces the cancellation as its error (see
  5.3). Model-requested cancellation never steers.

### 5.2 The shared primitive — new file `interactive-subagents/cancel.ts`

One exported function, used by BOTH the tool and the picker:

```
requestCancel(pi, id, requester) -> outcome
```

Outcome is a discriminated union the callers translate into tool results, errors, or
picker notifications: `cancelled-queued`, `cancelled-starting`, `stopping`,
`already-stopping`, and the rejections (`delivering`, `already-cancelled`, `completed`,
`unknown`). It implements exactly the table in 4.2 and owns the user-requester steers
(reusing `notifyQueueCancelled`): queued and drained-starting cancellations steer
immediately, while inline starts rely on their launch tool error. This keeps the notice
exactly once even when reload races the pipeline unwind. The primitive must be synchronous,
with no awaits.

### 5.3 `tool-spawn.ts` / `tool-resume.ts` — pipelines

- Pass the spec id into the boundary guard calls. Re-check the tombstone when an awaited
  launch step rejects, before translating the failure, so cancellation still dominates when
  `createWorktree` fails instead of reaching the boundary guard.
- Inline execute paths: translate `CancelLaunch` into a clear tool error, alongside the
  existing `RequeueLaunch`/`AbandonLaunch` translation: "cancelled by the user before it
  started — nothing is running and no result will arrive" (requester is on the error; a
  model-requested cancel of an inline claim can only come from a parallel tool call and
  gets symmetric prose).
- A worktree rollback failure remains attached to `CancelLaunch`: inline calls include its
  manual cleanup instruction in their error, while drained launches send one distinct
  operational cleanup-failure notice without duplicating the cancellation notice.
- Resume-specific: the rollback for a cancelled resume must NOT delete the target session
  file — it belongs to the earlier run. The existing rollback scope in `runResumeLaunch`
  already has this property (it only closes the pane); keep it that way and pin it with a
  test.

### 5.4 `watcher.ts` — requester-aware stop path

- Rename `RunningSubagent.stoppedByUser` to `stopRequester`
  (`"user" | "model" | undefined`). Update `canSteer`, the aborted-exit branch, and the
  stopped envelope: notice "Stopped by the user." vs "Stopped because you cancelled it."
  (both keep "Do not treat this as a subagent failure." and the resume/worktree guidance).
- `trackChild`: before registering, check `cancellationFor(child.id)`; if tombstoned,
  register-then-silently-abort is NOT needed — instead close the pane, skip registration,
  release the claim, and (unlike the generation-death silent path) trigger a drain, keeping
  the worktree decision under `finishWorktree` with `childSucceeded: false` so a child that
  briefly ran cannot have real work deleted. It must return a cancellation outcome to the
  pipeline so an inline spawn/resume cannot falsely report `started`; spawn then removes its
  newly seeded session artifacts while resume preserves its earlier session. This path is
  defensively unreachable today; keep it small, deterministic, and tested via a forced tombstone.
- The aborted-exit silent path's condition changes from `!child.stoppedByUser` to
  `child.stopRequester === undefined`.

### 5.5 `state.ts` — reload shims + delivering projection

- Upgrade block: map legacy `stoppedByUser: true` records to `stopRequester: "user"`.
- `DeliveringSubagent` gains `stopped: boolean` (projection of
  `exit.reason === "aborted"`); upgrade with `record.stopped ??= ...` in the existing
  delivering-upgrade loop. The watcher sets it when building records.

### 5.6 `command-status.ts` — picker

- `x` is accepted on `running`, `queued`, AND `pending` rows; all three route through
  `requestCancel(pi, row.id, "user")`. Delete the direct `cancelQueued` +
  `notifyQueueCancelled` and `abort.abort()` code.
- Action hints: pending rows get "x: cancel launch"; delivering rows read
  "stopped; its stopped notice is on its way" when the row is a stopped child, otherwise
  the existing "finished; result is on its way".
- Translate outcomes into `ctx.ui.notify` feedback where the picker already notifies
  (e.g. an id that resolved to `unknown` because the child finished between render and
  keypress keeps a graceful "already finished" notice).

### 5.7 Presentation — `widget.ts`, `running-widget.ts`, `tool-status.ts`

- Widget/picker rows for a stopped delivering child show status word `stopped` (add to the
  `WidgetRow.status` union; same attention priority as `delivering` in `rowPriority`).
- `subagent_status` keeps the model-facing state `delivering` (the six-state #79 contract
  is untouched) but the description for a stopped child becomes "stopped after X; its
  stopped notice is queued and will arrive automatically; do not poll or respawn".
- `subagent_status` descriptions for queued/starting/running rows may mention
  `subagent_cancel` where the prose already suggests actions (e.g. the stalled row's
  option list in `sendStalledSteer` and `tool-status.ts` can offer cancel as an option).
  Keep it brief; do not rewrite #79 prose wholesale.

### 5.8 `index.ts`, `README.md`

- Register the new tool (parent mode only) and add `cancel.ts` / `tool-cancel.ts` to the
  header's file map.
- README: extend "Model-facing tools" and "Observe, control, and receive results" with:
  the cancel table (state → behavior → result word), the `cancelled` vs `stopping`
  distinction, human cancellation via the picker (including starting rows), partial-work
  and worktree implications, and requester attribution in stopped notices.

## 6. Edge cases the implementation must handle

Each of these needs a test (section 7):

1. Cancel racing the picker's `x` (either order) → one stop, first requester wins, second
   call reports `already-stopping`.
2. Cancel of a starting launch, then `/reload` interrupts the pipeline → `RequeueLaunch`
   requeues the entry → adoption drain must DROP it (tombstone), not relaunch it.
3. Cancel of a queued forked child → pure splice; the parent conversation is never copied.
4. Cancel of a starting worktree spawn parked in `createWorktree` → guard fires after the
   await; worktree rollback runs; no pane/seed/meta/sidecar/worktree remains; claim
   released; queue drains.
5. Cancelled inline spawn → the spawn tool call itself errors with cancellation prose; no
   duplicate steer.
6. Cancelled drained (formerly queued) launch, user requester → exactly one steered notice;
   model requester → no steer.
7. Forced tombstone at `trackChild` time → child never registers, pane closed, no
   `subagent_result` ever, slot freed, drain triggered, dirty-worktree kept.
8. Repeat cancels: tombstoned id → "already cancelled" error; completed id (in ledger
   only) → "already finished" error; unknown id → "no such subagent" error; delivering id
   → "cannot be revoked" error and the delivery still lands afterwards.
9. Neighbor isolation: with two queued + one running child, cancelling one queued id leaves
   the other queued entry position-shifted but untouched and the running child running.
10. Stopped delivering row renders "stopped" wording on widget, picker, and
    `subagent_status`, while `state` stays `delivering` for the model.
11. Exactly-once stopped delivery across a reload mid-delivery (reuse the existing
    delivery-record test patterns in `tests/reload-state-test.ts` /
    `tests/delivery-test.ts`).

## 7. Test plan (unit)

Tests run with `make check` (typecheck + every `*/tests/*-test.ts` via
`node --experimental-strip-types`). Follow the existing assertion style (`eq`/`ok`
helpers, no framework). Suggested placement:

- `tests/cancel-test.ts` — the primitive's full state table (4.2), resolution order,
  idempotency, requester attribution, tombstone bookkeeping, and edge cases 1–9. Drive
  capacity/state directly with fake launchers, as `tests/capacity-test.ts` does; a fake
  launcher parked on a controllable promise simulates the worktree await.
- `tests/capacity-test.ts` — extend: drain skips tombstoned entries; `CancelLaunch`
  dispatch in `launchDequeued` (no requeue or duplicate notice, drain continues); destructive
  claim fencing prevents a late `RequeueLaunch` from surviving the failed-reload reaper.
- `tests/command-status-test.ts` — extend: `x` on pending rows selects the cancel action;
  hints updated; picker routes through the primitive (spy/stub).
- `tests/running-widget-test.ts` / `tests/widget-test.ts` / new assertions in
  `tests/available-status-test.ts` — stopped delivering row wording (edge case 10).
- `tests/reload-state-test.ts` — `stopRequester` upgrade shim; `stopped` projection
  upgrade; tombstone store survives reload and clears at shutdown.
- `tests/tool-cancel-test.ts` (if the tool wrapper has logic worth isolating beyond the
  primitive: parameter validation, result/error text selection, render functions).
- `tests/starting-cancel-test.ts` — real worktree pipeline rollback, awaited-create rejection
  dominance, rollback-failure warning preservation, and resume-session preservation.

## 8. Conventions checklist

- TUI: semantic theme tokens only; native tool typography per `AGENTS.md`.
- Comments: section-level, explain why, match neighboring density.
- No new lifecycle state in the model-facing contract; no `/subagent-cancel` command.
- Internal renames (`stoppedByUser`) fully swept in this change — grep for stragglers,
  including tests.
- Temporary files for local experiments go in `.sandbox/`, not `/tmp`.

## 9. Final verification: agent-verified end-to-end workflow

After `make check` passes, the implementing agent must prove the feature live, end-to-end,
in an isolated environment. This section is the workflow; run it and report the evidence.

Setup (see the pattern used previously for live extension tests):

1. Create an isolated pi home: copy ONLY auth + model config from the real
   `~/.pi/agent` into a scratch dir; do not copy `packages/` (avoids double-registering
   the installed copy of this extension). Export `PI_CODING_AGENT_DIR=<scratch>`.
2. Install this checkout's extension into the isolated home (or pass it with `-e`).
   Configure `subagents.json` with `maxConcurrentSubagents: 1` so queueing is
   deterministic, and configure a cheap model (Haiku/Sonnet class) for parent and children
   — never premium models for harness testing.
3. Start `tmux new -d -s cancel-smoke 'pi'` with the isolated env and a scratch cwd
   inside `.sandbox/`.

Flow A — queued cancel (model-initiated):

4. Drive the parent via `tmux send-keys`: instruct it to spawn two trivial long-running
   subagents (e.g. "sleep 120 then reply done") — the second must return `queued`.
5. Instruct the parent to call `subagent_cancel` on the queued id.
6. Assert, by reading the parent session `.jsonl`: the cancel tool result contains the
   `cancelled` / "no result will arrive" language; no `subagent_result` for that id ever
   appears; the queue count drops; the running child is unaffected.

Flow B — running cancel (model-initiated):

7. Instruct the parent to cancel the RUNNING child's id.
8. Assert: the tool result contains `stopping` language; exactly one
   `customType: "subagent_result"` steer arrives for that id with the stopped notice
   ("Stopped because you cancelled it"); the tmux pane for the child is gone
   (`tmux list-panes`); no orphan panes or processes remain.

Teardown: kill the tmux session, remove the scratch pi home and `.sandbox/` artifacts.

If any live step cannot be executed in the implementing environment (no tmux, no auth),
STOP and ask the maintainer to run this section manually — do not declare the feature
verified on unit tests alone.
