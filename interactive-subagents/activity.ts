/**
 * activity.ts — the liveness snapshot: child-side recorder, parent-side reader.
 *
 * v2 liveness rides on ONE small JSON file per child, `<session>.jsonl.activity`,
 * sibling of `.exit` and `.meta`. The child's implant overwrites it on every
 * recorded event; the parent's watcher reads it once per 1s poll tick. Both
 * halves of the contract live in this file so they can never drift apart —
 * the same colocation property protocol.ts gives the env-var/sidecar contract.
 *
 * Ground rules:
 *
 *   - Every `*At` timestamp INSIDE the snapshot is CHILD-clock Date.now().
 *     The parent never compares one against its own clock: snapshots are
 *     ordered child-against-child, watchdogs run parent-against-parent, and
 *     tool durations add two same-domain differences (toolElapsedSeconds), so
 *     clock skew between the processes can never fake or hide a stall.
 *   - Writes are atomic (tmp + rename) and try/catch-wrapped: a broken write
 *     must never throw into pi. Persistent failure degrades LOUD — the parent
 *     sees a missing/frozen snapshot and reports stalled — never WRONG.
 *   - No timers, no throttling, no debounce, and none is needed: the recorded
 *     events are naturally sparse and each write is under 1 KB and
 *     synchronous. Do NOT add a debounce "just in case" — a valid snapshot
 *     never has to prove freshness (see status.ts), so a heartbeat would add
 *     /reload-leak surface for zero correctness value.
 *
 * Pi types are imported as `import type` ONLY (erased by node's
 * --experimental-strip-types), so the unit tests can import this module under
 * plain node. Runtime imports are limited to node:fs.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

// ── the snapshot schema ──────────────────────────────────────────────────

export const ACTIVITY_VERSION = 1;

/** One tool call currently executing in the child. Parallel tool execution
 * is pi's default, so this is a list keyed by toolCallId — a single
 * "current tool" slot would corrupt the display under fan-out. */
export interface ActivityToolRun {
	toolCallId: string;
	/** Raw toolName from tool_execution_start — child-written, so display
	 * surfaces must sanitize it; the file keeps the raw truth. */
	name: string;
	/** Child clock at tool_execution_start. */
	startedAt: number;
}

export interface ActivitySnapshot {
	/** Readers reject anything but ACTIVITY_VERSION. */
	version: 1;
	/** PI_SUBAGENT_ID — the ownership fence. The parent trusts only snapshots
	 * stamped with the run id it minted for THIS launch, so a stale file that
	 * survived a failed clear is inert. */
	runId: string;
	/** The implant's process.pid. Informational. */
	pid: number;
	/** 1, 2, 3… per implant process; tie-breaker within one updatedAt ms. */
	sequence: number;
	/** Child clock at write; the primary ordering key. */
	updatedAt: number;
	/** True from agent_start until agent_settled. */
	inRun: boolean;
	/** Count of agent_settled events seen by THIS implant process. */
	runsCompleted: number;
	activeTools: ActivityToolRun[];
	/** ctx.model?.id at last refresh (display only). */
	modelId: string | null;
	/** Copied VERBATIM from ctx.getContextUsage() (contextWindow renamed to
	 * window); null when it returns undefined. tokens/percent are null right
	 * after a compaction until the next assistant reply — unknown is
	 * represented as null, never as 0. */
	context: {
		tokens: number | null;
		window: number;
		percent: number | null;
	} | null;
	/** Sum of usage.cost.total over THIS run's assistant turn_ends. Scoped to
	 * this implant process, not session lifetime: a lifetime figure seeded
	 * from the .jsonl would count the parent's forked-in messages as child
	 * spend. Every surface labels it "cost this run". */
	costUsd: number;
}

// ── path + lifecycle ─────────────────────────────────────────────────────

/** The activity file lives next to the session file, like `.exit` and
 * `.meta`. One helper owns the convention so both sides agree on it. */
export function activityFilePath(sessionFile: string): string {
	return `${sessionFile}.activity`;
}

/**
 * Delete a session's activity file before (re)launching into it. Stale runs
 * are doubly fenced — the reader also rejects snapshots with a foreign
 * runId — but clearing keeps the common path clean. Tmp files are
 * pid-suffixed and orphan-rare; ignore them.
 *
 * Placement matters on resume: clear AFTER the still-running guard, never
 * before — a rejected resume of a busy child must not delete the live
 * child's snapshot (that would manufacture a false stall ~60s later).
 */
export function clearActivityFile(sessionFile: string): void {
	rmSync(activityFilePath(sessionFile), { force: true });
}

// ── the atomic writer ────────────────────────────────────────────────────

/**
 * Whole-file overwrite via tmp + rename — the codebase's first, deliberately
 * confined to this file. Writing `${activityFile}.tmp-<pid>` and renaming
 * onto the final name is atomic because both names are in the same directory
 * (same filesystem): a reader sees either the old complete file or the new
 * complete file, never a torn one. The pid suffix closes the real two-writer
 * window — between the parent's poller resolving on the `.exit` sidecar and
 * closePane killing the child, the dying child can still write; pid-salted
 * tmp names cannot collide, last rename wins, and `runId` decides trust.
 *
 * Best effort, same stance as writeExitSidecar (implant.ts): a failed write
 * must never throw into pi. Persistent failure is the designed loud failure:
 * the parent sees a missing/frozen snapshot and the watchdog reports
 * stalled, while the pane and the sentinel still catch real death.
 */
export function writeActivitySnapshot(activityFile: string, snapshot: ActivitySnapshot): void {
	try {
		const tmpFile = `${activityFile}.tmp-${process.pid}`;
		writeFileSync(tmpFile, JSON.stringify(snapshot), "utf8");
		renameSync(tmpFile, activityFile);
	} catch {
		// degrade loud: the parent's watchdog will report stalled
	}
}

// ── the child-side recorder ──────────────────────────────────────────────

/**
 * Wire the implant's liveness reporting: one in-memory snapshot, bumped and
 * rewritten on every recorded event. Called once from implant.ts when both
 * PI_SUBAGENT_ID and PI_SUBAGENT_ACTIVITY_FILE are present; when they are
 * missing the recorder never registers and the parent shows starting then
 * stalled — documented degradation, not an error.
 *
 * Holds no globalThis state and registers no timers: a /reload inside the
 * child pane re-imports this module and re-registers with `sequence` back at
 * 1, which the parent's (updatedAt, sequence) ordering absorbs because the
 * new process's updatedAt is larger.
 *
 * Events deliberately NOT recorded:
 *
 *   - message_update: high frequency — listening to it would force the
 *     throttling this file promises not to need.
 *   - turn_start: agent_start is the run opener, so first-turn delivery
 *     quirks in pi's loop entry points cannot matter here.
 *   - agent_end: it fires while automatic retries, compaction, and queued
 *     continuations may still run (and can double-fire — see implant.ts);
 *     agent_settled is pi's own "truly idle" signal and closes the run.
 */
export function registerActivityRecorder(pi: ExtensionAPI, options: { runId: string; activityFile: string }): void {
	// The in-memory state. Tools live in a Map keyed by toolCallId because pi
	// runs tools in parallel by default; end events arrive in completion
	// order and the map handles that for free.
	const tools = new Map<string, ActivityToolRun>();
	let sequence = 0;
	let inRun = false;
	let runsCompleted = 0;
	let modelId: string | null = null;
	let context: ActivitySnapshot["context"] = null;
	let costUsd = 0;

	/** Bump sequence, stamp updatedAt, write the whole snapshot atomically. */
	function write(): void {
		sequence += 1;
		writeActivitySnapshot(options.activityFile, {
			version: ACTIVITY_VERSION,
			runId: options.runId,
			pid: process.pid,
			sequence,
			updatedAt: Date.now(),
			inRun,
			runsCompleted,
			activeTools: [...tools.values()],
			modelId,
			context,
			costUsd,
		});
	}

	/** Copy ctx.getContextUsage() VERBATIM — never derive tokens from usage
	 * fields ourselves. getContextUsage is the exact method pi's own footer
	 * renders, so the numbers match the child's footer by construction, and
	 * it already skips aborted/error/zero-usage turns internally. */
	function refreshContext(ctx: ExtensionContext): void {
		const usage = ctx.getContextUsage();
		context = usage ? { tokens: usage.tokens, window: usage.contextWindow, percent: usage.percent } : null;
	}

	// Snapshot #1: "pi is up, the implant is alive" — proves liveness before
	// any run begins.
	write();

	// On a resumed/forked session getContextUsage() already returns real
	// numbers from the prior transcript, so the widget shows a true context
	// share within a second of relaunch.
	pi.on("session_start", (_event, ctx) => {
		modelId = ctx.model?.id ?? null;
		refreshContext(ctx);
		write();
	});

	// The run opener; agent_settled below is the closer.
	pi.on("agent_start", () => {
		inRun = true;
		write();
	});

	pi.on("tool_execution_start", (event) => {
		tools.set(event.toolCallId, { toolCallId: event.toolCallId, name: event.toolName, startedAt: Date.now() });
		write();
	});

	pi.on("tool_execution_end", (event) => {
		tools.delete(event.toolCallId);
		write();
	});

	// Cost plus a context/model refresh once per assistant turn. pi persists
	// the assistant message on message_end, which the core loop emits BEFORE
	// turn_end, so getContextUsage() here already reflects the turn that just
	// finished. No skipping of aborted/error turns on cost: partial streams
	// still cost money, and errored turns carry zero usage, which sums
	// harmlessly.
	pi.on("turn_end", (event, ctx) => {
		// event.message is the AgentMessage union; we only read role and
		// usage.cost.total, so the local type says just that (the same
		// pattern as implant.ts's agent_end handler).
		const message = event.message as { role: string; usage?: { cost?: { total?: unknown } } };
		if (message.role !== "assistant") return;
		const total = message.usage?.cost?.total;
		if (typeof total === "number" && Number.isFinite(total)) costUsd += total;
		modelId = ctx.model?.id ?? null;
		refreshContext(ctx);
		write();
	});

	// agent_settled, not agent_end, closes the run: settled fires only once
	// no automatic retry, compaction, or queued continuation will run, so the
	// parent's "waiting" can never flash mid retry-storm. tools.clear() is
	// defensive — aborted turns can leave dangling start events.
	pi.on("agent_settled", (_event, ctx) => {
		inRun = false;
		runsCompleted += 1;
		tools.clear();
		refreshContext(ctx);
		write();
	});

	// Keeps the percent denominator honest when a human switches model
	// mid-run in the child pane.
	pi.on("model_select", (event, ctx) => {
		modelId = event.model.id;
		refreshContext(ctx);
		write();
	});

	// Best-effort final write. Fires on reload/new/resume/fork too, which is
	// fine: a fresh import re-registers and writes anew. Note ctx.shutdown()
	// called from a tool (subagent_done / caller_ping) is DEFERRED until
	// agent_settled, so those tools do get their tool_execution_end — no
	// dangling entry comes from them. This write's real jobs are the final
	// inRun: false snapshot and clearing entries left dangling by tool loops
	// aborted via a thrown error (also covered by agent_settled's defensive
	// clear). The `.exit` sidecar resolves the parent's poller regardless.
	pi.on("session_shutdown", (_event, ctx) => {
		inRun = false;
		tools.clear();
		refreshContext(ctx);
		write();
	});
}

// ── the parent-side reader ───────────────────────────────────────────────

/** What one read of the activity file produced. `foreign` (valid snapshot,
 * wrong runId) is distinguished from `missing` only for debugging and steer
 * prose; the status machine treats both as "no trustworthy snapshot". */
export type ActivityRead =
	| { kind: "missing" }
	| { kind: "invalid"; reason: string }
	| { kind: "foreign" }
	| { kind: "valid"; snapshot: ActivitySnapshot };

/**
 * Validate one raw read. Strict core, tolerant periphery:
 *
 *   - The CORE fields that ordering and status depend on (version, runId,
 *     sequence, updatedAt, inRun, runsCompleted) must be exactly right or
 *     the whole read is `invalid`. With tmp+rename in place a torn file is
 *     impossible from our writer, so unparseable content means a foreign or
 *     broken writer and deserves the invalid path.
 *   - The PERIPHERAL display fields are individually sanitized, never
 *     fatal: a malformed tool entry or context block degrades that field
 *     alone, not the whole snapshot.
 */
export function parseActivitySnapshot(raw: string, expectedRunId: string): ActivityRead {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { kind: "invalid", reason: "not JSON" };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { kind: "invalid", reason: "not a JSON object" };
	}
	const data = parsed as Record<string, unknown>;

	// The strict core. Note JSON.parse can still produce non-finite numbers
	// (e.g. `1e999` parses to Infinity), so finiteness is checked explicitly.
	if (data.version !== ACTIVITY_VERSION) {
		return { kind: "invalid", reason: `version is not ${ACTIVITY_VERSION}` };
	}
	if (typeof data.runId !== "string") {
		return { kind: "invalid", reason: "runId is not a string" };
	}
	if (typeof data.sequence !== "number" || !Number.isFinite(data.sequence)) {
		return { kind: "invalid", reason: "sequence is not a finite number" };
	}
	if (typeof data.updatedAt !== "number" || !Number.isFinite(data.updatedAt)) {
		return { kind: "invalid", reason: "updatedAt is not a finite number" };
	}
	if (typeof data.inRun !== "boolean") {
		return { kind: "invalid", reason: "inRun is not a boolean" };
	}
	if (typeof data.runsCompleted !== "number" || !Number.isFinite(data.runsCompleted)) {
		return { kind: "invalid", reason: "runsCompleted is not a finite number" };
	}

	// The ownership fence — checked only after the core is known-good, so a
	// mangled runId reads as invalid (broken writer), not foreign.
	if (data.runId !== expectedRunId) return { kind: "foreign" };

	// The tolerant periphery: drop malformed tool entries…
	const activeTools: ActivityToolRun[] = [];
	if (Array.isArray(data.activeTools)) {
		for (const entry of data.activeTools) {
			if (typeof entry !== "object" || entry === null) continue;
			const tool = entry as Record<string, unknown>;
			if (typeof tool.toolCallId !== "string") continue;
			if (typeof tool.name !== "string") continue;
			if (typeof tool.startedAt !== "number" || !Number.isFinite(tool.startedAt)) continue;
			activeTools.push({ toolCallId: tool.toolCallId, name: tool.name, startedAt: tool.startedAt });
		}
	}

	// …keep context only when it is coherent (window a positive finite
	// number, tokens/percent finite-or-null — null is pi's honest "unknown
	// right after compaction" and must survive as null, never become 0)…
	let context: ActivitySnapshot["context"] = null;
	if (typeof data.context === "object" && data.context !== null) {
		const c = data.context as Record<string, unknown>;
		if (
			typeof c.window === "number" &&
			Number.isFinite(c.window) &&
			c.window > 0 &&
			(c.tokens === null || (typeof c.tokens === "number" && Number.isFinite(c.tokens))) &&
			(c.percent === null || (typeof c.percent === "number" && Number.isFinite(c.percent)))
		) {
			context = { tokens: c.tokens, window: c.window, percent: c.percent };
		}
	}

	// …and fall back on the remaining display-only scalars.
	return {
		kind: "valid",
		snapshot: {
			version: ACTIVITY_VERSION,
			runId: data.runId,
			pid: typeof data.pid === "number" && Number.isFinite(data.pid) ? data.pid : 0,
			sequence: data.sequence,
			updatedAt: data.updatedAt,
			inRun: data.inRun,
			runsCompleted: data.runsCompleted,
			activeTools,
			modelId: typeof data.modelId === "string" ? data.modelId : null,
			context,
			costUsd: typeof data.costUsd === "number" && Number.isFinite(data.costUsd) ? data.costUsd : 0,
		},
	};
}

/** Read and validate a child's activity file. ENOENT is `missing`; any
 * other read failure is `invalid` (an unreadable file means a broken writer;
 * the status machine debounces both the same way before stalling). */
export function readActivityFile(activityFile: string, expectedRunId: string): ActivityRead {
	let raw: string;
	try {
		raw = readFileSync(activityFile, "utf8");
	} catch (error) {
		if ((error as { code?: unknown }).code === "ENOENT") return { kind: "missing" };
		return { kind: "invalid", reason: "file could not be read" };
	}
	return parseActivitySnapshot(raw, expectedRunId);
}

// ── the parent-side observation state ────────────────────────────────────
// One mutable record per child, owned by the watcher's onTick and stored on
// the RunningSubagent. Every `*Ms` field here is PARENT-clock: the child's
// timestamps order snapshots against each other, the parent's timestamps
// drive the watchdog, and the two domains never mix.

export interface ActivityObservation {
	/** Newest ACCEPTED snapshot (see observeActivity's ordering rules). */
	snapshot?: ActivitySnapshot;
	/** Parent clock when `snapshot` last advanced. */
	acceptedAtMs?: number;
	/** Parent clock since reads have been CONTINUOUSLY missing/foreign/
	 * invalid/stale; cleared by an accepted or same-pair valid read. After 60s
	 * of continuous problem the status machine stalls the child — this is what
	 * detects mid-run file deletion, corruption, a writer that died, or a
	 * child clock stepped backwards, for the whole run and not just startup. */
	problemSinceMs?: number;
	/** For steer prose only — never drives state transitions. `stale` means
	 * valid reads keep arriving but time-stamped strictly BEFORE the accepted
	 * pair (child clock stepped backwards). */
	lastProblemKind?: "missing" | "foreign" | "invalid" | "stale";
	/** Parent-side run-history latch: true once any ACCEPTED snapshot showed
	 * inRun or runsCompleted > 0. Needed because the child-side runsCompleted
	 * counter is per-process and resets to 0 on an in-pane /reload; without
	 * this latch a healthy reloaded idle child reads stalled forever and fires
	 * a misleading "task never started" steer. Chosen tradeoff: a reload that
	 * genuinely killed a run now reads waiting, not stalled — a human was at
	 * that pane to type /reload, and a false stall steer misleads the parent
	 * model. */
	everSawRun?: boolean;
	/** Parent clock; launch time, shifted forward on detected clock jumps. */
	watchdogStartMs: number;
	/** Parent clock; the previous onTick time (the clock-jump detector). */
	lastTickMs?: number;
}

/** Fresh observation state for a child launched at `nowMs` (parent clock). */
export function newActivityObservation(nowMs: number): ActivityObservation {
	return { watchdogStartMs: nowMs };
}

/** A gap of this many ms between 1s poll ticks means suspend/clock-step,
 * not child inactivity. */
export const CLOCK_JUMP_MS = 5_000;

/**
 * Clock-jump guard: call once at the top of every onTick, BEFORE
 * observeActivity. A gap of CLOCK_JUMP_MS or more between 1s ticks means the
 * parent machine slept or its clock stepped forward — not that the child was
 * quiet — so shift the watchdog anchors forward by the whole gap: a laptop
 * waking from sleep must not fire a spurious stall steer for every child.
 * ANY negative gap re-anchors too (shift by the gap, preserving the deltas
 * exactly): time never genuinely flows backward, and letting the durations
 * shrink is NOT safe — a backward step during a stall would flip the status
 * to starting, fire a false recovered steer, and then a duplicate stalled
 * steer when the delta re-crosses 60s. Small FORWARD gaps stay untouched:
 * under CLOCK_JUMP_MS they are real elapsed time, not a jump.
 */
export function noteTick(obs: ActivityObservation, nowMs: number): void {
	if (obs.lastTickMs !== undefined) {
		const gap = nowMs - obs.lastTickMs;
		if (gap < 0 || gap >= CLOCK_JUMP_MS) {
			obs.watchdogStartMs += gap;
			if (obs.problemSinceMs !== undefined) obs.problemSinceMs += gap;
		}
	}
	obs.lastTickMs = nowMs;
}

/**
 * Merge one read into the observation. The rules:
 *
 *   valid   → accept the snapshot iff its (updatedAt, sequence) pair STRICTLY
 *             advanced past the current one (or none was accepted yet). Both
 *             pair components are child-clock, so parent-side skew cannot
 *             affect the ordering, and updatedAt-first absorbs an in-pane
 *             /reload's sequence reset. Accepting also clears the problem
 *             fields and latches everSawRun when the snapshot shows run
 *             history — the parent-side latch that survives the child-side
 *             counter reset (see ActivityObservation.everSawRun).
 *             An EQUAL pair is the same write re-read: it clears the problem
 *             fields but changes nothing else — acceptedAtMs deliberately
 *             stays put (it anchors the parent half of toolElapsedSeconds).
 *             An OLDER pair is a valid-but-stale file (child clock stepped
 *             back): keep the current snapshot, and open (or continue) the
 *             problem window as kind "stale" — after 60s of continuously
 *             stale reads the status machine stalls the child, the loud
 *             failure the README promises, instead of silently serving the
 *             frozen accepted state for the whole skew window.
 *
 *   missing / foreign / invalid
 *           → start (or continue) the continuous-problem window and record
 *             the kind for steer prose. The previously accepted snapshot is
 *             NOT erased — a transient anomaly must not amnesia the child's
 *             known state.
 */
export function observeActivity(obs: ActivityObservation, read: ActivityRead, nowMs: number): void {
	if (read.kind === "valid") {
		const current = obs.snapshot;
		const candidate = read.snapshot;
		if (
			current === undefined ||
			candidate.updatedAt > current.updatedAt ||
			(candidate.updatedAt === current.updatedAt && candidate.sequence > current.sequence)
		) {
			obs.snapshot = candidate;
			obs.acceptedAtMs = nowMs;
			if (candidate.inRun || candidate.runsCompleted > 0) obs.everSawRun = true;
			obs.problemSinceMs = undefined;
			obs.lastProblemKind = undefined;
			return;
		}
		const samePair = candidate.updatedAt === current.updatedAt && candidate.sequence === current.sequence;
		if (samePair) {
			obs.problemSinceMs = undefined;
			obs.lastProblemKind = undefined;
			return;
		}
		// Strictly older: the child clock stepped backwards.
		obs.problemSinceMs ??= nowMs;
		obs.lastProblemKind = "stale";
		return;
	}
	obs.problemSinceMs ??= nowMs;
	obs.lastProblemKind = read.kind;
}

// ── picking the tool to display ──────────────────────────────────────────

/**
 * The tool both display surfaces (the widget segment and subagent_status)
 * show: the entry with the smallest startedAt — the longest-running one,
 * which is stable under parallel fan-out where newer tools come and go
 * around it. One shared helper so the two surfaces can never disagree.
 */
export function oldestActiveTool(tools: ActivityToolRun[]): ActivityToolRun | undefined {
	let oldest: ActivityToolRun | undefined;
	for (const tool of tools) {
		if (oldest === undefined || tool.startedAt < oldest.startedAt) oldest = tool;
	}
	return oldest;
}

// ── tool elapsed time (skew-free) ────────────────────────────────────────

/**
 * How long a tool has been running, WITHOUT ever subtracting a child
 * timestamp from a parent one. Two same-domain differences instead: how
 * long the tool had been running when the snapshot was written (child minus
 * child), plus how long ago the parent accepted that snapshot (parent minus
 * parent). Skew between the two clocks cancels out entirely; the clamp to 0
 * covers rounding jitter and hand-written garbage.
 */
export function toolElapsedSeconds(
	snapshot: ActivitySnapshot,
	tool: ActivityToolRun,
	acceptedAtMs: number,
	nowMs: number,
): number {
	const childMs = snapshot.updatedAt - tool.startedAt;
	const parentMs = nowMs - acceptedAtMs;
	// Each field is validated finite, but the DIFFERENCE of two finite
	// numbers can still overflow (1e308 - -1e308 = Infinity), which Math.max
	// would pass straight through to the display. Non-finite means garbage
	// input: report 0, never "InfinityhNaNm".
	const ms = childMs + parentMs;
	if (!Number.isFinite(ms)) return 0;
	return Math.max(0, Math.round(ms / 1000));
}
