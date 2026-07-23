/**
 * delivery.ts - observing result messages and proving when queued ones were
 * dropped before reaching the parent transcript.
 *
 * Why this exists: pi delivers steered messages one at a time at parent turn
 * boundaries. The watcher parks an exited child in state.ts's delivering map
 * until message_end proves its result landed. Escape can silently clear a
 * queued custom steer, so run lifecycle events provide the complementary
 * proof: after a normally settled run, a delivery accepted before that run
 * either landed or was dropped. A record still parked in the map was dropped
 * and its finalizer can safely send the same envelope again.
 *
 * agent_start stamps a process-stable counter. agent_end classifies the most
 * recent run, while agent_settled waits until retries, compaction, and queued
 * continuations are finished before applying the proof. Aborted, errored, or
 * ambiguous runs prove nothing. A delivery accepted during the settled run
 * also waits because it may have missed that run's final steering poll.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { delivering, deliveryRecords, incrementRunIndex, type DeliveryRecord } from "./state.ts";
import { updateRunningWidget } from "./running-widget.ts";
import { startFinalizer } from "./watcher.ts";

/**
 * Pure matcher: the delivering-map key confirmed by a landed message, or
 * undefined. Only the EXIT customTypes match: subagent_stalled and
 * subagent_recovered carry the same details.id shape but are sent for
 * STILL-RUNNING children, and one can land AFTER the child exits (it was
 * queued behind the same turn boundary) - matching on the id alone would
 * clear a row whose real result is still queued. The message is typed
 * unknown and narrowed one step at a time: pi types details as unknown, and
 * an earlier-loaded extension may have replaced the message entirely - a
 * mismatch must mean "the row stays", never a crash. Exported for the tests.
 */
export function deliveredChildId(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const msg = message as { role?: unknown; customType?: unknown; details?: unknown };
	if (msg.role !== "custom") return undefined;
	if (msg.customType !== "subagent_result" && msg.customType !== "subagent_ping") return undefined;
	if (typeof msg.details !== "object" || msg.details === null) return undefined;
	const id = (msg.details as { id?: unknown }).id;
	return typeof id === "string" ? id : undefined;
}

/** Whether a record can be safely re-armed after a normal settlement. */
export function needsRedelivery(record: DeliveryRecord, settledRunStartIndex: number): boolean {
	if (record.sendAccepted === false) return true;
	return record.sendAccepted === true
		&& typeof record.sendAcceptedRunIndex === "number"
		&& record.sendAcceptedRunIndex < settledRunStartIndex;
}

/** Conservative classifier for the most recent agent_end. */
export function agentEndWasNormal(event: unknown): boolean {
	if (typeof event !== "object" || event === null) return false;
	const messages = (event as { messages?: unknown }).messages;
	if (!Array.isArray(messages)) return false;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (typeof message !== "object" || message === null) continue;
		const assistant = message as { role?: unknown; stopReason?: unknown };
		if (assistant.role !== "assistant") continue;
		return typeof assistant.stopReason === "string"
			&& assistant.stopReason !== "aborted"
			&& assistant.stopReason !== "error";
	}
	return false;
}

function retryDroppedDeliveries(pi: ExtensionAPI, settledRunStartIndex: number): void {
	for (const record of [...deliveryRecords()]) {
		if (!needsRedelivery(record, settledRunStartIndex)) continue;
		record.sendAccepted = undefined;
		record.sendAcceptedRunIndex = undefined;
		record.finalizerGeneration = undefined;
		startFinalizer(pi, record);
	}
}

/**
 * Registered once at activation (parent mode only, index.ts), BEFORE any
 * child can exist: on an idle parent, message_end for a result fires within
 * microtasks of the watcher's pi.sendMessage call, so late registration
 * would miss it. Unknown ids are normal after a destructive session
 * boundary, and Map.delete is idempotent, so redelivery is harmless too.
 */
export function registerDeliveryListener(pi: ExtensionAPI): void {
	let lastRunStartIndex: number | undefined;
	let lastRunEndedNormally = false;

	pi.on("message_end", (event) => {
		const id = deliveredChildId(event.message);
		if (id === undefined) return;
		if (delivering.delete(id)) updateRunningWidget();
	});

	pi.on("agent_start", () => {
		lastRunStartIndex = incrementRunIndex();
		lastRunEndedNormally = false;
	});

	pi.on("agent_end", (event) => {
		lastRunEndedNormally = agentEndWasNormal(event);
	});

	pi.on("agent_settled", () => {
		const settledRunStartIndex = lastRunStartIndex;
		const settledNormally = lastRunEndedNormally;
		lastRunStartIndex = undefined;
		lastRunEndedNormally = false;
		if (!settledNormally || settledRunStartIndex === undefined) return;
		retryDroppedDeliveries(pi, settledRunStartIndex);
	});
}
