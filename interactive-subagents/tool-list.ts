/**
 * tool-list.ts — the `subagents_list` tool: the MODEL's view of the agents.
 *
 * Terse on purpose: the model only needs enough to CHOOSE an agent (name +
 * description), plus whether the result comes back on its own (interactive
 * agents wait for a human), plus a warning when a spawn would fail. The
 * full details — tools, model, file paths — live in the human-facing
 * /subagents-available command instead; both are views over the same
 * inventory (agents.ts).
 *
 * v2 appends a running-children section: one bullet per live child with its
 * status, context share, and cost — the numbers the model needs to decide
 * whether a child is too full to keep resuming. Status comes from the SAME
 * computeStatus inputs the widget and the watcher use, so the three surfaces
 * can never disagree. Finished children are not listed: their closing
 * numbers already arrived in their result message.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { oldestActiveTool, toolElapsedSeconds, type ActivityObservation } from "./activity.ts";
import { agentDefsDir, collectAgentInventory, projectDefsDir } from "./agents.ts";
import { sanitizeDisplayText } from "./display-text.ts";
import { running } from "./state.ts";
import { computeStatus, STALL_AFTER_MS, type SubagentStatus } from "./status.ts";
import { humanElapsed } from "./watcher.ts";
import { clampToolName, formatCost, formatTokens, formatToolElapsed } from "./widget.ts";

/** A stalled bullet's parenthetical — the steer prose's reasons, shortened
 * to fit one line. Same choice rule as the steer: healthy reads mean the
 * prompted run never began; otherwise the last problem kind decides. */
function shortStallReason(obs: ActivityObservation, nowMs: number): string {
	if (obs.problemSinceMs === undefined || nowMs - obs.problemSinceMs < STALL_AFTER_MS) {
		return "task never started";
	}
	if (obs.lastProblemKind === "invalid") return "unreadable liveness report";
	return "no liveness report";
}

/**
 * The "Currently running" section: bullet lines for the model plus raw
 * numbers for `details` (machine-only, but greppable by tests). Ids are
 * verbatim — the model passes them straight to subagent_resume. Both empty
 * when nothing is running: the section is then omitted entirely.
 */
function describeRunningChildren(nowMs: number): { lines: string[]; details: unknown[] } {
	const lines: string[] = [];
	const details: unknown[] = [];
	for (const child of running.values()) {
		const obs = child.activity;
		const snap = obs?.snapshot;
		const status: SubagentStatus = obs
			? computeStatus({
					nowMs,
					watchdogStartMs: obs.watchdogStartMs,
					expectsRun: child.expectsRun,
					snapshot: snap,
					problemSinceMs: obs.problemSinceMs,
				})
			: "starting";
		const elapsedSeconds = Math.round((nowMs - child.startTime) / 1000);
		const launched = `launched ${humanElapsed(elapsedSeconds)} ago`;

		// The status clause. Active names the longest-running tool when one is
		// known (same pick, clamp, and duration format as the widget segment).
		let statusClause: string;
		if (status === "starting") {
			statusClause = `starting (${launched})`;
		} else if (status === "waiting") {
			statusClause = "waiting for input";
		} else if (status === "stalled") {
			statusClause = `stalled (${obs ? shortStallReason(obs, nowMs) : "no liveness report"}; ${launched})`;
		} else {
			const tool = snap ? oldestActiveTool(snap.activeTools) : undefined;
			statusClause =
				tool && snap && obs?.acceptedAtMs !== undefined
					? `active, running ${clampToolName(tool.name)} for ${formatToolElapsed(toolElapsedSeconds(snap, tool, obs.acceptedAtMs, nowMs))}`
					: "active";
		}

		// The context clause. Null tokens are pi's honest "just compacted";
		// no snapshot at all is plain unknown — never guessed, never 0.
		let contextClause: string;
		if (snap === undefined || snap.context === null) {
			contextClause = "context unknown";
		} else if (snap.context.tokens === null || snap.context.percent === null) {
			contextClause = "context unknown (just compacted)";
		} else {
			contextClause =
				`context ${formatTokens(snap.context.tokens)}/${formatTokens(snap.context.window)} tokens ` +
				`(${Math.round(snap.context.percent)}%)`;
		}

		// Cost only when a snapshot exists — without one there is no number to
		// report, and $0.00 would be a lie.
		const clauses = [contextClause];
		if (snap !== undefined) clauses.push(`cost this run ${formatCost(snap.costUsd)}`);
		clauses.push(`elapsed ${humanElapsed(elapsedSeconds)}`);

		const name = sanitizeDisplayText(child.name);
		const agent = child.agent === undefined ? undefined : sanitizeDisplayText(child.agent);
		const identity = agent ? `(id ${child.id}, agent ${agent})` : `(id ${child.id})`;
		lines.push(`• "${name}" ${identity}: ${statusClause} · ${clauses.join(" · ")}`);
		details.push({
			id: child.id,
			name: child.name,
			agent: child.agent ?? null,
			status,
			contextTokens: snap?.context?.tokens ?? null,
			contextWindow: snap?.context?.window ?? null,
			contextPercent: snap?.context?.percent ?? null,
			costUsd: snap?.costUsd ?? null,
			elapsedSeconds,
		});
	}
	return { lines, details };
}

export function registerSubagentsListTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "subagents_list",
		label: "List Subagent Definitions",
		description:
			"List the available agent definitions (<name>.md files from the project's .pi/subagents/ or the global subagents dir; project shadows global) usable as the `agent` parameter of the subagent tool. " +
			"Also reports currently running sub-agents with their live status, context usage, and cost.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const inventory = collectAgentInventory(ctx.modelRegistry, ctx.cwd);
			const children = describeRunningChildren(Date.now());
			const runningSection =
				children.lines.length === 0 ? undefined : `Currently running (${children.lines.length}):\n${children.lines.join("\n")}`;

			if (inventory.length === 0) {
				const noAgents =
					`No agent definitions found in ${agentDefsDir()} or ${projectDefsDir(ctx.cwd)}. ` +
					"The subagent tool defaults to the 'worker' agent, so create worker.md in one of those directories before spawning.";
				return {
					content: [{ type: "text", text: runningSection ? `${noAgents}\n\n${runningSection}` : noAgents }],
					details: { count: 0, running: children.details },
				};
			}
			const lines = inventory.map((agent) => {
				const interactive = agent.autoExit ? "" : " (interactive — a human drives it)";
				// Worth surfacing to the model: a worktree agent runs isolated in
				// its own directory, which changes where its edits land.
				const worktree = agent.worktree ? " (worktree)" : "";
				// Problems keep their line breaks in the inventory; this terse
				// view flattens them to keep one bullet per agent.
				const problems = agent.problems.join("; ").replace(/\s*\n\s*/g, " ");
				const warning = agent.problems.length > 0 ? ` [⚠ not spawnable: ${problems}]` : "";
				const isDefault = agent.name === "worker" ? " (default)" : "";
				const source = agent.source === "project" ? " (project)" : "";
				return `• ${agent.name}${isDefault}${source}${interactive}${worktree}${warning} — ${agent.description ?? "(no description)"}`;
			});
			const text = runningSection ? `${lines.join("\n")}\n\n${runningSection}` : lines.join("\n");
			return {
				content: [{ type: "text", text }],
				details: { count: inventory.length, running: children.details },
			};
		},
	});
}
