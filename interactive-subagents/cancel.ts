import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	cancelQueued,
	cancellationFor,
	findPendingLaunch,
	findQueued,
	notifyQueueCancelled,
	recordCancellation,
	specDisplay,
	type LaunchSpec,
} from "./capacity.ts";
import {
	deliveryRecord,
	ledger,
	running,
	type CancellationRequester,
} from "./state.ts";

export interface CancellationTarget {
	id: string;
	name: string;
	agent?: string;
	worktree?: boolean;
}

export type CancelOutcome =
	| { kind: "cancelled-queued"; target: CancellationTarget; spec: LaunchSpec }
	| { kind: "cancelled-starting"; target: CancellationTarget; spec: LaunchSpec; origin: "inline" | "drain" }
	| { kind: "stopping"; target: CancellationTarget; requester: CancellationRequester }
	| { kind: "already-stopping"; target: CancellationTarget; requester: CancellationRequester }
	| { kind: "delivering"; target: CancellationTarget; stopped: boolean }
	| { kind: "already-cancelled"; id: string }
	| { kind: "completed"; target: CancellationTarget }
	| { kind: "unknown"; id: string };

function specTarget(spec: LaunchSpec): CancellationTarget {
	const display = specDisplay(spec);
	return { id: spec.id, name: display.name, agent: display.agent };
}

export function requestCancel(
	pi: ExtensionAPI,
	id: string,
	requester: CancellationRequester,
): CancelOutcome {
	const child = running.get(id);
	if (child) {
		const target = {
			id: child.id,
			name: child.name,
			agent: child.agent,
			worktree: child.worktree !== undefined,
		};
		if (child.stopRequester !== undefined || child.abort.signal.aborted) {
			child.stopRequester ??= requester;
			if (!child.abort.signal.aborted) child.abort.abort();
			return { kind: "already-stopping", target, requester: child.stopRequester };
		}
		child.stopRequester = requester;
		child.abort.abort();
		return { kind: "stopping", target, requester };
	}

	const delivery = deliveryRecord(id);
	if (delivery) {
		return {
			kind: "delivering",
			target: { id: delivery.id, name: delivery.name, agent: delivery.agent },
			stopped: delivery.stopped,
		};
	}

	const queued = findQueued(id);
	if (queued) {
		const removed = cancelQueued(id);
		if (!removed) return { kind: "unknown", id };
		recordCancellation(id, requester);
		if (requester === "user") notifyQueueCancelled(pi, removed.spec);
		return { kind: "cancelled-queued", target: specTarget(removed.spec), spec: removed.spec };
	}

	const pending = findPendingLaunch(id);
	if (pending) {
		recordCancellation(id, requester);
		if (requester === "user" && pending.origin === "drain") notifyQueueCancelled(pi, pending.spec);
		return {
			kind: "cancelled-starting",
			target: specTarget(pending.spec),
			spec: pending.spec,
			origin: pending.origin,
		};
	}

	if (cancellationFor(id)) return { kind: "already-cancelled", id };

	const completed = ledger.get(id);
	if (completed) {
		return { kind: "completed", target: { id, name: completed.name } };
	}

	return { kind: "unknown", id };
}
