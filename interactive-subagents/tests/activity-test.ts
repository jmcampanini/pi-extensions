// Unit tests for activity.ts — the liveness snapshot contract. The parser's
// strict-core / tolerant-periphery split, the (updatedAt, sequence) ordering,
// the clock-jump guard, the skew-free tool elapsed formula, and the atomic
// writer are all pinned here: these are the rules that keep a skewed or
// hostile child from ever faking "active" or hiding a stall.
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
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown) {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}: got ${g}, want ${w}`); }
}
function ok(label: string, cond: boolean) {
	if (cond) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}`); }
}

/** A well-formed snapshot; field order matches the parser's output so eq()'s
 * JSON.stringify comparison is exact. */
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

// ── parseActivitySnapshot: strict core ───────────────────────────────────

eq("version constant", ACTIVITY_VERSION, 1);

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
eq("happy path round-trips", parseActivitySnapshot(JSON.stringify(rich), "run1"), { kind: "valid", snapshot: rich });

eq(
	"version 2 is invalid",
	parseActivitySnapshot(JSON.stringify(snap({ version: 2 as unknown as 1 })), "run1"),
	{ kind: "invalid", reason: "version is not 1" },
);
eq("corrupt JSON is invalid", parseActivitySnapshot("{torn", "run1"), { kind: "invalid", reason: "not JSON" });
eq("a JSON array is invalid", parseActivitySnapshot("[1,2]", "run1"), { kind: "invalid", reason: "not a JSON object" });
eq("JSON null is invalid", parseActivitySnapshot("null", "run1"), { kind: "invalid", reason: "not a JSON object" });
eq("runId mismatch is foreign", parseActivitySnapshot(JSON.stringify(snap()), "other"), { kind: "foreign" });

// Each core field wrong-typed or non-finite → invalid with a reason. JSON
// cannot encode Infinity directly, but `1e999` parses to it — that is the
// non-finite shape a broken writer could actually produce.
function corrupt(field: string, jsonValue: string): string {
	const raw = JSON.stringify(snap());
	const pattern = new RegExp(`"${field}":[^,}]+`);
	return raw.replace(pattern, `"${field}":${jsonValue}`);
}
eq("non-string runId invalid", parseActivitySnapshot(corrupt("runId", "42"), "run1"), {
	kind: "invalid", reason: "runId is not a string",
});
eq("string sequence invalid", parseActivitySnapshot(corrupt("sequence", '"5"'), "run1"), {
	kind: "invalid", reason: "sequence is not a finite number",
});
eq("infinite sequence invalid", parseActivitySnapshot(corrupt("sequence", "1e999"), "run1"), {
	kind: "invalid", reason: "sequence is not a finite number",
});
eq("null updatedAt invalid", parseActivitySnapshot(corrupt("updatedAt", "null"), "run1"), {
	kind: "invalid", reason: "updatedAt is not a finite number",
});
eq("infinite updatedAt invalid", parseActivitySnapshot(corrupt("updatedAt", "1e999"), "run1"), {
	kind: "invalid", reason: "updatedAt is not a finite number",
});
eq("string inRun invalid", parseActivitySnapshot(corrupt("inRun", '"yes"'), "run1"), {
	kind: "invalid", reason: "inRun is not a boolean",
});
eq("string runsCompleted invalid", parseActivitySnapshot(corrupt("runsCompleted", '"0"'), "run1"), {
	kind: "invalid", reason: "runsCompleted is not a finite number",
});

// ── parseActivitySnapshot: tolerant periphery ────────────────────────────

function parsedSnapshot(raw: string): ActivitySnapshot {
	const read = parseActivitySnapshot(raw, "run1");
	if (read.kind !== "valid") throw new Error(`expected valid, got ${JSON.stringify(read)}`);
	return read.snapshot;
}

const goodTool = { toolCallId: "t1", name: "bash", startedAt: 4_000 };
const messyTools = [
	goodTool,
	{ toolCallId: 5, name: "x", startedAt: 1 },        // toolCallId not a string
	{ toolCallId: "t2", startedAt: 1 },                // name missing
	{ toolCallId: "t3", name: "y", startedAt: "now" }, // startedAt not a number
	"junk",
	null,
];
eq(
	"malformed activeTools entries are dropped, good ones kept",
	parsedSnapshot(JSON.stringify(snap({ activeTools: messyTools as unknown as ActivitySnapshot["activeTools"] }))).activeTools,
	[goodTool],
);
eq(
	"non-array activeTools becomes []",
	parsedSnapshot(corrupt("activeTools", '"nope"')).activeTools,
	[],
);
eq(
	"context with non-positive window becomes null",
	parsedSnapshot(JSON.stringify(snap({ context: { tokens: 5, window: 0, percent: 1 } }))).context,
	null,
);
eq(
	"context with non-numeric tokens becomes null",
	parsedSnapshot(JSON.stringify(snap({ context: { tokens: "5" as unknown as number, window: 200_000, percent: 1 } }))).context,
	null,
);
eq(
	"non-object context becomes null",
	parsedSnapshot(corrupt("context", '"big"')).context,
	null,
);
eq(
	"post-compaction null tokens/percent survive as null, never 0",
	parsedSnapshot(JSON.stringify(snap({ context: { tokens: null, window: 200_000, percent: null } }))).context,
	{ tokens: null, window: 200_000, percent: null },
);
eq("string costUsd becomes 0", parsedSnapshot(corrupt("costUsd", '"3"')).costUsd, 0);
eq("infinite costUsd becomes 0", parsedSnapshot(corrupt("costUsd", "1e999")).costUsd, 0);
eq("non-string modelId becomes null", parsedSnapshot(corrupt("modelId", "42")).modelId, null);
eq("non-finite pid becomes 0", parsedSnapshot(corrupt("pid", '"boom"')).pid, 0);

// ── observeActivity: ordering and merge rules ────────────────────────────

function freshObs(): ActivityObservation {
	return newActivityObservation(10_000);
}

{
	// First valid read is accepted; a later updatedAt advances.
	const obs = freshObs();
	const first = snap({ updatedAt: 1_000, sequence: 3 });
	observeActivity(obs, { kind: "valid", snapshot: first }, 11_000);
	eq("first valid read accepted", obs.snapshot, first);
	eq("acceptedAtMs stamped with parent now", obs.acceptedAtMs, 11_000);

	const later = snap({ updatedAt: 2_000, sequence: 4 });
	observeActivity(obs, { kind: "valid", snapshot: later }, 12_000);
	eq("larger updatedAt advances", obs.snapshot, later);
	eq("acceptedAtMs refreshed on advance", obs.acceptedAtMs, 12_000);
}

{
	// Tie on updatedAt is broken by sequence.
	const obs = freshObs();
	observeActivity(obs, { kind: "valid", snapshot: snap({ updatedAt: 2_000, sequence: 4 }) }, 11_000);
	const tieWinner = snap({ updatedAt: 2_000, sequence: 5 });
	observeActivity(obs, { kind: "valid", snapshot: tieWinner }, 12_000);
	eq("same updatedAt, larger sequence advances", obs.snapshot, tieWinner);
}

{
	// An equal pair is the same write re-read: complete no-op.
	const obs = freshObs();
	const only = snap({ updatedAt: 2_000, sequence: 4 });
	observeActivity(obs, { kind: "valid", snapshot: only }, 11_000);
	observeActivity(obs, { kind: "valid", snapshot: snap({ updatedAt: 2_000, sequence: 4, costUsd: 9 }) }, 15_000);
	eq("equal pair keeps the current snapshot", obs.snapshot, only);
	eq("equal pair leaves acceptedAtMs unchanged", obs.acceptedAtMs, 11_000);
}

{
	// The child in-pane /reload case: sequence restarts at 1, but the new
	// process's updatedAt is larger, so the pair still advances.
	const obs = freshObs();
	observeActivity(obs, { kind: "valid", snapshot: snap({ updatedAt: 2_000, sequence: 50 }) }, 11_000);
	const reloaded = snap({ updatedAt: 3_000, sequence: 1 });
	observeActivity(obs, { kind: "valid", snapshot: reloaded }, 12_000);
	eq("sequence reset with larger updatedAt accepted", obs.snapshot, reloaded);
}

{
	// An older pair (child clock stepped back) is kept out — and it is a
	// PROBLEM, kind "stale": it opens (or continues) the 60s window so rule 1
	// can stall the child loudly instead of silently serving the frozen
	// accepted state for the whole skew window.
	const obs = freshObs();
	const current = snap({ updatedAt: 5_000, sequence: 9 });
	observeActivity(obs, { kind: "valid", snapshot: current }, 11_000);
	observeActivity(obs, { kind: "missing" }, 12_000);
	eq("problem window opened by missing read", obs.problemSinceMs, 12_000);
	observeActivity(obs, { kind: "valid", snapshot: snap({ updatedAt: 4_000, sequence: 10 }) }, 13_000);
	eq("older pair does not replace the snapshot", obs.snapshot, current);
	eq("older pair does not refresh acceptedAtMs", obs.acceptedAtMs, 11_000);
	eq("older pair keeps the problem window open", obs.problemSinceMs, 12_000);
	eq("older pair records problem kind stale", obs.lastProblemKind, "stale");

	// An EQUAL pair (the same accepted write re-read) is healthy: it clears
	// the problem fields without touching the snapshot or acceptedAtMs.
	observeActivity(obs, { kind: "valid", snapshot: snap({ updatedAt: 5_000, sequence: 9 }) }, 14_000);
	eq("equal pair clears problemSinceMs", obs.problemSinceMs, undefined);
	eq("equal pair clears lastProblemKind", obs.lastProblemKind, undefined);
	eq("equal pair leaves acceptedAtMs alone", obs.acceptedAtMs, 11_000);

	// A stale read with no prior problem opens the window at its own tick…
	observeActivity(obs, { kind: "valid", snapshot: snap({ updatedAt: 4_500, sequence: 11 }) }, 15_000);
	eq("stale read opens the problem window itself", obs.problemSinceMs, 15_000);
	eq("stale read sets lastProblemKind stale", obs.lastProblemKind, "stale");

	// …and a genuinely advancing pair (child clock caught up) clears it.
	const caughtUp = snap({ updatedAt: 6_000, sequence: 12 });
	observeActivity(obs, { kind: "valid", snapshot: caughtUp }, 16_000);
	eq("advancing pair clears the stale window", obs.problemSinceMs, undefined);
	eq("advancing pair is accepted", obs.snapshot, caughtUp);
}

// ── observeActivity: the everSawRun run-history latch ────────────────────
// The child-side runsCompleted counter is per-process and resets to 0 on an
// in-pane /reload; the parent-side latch remembers accepted run history so
// the status machine's rule 4 keeps a reloaded idle child at waiting.

{
	const obs = freshObs();
	observeActivity(obs, { kind: "valid", snapshot: snap({ updatedAt: 1_000 }) }, 11_000);
	eq("idle pre-run snapshot does not latch", obs.everSawRun ?? false, false);
	observeActivity(obs, { kind: "valid", snapshot: snap({ updatedAt: 2_000, inRun: true }) }, 12_000);
	eq("accepted inRun snapshot latches everSawRun", obs.everSawRun, true);
	// The /reload aftermath: fresh process, sequence back at 1, counters at 0.
	observeActivity(obs, { kind: "valid", snapshot: snap({ updatedAt: 3_000, sequence: 1 }) }, 13_000);
	eq("latch survives the reloaded process's counter reset", obs.everSawRun, true);
}

{
	// runsCompleted > 0 latches too (a settle observed without seeing inRun).
	const obs = freshObs();
	observeActivity(obs, { kind: "valid", snapshot: snap({ updatedAt: 1_000, runsCompleted: 1 }) }, 11_000);
	eq("accepted runsCompleted > 0 latches everSawRun", obs.everSawRun, true);
}

{
	// Only ACCEPTED snapshots latch: a rejected stale write must not.
	const obs = freshObs();
	observeActivity(obs, { kind: "valid", snapshot: snap({ updatedAt: 5_000 }) }, 11_000);
	observeActivity(obs, { kind: "valid", snapshot: snap({ updatedAt: 4_000, inRun: true }) }, 12_000);
	eq("a rejected stale snapshot does not latch", obs.everSawRun ?? false, false);
}

{
	// missing → valid clears both problem fields; consecutive problems keep
	// the original problemSinceMs but track the latest kind.
	const obs = freshObs();
	observeActivity(obs, { kind: "missing" }, 11_000);
	eq("missing sets problemSinceMs", obs.problemSinceMs, 11_000);
	eq("missing sets lastProblemKind", obs.lastProblemKind, "missing");
	observeActivity(obs, { kind: "invalid", reason: "not JSON" }, 12_000);
	eq("problemSinceMs stable across consecutive problems", obs.problemSinceMs, 11_000);
	eq("lastProblemKind tracks the latest kind", obs.lastProblemKind, "invalid");
	observeActivity(obs, { kind: "foreign" }, 13_000);
	eq("lastProblemKind tracks foreign too", obs.lastProblemKind, "foreign");
	observeActivity(obs, { kind: "valid", snapshot: snap() }, 14_000);
	eq("valid read clears problemSinceMs", obs.problemSinceMs, undefined);
	eq("valid read clears lastProblemKind", obs.lastProblemKind, undefined);
	eq("valid read after problems is accepted", obs.acceptedAtMs, 14_000);
}

// ── noteTick: the clock-jump guard ───────────────────────────────────────

{
	const obs = newActivityObservation(100_000);
	noteTick(obs, 100_000);
	eq("first tick records lastTickMs", obs.lastTickMs, 100_000);
	eq("first tick leaves watchdogStartMs alone", obs.watchdogStartMs, 100_000);

	noteTick(obs, 101_000);
	noteTick(obs, 102_000);
	eq("1s ticks leave watchdogStartMs alone", obs.watchdogStartMs, 100_000);
	eq("1s ticks advance lastTickMs", obs.lastTickMs, 102_000);

	// Just under the threshold: still treated as a slow tick, no shift.
	noteTick(obs, 102_000 + CLOCK_JUMP_MS - 1);
	eq("gap under CLOCK_JUMP_MS does not shift", obs.watchdogStartMs, 100_000);
}

{
	// A 90s gap (laptop slept) shifts BOTH anchors forward by the whole gap.
	const obs = newActivityObservation(100_000);
	obs.problemSinceMs = 100_500;
	noteTick(obs, 100_000);
	noteTick(obs, 101_000);
	noteTick(obs, 101_000 + 90_000);
	eq("90s gap shifts watchdogStartMs by the gap", obs.watchdogStartMs, 190_000);
	eq("90s gap shifts problemSinceMs by the gap", obs.problemSinceMs, 190_500);
	eq("gap tick still records lastTickMs", obs.lastTickMs, 191_000);
}

{
	// Exactly CLOCK_JUMP_MS is a jump (>=), and ANY negative gap re-anchors:
	// time never genuinely flows backward, so the anchors shift by the gap
	// and the watchdog deltas are preserved exactly.
	const obs = newActivityObservation(100_000);
	noteTick(obs, 100_000);
	noteTick(obs, 100_000 + CLOCK_JUMP_MS);
	eq("gap of exactly CLOCK_JUMP_MS shifts", obs.watchdogStartMs, 100_000 + CLOCK_JUMP_MS);

	noteTick(obs, 90_000); // parent clock stepped BACK 15s
	eq("negative gap shifts watchdogStartMs by the gap", obs.watchdogStartMs, 90_000);
	eq("negative gap still records lastTickMs", obs.lastTickMs, 90_000);
}

{
	// A backward step during a stall must not shrink the problem delta —
	// letting it shrink would flip stalled → starting with no valid read,
	// firing a false recovered steer and then a duplicate stalled steer.
	const obs = newActivityObservation(100_000);
	obs.problemSinceMs = 100_000;
	noteTick(obs, 160_000);
	noteTick(obs, 160_001); // 60s into the problem window …
	noteTick(obs, 150_001); // … then the parent clock steps back 10s
	eq("negative gap shifts problemSinceMs by the gap", obs.problemSinceMs, 90_000);
	eq("negative gap preserves the problem delta exactly",
		(obs.lastTickMs ?? 0) - (obs.problemSinceMs ?? 0), 60_001);
	noteTick(obs, 151_001); // small FORWARD gaps stay real elapsed time
	eq("1s tick after the step leaves the anchors alone", obs.problemSinceMs, 90_000);
}

// ── toolElapsedSeconds: skew-free by construction ────────────────────────
// The tool ran 30s before the snapshot was written (child clock), and the
// parent accepted that snapshot 15s ago (parent clock) → always 45s, no
// matter how far apart the two clocks are.

{
	const tool = { toolCallId: "t1", name: "bash", startedAt: 100_000 };
	const zeroSkew = snap({ updatedAt: 130_000, activeTools: [tool] });
	eq("zero skew", toolElapsedSeconds(zeroSkew, tool, 130_000, 145_000), 45);

	const HOUR = 3_600_000;
	const aheadTool = { toolCallId: "t1", name: "bash", startedAt: 100_000 + HOUR };
	const ahead = snap({ updatedAt: 130_000 + HOUR, activeTools: [aheadTool] });
	eq("child clock 1h ahead: same elapsed", toolElapsedSeconds(ahead, aheadTool, 130_000, 145_000), 45);

	const behindTool = { toolCallId: "t1", name: "bash", startedAt: 100_000 - HOUR };
	const behind = snap({ updatedAt: 130_000 - HOUR, activeTools: [behindTool] });
	eq("child clock 1h behind: same elapsed", toolElapsedSeconds(behind, behindTool, 130_000, 145_000), 45);

	// Garbage where updatedAt predates the tool start clamps to 0.
	const garbageTool = { toolCallId: "t1", name: "bash", startedAt: 200_000 };
	const garbage = snap({ updatedAt: 100_000, activeTools: [garbageTool] });
	eq("negative elapsed clamps to 0", toolElapsedSeconds(garbage, garbageTool, 130_000, 130_000), 0);

	// Cross-field overflow: each timestamp passes the parser's per-field
	// finiteness check, but their difference overflows to Infinity, which the
	// max(0, …) clamp alone would pass through as "InfinityhNaNm" on the
	// display surfaces. Non-finite sums report 0.
	const overflowTool = { toolCallId: "t1", name: "bash", startedAt: -1e308 };
	const overflow = snap({ updatedAt: 1e308, activeTools: [overflowTool] });
	eq("non-finite child+parent sum reports 0", toolElapsedSeconds(overflow, overflowTool, 0, 0), 0);
}

// ── the atomic writer: real-fs round trip ────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), "subagents-activity-"));
const sessionFile = join(dir, "child.jsonl");
const activityFile = activityFilePath(sessionFile);

eq("activityFilePath convention", activityFile, `${sessionFile}.activity`);
eq("reading a never-written file is missing", readActivityFile(activityFile, "run1"), { kind: "missing" });

const firstWrite = snap({ sequence: 1, updatedAt: 1_000 });
writeActivitySnapshot(activityFile, firstWrite);
eq("read-back equals written", readActivityFile(activityFile, "run1"), { kind: "valid", snapshot: firstWrite });
ok("pid-suffixed tmp file gone after write", !existsSync(`${activityFile}.tmp-${process.pid}`));

const secondWrite = snap({ sequence: 2, updatedAt: 2_000, inRun: true, costUsd: 0.05 });
writeActivitySnapshot(activityFile, secondWrite);
eq("second write overwrites", readActivityFile(activityFile, "run1"), { kind: "valid", snapshot: secondWrite });

// A dying previous run (or a human) left garbage at the target: the rename
// replaces it wholesale, no append, no merge.
writeFileSync(activityFile, "{torn garbage", "utf8");
eq("garbage target reads invalid first", readActivityFile(activityFile, "run1"), { kind: "invalid", reason: "not JSON" });
writeActivitySnapshot(activityFile, secondWrite);
eq("pre-existing garbage replaced atomically", readActivityFile(activityFile, "run1"), { kind: "valid", snapshot: secondWrite });

eq("foreign runId on disk reads foreign", readActivityFile(activityFile, "other-run"), { kind: "foreign" });

clearActivityFile(sessionFile);
ok("clearActivityFile removes the file", !existsSync(activityFile));
eq("cleared file reads missing", readActivityFile(activityFile, "run1"), { kind: "missing" });
clearActivityFile(sessionFile); // force: true — clearing a missing file is a no-op, not an error
pass++; console.log("  ok  clearing an already-missing file does not throw");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
