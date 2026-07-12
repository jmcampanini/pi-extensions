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
	// An older pair (child clock stepped back) is kept out — but it is still
	// a VALID read, so it clears the problem window.
	const obs = freshObs();
	const current = snap({ updatedAt: 5_000, sequence: 9 });
	observeActivity(obs, { kind: "valid", snapshot: current }, 11_000);
	observeActivity(obs, { kind: "missing" }, 12_000);
	eq("problem window opened by missing read", obs.problemSinceMs, 12_000);
	observeActivity(obs, { kind: "valid", snapshot: snap({ updatedAt: 4_000, sequence: 10 }) }, 13_000);
	eq("older pair does not replace the snapshot", obs.snapshot, current);
	eq("older pair does not refresh acceptedAtMs", obs.acceptedAtMs, 11_000);
	eq("older pair still clears problemSinceMs", obs.problemSinceMs, undefined);
	eq("older pair still clears lastProblemKind", obs.lastProblemKind, undefined);
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
	// Exactly CLOCK_JUMP_MS is a jump (>=), and a negative gap is ignored.
	const obs = newActivityObservation(100_000);
	noteTick(obs, 100_000);
	noteTick(obs, 100_000 + CLOCK_JUMP_MS);
	eq("gap of exactly CLOCK_JUMP_MS shifts", obs.watchdogStartMs, 100_000 + CLOCK_JUMP_MS);

	noteTick(obs, 90_000); // parent clock stepped BACK
	eq("negative gap leaves anchors alone", obs.watchdogStartMs, 100_000 + CLOCK_JUMP_MS);
	eq("negative gap still records lastTickMs", obs.lastTickMs, 90_000);
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
