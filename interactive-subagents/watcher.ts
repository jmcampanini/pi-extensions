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
import { existsSync } from "node:fs";
import { config } from "./config.ts";
import { sanitizeDisplayText } from "./display-text.ts";
import { closePane, pollForExit, refreshLayout, type ExitResult } from "./tmux.ts";
import { extractSummary } from "./session.ts";
import { ledger, moduleSignal, running, type RunningSubagent } from "./state.ts";
import { ensureWidgetTimer, updateRunningWidget } from "./running-widget.ts";
import { finishWorktree, type WorktreeInfo, type WorktreeOutcome } from "./worktree.ts";

/** Elapsed time as prose ("3m 42s") for the steered messages. The widget's
 * clock format (03:42) lives separately in widget.ts — different surface. */
function humanElapsed(totalSeconds: number): string {
	if (totalSeconds < 60) return `${totalSeconds}s`;
	return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

/**
 * The worktree sentence appended to a result message. The model never sees
 * `details`, so this prose must carry everything it needs to act: the path,
 * the branch, what happened to them, and the next step (merge, inspect, or
 * clean up by hand). Branch phrasing is omitted when the worktree was on a
 * detached HEAD (`branch` is the literal "HEAD" — there is no branch to name).
 */
function worktreeNote(info: WorktreeInfo, outcome: WorktreeOutcome): string {
	const branch = info.branch === "HEAD" ? undefined : info.branch;
	if (outcome.status === "removed") {
		// The cleanup contract only promises the worktree goes away — branch
		// deletion is a property of the DEFAULT command, so name the branch
		// without asserting its fate (a grove-style override may keep it).
		return branch
			? `Worktree: no changes were made, so the cleanup command removed it (its branch was ${branch}).`
			: "Worktree: no changes were made, so the cleanup command removed it.";
	}
	if (outcome.status === "kept") {
		// The wording branches on WHY it was kept: "kept at <dir>" would be a
		// lie for a vanished directory, and `git merge` only helps once work
		// is committed — uncommitted changes live only in the worktree itself.
		if (outcome.code === "vanished") {
			return `Worktree: its directory ${info.dir} no longer exists — nothing was cleaned up.`;
		}
		const where = `Worktree: kept at ${info.dir}` + (branch ? ` on branch ${branch}` : "") + ` — ${outcome.reason}.`;
		if (outcome.code === "dirty") {
			return (
				`${where} Inspect the changes there` +
				(branch ? `; committed work can be merged from the main checkout with \`git merge ${branch}\`` : "") +
				`. Remove the worktree when you are done with it.`
			);
		}
		return `${where} Inspect or remove the worktree when you are done with it.`;
	}
	// cleanup-failed: say only what is observable — the command may have
	// removed the directory before failing, or done nothing at all.
	return existsSync(info.dir)
		? `Worktree: the cleanup command failed (${outcome.error}) — it is still at ${info.dir}` +
				(branch ? ` on branch ${branch}` : "") +
				"; remove it manually."
		: `Worktree: the cleanup command failed (${outcome.error}) after removing the directory` +
				(branch ? ` — check for a leftover branch ${branch}.` : ".");
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
	const childName = sanitizeDisplayText(child.name);

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
						`Sub-agent "${childName}" (id ${child.id}) was stopped by the user after ${elapsed}. ` +
						`Do not treat this as a failure of the sub-agent.` +
						// A stopped child's work may be half-done, so its worktree is
						// deliberately NOT cleaned up — resume still needs it.
						(child.worktree ? `\nIts worktree at ${child.worktree.dir} was kept (the work may be half-done).` : "") +
						`\n\nSession: ${child.sessionFile}\nResume with subagent_resume({ id: "${child.id}", message: "..." }) if the work should continue.`,
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
		const pingName = sanitizeDisplayText(result.pingName ?? child.name);
		const pingMessage = sanitizeDisplayText(result.pingMessage);
		pi.sendMessage(
			{
				customType: "subagent_ping",
				content:
					`Sub-agent "${pingName}" (id ${child.id}) needs help: ${pingMessage}\n\n` +
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
	const generatedSummary = summary === null ? null : sanitizeDisplayText(summary);
	const failed = result.exitCode !== 0 || result.reason === "error" || result.reason === "pane-closed";

	// Worktree cleanup runs BEFORE the result message is sent, so the status
	// the parent model reads (removed/kept/cleanup-failed) is the truth, not a
	// prediction. finishWorktree never throws, so result delivery is safe.
	let worktreeOutcome: WorktreeOutcome | undefined;
	if (child.worktree) {
		worktreeOutcome = await finishWorktree({
			info: child.worktree,
			mode: config.worktreeCleanupMode,
			command: config.worktreeCleanupCommand,
			childSucceeded: !failed,
		});
	}

	let content: string;
	if (!failed) {
		content =
			`Sub-agent "${childName}" (id ${child.id}) completed (${elapsed}).\n\n` +
			`${generatedSummary ?? "(the subagent produced no final message)"}\n\n` +
			`For follow-up work: subagent_resume({ id: "${child.id}", message: "..." }). Session: ${child.sessionFile}`;
	} else {
		const reasonText =
			result.reason === "error"
				? `provider/agent error: ${result.errorMessage}`
				: result.reason === "pane-closed"
					? result.errorMessage
					: `exit code ${result.exitCode}`;
		content =
			`Sub-agent "${childName}" (id ${child.id}) failed after ${elapsed} (${reasonText}).\n\n` +
			(generatedSummary ? `Last output:\n${generatedSummary}\n\n` : "") +
			`You can retry with subagent_resume({ id: "${child.id}", message: "<guidance>" }). Session: ${child.sessionFile}`;
	}

	// The worktree's fate is part of the result — appended to the prose (the
	// model only reads content) and mirrored in details for tooling.
	if (child.worktree && worktreeOutcome) {
		content += `\n\n${worktreeNote(child.worktree, worktreeOutcome)}`;
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
				worktreeDir: child.worktree?.dir,
				worktreeBranch: child.worktree?.branch,
				worktreeStatus: worktreeOutcome?.status,
			},
		},
		{ triggerTurn: true, deliverAs: "steer" },
	);
}
