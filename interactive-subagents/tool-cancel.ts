import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "@sinclair/typebox";
import { requestCancel, type CancellationTarget, type CancelOutcome } from "./cancel.ts";
import { queuedCount } from "./capacity.ts";
import { sanitizeDisplayText } from "./display-text.ts";
import { updateRunningWidget } from "./running-widget.ts";
import { running } from "./state.ts";

const CancelParams = Type.Object({
	id: Type.String({ description: "The stable short id shown by subagent_status and returned by subagent_spawn/subagent_resume." }),
});
type CancelParamsType = Static<typeof CancelParams>;

function identity(target: CancellationTarget): string {
	const agent = target.agent ? `, agent ${sanitizeDisplayText(target.agent)}` : "";
	return `Sub-agent "${sanitizeDisplayText(target.name)}" (id ${sanitizeDisplayText(target.id)}${agent})`;
}

function runningLine(): string {
	return `Currently ${running.size} running, ${queuedCount()} queued.`;
}

function successText(outcome: Extract<CancelOutcome, {
	kind: "cancelled-queued" | "cancelled-starting" | "stopping" | "already-stopping";
}>): { text: string; status: "cancelled" | "stopping" } {
	if (outcome.kind === "cancelled-queued") {
		return {
			status: "cancelled",
			text:
				`${identity(outcome.target)} was cancelled before it started. Result: cancelled. ` +
				`It never ran and no result will arrive for it. ${runningLine()}`,
		};
	}
	if (outcome.kind === "cancelled-starting") {
		return {
			status: "cancelled",
			text:
				`${identity(outcome.target)} was cancelled while starting. Result: cancelled. ` +
				`Its launch is being unwound, it will not run, and no result will arrive for it. ${runningLine()}`,
		};
	}
	if (outcome.kind === "already-stopping") {
		return {
			status: "stopping",
			text:
				`${identity(outcome.target)} is already being stopped. Result: stopping. ` +
				"Its stopped notice will still arrive on its own. Partial work may remain.",
		};
	}
	const worktree = outcome.target.worktree
		? " Its worktree is kept so it can be inspected or resumed."
		: "";
	return {
		status: "stopping",
		text:
			`${identity(outcome.target)} was asked to stop. Result: stopping. ` +
			"Its stopped notice will arrive on its own. " +
			`Partial work may remain.${worktree}`,
	};
}

function rejectionMessage(outcome: Exclude<CancelOutcome, {
	kind: "cancelled-queued" | "cancelled-starting" | "stopping" | "already-stopping";
}>): string {
	switch (outcome.kind) {
		case "delivering":
			return outcome.stopped
				? `${identity(outcome.target)} has already stopped. Its stopped notice is on its way and cannot be revoked; wait for it.`
				: `${identity(outcome.target)} has already finished. Its result is on its way and cannot be revoked; wait for it.`;
		case "already-cancelled":
			return `Sub-agent id ${sanitizeDisplayText(outcome.id)} was already cancelled. No result will arrive for it.`;
		case "completed":
			return `${identity(outcome.target)} already finished and its result was delivered; there is nothing to cancel.`;
		case "unknown":
			return `No sub-agent with id ${sanitizeDisplayText(outcome.id)}. Use subagent_status to list unresolved sub-agents.`;
	}
}

export function registerSubagentCancelTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "subagent_cancel",
		label: "Cancel Subagent",
		description:
			"Cancel one unresolved sub-agent by id. Its lifecycle state is resolved at execution time; do not choose a cancel/stop variant. " +
			"Result `cancelled` means the work never ran or was fully prevented and no result will ever arrive. Result `stopping` means a running child was asked to stop; its stopped notice arrives on its own like any result. " +
			"A running stop may leave partial work, and stopped worktrees are kept for inspection or resume. Interactive (`autoExit: false`) children may have a human working in their pane; cancel one only when the user clearly wants that.",
		parameters: CancelParams,
		renderCall(args, theme) {
			const id = sanitizeDisplayText(args.id).replace(/\s+/g, " ").trim();
			return new Text(
				theme.fg("toolTitle", theme.bold("subagent cancel")) + theme.fg("muted", " · ") + theme.fg("accent", id),
				0,
				0,
			);
		},
		renderResult(result, _options, theme, context) {
			const content = result.content.find((part) => part.type === "text");
			const text = sanitizeDisplayText(content?.type === "text" ? content.text : "");
			return new Text(
				context.isError
					? theme.fg("error", text || "Unable to cancel sub-agent.")
					: theme.fg("toolOutput", text),
				0,
				0,
			);
		},
		async execute(_toolCallId, params: CancelParamsType) {
			const outcome = requestCancel(pi, params.id, "model");
			updateRunningWidget();
			if (
				outcome.kind === "cancelled-queued"
				|| outcome.kind === "cancelled-starting"
				|| outcome.kind === "stopping"
				|| outcome.kind === "already-stopping"
			) {
				const result = successText(outcome);
				return {
					content: [{ type: "text" as const, text: result.text }],
					details: { id: params.id, status: result.status, outcome: outcome.kind },
				};
			}
			throw new Error(rejectionMessage(outcome));
		},
	});
}
