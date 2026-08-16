import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

process.env.PI_CODING_AGENT_DIR = join(process.cwd(), ".sandbox", "cancel-test-config-do-not-create");
process.env.PI_SUBAGENT_MAX_CONCURRENT_SUBAGENTS = "1";

const state = await import("../state.ts");
const capacity = await import("../capacity.ts");
const { requestCancel } = await import("../cancel.ts");
type RunningSubagent = import("../state.ts").RunningSubagent;
type SpawnSpec = import("../capacity.ts").SpawnSpec;

after(() => {
	reset();
});

function spawnSpec(id: string, overrides: Partial<SpawnSpec> = {}): SpawnSpec {
	return {
		kind: "spawn",
		id,
		name: `task-${id}`,
		task: `work for ${id}`,
		agentName: "worker",
		harness: "pi",
		agentBody: "",
		context: "new",
		autoExit: true,
		useWorktree: false,
		cwd: "/repo",
		parentCwd: "/repo",
		parentSessionFile: "/sessions/parent.jsonl",
		base: "/sessions",
		slug: id,
		...overrides,
	};
}

function runningChild(id: string): RunningSubagent {
	return {
		id,
		name: `task-${id}`,
		agent: "worker",
		paneId: `%${id}`,
		sessionFile: `/sessions/${id}.jsonl`,
		startTime: Date.now(),
		skipEntries: 0,
		autoExit: true,
		abort: new AbortController(),
		expectsRun: true,
	};
}

function delivery(id: string, stopped = false): void {
	const child = runningChild(id);
	state.setDeliveryRecord({
		id,
		name: child.name,
		agent: child.agent,
		startedAt: child.startTime,
		elapsedSeconds: 2,
		forked: false,
		interactive: false,
		worktree: false,
		stopped,
		child,
		exit: stopped
			? { reason: "aborted", paneDead: true, capturedAt: Date.now() }
			: { reason: "exited", exitCode: 0, paneDead: true, capturedAt: Date.now() },
	} as unknown as import("../state.ts").DeliveryRecord);
}

type Sent = {
	message: { customType?: string; details?: { id?: string }; content?: string };
	options?: { triggerTurn?: boolean; deliverAs?: string };
};
const sent: Sent[] = [];
const fakePi = {
	sendMessage(message: Sent["message"], options?: Sent["options"]): void {
		sent.push({ message, options });
	},
} as unknown as ExtensionAPI;

function reset(): void {
	state.running.clear();
	state.delivering.clear();
	state.ledger.clear();
	for (const pending of capacity.pendingLaunches()) capacity.releaseClaim(pending.spec.id);
	capacity.clearQueueForShutdown();
	sent.length = 0;
}

function queue(spec: SpawnSpec): void {
	state.running.set("blocker0", runningChild("blocker0"));
	assert.strictEqual(capacity.admitLaunch(spec).status, "queued", `queue ${spec.id}`);
}

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("requestCancel", () => {
	it("queued cancellation resolves, splices only its entry, and tombstones idempotently", () => {
		// Full lifecycle resolution and tombstone bookkeeping.
		reset();
		const queuedSpec = spawnSpec("queue001", { context: "forked", parentSessionFile: "/do-not-copy.jsonl" });
		queue(queuedSpec);
		const queuedOutcome = requestCancel(fakePi, queuedSpec.id, "model");
		assert.strictEqual(queuedOutcome.kind, "cancelled-queued", "queued work resolves to cancelled-queued");
		assert.deepStrictEqual(
			queuedOutcome.kind === "cancelled-queued" ? queuedOutcome.spec : undefined, queuedSpec,
			"queued cancellation returns the original pure-data spec");
		assert.deepStrictEqual(
			[capacity.queuedCount(), state.running.get("blocker0")?.abort.signal.aborted], [0, false],
			"queued entry is spliced and the running blocker is untouched");
		assert.deepStrictEqual(
			[capacity.cancellationFor(queuedSpec.id)?.requester, sent.length], ["model", 0],
			"model queued cancellation records a tombstone without steering");
		const firstTombstone = capacity.cancellationFor(queuedSpec.id);
		assert.deepStrictEqual(
			requestCancel(fakePi, queuedSpec.id, "user"), { kind: "already-cancelled", id: queuedSpec.id },
			"repeat queued cancellation is rejected as already-cancelled");
		assert.deepStrictEqual(capacity.cancellationFor(queuedSpec.id), firstTombstone,
			"repeat cancellation keeps the first tombstone requester and timestamp");
	});

	it("user queued cancellation sends one steer carrying the cancelled id", () => {
		reset();
		const userQueuedSpec = spawnSpec("queue002");
		queue(userQueuedSpec);
		assert.strictEqual(requestCancel(fakePi, userQueuedSpec.id, "user").kind, "cancelled-queued",
			"user queued cancellation succeeds");
		assert.deepStrictEqual(
			sent.map(({ message, options }) => [message.customType, message.details?.id, options?.deliverAs]),
			[["subagent_queue_cancelled", userQueuedSpec.id, "steer"]],
			"user queued cancellation sends one steer carrying the cancelled id");
	});

	it("inline starting cancellation tombstones, guards the launch, and stays cancelled after release", () => {
		reset();
		const inlineSpec = spawnSpec("inline01");
		assert.strictEqual(capacity.admitLaunch(inlineSpec).status, "run", "inline launch claims a slot");
		const inlineOutcome = requestCancel(fakePi, inlineSpec.id, "user");
		assert.deepStrictEqual(
			inlineOutcome.kind === "cancelled-starting" ? [inlineOutcome.kind, inlineOutcome.origin] : inlineOutcome,
			["cancelled-starting", "inline"],
			"inline starting launch reports its origin");
		assert.deepStrictEqual(
			[capacity.cancellationFor(inlineSpec.id)?.requester, sent.length], ["user", 0],
			"inline user cancellation tombstones without a duplicate steer");
		let inlineGuard: unknown;
		try { capacity.assertLaunchStillWanted(state.moduleGeneration(), inlineSpec.id); }
		catch (error) { inlineGuard = error; }
		assert.ok(inlineGuard instanceof capacity.CancelLaunch && inlineGuard.requester === "user",
			"starting tombstone makes the launch guard throw CancelLaunch");
		capacity.releaseClaim(inlineSpec.id);
		assert.strictEqual(requestCancel(fakePi, inlineSpec.id, "model").kind, "already-cancelled",
			"released starting claim remains a tombstone");
	});

	it("user drain cancellation steers once and the pipeline unwinds without requeue", async () => {
		reset();
		let releaseDrain!: () => void;
		const drainGate = new Promise<void>((resolve) => { releaseDrain = resolve; });
		capacity.registerLauncher("spawn", async (_pi, spec) => {
			await drainGate;
			capacity.assertLaunchStillWanted(state.moduleGeneration(), spec.id);
		});
		const drainedSpec = spawnSpec("drain001");
		queue(drainedSpec);
		state.running.delete("blocker0");
		capacity.drainQueue(fakePi);
		const drainedOutcome = requestCancel(fakePi, drainedSpec.id, "user");
		assert.deepStrictEqual(
			drainedOutcome.kind === "cancelled-starting" ? [drainedOutcome.kind, drainedOutcome.origin] : drainedOutcome,
			["cancelled-starting", "drain"],
			"drained starting launch reports drain origin");
		assert.deepStrictEqual(
			sent.map(({ message, options }) => [message.customType, message.details?.id, options?.deliverAs]),
			[["subagent_queue_cancelled", drainedSpec.id, "steer"]],
			"user drain cancellation sends exactly one durable steer");
		assert.ok(Boolean(sent[0]?.message.content?.includes("no result will arrive")),
			"drain cancellation notice promises that no result will arrive");
		releaseDrain();
		await flush();
		assert.deepStrictEqual(
			[capacity.findPendingLaunch(drainedSpec.id), capacity.queuedCount()], [undefined, 0],
			"cancelled drain pipeline releases its claim and does not requeue");
		assert.strictEqual(sent.length, 1, "pipeline unwind does not add a second user notice");
	});

	it("model drain cancellation never steers", async () => {
		reset();
		let releaseModelDrain!: () => void;
		const modelDrainGate = new Promise<void>((resolve) => { releaseModelDrain = resolve; });
		capacity.registerLauncher("spawn", async (_pi, spec) => {
			await modelDrainGate;
			capacity.assertLaunchStillWanted(state.moduleGeneration(), spec.id);
		});
		const modelDrainSpec = spawnSpec("drain002");
		queue(modelDrainSpec);
		state.running.delete("blocker0");
		capacity.drainQueue(fakePi);
		assert.strictEqual(requestCancel(fakePi, modelDrainSpec.id, "model").kind, "cancelled-starting",
			"model can cancel a drained starting launch");
		assert.strictEqual(sent.length, 0, "model starting cancellation never steers");
		releaseModelDrain();
		await flush();
	});

	it("a cancelled user launch failure emits only its original cancellation steer", async () => {
		reset();
		let releaseUserFailure!: () => void;
		const userFailureGate = new Promise<void>((resolve) => { releaseUserFailure = resolve; });
		capacity.registerLauncher("spawn", async () => {
			await userFailureGate;
			throw new Error("worktree create failed after cancellation");
		});
		const userFailureSpec = spawnSpec("failure1");
		queue(userFailureSpec);
		state.running.delete("blocker0");
		capacity.drainQueue(fakePi);
		requestCancel(fakePi, userFailureSpec.id, "user");
		releaseUserFailure();
		await flush();
		assert.deepStrictEqual(sent.map(({ message }) => message.customType), ["subagent_queue_cancelled"]);
	});

	it("a cancelled model launch failure stays silent", async () => {
		reset();
		let releaseModelFailure!: () => void;
		const modelFailureGate = new Promise<void>((resolve) => { releaseModelFailure = resolve; });
		capacity.registerLauncher("spawn", async () => {
			await modelFailureGate;
			throw new Error("worktree create failed after cancellation");
		});
		const modelFailureSpec = spawnSpec("failure2");
		queue(modelFailureSpec);
		state.running.delete("blocker0");
		capacity.drainQueue(fakePi);
		requestCancel(fakePi, modelFailureSpec.id, "model");
		releaseModelFailure();
		await flush();
		assert.strictEqual(sent.length, 0);
	});

	it("a reload requeue is dropped by its tombstone instead of relaunching", async () => {
		reset();
		let releaseReloadRace!: () => void;
		const reloadRaceGate = new Promise<void>((resolve) => { releaseReloadRace = resolve; });
		let reloadRaceLaunches = 0;
		capacity.registerLauncher("spawn", async () => {
			reloadRaceLaunches++;
			await reloadRaceGate;
			throw new capacity.RequeueLaunch();
		});
		const reloadRaceSpec = spawnSpec("reload01");
		queue(reloadRaceSpec);
		state.running.delete("blocker0");
		capacity.drainQueue(fakePi);
		assert.strictEqual(requestCancel(fakePi, reloadRaceSpec.id, "model").kind, "cancelled-starting",
			"reload-race starting cancellation succeeds");
		releaseReloadRace();
		await flush();
		assert.deepStrictEqual(
			[reloadRaceLaunches, capacity.queuedCount(), capacity.findPendingLaunch(reloadRaceSpec.id)],
			[1, 0, undefined],
			"a reload requeue is dropped by its tombstone instead of relaunching");
	});

	it("running cancellation stops immediately and later requests are idempotent", () => {
		reset();
		const running = runningChild("running1");
		let abortEvents = 0;
		running.abort.signal.addEventListener("abort", () => abortEvents++);
		state.running.set(running.id, running);
		const firstStop = requestCancel(fakePi, running.id, "user");
		const repeatStop = requestCancel(fakePi, running.id, "model");
		assert.deepStrictEqual(
			[firstStop.kind, running.stopRequester, running.abort.signal.aborted, abortEvents],
			["stopping", "user", true, 1],
			"running cancellation stops immediately and attributes the first request");
		assert.deepStrictEqual(
			repeatStop.kind === "already-stopping" ? [repeatStop.kind, repeatStop.requester, abortEvents] : repeatStop,
			["already-stopping", "user", 1],
			"model racing after the picker gets idempotent stopping with the first requester");
	});

	it("picker racing after model keeps model attribution", () => {
		reset();
		const modelFirst = runningChild("running2");
		state.running.set(modelFirst.id, modelFirst);
		assert.strictEqual(requestCancel(fakePi, modelFirst.id, "model").kind, "stopping", "model-first stop succeeds");
		const userSecond = requestCancel(fakePi, modelFirst.id, "user");
		assert.strictEqual(userSecond.kind === "already-stopping" ? userSecond.requester : undefined, "model",
			"picker racing after model keeps model attribution");
	});

	it("an already-fired abort is idempotent and adopts the first explicit requester", () => {
		reset();
		const externallyAborted = runningChild("running3");
		externallyAborted.abort.abort();
		state.running.set(externallyAborted.id, externallyAborted);
		const adoptedStop = requestCancel(fakePi, externallyAborted.id, "model");
		assert.deepStrictEqual(
			adoptedStop.kind === "already-stopping"
				? [adoptedStop.requester, externallyAborted.stopRequester]
				: adoptedStop,
			["model", "model"]);
	});

	it("delivering ids are rejected without mutation, preserving stopped attribution", () => {
		reset();
		delivery("deliver1", false);
		const delivering = requestCancel(fakePi, "deliver1", "model");
		assert.deepStrictEqual(
			delivering.kind === "delivering" ? [delivering.kind, delivering.stopped, delivering.target.name] : delivering,
			["delivering", false, "task-deliver1"],
			"finished delivery is rejected without mutation");
		state.delivering.clear();
		delivery("deliver2", true);
		const stoppedDelivery = requestCancel(fakePi, "deliver2", "user");
		assert.deepStrictEqual(
			stoppedDelivery.kind === "delivering" ? [stoppedDelivery.kind, stoppedDelivery.stopped] : stoppedDelivery,
			["delivering", true],
			"stopped delivery preserves stopped attribution in the rejection");
	});

	it("ledger-only ids resolve to completed and unknown ids stay distinct", () => {
		reset();
		state.ledger.set("complete", { sessionFile: "/sessions/complete.jsonl", name: "completed task" });
		assert.deepStrictEqual(requestCancel(fakePi, "complete", "model"), {
			kind: "completed",
			target: { id: "complete", name: "completed task" },
		}, "ledger-only id resolves to completed");
		assert.deepStrictEqual(requestCancel(fakePi, "unknown0", "model"), {
			kind: "unknown",
			id: "unknown0",
		}, "unknown id remains distinct from completed");
	});

	it("running wins over a stale delivery record", () => {
		// Resolution order is authoritative even if stale registries overlap.
		reset();
		const overlapRunning = runningChild("overlap1");
		state.running.set(overlapRunning.id, overlapRunning);
		delivery(overlapRunning.id, false);
		assert.strictEqual(requestCancel(fakePi, overlapRunning.id, "model").kind, "stopping");
	});

	it("delivery wins over a stale queued entry without splicing it", () => {
		reset();
		const overlapSpec = spawnSpec("overlap2");
		queue(overlapSpec);
		delivery(overlapSpec.id, false);
		assert.strictEqual(requestCancel(fakePi, overlapSpec.id, "model").kind, "delivering",
			"delivery wins over a stale queued entry");
		assert.strictEqual(capacity.findQueued(overlapSpec.id)?.spec.id, overlapSpec.id,
			"delivery rejection does not splice the queued neighbor");
	});

	it("cancelling one queue entry cannot touch neighbors", () => {
		// Every mutation is keyed by id: cancelling one queue entry cannot touch neighbors.
		reset();
		const blocker = runningChild("neighbor");
		state.running.set(blocker.id, blocker);
		const firstNeighbor = spawnSpec("queue101");
		const secondNeighbor = spawnSpec("queue102");
		capacity.admitLaunch(firstNeighbor);
		capacity.admitLaunch(secondNeighbor);
		const secondEntry = capacity.findQueued(secondNeighbor.id);
		assert.strictEqual(requestCancel(fakePi, firstNeighbor.id, "model").kind, "cancelled-queued",
			"neighbor cancellation succeeds");
		assert.deepStrictEqual(
			[capacity.queuedEntries().map((entry) => entry.spec.id), capacity.findQueued(secondNeighbor.id) === secondEntry],
			[[secondNeighbor.id], true],
			"neighbor queue entry shifts position but retains its exact record");
		assert.deepStrictEqual(
			[state.running.has(blocker.id), blocker.abort.signal.aborted], [true, false],
			"neighbor running child remains registered and unaborted");
		assert.ok(
			capacity.cancellationFor(firstNeighbor.id) !== undefined && capacity.cancellationFor(secondNeighbor.id) === undefined,
			"only the cancelled neighbor receives a tombstone");
	});
});
