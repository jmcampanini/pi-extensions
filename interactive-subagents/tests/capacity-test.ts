/**
 * capacity-test.ts — pins the concurrency-limit and launch-queue contract:
 * synchronous admission (a parallel burst cannot race past the limit), FIFO
 * order with no queue-jumping, claim accounting, resume dedupe, drain
 * behavior (launch order, failure notices, requeue/abandon on boundaries),
 * and queue survival across a simulated /reload re-import.
 *
 * The config singleton is read at module import, so PI_CODING_AGENT_DIR is
 * pointed at an empty temp dir BEFORE the dynamic imports below — the tests
 * run against the default limit of 9 regardless of the developer's own
 * subagents.json.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "subagents-capacity-"));

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const state = await import("../state.ts");
const capacity = await import("../capacity.ts");
type SpawnSpec = import("../capacity.ts").SpawnSpec;
type ResumeSpec = import("../capacity.ts").ResumeSpec;

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
function throws(label: string, fn: () => unknown, contains: string) {
	try { fn(); fail++; console.log(`  FAIL ${label}: expected throw`); }
	catch (error) {
		if (String(error).includes(contains)) { pass++; console.log(`  ok  ${label}`); }
		else { fail++; console.log(`  FAIL ${label}: ${String(error)}`); }
	}
}

function spawnSpec(id: string): SpawnSpec {
	return {
		kind: "spawn",
		id,
		name: `task-${id}`,
		task: "do the thing",
		agentName: "worker",
		harness: "pi",
		agentBody: "",
		context: "fresh",
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

/** A stand-in for a registered child — capacity only ever counts entries. */
function fakeRunning(id: string): void {
	state.running.set(id, { id } as unknown as import("../state.ts").RunningSubagent);
}

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

const sent: { customType?: string; content?: string }[] = [];
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
}

// ── admission ─────────────────────────────────────────────────────────────

reset();
const invalidAgentSpec = { ...spawnSpec("invalid"), agentName: "code reviewer" };
throws("admission rejects an invalid persisted agent identifier",
	() => capacity.admitLaunch(invalidAgentSpec), "whitespace");
eq("invalid admission creates no claim or queue entry",
	[capacity.pendingLaunchCount(), capacity.queuedCount()], [0, 0]);
eq("admit under capacity runs", capacity.admitLaunch(spawnSpec("a")), { status: "run" });
capacity.releaseClaim("a");

reset();
for (let i = 0; i < 8; i++) fakeRunning(`run-${i}`);
eq("ninth child still runs", capacity.admitLaunch(spawnSpec("a")), { status: "run" });
eq("tenth child queues (claims count toward capacity)", capacity.admitLaunch(spawnSpec("b")), { status: "queued", ahead: 0 });
eq("eleventh child sees one ahead", capacity.admitLaunch(spawnSpec("c")), { status: "queued", ahead: 1 });
eq("queued entries are in FIFO order", capacity.queuedEntries().map((entry) => entry.spec.id), ["b", "c"]);

// no queue-jumping: capacity freed, but the queue is non-empty
state.running.clear();
eq("admit with a non-empty queue always queues", capacity.admitLaunch(spawnSpec("d")), { status: "queued", ahead: 2 });

// a synchronous 12-call burst (what parallel tool calls reduce to, since
// admission has no interleave point) never exceeds the limit
reset();
const outcomes = Array.from({ length: 12 }, (_, i) => capacity.admitLaunch(spawnSpec(`s${i}`)));
eq("burst of 12: nine run", outcomes.filter((o) => o.status === "run").length, 9);
eq("burst of 12: three queue in order",
	capacity.queuedEntries().map((entry) => entry.spec.id), ["s9", "s10", "s11"]);

// ── resume dedupe ─────────────────────────────────────────────────────────

reset();
eq("resume claim is visible to pendingResumeFor",
	capacity.admitLaunch(resumeSpec("r1", "/tmp/child.jsonl")), { status: "run" });
ok("claimed resume blocks a second attach", capacity.pendingResumeFor("/tmp/child.jsonl"));
capacity.releaseClaim("r1");
ok("released claim unblocks", !capacity.pendingResumeFor("/tmp/child.jsonl"));

for (let i = 0; i < 9; i++) fakeRunning(`run-${i}`);
capacity.admitLaunch(resumeSpec("r2", "/tmp/child.jsonl"));
ok("queued resume blocks a second attach", capacity.pendingResumeFor("/tmp/child.jsonl"));
ok("other sessions are not blocked", !capacity.pendingResumeFor("/tmp/other.jsonl"));

// paths are compared resolved: a non-canonical spelling cannot slip past
reset();
eq("non-canonical resume path still claims",
	capacity.admitLaunch(resumeSpec("r1", "/tmp/./child.jsonl")), { status: "run" });
ok("dedupe matches the canonical spelling", capacity.pendingResumeFor("/tmp/child.jsonl"));
capacity.releaseClaim("r1");

// in-flight and queued launches are visible by id
reset();
capacity.admitLaunch(spawnSpec("a"));
ok("a claimed launch is pending", capacity.isPendingLaunch("a"));
eq("pendingLaunches exposes the spec", capacity.pendingLaunches().map((p) => p.spec.id), ["a"]);
capacity.releaseClaim("a");
ok("a released launch is no longer pending", !capacity.isPendingLaunch("a"));

// ── cancel ────────────────────────────────────────────────────────────────

reset();
for (let i = 0; i < 9; i++) fakeRunning(`run-${i}`);
capacity.admitLaunch(spawnSpec("a"));
capacity.admitLaunch(spawnSpec("b"));
eq("findQueued sees a queued id", capacity.findQueued("b")?.spec.id, "b");
eq("cancelQueued removes the right entry", capacity.cancelQueued("a")?.spec.id, "a");
eq("cancel leaves the rest in order", capacity.queuedEntries().map((entry) => entry.spec.id), ["b"]);
eq("cancel of an unknown id is undefined", capacity.cancelQueued("nope"), undefined);

// ── drain ─────────────────────────────────────────────────────────────────

reset();
const launched: string[] = [];
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
eq("drain launches as many as freed slots, in order", launched, ["a", "b"]);
eq("drain leaves the remainder queued", capacity.queuedEntries().map((entry) => entry.spec.id), ["c"]);
eq("drained children are running", [state.running.has("a"), state.running.has("b")], [true, true]);

// a failing launch notifies the model and keeps draining
reset();
capacity.registerLauncher("spawn", async (_pi, spec) => {
	if (spec.id === "bad") throw new Error("tmux exploded");
	launched.push(spec.id);
	fakeRunning(spec.id);
	capacity.releaseClaim(spec.id);
});
for (let i = 0; i < 9; i++) fakeRunning(`run-${i}`);
capacity.admitLaunch(spawnSpec("bad"));
capacity.admitLaunch(spawnSpec("good"));
launched.length = 0;
state.running.delete("run-0");
capacity.drainQueue(fakePi);
await flush();
eq("failure notice reaches the model", sent.map((m) => m.customType), ["subagent_launch_failed"]);
ok("notice names the child and the error",
	Boolean(sent[0]?.content?.includes("bad") && sent[0]?.content?.includes("tmux exploded")));
eq("drain continues past the failure", launched, ["good"]);
eq("failed entry is gone from the queue", capacity.queuedCount(), 0);

// RequeueLaunch (a reload landing mid-launch) puts the entry back at the
// head, silently; the follow-up drain no-ops because the module is aborted,
// so the entry waits for the replacement generation.
reset();
capacity.registerLauncher("spawn", async () => {
	state.prepareForReload(() => {});
	throw new capacity.RequeueLaunch();
});
for (let i = 0; i < 9; i++) fakeRunning(`run-${i}`);
capacity.admitLaunch(spawnSpec("a"));
state.running.delete("run-0");
capacity.drainQueue(fakePi);
await flush();
eq("requeued entry returns to the queue", capacity.queuedEntries().map((entry) => entry.spec.id), ["a"]);
eq("requeue sends nothing", sent.length, 0);

// ...and the drain hook lets the dying generation hand that entry to the
// replacement: once a live generation arms the hook, requestDrain launches.
state.completeReloadHandoff();
capacity.registerLauncher("spawn", async (_pi, spec) => {
	launched.push(spec.id);
	fakeRunning(spec.id);
	capacity.releaseClaim(spec.id);
});
state.running.clear();
launched.length = 0;
capacity.armDrainHook(fakePi);
capacity.requestDrain(fakePi);
await flush();
eq("armed drain hook launches the requeued entry", launched, ["a"]);

reset();
const retainedInvalid = { ...spawnSpec("retained-invalid"), agentName: "code reviewer" };
(capacity.queuedEntries() as Array<{ spec: SpawnSpec; queuedAt: number }>).push({
	spec: retainedInvalid,
	queuedAt: Date.now(),
});
capacity.armDrainHook(fakePi);
eq("reload hook discards an invalid retained queue entry", capacity.queuedCount(), 0);
eq("invalid retained queue entry gets a failure notice", sent.map((message) => message.customType), ["subagent_launch_failed"]);
ok("retained-entry notice does not reformat the invalid identifier",
	!sent[0]?.content?.includes(retainedInvalid.agentName));

// AbandonLaunch drops the entry, silently
reset();
capacity.registerLauncher("spawn", async () => {
	throw new capacity.AbandonLaunch();
});
for (let i = 0; i < 9; i++) fakeRunning(`run-${i}`);
capacity.admitLaunch(spawnSpec("a"));
state.running.delete("run-0");
capacity.drainQueue(fakePi);
await flush();
eq("abandoned entry is dropped", capacity.queuedCount(), 0);
eq("abandon sends nothing", sent.length, 0);

// ── notices are self-contained ────────────────────────────────────────────

reset();
fakeRunning("r");
capacity.admitLaunch(spawnSpec("x")); // consumes the last... no: 1 running, so this runs
capacity.releaseClaim("x");
const failureNotice = capacity.formatLaunchFailureNotice(spawnSpec("x"), "boom");
ok("failure notice carries id, error, and counts",
	failureNotice.includes("id x") && failureNotice.includes("boom") && failureNotice.includes("1 running"));
const cancelNotice = capacity.formatQueueCancelledNotice(resumeSpec("r9", "/tmp/child.jsonl"));
ok("cancel notice carries id and no-result warning",
	cancelNotice.includes("id r9") && cancelNotice.includes("no result will arrive"));

// ── boundary guards ───────────────────────────────────────────────────────
// prepareForReload aborts the module signal without changing the generation
// (→ requeue); completeReloadHandoff after an abort starts a fresh
// generation (→ abandon for launches captured under the old one).

reset();
const generation = state.moduleGeneration();
let guardOutcome = "none";
try { capacity.assertLaunchStillWanted(generation); guardOutcome = "passed"; } catch { guardOutcome = "threw"; }
eq("guard passes in a live generation", guardOutcome, "passed");

state.prepareForReload(() => {});
try { capacity.assertLaunchStillWanted(generation); guardOutcome = "passed"; }
catch (error) { guardOutcome = error instanceof capacity.RequeueLaunch ? "requeue" : "other"; }
eq("reload in progress requeues", guardOutcome, "requeue");

ok("drain is a no-op while the generation is aborted", (() => {
	capacity.registerLauncher("spawn", async (_pi, spec) => { launched.push(spec.id); });
	for (let i = 0; i < 9; i++) fakeRunning(`run-${i}`);
	capacity.admitLaunch(spawnSpec("a"));
	state.running.clear();
	launched.length = 0;
	capacity.drainQueue(fakePi);
	return launched.length === 0 && capacity.queuedCount() === 1;
})());

state.completeReloadHandoff();
try { capacity.assertLaunchStillWanted(generation); guardOutcome = "passed"; }
catch (error) { guardOutcome = error instanceof capacity.AbandonLaunch ? "abandon" : "other"; }
eq("a later generation abandons", guardOutcome, "abandon");

// the reaper arms even when only queued work exists (nothing running)
reset();
let reaped = false;
state.prepareForReload(() => { reaped = true; }, 0, true);
await new Promise((resolve) => setTimeout(resolve, 5));
eq("reaper arms for queued-only pending work", reaped, true);
state.completeReloadHandoff();

// ── /reload survival ──────────────────────────────────────────────────────
// A cache-busted re-import simulates pi re-importing the module graph; the
// queue lives on globalThis, so the replacement sees the same entries.

reset();
for (let i = 0; i < 9; i++) fakeRunning(`run-${i}`);
capacity.admitLaunch(spawnSpec("a"));
const reloaded = await import(new URL(`../capacity.ts?reload-test=${Date.now()}`, import.meta.url).href) as typeof capacity;
eq("queue survives a module re-import",
	reloaded.queuedEntries().map((entry) => entry.spec.id), ["a"]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
