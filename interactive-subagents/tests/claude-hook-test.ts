// Unit tests for claude-hook.mjs — run as a real subprocess (exactly how
// Claude Code invokes it) with fixture stdin payloads, then assert on the
// sidecar files through the SAME readers the parent supervisor uses.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readActivityFile } from "../activity.ts";
import { readExternalResult, readExternalSessionId } from "../harnesses.ts";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
	assert.ok(read.kind === "valid", `expected a valid snapshot, got ${read.kind}`);
	return read.snapshot;
}

describe("claude-hook.mjs", () => {
	it("hook events maintain the activity snapshot, result, and completion sidecars across a session", () => {
		// ── session-start writes the baseline snapshot ───────────────────

		assert.strictEqual(runHook("session-start", { session_id: "sess-1", hook_event_name: "SessionStart" }), "", "hook prints nothing to stdout");
		let snap = snapshot();
		assert.strictEqual(snap.sequence, 1, "baseline write has sequence 1");
		assert.deepStrictEqual([snap.inRun, snap.runsCompleted, snap.activeTools], [false, 0, []], "baseline is idle");
		assert.ok(!existsSync(`${activityFile}.lock`), "no lock file left behind");

		// ── prompt-start arms the run ────────────────────────────────────

		runHook("prompt-start", { session_id: "sess-1", hook_event_name: "UserPromptSubmit" });
		snap = snapshot();
		assert.strictEqual(snap.sequence, 2, "prompt-start advances the counter");
		assert.strictEqual(snap.runId, RUN_ID, "run id is stamped");
		assert.strictEqual(snap.inRun, true, "prompt-start sets inRun");
		assert.strictEqual(snap.runsCompleted, 0, "no runs completed yet");

		// ── tool-start / tool-end maintain the active-tool list ──────────

		runHook("tool-start", { session_id: "sess-1", tool_name: "Bash", tool_use_id: "tu_1" });
		snap = snapshot();
		assert.strictEqual(snap.sequence, 3, "tool-start advances the counter");
		assert.deepStrictEqual(snap.activeTools.map((t) => t.toolCallId), ["tu_1"], "tool entry keyed by tool_use_id");
		assert.strictEqual(snap.activeTools[0].name, "Bash", "tool entry names the tool");

		runHook("tool-start", { session_id: "sess-1", tool_name: "Read", tool_use_id: "tu_2" });
		assert.deepStrictEqual(snapshot().activeTools.map((t) => t.toolCallId), ["tu_1", "tu_2"], "parallel tools coexist");

		runHook("tool-end", { session_id: "sess-1", tool_name: "Bash", tool_use_id: "tu_1" });
		snap = snapshot();
		assert.deepStrictEqual(snap.activeTools.map((t) => t.toolCallId), ["tu_2"], "tool-end removes exactly its entry");
		assert.strictEqual(snap.sequence, 5, "counter keeps advancing");

		// Older payloads without tool_use_id fall back to the tool name as the key.
		runHook("tool-start", { session_id: "sess-1", tool_name: "Grep" });
		assert.deepStrictEqual(snapshot().activeTools.map((t) => t.toolCallId), ["tu_2", "Grep"], "no tool_use_id: keyed by name");
		runHook("tool-end", { session_id: "sess-1", tool_name: "Grep" });
		assert.deepStrictEqual(snapshot().activeTools.map((t) => t.toolCallId), ["tu_2"], "no tool_use_id: end matches by name");

		// ── turn-complete without --auto-exit (human-driven) ─────────────

		const FINAL = "The default branch is main.\n\nVerified with `git branch`.";
		runHook("turn-complete", { session_id: "sess-1", last_assistant_message: FINAL });
		snap = snapshot();
		assert.strictEqual(snap.inRun, false, "turn-complete clears inRun");
		assert.strictEqual(snap.runsCompleted, 1, "turn-complete counts the run");
		assert.deepStrictEqual(snap.activeTools, [], "turn-complete clears active tools");
		assert.strictEqual(readExternalResult(anchor), FINAL, "result file matches the payload verbatim");
		assert.strictEqual(readExternalSessionId(anchor), "sess-1", "session id is recorded");
		assert.ok(!existsSync(`${anchor}.exit`), "human-driven turn writes NO completion marker");

		// ── a second turn (human keeps driving) overwrites the result ────

		runHook("prompt-start", { session_id: "sess-1" });
		assert.strictEqual(snapshot().inRun, true, "second prompt re-arms the run");
		runHook("turn-complete", {
			session_id: "sess-1",
			last_assistant_message: [
				{ type: "text", text: "Part one." },
				{ type: "tool_use", id: "tu_9" },
				{ type: "text", text: "Part two." },
			],
		});
		assert.strictEqual(readExternalResult(anchor), "Part one.\nPart two.", "multi-part message joins its text blocks");
		assert.strictEqual(snapshot().runsCompleted, 2, "second run counted");

		// ── an empty final message leaves the previous result alone ──────

		runHook("turn-complete", { session_id: "sess-1", last_assistant_message: "   " });
		assert.strictEqual(readExternalResult(anchor), "Part one.\nPart two.", "blank final message does not clobber the result");

		// ── turn-complete with --auto-exit writes the marker last ────────

		runHook("turn-complete", { session_id: "sess-1", last_assistant_message: "All done." }, ["--auto-exit"]);
		assert.deepStrictEqual(JSON.parse(readFileSync(`${anchor}.exit`, "utf8")), { type: "done" }, "autonomous turn writes the completion marker");
		assert.strictEqual(readExternalResult(anchor), "All done.", "marker turn also wrote the result first");

		// ── ownership: a foreign snapshot is abandoned, not repaired ─────

		writeFileSync(activityFile, JSON.stringify({
			version: 1, runId: "someone-else", pid: 1, sequence: 99, updatedAt: 9, inRun: true,
			runsCompleted: 7, activeTools: [], modelId: null, context: null, costUsd: 0,
		}), "utf8");
		runHook("prompt-start", { session_id: "sess-1" });
		snap = snapshot();
		assert.strictEqual(snap.sequence, 1, "foreign snapshot: fresh baseline (sequence restarts)");
		assert.strictEqual(snap.runsCompleted, 0, "foreign snapshot: counters reset");

		// ── hostile input never breaks the hook ──────────────────────────

		const out = execFileSync("node", [HOOK, "turn-complete", anchor, RUN_ID], { input: "{not json", encoding: "utf8" });
		assert.strictEqual(out, "", "garbage stdin: silent stdout, exit 0");
		assert.strictEqual(snapshot().sequence, 2, "garbage stdin still advances the snapshot");
		assert.strictEqual(execFileSync("node", [HOOK, "bogus-event", anchor, RUN_ID], { input: "{}", encoding: "utf8" }), "", "unknown event exits quietly");
	});

	// Without the lock, parallel read-modify-writes lose updates: a stale write
	// landing last resurrects finished tool entries and can publish a regressed
	// (updatedAt, sequence) pair the parent debounces toward a false stall. With
	// it, every event lands exactly once and the pair only ever advances.
	it("concurrent hooks serialize through the lock", async () => {
		const dir2 = mkdtempSync(join(tmpdir(), "subagents-hook-race-"));
		const anchor2 = join(dir2, "child.jsonl");
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
		assert.ok(read.kind === "valid", "race: final snapshot is valid");
		assert.deepStrictEqual(read.snapshot.activeTools, [], "race: no phantom tool entries survive");
		assert.strictEqual(read.snapshot.sequence, PAIRS * 2, "race: every event landed exactly once");
		assert.ok(!existsSync(`${anchor2}.activity.lock`), "race: lock file released");
	});
});
