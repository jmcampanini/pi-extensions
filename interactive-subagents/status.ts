/**
 * status.ts — the pure liveness state machine.
 *
 * One function turns a single tick's observations into one of four words:
 * starting, active, waiting, stalled. It is deliberately a pure function of
 * its inputs — no Date.now(), no fs, no caching — so the watcher, the
 * widget, and subagents_list all call it from the same observation fields
 * and can never disagree. Stalled is computed, never latched: any later
 * tick where a valid snapshot advances reads as recovered, and
 * edge-triggering (steer once per episode) is the watcher's job.
 *
 * Clock discipline: every duration here compares parent clock to parent
 * clock (`nowMs` against `watchdogStartMs`/`problemSinceMs`, both stamped
 * by the parent). Child-written timestamps inside the snapshot never enter
 * an inequality, so clock skew between the parent and the child cannot
 * produce a false stall or a false recovery.
 */

import type { ActivitySnapshot } from "./activity.ts";

// ── the four states ──────────────────────────────────────────────────────

export type SubagentStatus = "starting" | "active" | "waiting" | "stalled";

/** How long the watchdog waits before calling a silent child stalled.
 * Fixed by design: this is not configurable. */
export const STALL_AFTER_MS = 60_000;

// ── the inputs (one tick's observations, all parent-clock) ───────────────

export interface StatusInput {
	/** Parent clock (the caller's Date.now()). */
	nowMs: number;
	/** Parent clock; launch time, shifted forward on detected clock jumps. */
	watchdogStartMs: number;
	/** Did this launch include an initial prompt/message? False means a pane
	 * handed to a human, which legitimately idles forever. */
	expectsRun: boolean;
	/** Parent-side run-history latch (ActivityObservation.everSawRun): true
	 * once any accepted snapshot showed inRun or runsCompleted > 0. REQUIRED,
	 * not optional, so the compiler forces every call site to thread it. */
	everSawRun: boolean;
	/** The last ACCEPTED snapshot; absent until the child's first write lands. */
	snapshot?: ActivitySnapshot;
	/** Parent clock since reads have been CONTINUOUSLY missing/foreign/invalid;
	 * absent while reads are healthy. */
	problemSinceMs?: number;
}

// ── the transition table ─────────────────────────────────────────────────
// Rules are evaluated top to bottom; `>=` means the watchdog fires at
// exactly STALL_AFTER_MS. Only rules 1 and 6 can stall — a valid active or
// waiting snapshot never ages out, because a 3-hour tool run with zero
// events is legal and there is no heartbeat to age against.

export function computeStatus(input: StatusInput): SubagentStatus {
	// Rule 1: the activity file has been continuously missing/foreign/invalid
	// for 60s — the writer is broken, deleted, or never came up. Checked
	// FIRST so it overrides even an old accepted snapshot that still says
	// active: the snapshot describes the past, the problem describes now.
	if (input.problemSinceMs !== undefined && input.nowMs - input.problemSinceMs >= STALL_AFTER_MS) {
		return "stalled";
	}

	// Rule 2: nothing accepted yet — the launch window, and also the
	// transient state while a problem is still debouncing toward rule 1.
	if (input.snapshot === undefined) return "starting";

	// Rule 3: mid-run. Never ages out, regardless of snapshot age.
	if (input.snapshot.inRun) return "active";

	// Rule 4: idle after at least one completed run, or idle on a launch that
	// never promised a run (interactive resume without a message). Never
	// ages out either — waiting forever is this state's whole meaning.
	// everSawRun sits alongside runsCompleted because the child-side counter
	// is per-process and resets to 0 on an in-pane /reload: without the
	// parent-side latch a healthy reloaded idle child would fall through to
	// rule 6 and read stalled forever, firing a misleading "task never
	// started" steer. Chosen tradeoff: a reload that genuinely killed a run
	// now reads waiting, not stalled — a human was at that pane to type
	// /reload, and a false stall steer misleads the parent model.
	if (input.snapshot.runsCompleted > 0 || input.everSawRun || !input.expectsRun) return "waiting";

	// Rules 5 and 6: the implant is alive but the prompted run has not begun.
	// Under 60s that is normal pi startup (rule 5); at 60s and beyond it is
	// the stuck-at-starting failure v2 exists to surface (rule 6).
	return input.nowMs - input.watchdogStartMs < STALL_AFTER_MS ? "starting" : "stalled";
}
