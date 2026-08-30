/**
 * capacity-test.ts - pins the concurrency-limit and launch-queue contract:
 * synchronous admission (a parallel burst cannot race past the limit), FIFO
 * order with no queue-jumping, claim accounting, resume dedupe, drain
 * behavior (launch order, failure notices, requeue/abandon on boundaries),
 * and queue survival across a simulated /reload re-import.
 *
 * The config singleton is read at module import, so PI_CODING_AGENT_DIR is
 * pointed at an empty temp dir BEFORE the dynamic imports below - the tests
 * run against the default limit of 9 regardless of the developer's own
 * subagents.json.
 */

import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "subagents-capacity-"));

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const state = await import("../state.ts");
const capacity = await import("../capacity.ts");
type SpawnSpec = import("../capacity.ts").SpawnSpec;
type ResumeSpec = import("../capacity.ts").ResumeSpec;

function spawnSpec(id: string): SpawnSpec {
	return {
		kind: "spawn",
		id,
		name: `task-${id}`,
		task: "do the thing",
		agentName: "worker",
		harness: "pi",
		agentBody: "",
		context: "new",
		autoExit: true,
		useWorktree: false,
		cwd: "/tmp",
		parentCwd: "/tmp",
		parentSessionFile: "/tmp/parent.jsonl",
		base: "/tmp/base",
		slug: "task",
	};
}

function resumeSpec(id: string, sessionPath: string): ResumeSpec {
	return {
		kind: "resume",
		id,
		sessionPath,
		name: `resume-${id}`,
		harness: "pi",
		autoExit: true,
		message: "continue",
		cwd: "/tmp",
		cwdFromWorktree: false,
		base: "/tmp/base",
		slug: "resume",
		expectsRun: true,
	};
}

/** A stand-in for a registered child - capacity only ever counts entries. */
function fakeRunning(id: string): void {
	state.running.set(id, { id } as unknown as import("../state.ts").RunningSubagent);
}

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

const sent: { customType?: string; content?: string }[] = [];
const launched: string[] = [];
const fakePi = {
	sendMessage: (message: { customType?: string; content?: string }) => {
		sent.push(message);
	},
} as unknown as ExtensionAPI;

function reset(): void {
	state.running.clear();
	capacity.clearQueueForShutdown();
	for (const id of ["a", "b", "c", "d", "e", "r1", "r2", ...Array.from({ length: 12 }, (_, i) => `s${i}`)]) {
		capacity.releaseClaim(id);
	}
	sent.length = 0;
	launched.length = 0;
}

beforeEach(reset);

describe("admission", () => {
	it("admission rejects an invalid persisted agent identifier without claiming", () => {
		const invalidAgentSpec = { ...spawnSpec("invalid"), agentName: "code reviewer" };
		assert.throws(
			() => capacity.admitLaunch(invalidAgentSpec),
			/whitespace/,
			"admission rejects an invalid persisted agent identifier",
		);
		assert.deepStrictEqual(
			[capacity.pendingLaunchCount(), capacity.queuedCount()], [0, 0],
			"invalid admission creates no claim or queue entry");
		assert.deepStrictEqual(capacity.admitLaunch(spawnSpec("a")), { status: "run" }, "admit under capacity runs");
		capacity.releaseClaim("a");
	});

	it("claims count toward capacity and the queue is FIFO with no queue-jumping", () => {
		for (let i = 0; i < 8; i++) fakeRunning(`run-${i}`);
		assert.deepStrictEqual(capacity.admitLaunch(spawnSpec("a")), { status: "run" }, "ninth child still runs");
		assert.deepStrictEqual(capacity.admitLaunch(spawnSpec("b")), { status: "queued", ahead: 0 },
			"tenth child queues (claims count toward capacity)");
		assert.deepStrictEqual(capacity.admitLaunch(spawnSpec("c")), { status: "queued", ahead: 1 },
			"eleventh child sees one ahead");
		assert.deepStrictEqual(capacity.queuedEntries().map((entry) => entry.spec.id), ["b", "c"],
			"queued entries are in FIFO order");

		// no queue-jumping: capacity freed, but the queue is non-empty
		state.running.clear();
		assert.deepStrictEqual(capacity.admitLaunch(spawnSpec("d")), { status: "queued", ahead: 2 },
			"admit with a non-empty queue always queues");
	});

	it("a synchronous 12-call burst never exceeds the limit", () => {
		// what parallel tool calls reduce to, since admission has no interleave point
		const outcomes = Array.from({ length: 12 }, (_, i) => capacity.admitLaunch(spawnSpec(`s${i}`)));
		assert.strictEqual(outcomes.filter((o) => o.status === "run").length, 9, "burst of 12: nine run");
		assert.deepStrictEqual(capacity.queuedEntries().map((entry) => entry.spec.id), ["s9", "s10", "s11"],
			"burst of 12: three queue in order");
	});
});

describe("resume dedupe", () => {
	it("a claimed or queued resume blocks a second attach until released", () => {
		assert.deepStrictEqual(capacity.admitLaunch(resumeSpec("r1", "/tmp/child.jsonl")), { status: "run" },
			"resume claim is visible to pendingResumeFor");
		assert.ok(capacity.pendingResumeFor("/tmp/child.jsonl"), "claimed resume blocks a second attach");
		capacity.releaseClaim("r1");
		assert.ok(!capacity.pendingResumeFor("/tmp/child.jsonl"), "released claim unblocks");

		for (let i = 0; i < 9; i++) fakeRunning(`run-${i}`);
		capacity.admitLaunch(resumeSpec("r2", "/tmp/child.jsonl"));
		assert.ok(capacity.pendingResumeFor("/tmp/child.jsonl"), "queued resume blocks a second attach");
		assert.ok(!capacity.pendingResumeFor("/tmp/other.jsonl"), "other sessions are not blocked");
	});

	it("paths are compared resolved: a non-canonical spelling cannot slip past", () => {
		assert.deepStrictEqual(capacity.admitLaunch(resumeSpec("r1", "/tmp/./child.jsonl")), { status: "run" },
			"non-canonical resume path still claims");
		assert.ok(capacity.pendingResumeFor("/tmp/child.jsonl"), "dedupe matches the canonical spelling");
		capacity.releaseClaim("r1");
	});

	it("in-flight and queued launches are visible by id", () => {
		capacity.admitLaunch(spawnSpec("a"));
		assert.ok(capacity.isPendingLaunch("a"), "a claimed launch is pending");
		assert.deepStrictEqual(capacity.pendingLaunches().map((p) => p.spec.id), ["a"], "pendingLaunches exposes the spec");
		capacity.releaseClaim("a");
		assert.ok(!capacity.isPendingLaunch("a"), "a released launch is no longer pending");
	});
});

describe("cancel", () => {
	it("cancelQueued splices exactly the requested entry and tombstones are stable", () => {
		for (let i = 0; i < 9; i++) fakeRunning(`run-${i}`);
		capacity.admitLaunch(spawnSpec("a"));
		capacity.admitLaunch(spawnSpec("b"));
		assert.strictEqual(capacity.findQueued("b")?.spec.id, "b", "findQueued sees a queued id");
		assert.strictEqual(capacity.cancelQueued("a")?.spec.id, "a", "cancelQueued removes the right entry");
		assert.deepStrictEqual(capacity.queuedEntries().map((entry) => entry.spec.id), ["b"],
			"cancel leaves the rest in order");
		assert.strictEqual(capacity.cancelQueued("nope"), undefined, "cancel of an unknown id is undefined");
		const firstCancellation = capacity.recordCancellation("cancelled", "user");
		assert.deepStrictEqual(
			[capacity.cancellationFor("cancelled")?.requester, capacity.recordCancellation("cancelled", "model") === firstCancellation],
			["user", true],
			"a cancellation tombstone records requester and is stable");
	});
});

describe("drain", () => {
	it("drain launches as many as freed slots, in order", async () => {
		capacity.registerLauncher("spawn", async (_pi, spec) => {
			launched.push(spec.id);
			// The pipeline contract: register the child and release the claim in the
			// same synchronous step.
			fakeRunning(spec.id);
			capacity.releaseClaim(spec.id);
		});

		for (let i = 0; i < 9; i++) fakeRunning(`run-${i}`);
		capacity.admitLaunch(spawnSpec("a"));
		capacity.admitLaunch(spawnSpec("b"));
		capacity.admitLaunch(spawnSpec("c"));
		state.running.delete("run-0");
		state.running.delete("run-1");
		capacity.drainQueue(fakePi);
		await flush();
		assert.deepStrictEqual(launched, ["a", "b"], "drain launches as many as freed slots, in order");
		assert.deepStrictEqual(capacity.queuedEntries().map((entry) => entry.spec.id), ["c"],
			"drain leaves the remainder queued");
		assert.deepStrictEqual([state.running.has("a"), state.running.has("b")], [true, true],
			"drained children are running");
	});

	it("drain drops a tombstoned entry and launches its neighbor", async () => {
		capacity.registerLauncher("spawn", async (_pi, spec) => {
			launched.push(spec.id);
			fakeRunning(spec.id);
			capacity.releaseClaim(spec.id);
		});
		for (let i = 0; i < 9; i++) fakeRunning(`run-${i}`);
		capacity.admitLaunch(spawnSpec("a"));
		capacity.admitLaunch(spawnSpec("b"));
		capacity.recordCancellation("a", "model");
		state.running.delete("run-0");
		capacity.drainQueue(fakePi);
		await flush();
		assert.deepStrictEqual(launched, ["b"], "drain drops a tombstoned entry and launches its neighbor");
		assert.strictEqual(state.running.has("a"), false, "the tombstoned entry is not resurrected");
	});

	it("a failing launch notifies the model and keeps draining", async () => {
		capacity.registerLauncher("spawn", async (_pi, spec) => {
			if (spec.id === "bad") throw new Error("tmux exploded");
			launched.push(spec.id);
			fakeRunning(spec.id);
			capacity.releaseClaim(spec.id);
		});
		for (let i = 0; i < 9; i++) fakeRunning(`run-${i}`);
		capacity.admitLaunch(spawnSpec("bad"));
		capacity.admitLaunch(spawnSpec("good"));
		state.running.delete("run-0");
		capacity.drainQueue(fakePi);
		await flush();
		assert.deepStrictEqual(sent.map((m) => m.customType), ["subagent_launch_failed"],
			"failure notice reaches the model");
		assert.ok(Boolean(sent[0]?.content?.includes("bad") && sent[0]?.content?.includes("tmux exploded")),
			"notice names the child and the error");
		assert.deepStrictEqual(launched, ["good"], "drain continues past the failure");
		assert.strictEqual(capacity.queuedCount(), 0, "failed entry is gone from the queue");
	});

	it("a requeued entry waits for the replacement generation and launches once the drain hook is armed", async () => {
		// RequeueLaunch (a reload landing mid-launch) puts the entry back at the
		// head, silently; the follow-up drain no-ops because the module is aborted,
		// so the entry waits for the replacement generation.
		capacity.registerLauncher("spawn", async () => {
			state.prepareForReload(() => {});
			throw new capacity.RequeueLaunch();
		});
		for (let i = 0; i < 9; i++) fakeRunning(`run-${i}`);
		capacity.admitLaunch(spawnSpec("a"));
		state.running.delete("run-0");
		capacity.drainQueue(fakePi);
		await flush();
		assert.deepStrictEqual(capacity.queuedEntries().map((entry) => entry.spec.id), ["a"],
			"requeued entry returns to the queue");
		assert.strictEqual(sent.length, 0, "requeue sends nothing");

		// ...and the drain hook lets the dying generation hand that entry to the
		// replacement: once a live generation arms the hook, requestDrain launches.
		state.completeReloadHandoff();
		capacity.registerLauncher("spawn", async (_pi, spec) => {
			launched.push(spec.id);
			fakeRunning(spec.id);
			capacity.releaseClaim(spec.id);
		});
		state.running.clear();
		capacity.armDrainHook(fakePi);
		capacity.requestDrain(fakePi);
		await flush();
		assert.deepStrictEqual(launched, ["a"], "armed drain hook launches the requeued entry");
	});

	it("a late RequeueLaunch cannot resurrect a claim fenced by shutdown", async () => {
		let releaseBoundaryLaunch!: () => void;
		const boundaryGate = new Promise<void>((resolve) => { releaseBoundaryLaunch = resolve; });
		let boundaryLaunches = 0;
		capacity.registerLauncher("spawn", async () => {
			boundaryLaunches++;
			await boundaryGate;
			throw new capacity.RequeueLaunch();
		});
		for (let i = 0; i < 9; i++) fakeRunning(`run-${i}`);
		capacity.admitLaunch(spawnSpec("a"));
		state.running.delete("run-0");
		capacity.drainQueue(fakePi);
		capacity.clearQueueForShutdown();
		releaseBoundaryLaunch();
		await flush();
		assert.deepStrictEqual(
			[boundaryLaunches, capacity.queuedCount(), capacity.findPendingLaunch("a")], [1, 0, undefined]);
	});

	it("the reload hook discards an invalid retained queue entry with a notice", () => {
		const retainedInvalid = { ...spawnSpec("retained-invalid"), agentName: "code reviewer" };
		(capacity.queuedEntries() as Array<{ spec: SpawnSpec; queuedAt: number }>).push({
			spec: retainedInvalid,
			queuedAt: Date.now(),
		});
		capacity.armDrainHook(fakePi);
		assert.strictEqual(capacity.queuedCount(), 0, "reload hook discards an invalid retained queue entry");
		assert.deepStrictEqual(sent.map((message) => message.customType), ["subagent_launch_failed"],
			"invalid retained queue entry gets a failure notice");
		assert.ok(!sent[0]?.content?.includes(retainedInvalid.agentName),
			"retained-entry notice does not reformat the invalid identifier");
	});

	it("AbandonLaunch drops the entry, silently", async () => {
		capacity.registerLauncher("spawn", async () => {
			throw new capacity.AbandonLaunch();
		});
		for (let i = 0; i < 9; i++) fakeRunning(`run-${i}`);
		capacity.admitLaunch(spawnSpec("a"));
		state.running.delete("run-0");
		capacity.drainQueue(fakePi);
		await flush();
		assert.strictEqual(capacity.queuedCount(), 0, "abandoned entry is dropped");
		assert.strictEqual(sent.length, 0, "abandon sends nothing");
	});

	it("CancelLaunch drops the claimed entry without a duplicate notice", async () => {
		capacity.registerLauncher("spawn", async () => {
			throw new capacity.CancelLaunch("model");
		});
		for (let i = 0; i < 9; i++) fakeRunning(`run-${i}`);
		capacity.admitLaunch(spawnSpec("a"));
		state.running.delete("run-0");
		capacity.drainQueue(fakePi);
		await flush();
		assert.deepStrictEqual([capacity.queuedCount(), capacity.isPendingLaunch("a")], [0, false],
			"CancelLaunch drops the claimed entry");
		assert.strictEqual(sent.length, 0, "CancelLaunch dispatch sends no duplicate notice");
	});

	it("cancel rollback failure emits one distinct operational notice", async () => {
		capacity.registerLauncher("spawn", async () => {
			const error = new capacity.CancelLaunch("model");
			error.cleanupFailure = "Remove /repo/leaked-worktree manually.";
			throw error;
		});
		for (let i = 0; i < 9; i++) fakeRunning(`run-${i}`);
		capacity.admitLaunch(spawnSpec("a"));
		state.running.delete("run-0");
		capacity.drainQueue(fakePi);
		await flush();
		assert.deepStrictEqual(sent.map((message) => message.customType), ["subagent_cancel_cleanup_failed"],
			"cancel rollback failure emits one distinct operational notice");
		assert.ok(sent[0]?.content?.includes("remains cancelled") === true && sent[0]?.content?.includes("/repo/leaked-worktree"),
			"cancel rollback warning preserves the manual cleanup instruction");
	});
});

describe("notices are self-contained", () => {
	it("failure and cancel notices carry id, error, counts, and warnings", () => {
		fakeRunning("r");
		capacity.admitLaunch(spawnSpec("x")); // consumes the last... no: 1 running, so this runs
		capacity.releaseClaim("x");
		const failureNotice = capacity.formatLaunchFailureNotice(spawnSpec("x"), "boom");
		assert.ok(failureNotice.includes("id x") && failureNotice.includes("boom") && failureNotice.includes("1 running"),
			"failure notice carries id, error, and counts");
		const cancelNotice = capacity.formatQueueCancelledNotice(resumeSpec("r9", "/tmp/child.jsonl"));
		assert.ok(cancelNotice.includes("id r9") && cancelNotice.includes("no result will arrive"),
			"cancel notice carries id and no-result warning");
	});
});

describe("boundary guards", () => {
	// prepareForReload aborts the module signal without changing the generation
	// (→ requeue); completeReloadHandoff after an abort starts a fresh
	// generation (→ abandon for launches captured under the old one).

	it("the launch guard passes, cancels, requeues, and abandons across generations", () => {
		const generation = state.moduleGeneration();
		let guardOutcome = "none";
		try { capacity.assertLaunchStillWanted(generation, "guard-live"); guardOutcome = "passed"; } catch { guardOutcome = "threw"; }
		assert.strictEqual(guardOutcome, "passed", "guard passes in a live generation");

		capacity.recordCancellation("guard-cancel", "user");
		try { capacity.assertLaunchStillWanted(generation, "guard-cancel"); guardOutcome = "passed"; }
		catch (error) {
			guardOutcome = error instanceof capacity.CancelLaunch && error.requester === "user" ? "cancel" : "other";
		}
		assert.strictEqual(guardOutcome, "cancel", "a tombstone wins the launch boundary");

		state.prepareForReload(() => {});
		try { capacity.assertLaunchStillWanted(generation, "guard-reload"); guardOutcome = "passed"; }
		catch (error) { guardOutcome = error instanceof capacity.RequeueLaunch ? "requeue" : "other"; }
		assert.strictEqual(guardOutcome, "requeue", "reload in progress requeues");

		capacity.registerLauncher("spawn", async (_pi, spec) => { launched.push(spec.id); });
		for (let i = 0; i < 9; i++) fakeRunning(`run-${i}`);
		capacity.admitLaunch(spawnSpec("a"));
		state.running.clear();
		capacity.drainQueue(fakePi);
		assert.ok(launched.length === 0 && capacity.queuedCount() === 1,
			"drain is a no-op while the generation is aborted");

		state.completeReloadHandoff();
		try { capacity.assertLaunchStillWanted(generation, "guard-abandon"); guardOutcome = "passed"; }
		catch (error) { guardOutcome = error instanceof capacity.AbandonLaunch ? "abandon" : "other"; }
		assert.strictEqual(guardOutcome, "abandon", "a later generation abandons");
	});

	it("the reaper arms even when only queued work exists", async () => {
		let reaped = false;
		state.prepareForReload(() => { reaped = true; }, 0, true);
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.strictEqual(reaped, true, "reaper arms for queued-only pending work");
		state.completeReloadHandoff();
	});
});

describe("/reload survival", () => {
	// A cache-busted re-import simulates pi re-importing the module graph; the
	// queue lives on globalThis, so the replacement sees the same entries.

	it("the queue and cancellation tombstones survive a module re-import", async () => {
		for (let i = 0; i < 9; i++) fakeRunning(`run-${i}`);
		capacity.admitLaunch(spawnSpec("a"));
		capacity.recordCancellation("reload-cancel", "model");
		const reloaded = await import(new URL(`../capacity.ts?reload-test=${Date.now()}`, import.meta.url).href) as typeof capacity;
		assert.deepStrictEqual(reloaded.queuedEntries().map((entry) => entry.spec.id), ["a"],
			"queue survives a module re-import");
		assert.strictEqual(reloaded.cancellationFor("reload-cancel")?.requester, "model",
			"cancellation tombstones survive a module re-import");
		reloaded.clearQueueForShutdown();
		assert.strictEqual(reloaded.cancellationFor("reload-cancel"), undefined,
			"destructive shutdown clears cancellation tombstones");
	});
});
