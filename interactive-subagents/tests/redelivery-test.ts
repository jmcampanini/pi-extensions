// Unit regressions for durable result delivery. A fake Pi event registry
// drives parent run boundaries while manufactured stopped and ping records
// exercise the real watcher finalizer. Missing message_end events represent
// custom steers that Escape silently removed from Pi's queue.
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

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown): void {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}: got ${g}, want ${w}`); }
}

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
		stoppedByUser: true,
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
		child,
		exit: { reason: "aborted", exitCode: 0 },
	};
}

function pingRecord(id: string): DeliveryRecord {
	const record = stoppedRecord(id);
	record.child.stoppedByUser = false;
	return {
		...record,
		exit: { reason: "ping", exitCode: 0, pingMessage: "Which API should I use?", pingName: record.name },
	};
}

function completedRecord(id: string, sessionFile: string): DeliveryRecord {
	const record = stoppedRecord(id);
	record.child.stoppedByUser = false;
	record.child.sessionFile = sessionFile;
	return { ...record, exit: { reason: "exited", exitCode: 0 } };
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

// Pure proof and outcome classifiers reject every ambiguous case.
const proofFixture = stoppedRecord("proof000");
proofFixture.sendAccepted = true;
proofFixture.sendAcceptedRunIndex = 4;
eq("proof accepts an older accepted-send stamp", needsRedelivery(proofFixture, 5), true);
eq("proof rejects an equal accepted-send stamp", needsRedelivery(proofFixture, 4), false);
proofFixture.sendAccepted = false;
eq("proof accepts a send that threw", needsRedelivery(proofFixture, 4), true);
proofFixture.sendAccepted = undefined;
eq("proof rejects a finalizer that has not sent yet", needsRedelivery(proofFixture, 5), false);
eq("normal classifier accepts a completed assistant", agentEndWasNormal({ messages: [{ role: "assistant", stopReason: "stop" }] }), true);
eq("normal classifier rejects an aborted assistant", agentEndWasNormal({ messages: [{ role: "assistant", stopReason: "aborted" }] }), false);
eq("normal classifier rejects an errored assistant", agentEndWasNormal({ messages: [{ role: "assistant", stopReason: "error" }] }), false);
eq("normal classifier rejects a run without an assistant", agentEndWasNormal({ messages: [{ role: "user" }] }), false);

// 1. Issue sequence: a stop queued in run N is dropped by Escape. The next
// normal run proves the loss, sends the same envelope once, and landing it
// clears the row permanently.
{
	const pi = beginScenario();
	startRun(pi);
	const record = stoppedRecord("issue001");
	seed(record);
	startFinalizer(pi.api, record);
	eq("issue: initial stopped send is accepted", pi.calls.length, 1);
	settle(pi, "aborted");
	eq("issue: Escape settlement does not resend", pi.calls.length, 1);
	startRun(pi);
	settle(pi, "stop");
	eq("issue: next normal settlement resends exactly once", pi.calls.length, 2);
	eq("issue: resend preserves the envelope and options", pi.calls[1], pi.calls[0]);
	land(pi, pi.calls[1]!);
	eq("issue: landed resend clears the delivering row", deliveryRecord(record.id), undefined);
	startRun(pi);
	settle(pi, "stop");
	eq("issue: later normal runs never send again", pi.calls.length, 2);
}

// The first prepared payload is process-stable too: a resume may append a
// newer assistant message to the same session while the old result is queued,
// but redelivery must retain the old child's exact response and identity.
{
	const pi = beginScenario();
	mkdirSync(".sandbox", { recursive: true });
	const sessionFile = `.sandbox/redelivery-session-${process.pid}.jsonl`;
	writeFileSync(sessionFile, sessionMessage("original child response", "old-message"));
	startRun(pi);
	const record = completedRecord("cached01", sessionFile);
	seed(record);
	startFinalizer(pi.api, record);
	settle(pi, "aborted");
	appendFileSync(sessionFile, sessionMessage("new response from a resume", "new-message"));
	startRun(pi);
	settle(pi, "stop");
	eq("cache: redelivery reuses the first prepared payload", pi.calls[1], pi.calls[0]);
	eq("cache: old response remains in the retried result", pi.calls[1]?.message.content.includes("original child response"), true);
	eq("cache: resumed response cannot replace the old result", pi.calls[1]?.message.content.includes("new response from a resume"), false);
	rmSync(sessionFile, { force: true });
}

// 2. A result observed landing before proof is removed and never retried.
{
	const pi = beginScenario();
	startRun(pi);
	const record = stoppedRecord("landed02");
	seed(record);
	startFinalizer(pi.api, record);
	settle(pi, "aborted");
	startRun(pi);
	land(pi, pi.calls[0]!);
	settle(pi, "stop");
	eq("landed: an observed result is never resent", pi.calls.length, 1);
	eq("landed: its row stays cleared", delivering.has(record.id), false);
}

// 3. Even when a send predates a later run, an aborted settlement proves
// nothing. A subsequent normal settlement performs the sole retry.
{
	const pi = beginScenario();
	startRun(pi);
	const record = stoppedRecord("abort003");
	seed(record);
	startFinalizer(pi.api, record);
	settle(pi, "aborted");
	startRun(pi);
	settle(pi, "aborted");
	eq("aborted: later aborted run still does not resend", pi.calls.length, 1);
	startRun(pi);
	settle(pi, "stop");
	eq("aborted: following normal run resends", pi.calls.length, 2);
}

// 4. A steer accepted after a run's last queue poll has the same stamp as
// that run. Its settlement waits; the next normal run proves the loss.
{
	const pi = beginScenario();
	const runIndex = startRun(pi);
	const record = stoppedRecord("late0004");
	seed(record);
	startFinalizer(pi.api, record);
	eq("late: send is stamped with its current run", record.sendAcceptedRunIndex, runIndex);
	settle(pi, "stop");
	eq("late: equal run stamp is not retried", pi.calls.length, 1);
	startRun(pi);
	settle(pi, "stop");
	eq("late: next normal run retries it", pi.calls.length, 2);
}

// 5. Multiple records are proved, resent, and cleared independently. Only
// each retry lands, so the parent transcript receives one outcome per id.
{
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
	eq("multiple: each child is resent exactly once", ids, [first.id, second.id, first.id, second.id]);
	const landedIds = [land(pi, pi.calls[2]!), land(pi, pi.calls[3]!)];
	eq("multiple: one outcome per child lands", landedIds, [first.id, second.id]);
	eq("multiple: both rows clear independently", delivering.size, 0);
	startRun(pi);
	settle(pi, "stop");
	eq("multiple: cleared records never resend", pi.calls.length, 4);
}

// 6. Ping records use the same proof and finalizer path as terminal results.
{
	const pi = beginScenario();
	startRun(pi);
	const record = pingRecord("ping0006");
	seed(record);
	startFinalizer(pi.api, record);
	settle(pi, "aborted");
	startRun(pi);
	settle(pi, "stop");
	eq("ping: a dropped ping is resent once", pi.calls.length, 2);
	eq("ping: retry retains its custom type", pi.calls[1]?.message.customType, "subagent_ping");
	land(pi, pi.calls[1]!);
	eq("ping: landed retry clears its row", delivering.has(record.id), false);
}

// 7. A synchronous send failure has no queued copy, so any normal settlement
// can safely re-arm it without waiting for a later run index.
{
	const pi = beginScenario();
	const record = stoppedRecord("failed07");
	seed(record);
	pi.failuresRemaining = 1;
	startFinalizer(pi.api, record);
	eq("failed send: record is marked unaccepted", record.sendAccepted, false);
	startRun(pi);
	settle(pi, "stop");
	eq("failed send: normal settlement makes one retry", pi.calls.length, 2);
	eq("failed send: retry is accepted", record.sendAccepted, true);
}

// 8. Whichever terminal record wins is immutable. A late stop cannot replace
// an accepted completion, and a late finalizer entry cannot duplicate a stop.
{
	const pi = beginScenario();
	startRun(pi);
	const completed = completedRecord("racecomp", "/missing/completed-session.jsonl");
	seed(completed);
	startFinalizer(pi.api, completed);
	completed.child.stoppedByUser = true;
	completed.finalizerGeneration = undefined;
	startFinalizer(pi.api, completed);
	eq("race: completion winner remains the sole envelope after a late stop", pi.calls.length, 1);
	eq("race: completion winner retains its exit reason", pi.calls[0]?.message.details.reason, "exited");

	resetForShutdown();
	const stopped = stoppedRecord("racestop");
	seed(stopped);
	startFinalizer(pi.api, stopped);
	stopped.finalizerGeneration = undefined;
	startFinalizer(pi.api, stopped);
	eq("race: stop winner remains the sole envelope after late finalization", pi.calls.length, 2);
	eq("race: stop winner retains its terminal reason", pi.calls[1]?.message.details.reason, "stopped");
}

resetForShutdown();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
