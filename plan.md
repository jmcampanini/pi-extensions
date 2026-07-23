# Plan: durable subagent result delivery (issue #72)

Fix for GitHub issue #72 — "Manually stopped subagents can remain stuck in `delivering` forever."
All design decisions below were made interactively with the repo owner; do not re-litigate them.
Everything else (naming, comment prose, exact code placement within the named files) is yours,
but match the existing style of `interactive-subagents/` — narrative header comments, tabs,
semantic naming, plain-node tests.

Run `npm install` in the worktree first; `make check` must pass when you are done.

## 1. Problem

When a child subagent exits (or is stopped with `x`), `watcher.ts` packages the outcome into a
custom message and sends it with `pi.sendMessage(msg, { triggerTurn: true, deliverAs: "steer" })`.
If the parent is idle, delivery is immediate. If the parent is **streaming**, pi queues the
message in its agent-core steering queue.

If the user presses **Escape** while such a message is queued, pi's interactive mode calls
`restoreQueuedMessagesToEditor({ abort: true })` → `clearAllQueues()` → agent-core
`steeringQueue.clear()`. User-typed queued text is restored into the editor; **extension custom
messages are silently discarded**. No event fires. Consequences:

- The parent model never hears the child's outcome (including a completed child's final summary).
- The `delivering` widget row — cleared only when `delivery.ts` observes the message land via
  `message_end` — sticks forever.

The extension currently *chooses* never to resend an accepted send (see the "deliberate gap"
comment in `delivery.ts` and README §"If Escape interrupts…"), because at the time it could not
distinguish "still queued, will arrive" from "dropped, never will," and resending a merely-queued
message would deliver it twice. pi now exposes enough signal to build that proof. That is this
change.

Verified root-cause references (in `@earendil-works/pi-coding-agent` ≥0.80.10; installed pi is
0.81.1 — re-verify against whatever version is installed when you start):

- `dist/modes/interactive/interactive-mode.js` — `restoreQueuedMessagesToEditor` /
  `clearAllQueues`: the drop path.
- `dist/core/agent-session.js` — `sendCustomMessage`: streaming → `agent.steer(appMessage)`
  (queued, droppable); idle + `triggerTurn` → `_runAgentPrompt(appMessage)` (immediate).
- `node_modules/@earendil-works/pi-agent-core/dist/agent.js` — the steering queue itself;
  `abort()` does not clear queues, only Escape's `clearAllQueues()` does.

## 2. Decisions (settled — implement as stated)

**D1 — Scope: all result types.** Durable delivery applies to everything that flows through
`watcher.ts`'s `sendDelivery()` / `DeliveryRecord`s: `completed`, `failed`, `stopped`
(`subagent_result`) and `ping` (`subagent_ping`). One mechanism, no per-type special cases.
*Why:* all four are stranded by the same race; a lost completion is worse than a lost stop
(real work silently lost); the issue's stop-specific acceptance criteria fall out as a special
case. **Out of scope:** the fire-and-forget steers with no delivery record — stalled/recovered
warnings (`watcher.ts`) and queue-cancelled notices (`capacity.ts`). Losing those is low-stakes
and they carry no widget row.

**D2 — Mechanism: provable-loss redelivery at a normally settled run.** Never resend on a guess.
Resend a record only once it is *provable* that its earlier accepted send was dropped (rule in
§4). *Why:* preserves the existing at-most-once guarantee ("the parent receives at most one
outcome per child") while eliminating the stuck-forever state; retries are naturally rate-limited
to one per completed parent run; repeated Escapes simply re-arm it.

**D3 — Stop-row UX: unchanged.** A user-stopped child parks in `delivering` exactly like any
other result and its row clears when the stopped notice actually lands. No new widget state, no
immediate clearing. *Why:* the row remains an honest "the model has not heard yet" indicator,
and with redelivery it can no longer stick forever, which removes the motivation for
special-casing.

**D4 — No retry cap.** A resend requires proof, proof requires a normally settled parent run,
so the mechanism is self-limiting and stops the moment a copy lands.

**D5 — Stop-vs-completion race: already safe, pin it with a test.** A child gets exactly one
`ExitResult` and one `DeliveryRecord` (keyed by id), and `sendDelivery` is guarded by
`sendAccepted`. If `x` lands in the same instant the child exits, whichever the poll observes
first produces the sole envelope. No new code — but the regression test must assert exactly one
outcome per child.

**D6 — Docs are part of the change.** The never-resend philosophy is being retired; every trace
of it must be rewritten (§6).

## 3. pi API contract (what to rely on, what to avoid)

Rely on (all present in the typed `ExtensionAPI` the repo compiles against):

- `pi.on("agent_start", …)` — fires when an agent run starts. Used to count runs.
- `pi.on("agent_end", …)` — fires when a run ends; `event.messages` is the run's messages.
  Used to classify the run's outcome (normal vs aborted/errored) from the last assistant
  message's `stopReason`.
- `pi.on("agent_settled", …)` — fires after a run has *fully* settled: no automatic retry,
  compaction continuation, or queued continuation will run. This is the only safe place to
  apply the proof rule. Note one settlement may span several `agent_start`/`agent_end` cycles
  (overflow recovery, queued continuations); always use the outcome of the **most recent**
  `agent_end`.
- `pi.on("message_end", …)` — already used by `delivery.ts` to observe our messages landing.
- `pi.sendMessage(msg, { triggerTurn: true, deliverAs: "steer" })` — the existing send. These
  exact options remain load-bearing (see `watcher.ts` header) and must be identical on resend.

Do **not** use:

- `ctx.hasPendingMessages()` — it counts only *user-typed* steering/follow-up text
  (`AgentSession._steeringMessages`), and is **blind to custom messages** queued via
  `agent.steer(appMessage)`. It cannot tell you whether our result is still queued.
- `deliverAs: "nextTurn"` — asides survive Escape but only flush on the user-prompt path and
  do not trigger turns; rejected during design.

Two invariants the proof rule depends on. Both were verified during design; re-verify them
briefly against the installed pi source before coding (they are the load-bearing assumptions):

- **I1:** a steering-queue item enqueued *before* run R starts is always drained (and lands as
  `message_end`) during R, if R runs to a normal end. Between-turn steering polls in the
  agent-core run loop guarantee this. Corollary: after a normally settled run R, any of our
  messages accepted before R started either landed or was dropped — nothing can still be queued.
  (An item enqueued *mid*-R, after R's final steering poll, may legitimately survive R in the
  queue — which is why the proof rule compares against R's **start**, not its end.)
- **I2:** a send accepted while the parent is idle (`sendCustomMessage` → `_runAgentPrompt`)
  appends the message to state/session as the run begins, so it produces `message_end` even if
  that run is later aborted. Idle-path sends are therefore never at risk and never need proof.

## 4. Design

### State (`state.ts`)

- Add a monotonically increasing **run counter** to the process-stable `reloadState` slot on
  `globalThis` (so it survives `/reload`, like `running`/`delivering`). Expose a getter and an
  increment used by the `agent_start` listener. It never resets within a process; a skipped or
  double increment is harmless (stamps are compared with `<`), which makes reload races benign.
- Add to `DeliveryRecord` a stamp recording the counter value at the moment its send was
  accepted (name it explicitly and symmetrically with `sendAccepted`, e.g.
  `sendAcceptedRunIndex`). Set it in `sendDelivery` alongside `sendAccepted = true`.

### Proof rule

At `agent_settled`, where `S` = counter value stamped at the most recent `agent_start` and the
most recent `agent_end` classified as **normal** (last assistant message exists and its
`stopReason` is neither `"aborted"` nor `"error"` — anything ambiguous, e.g. a run with no
assistant message, counts as *not* normal):

> A `DeliveryRecord` still present in the delivering map is **provably dropped** iff
> `sendAccepted && sendAcceptedRunIndex < S`.

Reasoning: the record still existing means `message_end` never observed the message (the
existing listener deletes on landing); the send predating R's start plus I1 means it cannot
still be queued. If the settled run was aborted, prove nothing (Escape may or may not have
cleared the queue; an extension-initiated abort leaves it intact). If `sendAcceptedRunIndex`
equals `S` (sent mid-run, late-enqueue window), wait — it either lands in the next run or
becomes provable at the next normal settle.

Additionally: records with `sendAccepted === false` (the original `sendMessage` threw) may also
be re-armed at any normal settle — there is no queued copy, so resending is unconditionally
safe. Today such records wait for a `/reload`; this heals them sooner.

### Redelivery flow

On proof, for each dropped record: reset `sendAccepted` (and its stamp), reset
`finalizerGeneration`, and restart the finalizer (`startFinalizer`-equivalent), which re-runs
`finalizeDelivery` → rebuilds the identical envelope → `sendDelivery` again. Notes:

- `finalizeDelivery` is already safe to re-run: `worktreeCleanup` is memoized on the record,
  `externalSummary` was captured at exit, `extractSummary` re-reads a session file that still
  exists, and the stopped/ping paths build purely from record fields. No new side effects.
- The resent message is byte-identical in intent to the original — no "redelivered" marker.
- Parent is idle at settle, so the first resend immediately triggers a delivery turn (mirroring
  pi's own queued-continuation behavior). With several dropped records, the first send starts a
  run and the rest queue as steers into it, landing one per boundary under pi's default
  one-at-a-time steering mode. Each record heals independently.
- The resend is itself droppable (another Escape) — fine; the same proof re-arms it later.

### Wiring

- Keep row-clearing (`message_end`) in `delivery.ts`; register the three new listeners
  (`agent_start`, `agent_end`, `agent_settled`) alongside it — same activation point in
  `index.ts` (parent mode only, before any child can exist), same lifecycle as
  `registerDeliveryListener`. The settle handler calls a function exported from `watcher.ts`
  (e.g. `retryDroppedDeliveries(pi)` or an exported `startFinalizer`) — the import direction
  `delivery.ts → watcher.ts` introduces no cycle. Keep the proof decision itself a pure,
  exported function (mirroring `deliveredChildId`) so tests can hit it without a fake run loop.
- Classification state (last run outcome, last run start index) lives with the listeners; if a
  `/reload` lands mid-run, the conservative default ("no normal end observed yet") merely delays
  proof to the next completed run. Never prove a drop with state you did not observe.

## 5. What does NOT change

- The send options, envelope construction, and prose in `watcher.ts` (except its header comment).
- Widget row states, ordering, and the picker (`command-status.ts` stop handler stays
  `stoppedByUser = true; child.abort.abort()`).
- The silent-abort path for session shutdown (`result.reason === "aborted"` without
  `stoppedByUser` stays a deliberate no-op — nobody is left to tell).
- Stalled/recovered and queue-cancelled steers (out of scope, D1).

## 6. Documentation updates (sweep for the old philosophy)

The claim "an accepted send is never retried; a frozen `delivering` row is the honest signal of
a lost result" must not survive anywhere. Known sites — sweep for others:

- `delivery.ts` header ("The deliberate gap: …") — rewrite to describe observation + proof +
  redelivery.
- `watcher.ts` `sendDelivery` comment ("A successful queued send survives reload and is never
  sent a second time.") — now "never sent a second time *unless provably dropped*".
- `README.md` §"If Escape interrupts a streaming parent…" — rewrite: Escape can still drop a
  queued result, but the extension detects the loss at the next normally completed parent run
  and redelivers exactly once; rows can no longer stick forever while the parent is active.

## 7. Unit regression tests

New test file (e.g. `tests/redelivery-test.ts`) following the existing conventions
(`delivery-test.ts` is the model: plain node, fake `pi` object with an `on`-registry and manual
`emit`, pass/fail counters, runs via the `make test` glob). The fake pi additionally captures
`sendMessage` calls. Manufacture `DeliveryRecord`s directly via `setDeliveryRecord` with a
fabricated `RunningSubagent` (the stopped path needs no session file on disk). Scenarios:

1. **The issue's sequence:** stopped child → send accepted during run N → no `message_end`
   (dropped) → run N+1 ends normally and settles → exactly one resend; its `message_end` then
   clears the row; a further normal settle causes no additional send.
2. **Landed message:** `message_end` for the id before settle → no resend ever.
3. **Aborted settle:** run ends with `stopReason: "aborted"` → no resend; the following normal
   settle does resend.
4. **Late-enqueue window:** send accepted with stamp = settled run's index → no resend at that
   settle; resend at the next normal settle.
5. **Independence:** two stopped children dropped together → each resent exactly once, both rows
   clear, at most one outcome per id (acceptance criteria "independently" + "at most one").
6. **Ping records** heal identically to results.
7. **Failed-send re-arm:** record with `sendAccepted === false` resends at a normal settle.
8. **Race pin (D5):** with a record already present for a child, a late stop cannot produce a
   second envelope (assert `sendDelivery`'s guard: one accepted send per record).

Also extend `reload-state-test.ts` (or assert within the new file) that the run counter and
stamps live in the `globalThis` slot and survive a simulated module replacement.

## 8. End-to-end verification (required final step)

Per the repo owner's standing rule, the plan must end with an **agent-verified** live workflow.
Drive this yourself in tmux; only if you genuinely cannot, hand the user this exact script and
ask them to run it.

Setup (both constraints are standing rules from the owner):

- **Isolated pi home:** create a scratch dir, copy only `auth.json` and `models.json` from
  `~/.pi/agent/` into it, and launch with `PI_CODING_AGENT_DIR=<scratch>` so the
  globally-installed copy of this extension is not double-registered. Load the worktree's
  extension explicitly (e.g. `pi -e <worktree>/interactive-subagents/index.ts`).
- **Cheap child models only:** configure children to Haiku/Sonnet-class models (via
  `subagents.json`), never Fable/Opus.

Scenario (mirrors the issue's acceptance criteria):

1. In a tmux window, start the parent pi with the extension loaded.
2. Prompt the parent to spawn **two autonomous children** with multi-minute tasks, and give the
   parent itself a long-running prompt so it keeps streaming.
3. While the parent streams: open `/subagent-status`, stop **both** children with `x` (the
   watcher's stopped sends will be accepted mid-stream and queue), then press **Escape** before
   the turn boundary. Expected: both rows freeze at `delivering` — the bug, reproduced.
   (If the picker cannot open mid-stream, the equivalent drop window is letting two children
   *complete* while the parent streams, then Escape — same mechanism; additionally exercise the
   stop path with best-effort timing.)
4. Send any new parent prompt and let the turn complete.
5. Verify, and capture evidence for the summary you report back:
   - `tmux capture-pane` of the widget after step 3 (rows stuck `delivering`) and after step 4
     (rows gone, no stale rows anywhere).
   - The parent session JSONL contains **exactly one** `subagent_result` with reason `stopped`
     per child id — count them — and each arrived after the step-4 turn.
   - No duplicate outcomes for any child across the whole file.

## 9. Acceptance criteria mapping (from issue #72)

- "Stopping a child with `x` cannot leave a permanent `delivering` row…" → D2/§4; e2e step 5.
- "Cancellation and normal completion cannot both claim the same child's terminal delivery." →
  D5; unit test 8.
- "At most one stopped outcome per child, including retries/recovery." → proof rule (resend only
  on proof) + `sendAccepted` guard; unit tests 1–5; e2e JSONL count.
- "Multiple children stopped close together are handled independently…" → per-record proof and
  finalizers; unit test 5; e2e uses two children.
- "Regression test for: stopped child → send accepted → parent abort drops queued message →
  later parent turn/session activity." → unit test 1.
- "Verify end to end in tmux…" → §8.
