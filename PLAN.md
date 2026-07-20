# PLAN: Model-relative auto-compaction at 70% (issue #65)

A new `auto-compact/` extension that requests pi's standard compaction when context usage
reaches a model-relative threshold (default 70% of the active model's context window),
evaluated only at safe workflow boundaries. Plus a small `better-footer-context` change that
surfaces the threshold in the footer.

This document is the full shared understanding: contract, verified API surfaces, and every
decision already made. It deliberately omits implementation details.

## Why

Pi's native auto-compaction fires at a fixed token reserve: `contextTokens > contextWindow −
reserveTokens`, with `reserveTokens` defaulting to 16,384 (`shouldCompact` in
`node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js`). That is
~92% of a 200K window and ~98.4% of a 1M window — compaction lands very late, and later the
bigger the window. This extension adds a consistent, model-relative threshold across all
providers and window sizes. Native auto-compaction stays enabled as the in-workflow and
overflow-recovery backstop.

## Verified pi API facts (pi-coding-agent 0.80.6)

These were confirmed by reading the installed package; they ground every design choice.
Types live in `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`.

- **`agent_settled`** — "Fired after an agent run has fully settled and no automatic retry,
  compaction, or queued continuation will run." It is emitted in the `finally` of
  `_runAgentPrompt`, so it fires exactly once per user-driven run — **including runs the user
  aborted with Esc**. It does NOT fire after an extension-requested compaction, so a completed
  compaction cannot re-enter the trigger until the next real run settles.
- **`ctx.getContextUsage(): ContextUsage | undefined`** — returns `{tokens, contextWindow,
  percent}` where `tokens`/`percent` are `null` when unknown, explicitly including "right
  after compaction, before next LLM response". The stale-usage guard the contract needs is
  therefore native: post-compaction usage reads as unknown until fresh.
- **`ctx.compact(options?: {customInstructions?, onComplete?, onError?}): void`** —
  fire-and-forget; completion/failure arrive via callbacks. Internally it runs
  `session.compact()`, which **calls `await this.abort()` first** — this is the hard reason
  triggering anywhere but `agent_settled` is unsafe. It throws catchable errors such as
  `"Already compacted"` and `"Nothing to compact (session too small)"` (e.g. everything fits
  inside the keep-recent window). Pi has no internal guard against two concurrent `compact()`
  calls; the extension must guard.
- During compaction, pi **queues any prompt the user submits** and **Esc cancels the
  compaction** (interactive mode). The native TUI shows its standard compaction status
  indicator for extension-requested compaction. Nothing the user types can be lost.
- **`session_compact`** fires after ANY successful compaction with `reason:
  "manual" | "threshold" | "overflow"` and `fromExtension`. Extension-requested compaction is
  classified `manual`; the feature must not depend on receiving `threshold`.
- **`model_select`** fires on model switches.
- **Session replacement** (`new`/`resume`/`fork`) tears down and reloads the extension
  runtime — in-memory extension state resets for free.
- **`ctx.ui.notify(message, "info" | "warning" | "error")`** is the user-facing message
  channel; notifications do not enter model context.
- `ctx.isIdle()` and `ctx.hasPendingMessages()` exist on the extension context.
- `pi.setStatus()` / footer: custom footers receive extension statuses; `better-footer-context`
  already renders the context display and can import sibling modules (same package).

## Behavioral contract

- At `agent_settled`, with known usage (`percent != null`):
  - below threshold → nothing.
  - at/above threshold (`percent >= thresholdPercent`) → exactly one compaction request.
- Unknown usage (including immediately post-compaction) never triggers.
- A compaction in progress never receives a duplicate request (extension-held in-flight guard).
- A completed compaction must not retrigger from stale pre-compaction usage (guaranteed by
  the null-usage window plus `agent_settled` not firing after compaction).
- An active workflow is never interrupted: no triggering at `turn_end` or any other
  mid-run event. Crossing the threshold mid-workflow is allowed; native compaction remains
  the mid-run backstop. There is no hard guarantee usage never exceeds the threshold.
- Compaction uses pi's standard behavior end-to-end: its summarizer, retention
  (`keepRecentTokens`), compaction entry, and rebuilt context. No custom prompts, no
  summarizer replacement, no changes to `reserveTokens`/`keepRecentTokens`.
- No mutation of pi-owned state (usage, model metadata, session messages) to force the
  native threshold path. Supported extension APIs only.
- Manual `/compact` behavior is unchanged. Native auto-compaction and overflow recovery stay
  enabled and independent.
- Model switches and session replacement use current model/usage; no stale threshold state
  carries across (each settle reads fresh usage; the only persistent state is the in-flight
  guard, the failure latch, and last-run-aborted tracking).
- Works in every pi mode where the APIs exist (`tui`/`rpc`/`json`/`print`); no TUI-only
  dependence. Also runs inside pi subagent children — no `PI_SUBAGENT_SESSION`
  special-casing.

## Decisions (resolved in interview — do not reopen)

1. **Config: layered, mirroring `interactive-subagents/config.ts`** — built-in defaults <
   `autocompact.json` in pi's config root (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`) <
   env vars. Same conventions: one validator per key shared by file and env layers, unknown
   file keys rejected by name, malformed values throw at extension load (fail-fast),
   dependency-free module taking env as a parameter for unit testing.
   - `thresholdPercent`: integer 1–100, default 70. Env `PI_AUTO_COMPACT_THRESHOLD_PERCENT`.
   - `enabled`: boolean, default true. Env `PI_AUTO_COMPACT_ENABLED`.
   - One global value — per-model/per-provider overrides are out of scope.
2. **Naming set**: directory `auto-compact/`, config file `autocompact.json`, env prefix
   `PI_AUTO_COMPACT_*`.
3. **Abort handling**: a settle following a user-aborted run does not compact (detect the
   abort from the last assistant message's stop reason via `agent_end`). If usage is at/above
   threshold at that settle, post one info notify telling the user compaction was deferred
   and will happen after the next completed run. The next natural settle triggers normally.
4. **Announce**: one info notify when triggering (e.g. "Context at 72% — auto-compacting").
   Nothing extra on success — pi's native indicator and compaction entry cover it. Failure
   surfaces as an error notify.
5. **Failure latch**: ONE failure (`onError`) disables percentage compaction and notifies.
   The latch clears on: any successful compaction (`session_compact`, any reason), a model
   switch (`model_select`), or session replacement (automatic via extension reload). This
   plus once-per-settle evaluation makes a retry loop impossible by construction.
6. **Footer surfacing** (changes to `better-footer-context/index.ts`, importing the
   auto-compact config directly):
   - Append the target inline to the context display: `43% 160k/372k · compact @70%`.
   - Derive color bands from the configured threshold instead of the hardcoded 70/90:
     warning within 10 points of the threshold, error at/above it.
   - A proximity `setStatus` line was considered and rejected.
7. **Scope**: the extension runs everywhere, including pi subagent children. External-harness
   children run Claude Code, not pi — unaffected.

## Defaults chosen (flagged to user, not vetoed)

- Comparison is `percent >= thresholdPercent`, using pi's own `percent` value (0–100 scale).
- Immediately before calling `ctx.compact()`, re-check `ctx.isIdle()` and
  `!ctx.hasPendingMessages()` to narrow the settle-vs-new-prompt race; pi's queueing makes
  the residual window harmless.
- `enabled: false` makes the extension fully inert (no compaction, no deferred-abort
  notify), and the footer then omits the `· compact @70%` suffix and keeps its current
  hardcoded bands.

## Trigger logic (shape only — the one piece of pseudocode)

```
on agent_settled:
  if !config.enabled or latch.failed or inFlight: return
  usage = ctx.getContextUsage()
  if usage?.percent == null or usage.percent < config.thresholdPercent: return
  if lastRunAborted: notify info "deferred"; return
  if !ctx.isIdle() or ctx.hasPendingMessages(): return
  inFlight = true; notify info "compacting"
  ctx.compact({ onComplete: clear inFlight, onError: clear inFlight, set latch, notify error })
```

## Out of scope

- Compaction during `turn_end` or any other active agent phase.
- Any guarantee that usage never exceeds the threshold mid-workflow.
- Per-model or per-provider thresholds.
- Custom summary prompts, alternate summarization models, custom retention.
- Mutating pi internals to enter the private native-threshold path.
- Disabling or replacing native auto-compaction/overflow recovery.
- The rejected proximity status line.

## Acceptance criteria

- Equivalent threshold behavior across materially different context windows (200K, 372K,
  1M), driven by `ContextUsage`, never by hard-coded window sizes.
- Boundary behavior below/at/above the threshold matches the contract (69/70/71).
- A multi-turn tool workflow and a run with queued steering/follow-up messages that cross
  the threshold fully settle before exactly one compaction begins.
- Unknown and stale post-compaction usage cannot retrigger; an in-progress compaction never
  gets a duplicate request.
- An aborted run defers with the info notify instead of compacting.
- One failure latches off with an error notify; the latch clears on successful compaction,
  model switch, or session replacement; native protection is never disabled.
- Standard pi compaction output: normal compaction entry, configured recent-context
  retention, rebuilt session context. `/compact` unchanged.
- No pi-owned usage/model/message/session object is mutated.

## Verification workflow (agent-verified)

1. `make check` (typecheck + all `*/tests/*-test.ts` via `node --experimental-strip-types`).
2. Unit tests against fakes: the trigger decision at 69/70/71% for 200K/372K/1M windows;
   unknown usage; abort-skip with deferred notify; in-flight guard; failure latch set/clear
   (success, model switch); config validation (defaults, file layer, env layer, rejects).
3. Live smoke test, agent-run: isolated pi home (copy auth/models into a packages-free
   `PI_CODING_AGENT_DIR` so the installed copy of this package doesn't double-register), a
   cheap model (Haiku/Sonnet — never Fable/Opus), `PI_AUTO_COMPACT_THRESHOLD_PERCENT=5`.
   Drive a couple of short prompts to cross 5%, then assert: exactly one compaction entry
   appears in the session file after settle, the pre-compaction notify fired, and the next
   settle (usage unknown/fresh-below) does not retrigger.
4. Footer: verify the inline `· compact @<n>%` suffix and threshold-relative bands render
   (live smoke or existing footer test pattern), and that `enabled: false` removes them.
