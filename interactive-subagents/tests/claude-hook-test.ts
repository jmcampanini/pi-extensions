// Unit tests for claude-hook.mjs — run as a real subprocess (exactly how
// Claude Code invokes it) with fixture stdin payloads, then assert on the
// sidecar files through the SAME readers the parent supervisor uses.
import { readActivityFile } from "../activity.ts";
import { readExternalResult, readExternalSessionId } from "../harnesses.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "claude-hook.mjs");
const dir = mkdtempSync(join(tmpdir(), "subagents-hook-"));
const anchor = join(dir, "child.jsonl");
const activityFile = `${anchor}.activity`;
const RUN_ID = "a55ba067";

/** Invoke the hook exactly as Claude Code would: argv + JSON on stdin. */
function runHook(event: string, payload: unknown, extraArgs: string[] = []): string {
	return execFileSync("node", [HOOK, event, anchor, RUN_ID, ...extraArgs], {
		input: JSON.stringify(payload),
		encoding: "utf8",
	});
}

/** The accepted snapshot, via the parent's own reader (runId fence included). */
function snapshot() {
	const read = readActivityFile(activityFile, RUN_ID);
	if (read.kind !== "valid") throw new Error(`expected a valid snapshot, got ${read.kind}`);
	return read.snapshot;
}

// ── session-start writes the baseline snapshot ───────────────────────────

eq("hook prints nothing to stdout", runHook("session-start", { session_id: "sess-1", hook_event_name: "SessionStart" }), "");
let snap = snapshot();
eq("baseline write has sequence 1", snap.sequence, 1);
eq("baseline is idle", [snap.inRun, snap.runsCompleted, snap.activeTools], [false, 0, []]);
ok("no lock file left behind", !existsSync(`${activityFile}.lock`));

// ── prompt-start arms the run ────────────────────────────────────────────

runHook("prompt-start", { session_id: "sess-1", hook_event_name: "UserPromptSubmit" });
snap = snapshot();
eq("prompt-start advances the counter", snap.sequence, 2);
eq("run id is stamped", snap.runId, RUN_ID);
eq("prompt-start sets inRun", snap.inRun, true);
eq("no runs completed yet", snap.runsCompleted, 0);

// ── tool-start / tool-end maintain the active-tool list ──────────────────

runHook("tool-start", { session_id: "sess-1", tool_name: "Bash", tool_use_id: "tu_1" });
snap = snapshot();
eq("tool-start advances the counter", snap.sequence, 3);
eq("tool entry keyed by tool_use_id", snap.activeTools.map((t) => t.toolCallId), ["tu_1"]);
eq("tool entry names the tool", snap.activeTools[0].name, "Bash");

runHook("tool-start", { session_id: "sess-1", tool_name: "Read", tool_use_id: "tu_2" });
eq("parallel tools coexist", snapshot().activeTools.map((t) => t.toolCallId), ["tu_1", "tu_2"]);

runHook("tool-end", { session_id: "sess-1", tool_name: "Bash", tool_use_id: "tu_1" });
snap = snapshot();
eq("tool-end removes exactly its entry", snap.activeTools.map((t) => t.toolCallId), ["tu_2"]);
eq("counter keeps advancing", snap.sequence, 5);

// Older payloads without tool_use_id fall back to the tool name as the key.
runHook("tool-start", { session_id: "sess-1", tool_name: "Grep" });
eq("no tool_use_id: keyed by name", snapshot().activeTools.map((t) => t.toolCallId), ["tu_2", "Grep"]);
runHook("tool-end", { session_id: "sess-1", tool_name: "Grep" });
eq("no tool_use_id: end matches by name", snapshot().activeTools.map((t) => t.toolCallId), ["tu_2"]);

// ── turn-complete without --auto-exit (human-driven) ─────────────────────

const FINAL = "The default branch is main.\n\nVerified with `git branch`.";
runHook("turn-complete", { session_id: "sess-1", last_assistant_message: FINAL });
snap = snapshot();
eq("turn-complete clears inRun", snap.inRun, false);
eq("turn-complete counts the run", snap.runsCompleted, 1);
eq("turn-complete clears active tools", snap.activeTools, []);
eq("result file matches the payload verbatim", readExternalResult(anchor), FINAL);
eq("session id is recorded", readExternalSessionId(anchor), "sess-1");
ok("human-driven turn writes NO completion marker", !existsSync(`${anchor}.exit`));

// ── a second turn (human keeps driving) overwrites the result ────────────

runHook("prompt-start", { session_id: "sess-1" });
eq("second prompt re-arms the run", snapshot().inRun, true);
runHook("turn-complete", {
	session_id: "sess-1",
	last_assistant_message: [
		{ type: "text", text: "Part one." },
		{ type: "tool_use", id: "tu_9" },
		{ type: "text", text: "Part two." },
	],
});
eq("multi-part message joins its text blocks", readExternalResult(anchor), "Part one.\nPart two.");
eq("second run counted", snapshot().runsCompleted, 2);

// ── an empty final message leaves the previous result alone ──────────────

runHook("turn-complete", { session_id: "sess-1", last_assistant_message: "   " });
eq("blank final message does not clobber the result", readExternalResult(anchor), "Part one.\nPart two.");

// ── turn-complete with --auto-exit writes the marker last ────────────────

runHook("turn-complete", { session_id: "sess-1", last_assistant_message: "All done." }, ["--auto-exit"]);
eq("autonomous turn writes the completion marker", JSON.parse(readFileSync(`${anchor}.exit`, "utf8")), { type: "done" });
eq("marker turn also wrote the result first", readExternalResult(anchor), "All done.");

// ── ownership: a foreign snapshot is abandoned, not repaired ─────────────

writeFileSync(activityFile, JSON.stringify({
	version: 1, runId: "someone-else", pid: 1, sequence: 99, updatedAt: 9, inRun: true,
	runsCompleted: 7, activeTools: [], modelId: null, context: null, costUsd: 0,
}), "utf8");
runHook("prompt-start", { session_id: "sess-1" });
snap = snapshot();
eq("foreign snapshot: fresh baseline (sequence restarts)", snap.sequence, 1);
eq("foreign snapshot: counters reset", snap.runsCompleted, 0);

// ── hostile input never breaks the hook ──────────────────────────────────

const out = execFileSync("node", [HOOK, "turn-complete", anchor, RUN_ID], { input: "{not json", encoding: "utf8" });
eq("garbage stdin: silent stdout, exit 0", out, "");
eq("garbage stdin still advances the snapshot", snapshot().sequence, 2);
eq("unknown event exits quietly", execFileSync("node", [HOOK, "bogus-event", anchor, RUN_ID], { input: "{}", encoding: "utf8" }), "");

// ── concurrent hooks serialize through the lock ──────────────────────────
// Without the lock, parallel read-modify-writes lose updates: a stale write
// landing last resurrects finished tool entries and can publish a regressed
// (updatedAt, sequence) pair the parent debounces toward a false stall. With
// it, every event lands exactly once and the pair only ever advances.
{
	const dir2 = mkdtempSync(join(tmpdir(), "subagents-hook-race-"));
	const anchor2 = join(dir2, "child.jsonl");
	const { execFile } = await import("node:child_process");
	const run = (event: string, payload: unknown) =>
		new Promise<void>((resolve, reject) => {
			const proc = execFile("node", [HOOK, event, anchor2, RUN_ID], (error) => (error ? reject(error) : resolve()));
			proc.stdin!.end(JSON.stringify(payload));
		});
	const PAIRS = 8;
	await Promise.all(
		Array.from({ length: PAIRS }, (_, i) => (async () => {
			await run("tool-start", { tool_name: "Bash", tool_use_id: `tu_${i}` });
			await run("tool-end", { tool_name: "Bash", tool_use_id: `tu_${i}` });
		})()),
	);
	const read = readActivityFile(`${anchor2}.activity`, RUN_ID);
	eq("race: final snapshot is valid", read.kind, "valid");
	if (read.kind === "valid") {
		eq("race: no phantom tool entries survive", read.snapshot.activeTools, []);
		eq("race: every event landed exactly once", read.snapshot.sequence, PAIRS * 2);
	}
	ok("race: lock file released", !existsSync(`${anchor2}.activity.lock`));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
