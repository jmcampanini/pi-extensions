// Unit tests for status.ts — every row of the design's six-rule transition
// table, the exact 60s watchdog boundaries, the never-ages-out rules, and
// the no-latch recovery property. computeStatus is a pure function, so each
// case is just one literal in, one word out.
//
// The ActivitySnapshot import below is type-only and erased by
// --experimental-strip-types, so this test runs even before activity.ts
// exists (the two modules are built in parallel).
import type { ActivitySnapshot } from "../activity.ts";
import { STALL_AFTER_MS, computeStatus } from "../status.ts";

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown) {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}: got ${g}, want ${w}`); }
}

// Snapshot literals: only inRun/runsCompleted matter to computeStatus (the
// rest is display data), so a helper fills the boring required fields.
function snap(partial: Partial<ActivitySnapshot>): ActivitySnapshot {
	return {
		version: 1,
		runId: "abcd1234",
		pid: 4242,
		sequence: 1,
		updatedAt: 1_000,
		inRun: false,
		runsCompleted: 0,
		activeTools: [],
		modelId: null,
		context: null,
		costUsd: 0,
		...partial,
	};
}

// The parent clock: an arbitrary anchor, everything is relative to it.
const T0 = 1_000_000;

eq("watchdog constant is fixed at 60s", STALL_AFTER_MS, 60_000);

// ── rule 1: continuous read problem for 60s → stalled ────────────────────
eq("rule 1: 60s-old problem, no snapshot ever accepted → stalled",
	computeStatus({ nowMs: T0 + STALL_AFTER_MS, watchdogStartMs: T0, expectsRun: true, everSawRun: false,
		problemSinceMs: T0 }),
	"stalled");
eq("rule 1 boundary: problem at 59_999ms is NOT stalled (still starting)",
	computeStatus({ nowMs: T0 + STALL_AFTER_MS - 1, watchdogStartMs: T0, expectsRun: true, everSawRun: false,
		problemSinceMs: T0 }),
	"starting");
eq("rule 1 boundary: problem at exactly 60_000ms IS stalled",
	computeStatus({ nowMs: T0 + STALL_AFTER_MS, watchdogStartMs: T0, expectsRun: true, everSawRun: false,
		problemSinceMs: T0 }),
	"stalled");
// Rule 1 outranks every snapshot rule: an old accepted snapshot that still
// says active describes the past; 60s of unreadable file describes now.
eq("rule 1 overrides an old accepted ACTIVE snapshot",
	computeStatus({ nowMs: T0 + STALL_AFTER_MS, watchdogStartMs: T0 - 3_600_000, expectsRun: true, everSawRun: false,
		snapshot: snap({ inRun: true }), problemSinceMs: T0 }),
	"stalled");
eq("rule 1 overrides an old accepted WAITING snapshot",
	computeStatus({ nowMs: T0 + STALL_AFTER_MS, watchdogStartMs: T0 - 3_600_000, expectsRun: true, everSawRun: false,
		snapshot: snap({ runsCompleted: 2 }), problemSinceMs: T0 }),
	"stalled");
// A stale-pair problem window (observeActivity's kind "stale": the child
// clock stepped backwards and its writes are time-stamped before the
// accepted pair) stalls through the same rule-1 debounce — even while the
// frozen accepted snapshot still says active, and even with the latch set.
eq("rule 1: 60s of stale reads overrides an accepted ACTIVE snapshot",
	computeStatus({ nowMs: T0 + STALL_AFTER_MS, watchdogStartMs: T0 - 3_600_000, expectsRun: true, everSawRun: true,
		snapshot: snap({ inRun: true }), problemSinceMs: T0 }),
	"stalled");
eq("rule 1 boundary: stale reads at 59_999ms still read the accepted snapshot (active)",
	computeStatus({ nowMs: T0 + STALL_AFTER_MS - 1, watchdogStartMs: T0 - 3_600_000, expectsRun: true, everSawRun: true,
		snapshot: snap({ inRun: true }), problemSinceMs: T0 }),
	"active");

// ── rule 2: no accepted snapshot → starting ──────────────────────────────
eq("rule 2: no snapshot, no problem → starting",
	computeStatus({ nowMs: T0, watchdogStartMs: T0, expectsRun: true, everSawRun: false }),
	"starting");
eq("rule 2: a problem still debouncing (under 60s) reads starting, not stalled",
	computeStatus({ nowMs: T0 + 30_000, watchdogStartMs: T0, expectsRun: true, everSawRun: false,
		problemSinceMs: T0 + 10_000 }),
	"starting");
// Rule 2 does NOT consult the starting watchdog: with no snapshot the only
// stall path is rule 1's problem clock (problemSince starts at the first
// failing tick, so missing-from-birth still stalls on time).
eq("rule 2: no snapshot at 10h age with no problem → still starting",
	computeStatus({ nowMs: T0 + 36_000_000, watchdogStartMs: T0, expectsRun: true, everSawRun: false }),
	"starting");

// ── rule 3: inRun → active, never ages out ───────────────────────────────
eq("rule 3: inRun snapshot → active",
	computeStatus({ nowMs: T0, watchdogStartMs: T0, expectsRun: true, everSawRun: false,
		snapshot: snap({ inRun: true }) }),
	"active");
eq("rule 3: inRun at 10h age still active (a 3h bash run is legal)",
	computeStatus({ nowMs: T0 + 36_000_000, watchdogStartMs: T0, expectsRun: true, everSawRun: false,
		snapshot: snap({ inRun: true, updatedAt: 5 }) }),
	"active");

// ── rule 4: idle with a completed run, or no run promised → waiting ──────
eq("rule 4: runsCompleted > 0 → waiting",
	computeStatus({ nowMs: T0, watchdogStartMs: T0, expectsRun: true, everSawRun: false,
		snapshot: snap({ runsCompleted: 1 }) }),
	"waiting");
eq("rule 4: runsCompleted > 0 at 10h age still waiting (never ages out)",
	computeStatus({ nowMs: T0 + 36_000_000, watchdogStartMs: T0, expectsRun: true, everSawRun: false,
		snapshot: snap({ runsCompleted: 1 }) }),
	"waiting");
eq("rule 4: expectsRun false with zero runs waits immediately (human handoff)",
	computeStatus({ nowMs: T0, watchdogStartMs: T0, expectsRun: false, everSawRun: false,
		snapshot: snap({}) }),
	"waiting");
eq("rule 4: expectsRun false with zero runs still waiting past the watchdog",
	computeStatus({ nowMs: T0 + STALL_AFTER_MS * 10, watchdogStartMs: T0, expectsRun: false, everSawRun: false,
		snapshot: snap({}) }),
	"waiting");
// The everSawRun latch: an in-pane /reload resets the child-side
// runsCompleted counter to 0, but the parent remembers accepted run history.
// Without the latch the reloaded idle child would fall to rule 6 and read
// stalled forever (the launch watchdog expired long ago).
eq("rule 4: everSawRun latch keeps a reloaded idle child waiting",
	computeStatus({ nowMs: T0 + STALL_AFTER_MS * 10, watchdogStartMs: T0, expectsRun: true, everSawRun: true,
		snapshot: snap({}) }),
	"waiting");
eq("rule 4 control: the same input without the latch misreads stalled",
	computeStatus({ nowMs: T0 + STALL_AFTER_MS * 10, watchdogStartMs: T0, expectsRun: true, everSawRun: false,
		snapshot: snap({}) }),
	"stalled");
eq("rule 4: the latch does not shortcut rule 3 (in-progress run reads active)",
	computeStatus({ nowMs: T0, watchdogStartMs: T0, expectsRun: true, everSawRun: true,
		snapshot: snap({ inRun: true }) }),
	"active");

// ── rules 5 and 6: prompted run not begun — the starting watchdog ────────
eq("rule 5: implant alive, prompted run not begun, under 60s → starting",
	computeStatus({ nowMs: T0 + 5_000, watchdogStartMs: T0, expectsRun: true, everSawRun: false,
		snapshot: snap({}) }),
	"starting");
eq("rule 6 boundary: stuck-at-starting at 59_999ms is NOT stalled",
	computeStatus({ nowMs: T0 + STALL_AFTER_MS - 1, watchdogStartMs: T0, expectsRun: true, everSawRun: false,
		snapshot: snap({}) }),
	"starting");
eq("rule 6 boundary: stuck-at-starting at exactly 60_000ms IS stalled",
	computeStatus({ nowMs: T0 + STALL_AFTER_MS, watchdogStartMs: T0, expectsRun: true, everSawRun: false,
		snapshot: snap({}) }),
	"stalled");

// ── recovery: stalled is computed, never latched ─────────────────────────
// The same machine that said stalled reads active the moment observeActivity
// accepts a fresh valid snapshot (which also clears problemSinceMs).
{
	const stalledInput = { nowMs: T0 + STALL_AFTER_MS, watchdogStartMs: T0, expectsRun: true, everSawRun: false,
		snapshot: snap({ inRun: true }), problemSinceMs: T0 };
	eq("recovery precondition: problem-stalled while last snapshot said active",
		computeStatus(stalledInput), "stalled");
	eq("recovery: fresh valid inRun snapshot (problem cleared) reads active again",
		computeStatus({ ...stalledInput, snapshot: snap({ inRun: true, updatedAt: 2_000, sequence: 7 }),
			problemSinceMs: undefined }),
		"active");
}

// ── suspend simulation: a clock jump must not fire a spurious stall ──────
// noteTick (activity.ts, tested there) shifts watchdogStartMs forward by any
// tick gap of 5s or more; this pins the computeStatus half of that contract,
// applying the shift inline so the test needs no runtime activity.ts import.
{
	let watchdogStartMs = T0;          // starting child, prompted, no run yet
	const lastTickMs = T0 + 30_000;    // last healthy 1s tick
	const nowMs = lastTickMs + 300_000; // laptop wakes 5 minutes later
	watchdogStartMs += nowMs - lastTickMs; // noteTick's forward shift
	eq("suspend: 5-minute gap re-anchors the watchdog → still starting",
		computeStatus({ nowMs, watchdogStartMs, expectsRun: true, everSawRun: false, snapshot: snap({}) }),
		"starting");
	eq("suspend control: WITHOUT the shift the same tick would misread stalled",
		computeStatus({ nowMs, watchdogStartMs: T0, expectsRun: true, everSawRun: false, snapshot: snap({}) }),
		"stalled");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
