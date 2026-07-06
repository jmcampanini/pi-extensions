/**
 * watcher.ts — per-child supervision, and the words the parent model hears.
 *
 * The spawn tools return immediately, so the detached promise started by
 * trackChild() is a child's ONLY supervisor: it polls for the exit, cleans
 * up the pane, and steers the outcome back into the parent conversation.
 * It must never reject silently — every path ends in either a steered
 * message or a deliberate no-op.
 *
 * pi API in play: `pi.sendMessage(message, options)` is the one way to wake
 * the parent model asynchronously. `customType` tags the entry in the
 * session file (our E2E tests grep for it), `content` is the prose the
 * model reads, `display: true` also shows it in the TUI, and `details` is
 * machine-readable metadata persisted with the entry — the MODEL NEVER SEES
 * `details`, which is why the content prose must carry everything the model
 * needs (ids, paths, next steps): the prose IS the protocol.
 * `{ triggerTurn: true, deliverAs: "steer" }` makes the message start/steer
 * a turn instead of waiting for the human to type something.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { closePane, pollForExit, refreshLayout, type ExitResult } from "./tmux.ts";
import { extractSummary } from "./session.ts";
import { ledger, moduleSignal, running, type RunningSubagent } from "./state.ts";
import { ensureWidgetTimer, updateRunningWidget } from "./running-widget.ts";

/** Elapsed time as prose ("3m 42s") for the steered messages. The widget's
 * clock format (03:42) lives separately in widget.ts — different surface. */
function humanElapsed(totalSeconds: number): string {
	if (totalSeconds < 60) return `${totalSeconds}s`;
	return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

/** Register a child and start its supervision machinery. */
export function trackChild(pi: ExtensionAPI, child: RunningSubagent): void {
	running.set(child.id, child);
	ledger.set(child.id, { sessionFile: child.sessionFile, name: child.name });
	ensureWidgetTimer();
	updateRunningWidget();
	void watchSubagent(pi, child);
}

async function watchSubagent(pi: ExtensionAPI, child: RunningSubagent): Promise<void> {
	let result: ExitResult;
	try {
		result = await pollForExit({
			paneId: child.paneId,
			sessionFile: child.sessionFile,
			// AbortSignal.any fires when EITHER source aborts: the module-wide
			// signal (session shutdown or /reload) or this child's own
			// controller (x = stop in the /subagents-running picker).
			signal: AbortSignal.any([moduleSignal(), child.abort.signal]),
			// v2 seam: liveness snapshot observation attaches here.
		});
	} catch (error) {
		result = {
			reason: "error",
			exitCode: 1,
			errorMessage: `Watcher failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	running.delete(child.id);
	updateRunningWidget();
	closePane(child.paneId);
	// Re-flow the remaining subagent panes so they reclaim this one's space.
	if (running.size > 0) refreshLayout();

	const elapsed = humanElapsed(Math.round((Date.now() - child.startTime) / 1000));

	if (result.reason === "aborted") {
		// Two ways to get aborted: the session is shutting down (stay
		// silent — nobody is left to tell) or a human pressed x in the
		// picker. The model must hear about the latter, because it was
		// promised a result for this child and would otherwise wait for
		// one that can never arrive.
		if (child.stoppedByUser) {
			pi.sendMessage(
				{
					customType: "subagent_result",
					content:
						`Sub-agent "${child.name}" (id ${child.id}) was stopped by the user after ${elapsed}. ` +
						`Do not treat this as a failure of the sub-agent.\n\n` +
						`Session: ${child.sessionFile}\nResume with subagent_resume({ id: "${child.id}", message: "..." }) if the work should continue.`,
					display: true,
					details: { id: child.id, name: child.name, reason: "stopped", sessionFile: child.sessionFile },
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
		}
		return;
	}

	// A ping is a help request, not a completion: hand the parent model
	// the question plus everything it needs to resume the child.
	if (result.reason === "ping") {
		pi.sendMessage(
			{
				customType: "subagent_ping",
				content:
					`Sub-agent "${result.pingName ?? child.name}" (id ${child.id}) needs help: ${result.pingMessage}\n\n` +
					`Answer with subagent_resume({ id: "${child.id}", message: "<your answer>" }). ` +
					"Its original system prompt, tools, and model are reapplied automatically.\n" +
					`Session: ${child.sessionFile} (pass as sessionPath instead of id if the id is no longer known)`,
				display: true,
				details: { id: child.id, name: child.name, sessionFile: child.sessionFile },
			},
			{ triggerTurn: true, deliverAs: "steer" },
		);
		return;
	}

	// Completion or failure: the summary is the child's last assistant
	// message, read from its session file (only entries after a resume
	// point, if any).
	const summary = extractSummary(child.sessionFile, child.skipEntries);
	const failed = result.exitCode !== 0 || result.reason === "error" || result.reason === "pane-closed";

	let content: string;
	if (!failed) {
		content =
			`Sub-agent "${child.name}" (id ${child.id}) completed (${elapsed}).\n\n` +
			`${summary ?? "(the subagent produced no final message)"}\n\n` +
			`For follow-up work: subagent_resume({ id: "${child.id}", message: "..." }). Session: ${child.sessionFile}`;
	} else {
		const reasonText =
			result.reason === "error"
				? `provider/agent error: ${result.errorMessage}`
				: result.reason === "pane-closed"
					? result.errorMessage
					: `exit code ${result.exitCode}`;
		content =
			`Sub-agent "${child.name}" (id ${child.id}) failed after ${elapsed} (${reasonText}).\n\n` +
			(summary ? `Last output:\n${summary}\n\n` : "") +
			`You can retry with subagent_resume({ id: "${child.id}", message: "<guidance>" }). Session: ${child.sessionFile}`;
	}

	pi.sendMessage(
		{
			customType: "subagent_result",
			content,
			display: true,
			details: {
				id: child.id,
				name: child.name,
				agent: child.agent,
				exitCode: result.exitCode,
				reason: result.reason,
				sessionFile: child.sessionFile,
				tools: child.tools,
				model: child.model,
			},
		},
		{ triggerTurn: true, deliverAs: "steer" },
	);
}
