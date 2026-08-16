// Unit regressions for durable result delivery. A fake Pi event registry
// drives parent run boundaries while manufactured stopped and ping records
// exercise the real watcher finalizer. Missing message_end events represent
// custom steers that Escape silently removed from Pi's queue.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { agentEndWasNormal, needsRedelivery, registerDeliveryListener } from "../delivery.ts";
import {
	currentRunIndex,
	deliveryRecord,
	delivering,
	resetForShutdown,
	setDeliveryRecord,
	type DeliveryRecord,
	type RunningSubagent,
} from "../state.ts";
import { startFinalizer } from "../watcher.ts";

after(() => {
	resetForShutdown();
});

type Handler = (event: any, ctx: unknown) => void;
type SendCall = { message: any; options: any };

function fakePi(): {
	api: ExtensionAPI;
	emit: (type: string, event: any) => void;
	calls: SendCall[];
	failuresRemaining: number;
} {
	const handlers = new Map<string, Handler[]>();
	const fake = {
		emit(type: string, event: any): void {
			for (const handler of handlers.get(type) ?? []) handler(event, undefined);
		},
		calls: [] as SendCall[],
		failuresRemaining: 0,
	};
	const api = {
		on(type: string, handler: Handler): void {
			const list = handlers.get(type) ?? [];
			list.push(handler);
			handlers.set(type, list);
		},
		sendMessage(message: any, options: any): void {
			fake.calls.push({ message, options });
			if (fake.failuresRemaining > 0) {
				fake.failuresRemaining--;
				throw new Error("manufactured send failure");
			}
		},
	} as unknown as ExtensionAPI;
	return Object.assign(fake, { api });
}

function stoppedRecord(id: string): DeliveryRecord {
	const child = {
		id,
		name: `child-${id}`,
		agent: "worker",
		paneId: `%${id}`,
		sessionFile: `/fixture/${id}.jsonl`,
		startTime: 1,
		skipEntries: 0,
		autoExit: true,
		abort: new AbortController(),
		stopRequester: "user",
		expectsRun: true,
	} satisfies RunningSubagent;
	return {
		id,
		name: child.name,
		agent: child.agent,
		startedAt: child.startTime,
		elapsedSeconds: 42,
		forked: false,
		interactive: false,
		worktree: false,
		stopped: true,
		child,
		exit: { reason: "aborted", exitCode: 0 },
	};
}

function pingRecord(id: string): DeliveryRecord {
	const record = stoppedRecord(id);
	record.child.stopRequester = undefined;
	return {
		...record,
		stopped: false,
		exit: { reason: "ping", exitCode: 0, pingMessage: "Which API should I use?", pingName: record.name },
	};
}

function completedRecord(id: string, sessionFile: string): DeliveryRecord {
	const record = stoppedRecord(id);
	record.child.stopRequester = undefined;
	record.child.sessionFile = sessionFile;
	return { ...record, stopped: false, exit: { reason: "exited", exitCode: 0 } };
}

function sessionMessage(text: string, id: string): string {
	return JSON.stringify({
		type: "message",
		id,
		message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
	}) + "\n";
}

function seed(record: DeliveryRecord): void {
	setDeliveryRecord(record);
}

function startRun(pi: ReturnType<typeof fakePi>): number {
	pi.emit("agent_start", { type: "agent_start" });
	return currentRunIndex();
}

function settle(pi: ReturnType<typeof fakePi>, stopReason: string, messages?: unknown[]): void {
	pi.emit("agent_end", {
		type: "agent_end",
		messages: messages ?? [{ role: "assistant", stopReason }],
	});
	pi.emit("agent_settled", { type: "agent_settled" });
}

function land(pi: ReturnType<typeof fakePi>, call: SendCall): string {
	const message = { role: "custom", ...call.message };
	pi.emit("message_end", { type: "message_end", message });
	return message.details.id;
}

function beginScenario(): ReturnType<typeof fakePi> {
	resetForShutdown();
	const pi = fakePi();
	registerDeliveryListener(pi.api);
	return pi;
}

describe("needsRedelivery", () => {
	// The pure proof classifier rejects every ambiguous case.
	it("accepts only a proven-lost accepted send from an older run", () => {
		const proofFixture = stoppedRecord("proof000");
		proofFixture.sendAccepted = true;
		proofFixture.sendAcceptedRunIndex = 4;
		assert.strictEqual(needsRedelivery(proofFixture, 5), true, "proof accepts an older accepted-send stamp");
		assert.strictEqual(needsRedelivery(proofFixture, 4), false, "proof rejects an equal accepted-send stamp");
		proofFixture.sendAccepted = false;
		assert.strictEqual(needsRedelivery(proofFixture, 4), true, "proof accepts a send that threw");
		proofFixture.sendAccepted = undefined;
		assert.strictEqual(needsRedelivery(proofFixture, 5), false, "proof rejects a finalizer that has not sent yet");
	});
});

describe("agentEndWasNormal", () => {
	it("normal classifier accepts a completed assistant", () => {
		assert.strictEqual(agentEndWasNormal({ messages: [{ role: "assistant", stopReason: "stop" }] }), true);
	});

	it("normal classifier rejects an aborted assistant", () => {
		assert.strictEqual(agentEndWasNormal({ messages: [{ role: "assistant", stopReason: "aborted" }] }), false);
	});

	it("normal classifier rejects an errored assistant", () => {
		assert.strictEqual(agentEndWasNormal({ messages: [{ role: "assistant", stopReason: "error" }] }), false);
	});

	it("normal classifier rejects a run without an assistant", () => {
		assert.strictEqual(agentEndWasNormal({ messages: [{ role: "user" }] }), false);
	});
});

describe("durable result delivery", () => {
	// 1. Issue sequence: a stop queued in run N is dropped by Escape. The next
	// normal run proves the loss, sends the same envelope once, and landing it
	// clears the row permanently.
	it("a dropped stop is resent once by the next normal run and clears when it lands", () => {
		const pi = beginScenario();
		startRun(pi);
		const record = stoppedRecord("issue001");
		seed(record);
		startFinalizer(pi.api, record);
		assert.strictEqual(pi.calls.length, 1, "issue: initial stopped send is accepted");
		settle(pi, "aborted");
		assert.strictEqual(pi.calls.length, 1, "issue: Escape settlement does not resend");
		startRun(pi);
		settle(pi, "stop");
		assert.strictEqual(pi.calls.length, 2, "issue: next normal settlement resends exactly once");
		assert.deepStrictEqual(pi.calls[1], pi.calls[0], "issue: resend preserves the envelope and options");
		land(pi, pi.calls[1]!);
		assert.strictEqual(deliveryRecord(record.id), undefined, "issue: landed resend clears the delivering row");
		startRun(pi);
		settle(pi, "stop");
		assert.strictEqual(pi.calls.length, 2, "issue: later normal runs never send again");
	});

	// The first prepared payload is process-stable too: a resume may append a
	// newer assistant message to the same session while the old result is queued,
	// but redelivery must retain the old child's exact response and identity.
	it("redelivery reuses the first prepared payload after a resume appends a newer response", (t) => {
		const pi = beginScenario();
		const sessionFile = `.sandbox/redelivery-session-${process.pid}.jsonl`;
		t.after(() => rmSync(sessionFile, { force: true }));
		mkdirSync(".sandbox", { recursive: true });
		writeFileSync(sessionFile, sessionMessage("original child response", "old-message"));
		startRun(pi);
		const record = completedRecord("cached01", sessionFile);
		seed(record);
		startFinalizer(pi.api, record);
		settle(pi, "aborted");
		appendFileSync(sessionFile, sessionMessage("new response from a resume", "new-message"));
		startRun(pi);
		settle(pi, "stop");
		assert.deepStrictEqual(pi.calls[1], pi.calls[0], "cache: redelivery reuses the first prepared payload");
		assert.strictEqual(pi.calls[1]?.message.content.includes("original child response"), true,
			"cache: old response remains in the retried result");
		assert.strictEqual(pi.calls[1]?.message.content.includes("new response from a resume"), false,
			"cache: resumed response cannot replace the old result");
	});

	// 2. A result observed landing before proof is removed and never retried.
	it("a result observed landing before proof is never resent", () => {
		const pi = beginScenario();
		startRun(pi);
		const record = stoppedRecord("landed02");
		seed(record);
		startFinalizer(pi.api, record);
		settle(pi, "aborted");
		startRun(pi);
		land(pi, pi.calls[0]!);
		settle(pi, "stop");
		assert.strictEqual(pi.calls.length, 1, "landed: an observed result is never resent");
		assert.strictEqual(delivering.has(record.id), false, "landed: its row stays cleared");
	});

	// 3. Even when a send predates a later run, an aborted settlement proves
	// nothing. A subsequent normal settlement performs the sole retry.
	it("an aborted settlement proves nothing; only a normal settlement retries", () => {
		const pi = beginScenario();
		startRun(pi);
		const record = stoppedRecord("abort003");
		seed(record);
		startFinalizer(pi.api, record);
		settle(pi, "aborted");
		startRun(pi);
		settle(pi, "aborted");
		assert.strictEqual(pi.calls.length, 1, "aborted: later aborted run still does not resend");
		startRun(pi);
		settle(pi, "stop");
		assert.strictEqual(pi.calls.length, 2, "aborted: following normal run resends");
	});

	// 4. A steer accepted after a run's last queue poll has the same stamp as
	// that run. Its settlement waits; the next normal run proves the loss.
	it("a steer stamped with the current run waits for the next normal run", () => {
		const pi = beginScenario();
		const runIndex = startRun(pi);
		const record = stoppedRecord("late0004");
		seed(record);
		startFinalizer(pi.api, record);
		assert.strictEqual(record.sendAcceptedRunIndex, runIndex, "late: send is stamped with its current run");
		settle(pi, "stop");
		assert.strictEqual(pi.calls.length, 1, "late: equal run stamp is not retried");
		startRun(pi);
		settle(pi, "stop");
		assert.strictEqual(pi.calls.length, 2, "late: next normal run retries it");
	});

	// 5. Multiple records are proved, resent, and cleared independently. Only
	// each retry lands, so the parent transcript receives one outcome per id.
	it("multiple records are proved, resent, and cleared independently", () => {
		const pi = beginScenario();
		startRun(pi);
		const first = stoppedRecord("multi005");
		const second = stoppedRecord("multi006");
		seed(first);
		seed(second);
		startFinalizer(pi.api, first);
		startFinalizer(pi.api, second);
		settle(pi, "aborted");
		startRun(pi);
		settle(pi, "stop");
		const ids = pi.calls.map((call) => call.message.details.id);
		assert.deepStrictEqual(ids, [first.id, second.id, first.id, second.id],
			"multiple: each child is resent exactly once");
		const landedIds = [land(pi, pi.calls[2]!), land(pi, pi.calls[3]!)];
		assert.deepStrictEqual(landedIds, [first.id, second.id], "multiple: one outcome per child lands");
		assert.strictEqual(delivering.size, 0, "multiple: both rows clear independently");
		startRun(pi);
		settle(pi, "stop");
		assert.strictEqual(pi.calls.length, 4, "multiple: cleared records never resend");
	});

	// 6. Ping records use the same proof and finalizer path as terminal results.
	it("ping records use the same proof and finalizer path as terminal results", () => {
		const pi = beginScenario();
		startRun(pi);
		const record = pingRecord("ping0006");
		seed(record);
		startFinalizer(pi.api, record);
		settle(pi, "aborted");
		startRun(pi);
		settle(pi, "stop");
		assert.strictEqual(pi.calls.length, 2, "ping: a dropped ping is resent once");
		assert.strictEqual(pi.calls[1]?.message.customType, "subagent_ping", "ping: retry retains its custom type");
		land(pi, pi.calls[1]!);
		assert.strictEqual(delivering.has(record.id), false, "ping: landed retry clears its row");
	});

	// 7. A synchronous send failure has no queued copy, so any normal settlement
	// can safely re-arm it without waiting for a later run index.
	it("a synchronous send failure re-arms on any normal settlement", () => {
		const pi = beginScenario();
		const record = stoppedRecord("failed07");
		seed(record);
		pi.failuresRemaining = 1;
		startFinalizer(pi.api, record);
		assert.strictEqual(record.sendAccepted, false, "failed send: record is marked unaccepted");
		startRun(pi);
		settle(pi, "stop");
		assert.strictEqual(pi.calls.length, 2, "failed send: normal settlement makes one retry");
		assert.strictEqual(record.sendAccepted, true, "failed send: retry is accepted");
	});

	// 8. Whichever terminal record wins is immutable. A late stop cannot replace
	// an accepted completion, and a late finalizer entry cannot duplicate a stop.
	it("the winning terminal record is immutable", () => {
		const pi = beginScenario();
		startRun(pi);
		const completed = completedRecord("racecomp", "/missing/completed-session.jsonl");
		completed.child.model = "spawn/model";
		completed.child.thinking = "high";
		completed.child.activity = {
			watchdogStartMs: 0,
			snapshot: {
				version: 1,
				runId: completed.id,
				pid: 1,
				sequence: 1,
				updatedAt: 1,
				inRun: false,
				runsCompleted: 1,
				activeTools: [],
				modelId: "actual/model",
				context: { tokens: null, window: 200_000, percent: null },
				costUsd: 0,
			},
		};
		seed(completed);
		startFinalizer(pi.api, completed);
		assert.deepStrictEqual({
			model: pi.calls[0]?.message.details.model,
			effort: pi.calls[0]?.message.details.effort,
			contextTokens: pi.calls[0]?.message.details.contextTokens,
			contextWindow: pi.calls[0]?.message.details.contextWindow,
		}, { model: "actual/model", effort: "high", contextTokens: null, contextWindow: 200_000 },
			"race: liveness telemetry overrides the spawn model and preserves compacted context");
		assert.strictEqual(pi.calls[0]?.message.content.includes("Context:"), false,
			"race: compacted context is omitted from the prose envelope");
		completed.child.stopRequester = "user";
		completed.finalizerGeneration = undefined;
		startFinalizer(pi.api, completed);
		assert.strictEqual(pi.calls.length, 1, "race: completion winner remains the sole envelope after a late stop");
		assert.strictEqual(pi.calls[0]?.message.details.reason, "exited",
			"race: completion winner retains its exit reason");

		resetForShutdown();
		const stopped = stoppedRecord("racestop");
		seed(stopped);
		startFinalizer(pi.api, stopped);
		stopped.finalizerGeneration = undefined;
		startFinalizer(pi.api, stopped);
		assert.strictEqual(pi.calls.length, 2, "race: stop winner remains the sole envelope after late finalization");
		assert.strictEqual(pi.calls[1]?.message.details.reason, "stopped",
			"race: stop winner retains its terminal reason");
	});
});
