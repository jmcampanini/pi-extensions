import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

process.env.PI_CODING_AGENT_DIR = join(process.cwd(), ".sandbox", "cancel-test-config-do-not-create");
process.env.PI_SUBAGENT_MAX_CONCURRENT_SUBAGENTS = "1";

const state = await import("../state.ts");
const capacity = await import("../capacity.ts");
const { requestCancel } = await import("../cancel.ts");
type RunningSubagent = import("../state.ts").RunningSubagent;
type SpawnSpec = import("../capacity.ts").SpawnSpec;

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown): void {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}: got ${g}, want ${w}`); }
}
function ok(label: string, condition: boolean): void {
	if (condition) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}`); }
}

function spawnSpec(id: string, overrides: Partial<SpawnSpec> = {}): SpawnSpec {
	return {
		kind: "spawn",
		id,
		name: `task-${id}`,
		task: `work for ${id}`,
		agentName: "worker",
		harness: "pi",
		agentBody: "",
		context: "fresh",
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
	eq(`queue ${spec.id}`, capacity.admitLaunch(spec).status, "queued");
}

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

// Full lifecycle resolution and tombstone bookkeeping.
reset();
const queuedSpec = spawnSpec("queue001", { context: "forked", parentSessionFile: "/do-not-copy.jsonl" });
queue(queuedSpec);
const queuedOutcome = requestCancel(fakePi, queuedSpec.id, "model");
eq("queued work resolves to cancelled-queued", queuedOutcome.kind, "cancelled-queued");
eq("queued cancellation returns the original pure-data spec",
	queuedOutcome.kind === "cancelled-queued" ? queuedOutcome.spec : undefined, queuedSpec);
eq("queued entry is spliced and the running blocker is untouched",
	[capacity.queuedCount(), state.running.get("blocker0")?.abort.signal.aborted], [0, false]);
eq("model queued cancellation records a tombstone without steering",
	[capacity.cancellationFor(queuedSpec.id)?.requester, sent.length], ["model", 0]);
const firstTombstone = capacity.cancellationFor(queuedSpec.id);
eq("repeat queued cancellation is rejected as already-cancelled",
	requestCancel(fakePi, queuedSpec.id, "user"), { kind: "already-cancelled", id: queuedSpec.id });
eq("repeat cancellation keeps the first tombstone requester and timestamp",
	capacity.cancellationFor(queuedSpec.id), firstTombstone);

reset();
const userQueuedSpec = spawnSpec("queue002");
queue(userQueuedSpec);
eq("user queued cancellation succeeds", requestCancel(fakePi, userQueuedSpec.id, "user").kind, "cancelled-queued");
eq("user queued cancellation sends one steer carrying the cancelled id",
	sent.map(({ message, options }) => [message.customType, message.details?.id, options?.deliverAs]),
	[["subagent_queue_cancelled", userQueuedSpec.id, "steer"]]);

reset();
const inlineSpec = spawnSpec("inline01");
eq("inline launch claims a slot", capacity.admitLaunch(inlineSpec).status, "run");
const inlineOutcome = requestCancel(fakePi, inlineSpec.id, "user");
eq("inline starting launch reports its origin",
	inlineOutcome.kind === "cancelled-starting" ? [inlineOutcome.kind, inlineOutcome.origin] : inlineOutcome,
	["cancelled-starting", "inline"]);
eq("inline user cancellation tombstones without a duplicate steer",
	[capacity.cancellationFor(inlineSpec.id)?.requester, sent.length], ["user", 0]);
let inlineGuard: unknown;
try { capacity.assertLaunchStillWanted(state.moduleGeneration(), inlineSpec.id); }
catch (error) { inlineGuard = error; }
ok("starting tombstone makes the launch guard throw CancelLaunch",
	inlineGuard instanceof capacity.CancelLaunch && inlineGuard.requester === "user");
capacity.releaseClaim(inlineSpec.id);
eq("released starting claim remains a tombstone", requestCancel(fakePi, inlineSpec.id, "model").kind, "already-cancelled");

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
eq("drained starting launch reports drain origin",
	drainedOutcome.kind === "cancelled-starting" ? [drainedOutcome.kind, drainedOutcome.origin] : drainedOutcome,
	["cancelled-starting", "drain"]);
eq("user drain cancellation sends exactly one durable steer",
	sent.map(({ message, options }) => [message.customType, message.details?.id, options?.deliverAs]),
	[["subagent_queue_cancelled", drainedSpec.id, "steer"]]);
ok("drain cancellation notice promises that no result will arrive",
	Boolean(sent[0]?.message.content?.includes("no result will arrive")));
releaseDrain();
await flush();
eq("cancelled drain pipeline releases its claim and does not requeue",
	[capacity.findPendingLaunch(drainedSpec.id), capacity.queuedCount()], [undefined, 0]);
eq("pipeline unwind does not add a second user notice", sent.length, 1);

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
eq("model can cancel a drained starting launch",
	requestCancel(fakePi, modelDrainSpec.id, "model").kind, "cancelled-starting");
eq("model starting cancellation never steers", sent.length, 0);
releaseModelDrain();
await flush();

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
eq("a cancelled user launch failure emits only its original cancellation steer",
	sent.map(({ message }) => message.customType), ["subagent_queue_cancelled"]);

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
eq("a cancelled model launch failure stays silent", sent.length, 0);

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
eq("reload-race starting cancellation succeeds",
	requestCancel(fakePi, reloadRaceSpec.id, "model").kind, "cancelled-starting");
releaseReloadRace();
await flush();
eq("a reload requeue is dropped by its tombstone instead of relaunching",
	[reloadRaceLaunches, capacity.queuedCount(), capacity.findPendingLaunch(reloadRaceSpec.id)],
	[1, 0, undefined]);

reset();
const running = runningChild("running1");
let abortEvents = 0;
running.abort.signal.addEventListener("abort", () => abortEvents++);
state.running.set(running.id, running);
const firstStop = requestCancel(fakePi, running.id, "user");
const repeatStop = requestCancel(fakePi, running.id, "model");
eq("running cancellation stops immediately and attributes the first request",
	[firstStop.kind, running.stopRequester, running.abort.signal.aborted, abortEvents],
	["stopping", "user", true, 1]);
eq("model racing after the picker gets idempotent stopping with the first requester",
	repeatStop.kind === "already-stopping" ? [repeatStop.kind, repeatStop.requester, abortEvents] : repeatStop,
	["already-stopping", "user", 1]);

reset();
const modelFirst = runningChild("running2");
state.running.set(modelFirst.id, modelFirst);
eq("model-first stop succeeds", requestCancel(fakePi, modelFirst.id, "model").kind, "stopping");
const userSecond = requestCancel(fakePi, modelFirst.id, "user");
eq("picker racing after model keeps model attribution",
	userSecond.kind === "already-stopping" ? userSecond.requester : undefined, "model");

reset();
const externallyAborted = runningChild("running3");
externallyAborted.abort.abort();
state.running.set(externallyAborted.id, externallyAborted);
const adoptedStop = requestCancel(fakePi, externallyAborted.id, "model");
eq("an already-fired abort is idempotent and adopts the first explicit requester",
	adoptedStop.kind === "already-stopping"
		? [adoptedStop.requester, externallyAborted.stopRequester]
		: adoptedStop,
	["model", "model"]);

reset();
delivery("deliver1", false);
const delivering = requestCancel(fakePi, "deliver1", "model");
eq("finished delivery is rejected without mutation",
	delivering.kind === "delivering" ? [delivering.kind, delivering.stopped, delivering.target.name] : delivering,
	["delivering", false, "task-deliver1"]);
state.delivering.clear();
delivery("deliver2", true);
const stoppedDelivery = requestCancel(fakePi, "deliver2", "user");
eq("stopped delivery preserves stopped attribution in the rejection",
	stoppedDelivery.kind === "delivering" ? [stoppedDelivery.kind, stoppedDelivery.stopped] : stoppedDelivery,
	["delivering", true]);

reset();
state.ledger.set("complete", { sessionFile: "/sessions/complete.jsonl", name: "completed task" });
eq("ledger-only id resolves to completed", requestCancel(fakePi, "complete", "model"), {
	kind: "completed",
	target: { id: "complete", name: "completed task" },
});
eq("unknown id remains distinct from completed", requestCancel(fakePi, "unknown0", "model"), {
	kind: "unknown",
	id: "unknown0",
});

// Resolution order is authoritative even if stale registries overlap.
reset();
const overlapRunning = runningChild("overlap1");
state.running.set(overlapRunning.id, overlapRunning);
delivery(overlapRunning.id, false);
eq("running wins over a stale delivery record", requestCancel(fakePi, overlapRunning.id, "model").kind, "stopping");

reset();
const overlapSpec = spawnSpec("overlap2");
queue(overlapSpec);
delivery(overlapSpec.id, false);
eq("delivery wins over a stale queued entry", requestCancel(fakePi, overlapSpec.id, "model").kind, "delivering");
eq("delivery rejection does not splice the queued neighbor", capacity.findQueued(overlapSpec.id)?.spec.id, overlapSpec.id);

// Every mutation is keyed by id: cancelling one queue entry cannot touch neighbors.
reset();
const blocker = runningChild("neighbor");
state.running.set(blocker.id, blocker);
const firstNeighbor = spawnSpec("queue101");
const secondNeighbor = spawnSpec("queue102");
capacity.admitLaunch(firstNeighbor);
capacity.admitLaunch(secondNeighbor);
const secondEntry = capacity.findQueued(secondNeighbor.id);
eq("neighbor cancellation succeeds", requestCancel(fakePi, firstNeighbor.id, "model").kind, "cancelled-queued");
eq("neighbor queue entry shifts position but retains its exact record",
	[capacity.queuedEntries().map((entry) => entry.spec.id), capacity.findQueued(secondNeighbor.id) === secondEntry],
	[[secondNeighbor.id], true]);
eq("neighbor running child remains registered and unaborted",
	[state.running.has(blocker.id), blocker.abort.signal.aborted], [true, false]);
ok("only the cancelled neighbor receives a tombstone",
	capacity.cancellationFor(firstNeighbor.id) !== undefined && capacity.cancellationFor(secondNeighbor.id) === undefined);

reset();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
