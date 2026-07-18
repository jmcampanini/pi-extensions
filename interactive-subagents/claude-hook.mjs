/**
 * claude-hook.mjs - the lifecycle notifier for external Claude Code children.
 *
 * Claude Code runs this script (via the per-run `--settings` JSON built in
 * harnesses.ts) at five moments, passing a JSON payload on stdin:
 *
 *   session-start  the tool came up              (SessionStart)
 *   prompt-start   a prompt was submitted        (UserPromptSubmit)
 *   tool-start     a tool began executing        (PreToolUse)
 *   tool-end       a tool finished               (PostToolUse)
 *   turn-complete  the assistant's turn finished (Stop)
 *
 * Usage: node claude-hook.mjs <event> <anchor> <run-id> [--auto-exit]
 *
 * session-start changes no state - its whole job is the baseline snapshot,
 * the analog of the pi implant's "snapshot #1": it proves the tool is up
 * before any run begins, so an idle human-driven child reads "waiting"
 * rather than aging into a false "stalled".
 *
 * Every event updates the `<anchor>.activity` liveness snapshot (the v1
 * schema from activity.ts) so the parent's supervisor sees the same
 * starting/active/waiting/stalled signals a pi child produces. turn-complete
 * additionally writes `<anchor>.result` (the child's final message, taken
 * verbatim from the payload's last_assistant_message), `<anchor>.harness.json`
 * (the tool's own session id, read on resume), and - only with --auto-exit -
 * the one-shot `<anchor>.exit` completion marker, written LAST because it is
 * the signal the supervisor waits for before reading the others.
 *
 * This file runs under plain node (it cannot import the extension's
 * TypeScript), so the sidecar suffixes are hardcoded here and in harnesses.ts
 * together - change them in both places.
 *
 * Failure stance mirrors activity.ts: writes are atomic (pid-salted tmp +
 * rename) and try/catch-wrapped; a broken write degrades LOUD on the parent
 * side (missing/frozen snapshot reads as stalled) but never breaks the child.
 * Nothing is ever printed to stdout - Claude Code injects some hooks' stdout
 * into the conversation - and the exit code is always 0 so a sidecar problem
 * can never block the child's own work.
 *
 * Concurrency: parallel tools run one hook process each, all doing a
 * read-modify-write of the same snapshot, so the sequence is serialized
 * through a best-effort lock file. Without it, a stale write landing last
 * would publish a regressed (updatedAt, sequence) pair - which the parent
 * debounces toward a false "stalled" - or resurrect a finished tool entry
 * for the rest of the turn. On lock timeout the write proceeds unlocked
 * (last-write-wins beats losing the event outright).
 */

import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

const ACTIVITY_VERSION = 1;

const [event, anchor, runId, ...extraArgs] = process.argv.slice(2);
const autoExit = extraArgs.includes("--auto-exit");

const KNOWN_EVENTS = ["session-start", "prompt-start", "tool-start", "tool-end", "turn-complete"];
if (!KNOWN_EVENTS.includes(event) || !anchor || !runId) {
	process.exit(0);
}

/** Synchronous sleep without a child process (plain-node friendly). */
function sleepMs(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Serialize the snapshot's read-modify-write across concurrent hook
 * processes via an O_EXCL lock file next to the activity file. A holder that
 * crashed is taken over once its lock ages past the same 2s budget; on
 * timeout the write proceeds unlocked rather than dropping the event.
 */
function withSnapshotLock(lockFile, fn) {
	const deadline = Date.now() + 2000;
	let locked = false;
	while (Date.now() < deadline) {
		try {
			writeFileSync(lockFile, String(process.pid), { flag: "wx" });
			locked = true;
			break;
		} catch {
			try {
				if (Date.now() - statSync(lockFile).mtimeMs > 2000) rmSync(lockFile, { force: true });
			} catch {
				// lock vanished between attempts - retry immediately
			}
			sleepMs(5);
		}
	}
	try {
		fn();
	} finally {
		if (locked) rmSync(lockFile, { force: true });
	}
}

/** The stdin payload Claude Code pipes in; {} when unreadable. */
function readPayload() {
	try {
		return JSON.parse(readFileSync(0, "utf8"));
	} catch {
		return {};
	}
}

/** Atomic whole-file write, same tmp+rename approach as activity.ts. */
function atomicWrite(file, text) {
	const tmpFile = `${file}.tmp-${process.pid}`;
	writeFileSync(tmpFile, text, "utf8");
	renameSync(tmpFile, file);
}

/**
 * The current snapshot when it is ours (same runId) and structurally sound,
 * else a fresh baseline. A foreign or corrupt snapshot is abandoned rather
 * than repaired: the parent's reader fences foreign runIds off anyway.
 */
function loadSnapshot(activityFile) {
	try {
		const parsed = JSON.parse(readFileSync(activityFile, "utf8"));
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			parsed.version === ACTIVITY_VERSION &&
			parsed.runId === runId &&
			typeof parsed.sequence === "number" &&
			Number.isFinite(parsed.sequence) &&
			typeof parsed.runsCompleted === "number" &&
			Number.isFinite(parsed.runsCompleted)
		) {
			return {
				...parsed,
				inRun: parsed.inRun === true,
				activeTools: Array.isArray(parsed.activeTools) ? parsed.activeTools : [],
			};
		}
	} catch {
		// missing or unreadable - start fresh below
	}
	return {
		version: ACTIVITY_VERSION,
		runId,
		pid: process.pid,
		sequence: 0,
		updatedAt: 0,
		inRun: false,
		runsCompleted: 0,
		activeTools: [],
		modelId: null,
		context: null,
		costUsd: 0,
	};
}

/**
 * The key an active-tool entry lives under. Payloads carry tool_use_id on
 * recent Claude Code versions; older ones only carry tool_name, which still
 * pairs starts with ends correctly for sequential tools (parallel same-name
 * tools then share one entry - a display flicker, not a correctness issue).
 */
function toolKey(payload) {
	if (typeof payload.tool_use_id === "string" && payload.tool_use_id !== "") return payload.tool_use_id;
	if (typeof payload.tool_name === "string" && payload.tool_name !== "") return payload.tool_name;
	return "tool";
}

/**
 * The final message as plain text. last_assistant_message arrives as a
 * string, or as a content-block list (or an object holding one) for
 * multi-part messages - join the text blocks, same as the pi-side summary
 * extraction in session.ts.
 */
function messageText(value) {
	if (typeof value === "string") return value;
	const blocks = Array.isArray(value) ? value : value !== null && typeof value === "object" ? value.content : undefined;
	if (!Array.isArray(blocks)) return "";
	return blocks
		.filter((block) => block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

try {
	const payload = readPayload();
	const activityFile = `${anchor}.activity`;

	withSnapshotLock(`${activityFile}.lock`, () => {
		const snapshot = loadSnapshot(activityFile);

		// session-start deliberately falls through: the stamped write below IS
		// the baseline liveness proof.
		if (event === "prompt-start") {
			// Arms the parent's status machine: inRun flips the child to "active".
			snapshot.inRun = true;
		} else if (event === "tool-start") {
			const key = toolKey(payload);
			snapshot.activeTools = snapshot.activeTools.filter((tool) => tool && tool.toolCallId !== key);
			snapshot.activeTools.push({
				toolCallId: key,
				name: typeof payload.tool_name === "string" ? payload.tool_name : "tool",
				startedAt: Date.now(),
			});
		} else if (event === "tool-end") {
			const key = toolKey(payload);
			snapshot.activeTools = snapshot.activeTools.filter((tool) => tool && tool.toolCallId !== key);
		} else if (event === "turn-complete") {
			snapshot.inRun = false;
			snapshot.runsCompleted += 1;
			snapshot.activeTools = [];
		}

		snapshot.pid = process.pid;
		snapshot.sequence += 1;
		// Monotonic under a backward clock step: the (updatedAt, sequence) pair
		// must strictly advance or the parent reads the file as stale.
		snapshot.updatedAt = Math.max(Date.now(), snapshot.updatedAt);
		atomicWrite(activityFile, JSON.stringify(snapshot));
	});

	if (event === "turn-complete") {
		// Result and session id are (re)written on EVERY completed turn, not
		// just autonomous ones: a human-driven child ends when its pane
		// closes, and these files are then already the last turn's outcome.
		const text = messageText(payload.last_assistant_message);
		if (text.trim() !== "") atomicWrite(`${anchor}.result`, text);
		if (typeof payload.session_id === "string" && payload.session_id !== "") {
			atomicWrite(`${anchor}.harness.json`, JSON.stringify({ sessionId: payload.session_id }));
		}
		// The completion marker goes LAST - it is the signal the supervisor
		// consumes, and the files above must already be durable when it does.
		if (autoExit) writeFileSync(`${anchor}.exit`, JSON.stringify({ type: "done" }));
	}
} catch {
	// Degrade loud on the parent side (stalled), never into the child.
}

process.exit(0);
