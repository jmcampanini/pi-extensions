import { describe, it } from "node:test";
import assert from "node:assert/strict";
// The ActivitySnapshot import below is type-only and erased by
// --experimental-strip-types, so this test runs even before activity.ts
// exists (the two modules are built in parallel).
import type { ActivitySnapshot } from "../activity.ts";
import { STALL_AFTER_MS, computeStatus } from "../status.ts";

// Only inRun/runsCompleted matter to computeStatus (the rest is display
// data), so a helper fills the boring required fields.
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

describe("computeStatus", () => {
	it("watchdog constant is fixed at 60s", () => {
		assert.strictEqual(STALL_AFTER_MS, 60_000);
	});

	it("rule 1: 60s-old problem, no snapshot ever accepted → stalled", () => {
		assert.strictEqual(
			computeStatus({ nowMs: T0 + STALL_AFTER_MS, watchdogStartMs: T0, expectsRun: true, everSawRun: false,
				problemSinceMs: T0 }),
			"stalled");
	});

	it("rule 1 boundary: problem at 59_999ms is NOT stalled (still starting)", () => {
		assert.strictEqual(
			computeStatus({ nowMs: T0 + STALL_AFTER_MS - 1, watchdogStartMs: T0, expectsRun: true, everSawRun: false,
				problemSinceMs: T0 }),
			"starting");
	});

	it("rule 1 boundary: problem at exactly 60_000ms IS stalled", () => {
		assert.strictEqual(
			computeStatus({ nowMs: T0 + STALL_AFTER_MS, watchdogStartMs: T0, expectsRun: true, everSawRun: false,
				problemSinceMs: T0 }),
			"stalled");
	});

	// Rule 1 outranks every snapshot rule: an old accepted snapshot that still
	// says active describes the past; 60s of unreadable file describes now.
	it("rule 1 overrides an old accepted ACTIVE snapshot", () => {
		assert.strictEqual(
			computeStatus({ nowMs: T0 + STALL_AFTER_MS, watchdogStartMs: T0 - 3_600_000, expectsRun: true, everSawRun: false,
				snapshot: snap({ inRun: true }), problemSinceMs: T0 }),
			"stalled");
	});

	it("rule 1 overrides an old accepted WAITING snapshot", () => {
		assert.strictEqual(
			computeStatus({ nowMs: T0 + STALL_AFTER_MS, watchdogStartMs: T0 - 3_600_000, expectsRun: true, everSawRun: false,
				snapshot: snap({ runsCompleted: 2 }), problemSinceMs: T0 }),
			"stalled");
	});

	// A stale-pair problem window (observeActivity's kind "stale": the child
	// clock stepped backwards and its writes are time-stamped before the
	// accepted pair) stalls through the same rule-1 debounce — even while the
	// frozen accepted snapshot still says active, and even with the latch set.
	it("rule 1: 60s of stale reads overrides an accepted ACTIVE snapshot", () => {
		assert.strictEqual(
			computeStatus({ nowMs: T0 + STALL_AFTER_MS, watchdogStartMs: T0 - 3_600_000, expectsRun: true, everSawRun: true,
				snapshot: snap({ inRun: true }), problemSinceMs: T0 }),
			"stalled");
	});

	it("rule 1 boundary: stale reads at 59_999ms still read the accepted snapshot (active)", () => {
		assert.strictEqual(
			computeStatus({ nowMs: T0 + STALL_AFTER_MS - 1, watchdogStartMs: T0 - 3_600_000, expectsRun: true, everSawRun: true,
				snapshot: snap({ inRun: true }), problemSinceMs: T0 }),
			"active");
	});

	it("rule 2: no snapshot, no problem → starting", () => {
		assert.strictEqual(
			computeStatus({ nowMs: T0, watchdogStartMs: T0, expectsRun: true, everSawRun: false }),
			"starting");
	});

	it("rule 2: a problem still debouncing (under 60s) reads starting, not stalled", () => {
		assert.strictEqual(
			computeStatus({ nowMs: T0 + 30_000, watchdogStartMs: T0, expectsRun: true, everSawRun: false,
				problemSinceMs: T0 + 10_000 }),
			"starting");
	});

	// Rule 2 does NOT consult the starting watchdog: with no snapshot the only
	// stall path is rule 1's problem clock (problemSince starts at the first
	// failing tick, so missing-from-birth still stalls on time).
	it("rule 2: no snapshot at 10h age with no problem → still starting", () => {
		assert.strictEqual(
			computeStatus({ nowMs: T0 + 36_000_000, watchdogStartMs: T0, expectsRun: true, everSawRun: false }),
			"starting");
	});

	it("rule 3: inRun snapshot → active", () => {
		assert.strictEqual(
			computeStatus({ nowMs: T0, watchdogStartMs: T0, expectsRun: true, everSawRun: false,
				snapshot: snap({ inRun: true }) }),
			"active");
	});

	it("rule 3: inRun at 10h age still active (a 3h bash run is legal)", () => {
		assert.strictEqual(
			computeStatus({ nowMs: T0 + 36_000_000, watchdogStartMs: T0, expectsRun: true, everSawRun: false,
				snapshot: snap({ inRun: true, updatedAt: 5 }) }),
			"active");
	});

	it("rule 4: runsCompleted > 0 → waiting", () => {
		assert.strictEqual(
			computeStatus({ nowMs: T0, watchdogStartMs: T0, expectsRun: true, everSawRun: false,
				snapshot: snap({ runsCompleted: 1 }) }),
			"waiting");
	});

	it("rule 4: runsCompleted > 0 at 10h age still waiting (never ages out)", () => {
		assert.strictEqual(
			computeStatus({ nowMs: T0 + 36_000_000, watchdogStartMs: T0, expectsRun: true, everSawRun: false,
				snapshot: snap({ runsCompleted: 1 }) }),
			"waiting");
	});

	it("rule 4: expectsRun false with zero runs waits immediately (human handoff)", () => {
		assert.strictEqual(
			computeStatus({ nowMs: T0, watchdogStartMs: T0, expectsRun: false, everSawRun: false,
				snapshot: snap({}) }),
			"waiting");
	});

	it("rule 4: expectsRun false with zero runs still waiting past the watchdog", () => {
		assert.strictEqual(
			computeStatus({ nowMs: T0 + STALL_AFTER_MS * 10, watchdogStartMs: T0, expectsRun: false, everSawRun: false,
				snapshot: snap({}) }),
			"waiting");
	});

	// The everSawRun latch: an in-pane /reload resets the child-side
	// runsCompleted counter to 0, but the parent remembers accepted run history.
	// Without the latch the reloaded idle child would fall to rule 6 and read
	// stalled forever (the launch watchdog expired long ago).
	it("rule 4: everSawRun latch keeps a reloaded idle child waiting", () => {
		assert.strictEqual(
			computeStatus({ nowMs: T0 + STALL_AFTER_MS * 10, watchdogStartMs: T0, expectsRun: true, everSawRun: true,
				snapshot: snap({}) }),
			"waiting");
	});

	it("rule 4 control: the same input without the latch misreads stalled", () => {
		assert.strictEqual(
			computeStatus({ nowMs: T0 + STALL_AFTER_MS * 10, watchdogStartMs: T0, expectsRun: true, everSawRun: false,
				snapshot: snap({}) }),
			"stalled");
	});

	it("rule 4: the latch does not shortcut rule 3 (in-progress run reads active)", () => {
		assert.strictEqual(
			computeStatus({ nowMs: T0, watchdogStartMs: T0, expectsRun: true, everSawRun: true,
				snapshot: snap({ inRun: true }) }),
			"active");
	});

	it("rule 5: implant alive, prompted run not begun, under 60s → starting", () => {
		assert.strictEqual(
			computeStatus({ nowMs: T0 + 5_000, watchdogStartMs: T0, expectsRun: true, everSawRun: false,
				snapshot: snap({}) }),
			"starting");
	});

	it("rule 6 boundary: stuck-at-starting at 59_999ms is NOT stalled", () => {
		assert.strictEqual(
			computeStatus({ nowMs: T0 + STALL_AFTER_MS - 1, watchdogStartMs: T0, expectsRun: true, everSawRun: false,
				snapshot: snap({}) }),
			"starting");
	});

	it("rule 6 boundary: stuck-at-starting at exactly 60_000ms IS stalled", () => {
		assert.strictEqual(
			computeStatus({ nowMs: T0 + STALL_AFTER_MS, watchdogStartMs: T0, expectsRun: true, everSawRun: false,
				snapshot: snap({}) }),
			"stalled");
	});

	// The same machine that said stalled reads active the moment observeActivity
	// accepts a fresh valid snapshot (which also clears problemSinceMs).
	it("stalled is computed, never latched", () => {
		const stalledInput = { nowMs: T0 + STALL_AFTER_MS, watchdogStartMs: T0, expectsRun: true, everSawRun: false,
			snapshot: snap({ inRun: true }), problemSinceMs: T0 };
		assert.strictEqual(computeStatus(stalledInput), "stalled",
			"recovery precondition: problem-stalled while last snapshot said active");
		assert.strictEqual(
			computeStatus({ ...stalledInput, snapshot: snap({ inRun: true, updatedAt: 2_000, sequence: 7 }),
				problemSinceMs: undefined }),
			"active",
			"recovery: fresh valid inRun snapshot (problem cleared) reads active again");
	});

	// noteTick (activity.ts, tested there) shifts watchdogStartMs forward by any
	// tick gap of 5s or more; this pins the computeStatus half of that contract,
	// applying the shift inline so the test needs no runtime activity.ts import.
	it("a suspend clock jump must not fire a spurious stall", () => {
		let watchdogStartMs = T0;          // starting child, prompted, no run yet
		const lastTickMs = T0 + 30_000;    // last healthy 1s tick
		const nowMs = lastTickMs + 300_000; // laptop wakes 5 minutes later
		watchdogStartMs += nowMs - lastTickMs; // noteTick's forward shift
		assert.strictEqual(
			computeStatus({ nowMs, watchdogStartMs, expectsRun: true, everSawRun: false, snapshot: snap({}) }),
			"starting",
			"suspend: 5-minute gap re-anchors the watchdog → still starting");
		assert.strictEqual(
			computeStatus({ nowMs, watchdogStartMs: T0, expectsRun: true, everSawRun: false, snapshot: snap({}) }),
			"stalled",
			"suspend control: WITHOUT the shift the same tick would misread stalled");
	});
});
