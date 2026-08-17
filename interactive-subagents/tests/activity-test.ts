// Unit tests for activity.ts — the liveness snapshot contract. The parser's
// strict-core / tolerant-periphery split, the (updatedAt, sequence) ordering,
// the clock-jump guard, the skew-free tool elapsed formula, and the atomic
// writer are all pinned here: these are the rules that keep a skewed or
// hostile child from ever faking "active" or hiding a stall.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	ACTIVITY_VERSION,
	activityFilePath,
	clearActivityFile,
	CLOCK_JUMP_MS,
	newActivityObservation,
	noteTick,
	observeActivity,
	parseActivitySnapshot,
	readActivityFile,
	toolElapsedSeconds,
	writeActivitySnapshot,
	type ActivityObservation,
	type ActivitySnapshot,
} from "../activity.ts";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "subagents-activity-"));

after(() => {
	rmSync(dir, { recursive: true, force: true });
});

function snap(overrides: Partial<ActivitySnapshot> = {}): ActivitySnapshot {
	return {
		version: 1,
		runId: "run1",
		pid: 4242,
		sequence: 1,
		updatedAt: 1_000,
		inRun: false,
		runsCompleted: 0,
		activeTools: [],
		modelId: null,
		context: null,
		costUsd: 0,
		...overrides,
	};
}

// Each core field wrong-typed or non-finite → invalid with a reason. JSON
// cannot encode Infinity directly, but `1e999` parses to it — that is the
// non-finite shape a broken writer could actually produce.
function corrupt(field: string, jsonValue: string): string {
	const raw = JSON.stringify(snap());
	const pattern = new RegExp(`"${field}":[^,}]+`);
	return raw.replace(pattern, `"${field}":${jsonValue}`);
}

function parsedSnapshot(raw: string): ActivitySnapshot {
	const read = parseActivitySnapshot(raw, "run1");
	assert.ok(read.kind === "valid", `expected valid, got ${JSON.stringify(read)}`);
	return read.snapshot;
}

function freshObs(): ActivityObservation {
	return newActivityObservation(10_000);
}

describe("parseActivitySnapshot", () => {
	it("version constant", () => {
		assert.strictEqual(ACTIVITY_VERSION, 1);
	});

	it("happy path round-trips", () => {
		const rich = snap({
			sequence: 7,
			updatedAt: 5_000,
			inRun: true,
			runsCompleted: 2,
			activeTools: [{ toolCallId: "t1", name: "bash", startedAt: 4_000 }],
			modelId: "provider/model",
			context: { tokens: 84_000, window: 200_000, percent: 42 },
			costUsd: 0.31,
		});
		assert.deepStrictEqual(parseActivitySnapshot(JSON.stringify(rich), "run1"), { kind: "valid", snapshot: rich });
	});

	it("version 2 is invalid", () => {
		assert.deepStrictEqual(
			parseActivitySnapshot(JSON.stringify(snap({ version: 2 as unknown as 1 })), "run1"),
			{ kind: "invalid", reason: "version is not 1" },
		);
	});

	it("corrupt JSON is invalid", () => {
		assert.deepStrictEqual(parseActivitySnapshot("{torn", "run1"), { kind: "invalid", reason: "not JSON" });
	});

	it("a JSON array is invalid", () => {
		assert.deepStrictEqual(parseActivitySnapshot("[1,2]", "run1"), { kind: "invalid", reason: "not a JSON object" });
	});

	it("JSON null is invalid", () => {
		assert.deepStrictEqual(parseActivitySnapshot("null", "run1"), { kind: "invalid", reason: "not a JSON object" });
	});

	it("runId mismatch is foreign", () => {
		assert.deepStrictEqual(parseActivitySnapshot(JSON.stringify(snap()), "other"), { kind: "foreign" });
	});

	it("non-string runId invalid", () => {
		assert.deepStrictEqual(parseActivitySnapshot(corrupt("runId", "42"), "run1"), {
			kind: "invalid", reason: "runId is not a string",
		});
	});

	it("string sequence invalid", () => {
		assert.deepStrictEqual(parseActivitySnapshot(corrupt("sequence", '"5"'), "run1"), {
			kind: "invalid", reason: "sequence is not a finite number",
		});
	});

	it("infinite sequence invalid", () => {
		assert.deepStrictEqual(parseActivitySnapshot(corrupt("sequence", "1e999"), "run1"), {
			kind: "invalid", reason: "sequence is not a finite number",
		});
	});

	it("null updatedAt invalid", () => {
		assert.deepStrictEqual(parseActivitySnapshot(corrupt("updatedAt", "null"), "run1"), {
			kind: "invalid", reason: "updatedAt is not a finite number",
		});
	});

	it("infinite updatedAt invalid", () => {
		assert.deepStrictEqual(parseActivitySnapshot(corrupt("updatedAt", "1e999"), "run1"), {
			kind: "invalid", reason: "updatedAt is not a finite number",
		});
	});

	it("string inRun invalid", () => {
		assert.deepStrictEqual(parseActivitySnapshot(corrupt("inRun", '"yes"'), "run1"), {
			kind: "invalid", reason: "inRun is not a boolean",
		});
	});

	it("string runsCompleted invalid", () => {
		assert.deepStrictEqual(parseActivitySnapshot(corrupt("runsCompleted", '"0"'), "run1"), {
			kind: "invalid", reason: "runsCompleted is not a finite number",
		});
	});

	it("malformed activeTools entries are dropped, good ones kept", () => {
		const goodTool = { toolCallId: "t1", name: "bash", startedAt: 4_000 };
		const messyTools = [
			goodTool,
			{ toolCallId: 5, name: "x", startedAt: 1 },        // toolCallId not a string
			{ toolCallId: "t2", startedAt: 1 },                // name missing
			{ toolCallId: "t3", name: "y", startedAt: "now" }, // startedAt not a number
			"junk",
			null,
		];
		assert.deepStrictEqual(
			parsedSnapshot(JSON.stringify(snap({ activeTools: messyTools as unknown as ActivitySnapshot["activeTools"] }))).activeTools,
			[goodTool],
		);
	});

	it("non-array activeTools becomes []", () => {
		assert.deepStrictEqual(parsedSnapshot(corrupt("activeTools", '"nope"')).activeTools, []);
	});

	it("context with non-positive window becomes null", () => {
		assert.strictEqual(parsedSnapshot(JSON.stringify(snap({ context: { tokens: 5, window: 0, percent: 1 } }))).context, null);
	});

	it("context with non-numeric tokens becomes null", () => {
		assert.strictEqual(
			parsedSnapshot(JSON.stringify(snap({ context: { tokens: "5" as unknown as number, window: 200_000, percent: 1 } }))).context,
			null,
		);
	});

	it("non-object context becomes null", () => {
		assert.strictEqual(parsedSnapshot(corrupt("context", '"big"')).context, null);
	});

	it("post-compaction null tokens/percent survive as null, never 0", () => {
		assert.deepStrictEqual(
			parsedSnapshot(JSON.stringify(snap({ context: { tokens: null, window: 200_000, percent: null } }))).context,
			{ tokens: null, window: 200_000, percent: null },
		);
	});

	it("string costUsd becomes 0", () => {
		assert.strictEqual(parsedSnapshot(corrupt("costUsd", '"3"')).costUsd, 0);
	});

	it("infinite costUsd becomes 0", () => {
		assert.strictEqual(parsedSnapshot(corrupt("costUsd", "1e999")).costUsd, 0);
	});

	it("non-string modelId becomes null", () => {
		assert.strictEqual(parsedSnapshot(corrupt("modelId", "42")).modelId, null);
	});

	it("non-finite pid becomes 0", () => {
		assert.strictEqual(parsedSnapshot(corrupt("pid", '"boom"')).pid, 0);
	});
});

describe("observeActivity", () => {
	it("a first valid read is accepted and a later updatedAt advances", () => {
		const obs = freshObs();
		const first = snap({ updatedAt: 1_000, sequence: 3 });
		observeActivity(obs, { kind: "valid", snapshot: first }, 11_000);
		assert.deepStrictEqual(obs.snapshot, first, "first valid read accepted");
		assert.strictEqual(obs.acceptedAtMs, 11_000, "acceptedAtMs stamped with parent now");

		const later = snap({ updatedAt: 2_000, sequence: 4 });
		observeActivity(obs, { kind: "valid", snapshot: later }, 12_000);
		assert.deepStrictEqual(obs.snapshot, later, "larger updatedAt advances");
		assert.strictEqual(obs.acceptedAtMs, 12_000, "acceptedAtMs refreshed on advance");
	});

	it("a tie on updatedAt is broken by sequence", () => {
		const obs = freshObs();
		observeActivity(obs, { kind: "valid", snapshot: snap({ updatedAt: 2_000, sequence: 4 }) }, 11_000);
		const tieWinner = snap({ updatedAt: 2_000, sequence: 5 });
		observeActivity(obs, { kind: "valid", snapshot: tieWinner }, 12_000);
		assert.deepStrictEqual(obs.snapshot, tieWinner, "same updatedAt, larger sequence advances");
	});

	it("an equal pair is the same write re-read: complete no-op", () => {
		const obs = freshObs();
		const only = snap({ updatedAt: 2_000, sequence: 4 });
		observeActivity(obs, { kind: "valid", snapshot: only }, 11_000);
		observeActivity(obs, { kind: "valid", snapshot: snap({ updatedAt: 2_000, sequence: 4, costUsd: 9 }) }, 15_000);
		assert.deepStrictEqual(obs.snapshot, only, "equal pair keeps the current snapshot");
		assert.strictEqual(obs.acceptedAtMs, 11_000, "equal pair leaves acceptedAtMs unchanged");
	});

	it("the in-pane /reload sequence reset still advances on a larger updatedAt", () => {
		const obs = freshObs();
		observeActivity(obs, { kind: "valid", snapshot: snap({ updatedAt: 2_000, sequence: 50 }) }, 11_000);
		const reloaded = snap({ updatedAt: 3_000, sequence: 1 });
		observeActivity(obs, { kind: "valid", snapshot: reloaded }, 12_000);
		assert.deepStrictEqual(obs.snapshot, reloaded, "sequence reset with larger updatedAt accepted");
	});

	it("an older pair is kept out as a stale problem until the child catches up", () => {
		// An older pair (child clock stepped back) is kept out — and it is a
		// PROBLEM, kind "stale": it opens (or continues) the 60s window so rule 1
		// can stall the child loudly instead of silently serving the frozen
		// accepted state for the whole skew window.
		const obs = freshObs();
		const current = snap({ updatedAt: 5_000, sequence: 9 });
		observeActivity(obs, { kind: "valid", snapshot: current }, 11_000);
		observeActivity(obs, { kind: "missing" }, 12_000);
		assert.strictEqual(obs.problemSinceMs, 12_000, "problem window opened by missing read");
		observeActivity(obs, { kind: "valid", snapshot: snap({ updatedAt: 4_000, sequence: 10 }) }, 13_000);
		assert.deepStrictEqual(obs.snapshot, current, "older pair does not replace the snapshot");
		assert.strictEqual(obs.acceptedAtMs, 11_000, "older pair does not refresh acceptedAtMs");
		assert.strictEqual(obs.problemSinceMs, 12_000, "older pair keeps the problem window open");
		assert.strictEqual(obs.lastProblemKind, "stale", "older pair records problem kind stale");

		// An EQUAL pair (the same accepted write re-read) is healthy: it clears
		// the problem fields without touching the snapshot or acceptedAtMs.
		observeActivity(obs, { kind: "valid", snapshot: snap({ updatedAt: 5_000, sequence: 9 }) }, 14_000);
		assert.strictEqual(obs.problemSinceMs, undefined, "equal pair clears problemSinceMs");
		assert.strictEqual(obs.lastProblemKind, undefined, "equal pair clears lastProblemKind");
		assert.strictEqual(obs.acceptedAtMs, 11_000, "equal pair leaves acceptedAtMs alone");

		// A stale read with no prior problem opens the window at its own tick…
		observeActivity(obs, { kind: "valid", snapshot: snap({ updatedAt: 4_500, sequence: 11 }) }, 15_000);
		assert.strictEqual(obs.problemSinceMs, 15_000, "stale read opens the problem window itself");
		assert.strictEqual(obs.lastProblemKind, "stale", "stale read sets lastProblemKind stale");

		// …and a genuinely advancing pair (child clock caught up) clears it.
		const caughtUp = snap({ updatedAt: 6_000, sequence: 12 });
		observeActivity(obs, { kind: "valid", snapshot: caughtUp }, 16_000);
		assert.strictEqual(obs.problemSinceMs, undefined, "advancing pair clears the stale window");
		assert.deepStrictEqual(obs.snapshot, caughtUp, "advancing pair is accepted");
	});

	// The child-side runsCompleted counter is per-process and resets to 0 on an
	// in-pane /reload; the parent-side latch remembers accepted run history so
	// the status machine's rule 4 keeps a reloaded idle child at waiting.
	it("an accepted inRun snapshot latches everSawRun across the reload counter reset", () => {
		const obs = freshObs();
		observeActivity(obs, { kind: "valid", snapshot: snap({ updatedAt: 1_000 }) }, 11_000);
		assert.strictEqual(obs.everSawRun ?? false, false, "idle pre-run snapshot does not latch");
		observeActivity(obs, { kind: "valid", snapshot: snap({ updatedAt: 2_000, inRun: true }) }, 12_000);
		assert.strictEqual(obs.everSawRun, true, "accepted inRun snapshot latches everSawRun");
		// The /reload aftermath: fresh process, sequence back at 1, counters at 0.
		observeActivity(obs, { kind: "valid", snapshot: snap({ updatedAt: 3_000, sequence: 1 }) }, 13_000);
		assert.strictEqual(obs.everSawRun, true, "latch survives the reloaded process's counter reset");
	});

	it("accepted runsCompleted > 0 latches everSawRun", () => {
		const obs = freshObs();
		observeActivity(obs, { kind: "valid", snapshot: snap({ updatedAt: 1_000, runsCompleted: 1 }) }, 11_000);
		assert.strictEqual(obs.everSawRun, true);
	});

	it("a rejected stale snapshot does not latch", () => {
		const obs = freshObs();
		observeActivity(obs, { kind: "valid", snapshot: snap({ updatedAt: 5_000 }) }, 11_000);
		observeActivity(obs, { kind: "valid", snapshot: snap({ updatedAt: 4_000, inRun: true }) }, 12_000);
		assert.strictEqual(obs.everSawRun ?? false, false);
	});

	it("consecutive problems keep the original window and a valid read clears it", () => {
		const obs = freshObs();
		observeActivity(obs, { kind: "missing" }, 11_000);
		assert.strictEqual(obs.problemSinceMs, 11_000, "missing sets problemSinceMs");
		assert.strictEqual(obs.lastProblemKind, "missing", "missing sets lastProblemKind");
		observeActivity(obs, { kind: "invalid", reason: "not JSON" }, 12_000);
		assert.strictEqual(obs.problemSinceMs, 11_000, "problemSinceMs stable across consecutive problems");
		assert.strictEqual(obs.lastProblemKind, "invalid", "lastProblemKind tracks the latest kind");
		observeActivity(obs, { kind: "foreign" }, 13_000);
		assert.strictEqual(obs.lastProblemKind, "foreign", "lastProblemKind tracks foreign too");
		observeActivity(obs, { kind: "valid", snapshot: snap() }, 14_000);
		assert.strictEqual(obs.problemSinceMs, undefined, "valid read clears problemSinceMs");
		assert.strictEqual(obs.lastProblemKind, undefined, "valid read clears lastProblemKind");
		assert.strictEqual(obs.acceptedAtMs, 14_000, "valid read after problems is accepted");
	});
});

describe("noteTick", () => {
	it("ordinary ticks advance lastTickMs without shifting the watchdog anchor", () => {
		const obs = newActivityObservation(100_000);
		noteTick(obs, 100_000);
		assert.strictEqual(obs.lastTickMs, 100_000, "first tick records lastTickMs");
		assert.strictEqual(obs.watchdogStartMs, 100_000, "first tick leaves watchdogStartMs alone");

		noteTick(obs, 101_000);
		noteTick(obs, 102_000);
		assert.strictEqual(obs.watchdogStartMs, 100_000, "1s ticks leave watchdogStartMs alone");
		assert.strictEqual(obs.lastTickMs, 102_000, "1s ticks advance lastTickMs");

		// Just under the threshold: still treated as a slow tick, no shift.
		noteTick(obs, 102_000 + CLOCK_JUMP_MS - 1);
		assert.strictEqual(obs.watchdogStartMs, 100_000, "gap under CLOCK_JUMP_MS does not shift");
	});

	it("a 90s gap (laptop slept) shifts both anchors forward by the whole gap", () => {
		const obs = newActivityObservation(100_000);
		obs.problemSinceMs = 100_500;
		noteTick(obs, 100_000);
		noteTick(obs, 101_000);
		noteTick(obs, 101_000 + 90_000);
		assert.strictEqual(obs.watchdogStartMs, 190_000, "90s gap shifts watchdogStartMs by the gap");
		assert.strictEqual(obs.problemSinceMs, 190_500, "90s gap shifts problemSinceMs by the gap");
		assert.strictEqual(obs.lastTickMs, 191_000, "gap tick still records lastTickMs");
	});

	it("a gap of exactly CLOCK_JUMP_MS and any negative gap re-anchor", () => {
		// Exactly CLOCK_JUMP_MS is a jump (>=), and ANY negative gap re-anchors:
		// time never genuinely flows backward, so the anchors shift by the gap
		// and the watchdog deltas are preserved exactly.
		const obs = newActivityObservation(100_000);
		noteTick(obs, 100_000);
		noteTick(obs, 100_000 + CLOCK_JUMP_MS);
		assert.strictEqual(obs.watchdogStartMs, 100_000 + CLOCK_JUMP_MS, "gap of exactly CLOCK_JUMP_MS shifts");

		noteTick(obs, 90_000); // parent clock stepped BACK 15s
		assert.strictEqual(obs.watchdogStartMs, 90_000, "negative gap shifts watchdogStartMs by the gap");
		assert.strictEqual(obs.lastTickMs, 90_000, "negative gap still records lastTickMs");
	});

	it("a backward step during a stall preserves the problem delta exactly", () => {
		// Letting the delta shrink would flip stalled → starting with no valid
		// read, firing a false recovered steer and then a duplicate stalled steer.
		const obs = newActivityObservation(100_000);
		obs.problemSinceMs = 100_000;
		noteTick(obs, 160_000);
		noteTick(obs, 160_001); // 60s into the problem window …
		noteTick(obs, 150_001); // … then the parent clock steps back 10s
		assert.strictEqual(obs.problemSinceMs, 90_000, "negative gap shifts problemSinceMs by the gap");
		assert.strictEqual(
			(obs.lastTickMs ?? 0) - (obs.problemSinceMs ?? 0), 60_001,
			"negative gap preserves the problem delta exactly");
		noteTick(obs, 151_001); // small FORWARD gaps stay real elapsed time
		assert.strictEqual(obs.problemSinceMs, 90_000, "1s tick after the step leaves the anchors alone");
	});
});

// The tool ran 30s before the snapshot was written (child clock), and the
// parent accepted that snapshot 15s ago (parent clock) → always 45s, no
// matter how far apart the two clocks are.
describe("toolElapsedSeconds", () => {
	const HOUR = 3_600_000;

	it("zero skew", () => {
		const tool = { toolCallId: "t1", name: "bash", startedAt: 100_000 };
		const zeroSkew = snap({ updatedAt: 130_000, activeTools: [tool] });
		assert.strictEqual(toolElapsedSeconds(zeroSkew, tool, 130_000, 145_000), 45);
	});

	it("child clock 1h ahead: same elapsed", () => {
		const aheadTool = { toolCallId: "t1", name: "bash", startedAt: 100_000 + HOUR };
		const ahead = snap({ updatedAt: 130_000 + HOUR, activeTools: [aheadTool] });
		assert.strictEqual(toolElapsedSeconds(ahead, aheadTool, 130_000, 145_000), 45);
	});

	it("child clock 1h behind: same elapsed", () => {
		const behindTool = { toolCallId: "t1", name: "bash", startedAt: 100_000 - HOUR };
		const behind = snap({ updatedAt: 130_000 - HOUR, activeTools: [behindTool] });
		assert.strictEqual(toolElapsedSeconds(behind, behindTool, 130_000, 145_000), 45);
	});

	it("negative elapsed clamps to 0", () => {
		// Garbage where updatedAt predates the tool start clamps to 0.
		const garbageTool = { toolCallId: "t1", name: "bash", startedAt: 200_000 };
		const garbage = snap({ updatedAt: 100_000, activeTools: [garbageTool] });
		assert.strictEqual(toolElapsedSeconds(garbage, garbageTool, 130_000, 130_000), 0);
	});

	it("non-finite child+parent sum reports 0", () => {
		// Cross-field overflow: each timestamp passes the parser's per-field
		// finiteness check, but their difference overflows to Infinity, which the
		// max(0, …) clamp alone would pass through as "InfinityhNaNm" on the
		// display surfaces. Non-finite sums report 0.
		const overflowTool = { toolCallId: "t1", name: "bash", startedAt: -1e308 };
		const overflow = snap({ updatedAt: 1e308, activeTools: [overflowTool] });
		assert.strictEqual(toolElapsedSeconds(overflow, overflowTool, 0, 0), 0);
	});
});

describe("the atomic writer", () => {
	it("round-trips, replaces garbage wholesale, and clears cleanly on the real fs", () => {
		const sessionFile = join(dir, "child.jsonl");
		const activityFile = activityFilePath(sessionFile);

		assert.strictEqual(activityFile, `${sessionFile}.activity`, "activityFilePath convention");
		assert.deepStrictEqual(readActivityFile(activityFile, "run1"), { kind: "missing" },
			"reading a never-written file is missing");

		const firstWrite = snap({ sequence: 1, updatedAt: 1_000 });
		writeActivitySnapshot(activityFile, firstWrite);
		assert.deepStrictEqual(readActivityFile(activityFile, "run1"), { kind: "valid", snapshot: firstWrite },
			"read-back equals written");
		assert.ok(!existsSync(`${activityFile}.tmp-${process.pid}`), "pid-suffixed tmp file gone after write");

		const secondWrite = snap({ sequence: 2, updatedAt: 2_000, inRun: true, costUsd: 0.05 });
		writeActivitySnapshot(activityFile, secondWrite);
		assert.deepStrictEqual(readActivityFile(activityFile, "run1"), { kind: "valid", snapshot: secondWrite },
			"second write overwrites");

		// A dying previous run (or a human) left garbage at the target: the rename
		// replaces it wholesale, no append, no merge.
		writeFileSync(activityFile, "{torn garbage", "utf8");
		assert.deepStrictEqual(readActivityFile(activityFile, "run1"), { kind: "invalid", reason: "not JSON" },
			"garbage target reads invalid first");
		writeActivitySnapshot(activityFile, secondWrite);
		assert.deepStrictEqual(readActivityFile(activityFile, "run1"), { kind: "valid", snapshot: secondWrite },
			"pre-existing garbage replaced atomically");

		assert.deepStrictEqual(readActivityFile(activityFile, "other-run"), { kind: "foreign" },
			"foreign runId on disk reads foreign");

		clearActivityFile(sessionFile);
		assert.ok(!existsSync(activityFile), "clearActivityFile removes the file");
		assert.deepStrictEqual(readActivityFile(activityFile, "run1"), { kind: "missing" }, "cleared file reads missing");
		// force: true — clearing a missing file is a no-op, not an error
		assert.doesNotThrow(() => clearActivityFile(sessionFile), "clearing an already-missing file does not throw");
	});
});
