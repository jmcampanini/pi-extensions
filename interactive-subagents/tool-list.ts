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
 * status, context tokens, and cost — the numbers the model needs to decide
 * whether a child is too full to keep resuming. Status comes from the SAME
 * computeStatus inputs the widget and the watcher use, so the three surfaces
 * can never disagree. Finished children appear in a second section only
 * while their result message is still queued behind the parent's current
 * turn; once it lands they vanish - their closing numbers arrived with it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { oldestActiveTool, toolElapsedSeconds, type ActivityObservation } from "./activity.ts";
import { agentDefsDir, collectAgentInventory, projectDefsDir } from "./agents.ts";
import { sanitizeDisplayText } from "./display-text.ts";
import { delivering, running } from "./state.ts";
import { computeStatus, STALL_AFTER_MS, type SubagentStatus } from "./status.ts";
import { humanElapsed } from "./watcher.ts";
import { clampToolName, formatCost, formatTokens, formatToolElapsed } from "./widget.ts";

/** A stalled bullet's parenthetical — the steer prose's reasons, shortened
 * to fit one line. Same choice rules as the steer (watcher.ts stalledReason):
 * healthy reads mean the prompted run never began; otherwise the last
 * problem kind decides, and "no liveness report" is claimed only when none
 * was EVER accepted — a mid-run disappearance says the reports stopped. */
function shortStallReason(obs: ActivityObservation, nowMs: number): string {
	if (obs.problemSinceMs === undefined || nowMs - obs.problemSinceMs < STALL_AFTER_MS) {
		return "task never started";
	}
	if (obs.lastProblemKind === "invalid") return "unreadable liveness report";
	if (obs.lastProblemKind === "stale") return "stale liveness reports (child clock stepped backwards)";
	if (obs.snapshot !== undefined) return "liveness reports stopped";
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
					everSawRun: obs.everSawRun ?? false,
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
		} else if (snap.context.tokens === null) {
			contextClause = "context unknown (just compacted)";
		} else {
			contextClause = `context ${formatTokens(snap.context.tokens)}/${formatTokens(snap.context.window)} tokens`;
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
			costUsd: snap?.costUsd ?? null,
			elapsedSeconds,
		});
	}
	return { lines, details };
}

/**
 * The "Finished, result on its way" section: children whose pi process has
 * exited but whose result message is still queued behind the parent's
 * current turn (state.ts's delivering map). Without these bullets the model
 * would see a child it spawned in NEITHER list during that window and might
 * respawn finished work. The elapsed number is frozen at exit - the same
 * number the widget row shows. The economics fields are null on purpose:
 * the closing numbers travel in the result message itself.
 */
function describeDeliveringChildren(): { lines: string[]; details: unknown[] } {
	const lines: string[] = [];
	const details: unknown[] = [];
	for (const child of delivering.values()) {
		const name = sanitizeDisplayText(child.name);
		const agent = child.agent === undefined ? undefined : sanitizeDisplayText(child.agent);
		const identity = agent ? `(id ${child.id}, agent ${agent})` : `(id ${child.id})`;
		lines.push(
			`• "${name}" ${identity}: finished after ${humanElapsed(child.elapsedSeconds)} - its result message is queued and will arrive automatically (do not poll or respawn)`,
		);
		details.push({
			id: child.id,
			name: child.name,
			agent: child.agent ?? null,
			status: "delivering",
			contextTokens: null,
			contextWindow: null,
			costUsd: null,
			elapsedSeconds: child.elapsedSeconds,
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
			"Also reports currently running sub-agents with their live status, context usage, and cost, plus just-finished sub-agents whose result message is still on its way.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const inventory = collectAgentInventory(ctx.modelRegistry, ctx.cwd);
			const runningChildren = describeRunningChildren(Date.now());
			const deliveringChildren = describeDeliveringChildren();
			const sections: string[] = [];
			if (runningChildren.lines.length > 0) {
				sections.push(`Currently running (${runningChildren.lines.length}):\n${runningChildren.lines.join("\n")}`);
			}
			if (deliveringChildren.lines.length > 0) {
				sections.push(`Finished, result on its way (${deliveringChildren.lines.length}):\n${deliveringChildren.lines.join("\n")}`);
			}
			const childrenSection = sections.length === 0 ? undefined : sections.join("\n\n");

			if (inventory.length === 0) {
				const noAgents =
					`No agent definitions found in ${agentDefsDir()} or ${projectDefsDir(ctx.cwd)}. ` +
					"The subagent tool defaults to the 'worker' agent, so create worker.md in one of those directories before spawning.";
				return {
					content: [{ type: "text", text: childrenSection ? `${noAgents}\n\n${childrenSection}` : noAgents }],
					details: { count: 0, running: runningChildren.details, delivering: deliveringChildren.details },
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
			const text = childrenSection ? `${lines.join("\n")}\n\n${childrenSection}` : lines.join("\n");
			return {
				content: [{ type: "text", text }],
				details: { count: inventory.length, running: runningChildren.details, delivering: deliveringChildren.details },
			};
		},
	});
}
