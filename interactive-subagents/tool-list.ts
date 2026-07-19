/**
 * tool-list.ts — the `subagent_list` tool: the MODEL's view of the agents.
 *
 * Terse on purpose: the model only needs enough to CHOOSE an agent (name +
 * description), plus whether the result comes back on its own (interactive
 * agents wait for a human), plus a warning when a spawn would fail. The
 * full details — tools, model, file paths — live in the human-facing
 * /subagent-available command instead; both are views over the same
 * inventory (agents.ts). This is the EXPANDED counterpart of the bounded
 * catalogue in the system prompt: each bullet shows the agent's `details`
 * text, falling back to the full (untruncated) description, and running the
 * tool also refreshes the catalogue snapshot (catalogue.ts).
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
import { pendingLaunches, queuedEntries, specDisplay } from "./capacity.ts";
import { updateCatalogue } from "./catalogue.ts";
import { sanitizeDisplayText } from "./display-text.ts";
import { delivering, running } from "./state.ts";
import { computeStatus, STALL_AFTER_MS, type SubagentStatus } from "./status.ts";
import { humanElapsed } from "./result-message.ts";
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
		// report, and $0.00 would be a lie. External children report NEITHER
		// number: their snapshots carry no context or cost telemetry (both are
		// intentionally deferred), so the clauses would only mislead.
		const clauses: string[] = [];
		if (child.harness === undefined) {
			clauses.push(contextClause);
			if (snap !== undefined) clauses.push(`cost this run ${formatCost(snap.costUsd)}`);
		}
		clauses.push(`elapsed ${humanElapsed(elapsedSeconds)}`);

		const name = sanitizeDisplayText(child.name);
		const agent = child.agent === undefined ? undefined : sanitizeDisplayText(child.agent);
		const identityParts = [`id ${child.id}`];
		if (agent) identityParts.push(`agent ${agent}`);
		if (child.harness) identityParts.push(`harness ${sanitizeDisplayText(child.harness)}`);
		const identity = `(${identityParts.join(", ")})`;
		lines.push(`• "${name}" ${identity}: ${statusClause} · ${clauses.join(" · ")}`);
		details.push({
			id: child.id,
			name: child.name,
			agent: child.agent ?? null,
			harness: child.harness ?? null,
			status,
			contextTokens: child.harness ? null : (snap?.context?.tokens ?? null),
			contextWindow: child.harness ? null : (snap?.context?.window ?? null),
			costUsd: child.harness ? null : (snap?.costUsd ?? null),
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
		const identityParts = [`id ${child.id}`];
		if (agent) identityParts.push(`agent ${agent}`);
		if (child.harness) identityParts.push(`harness ${sanitizeDisplayText(child.harness)}`);
		const identity = `(${identityParts.join(", ")})`;
		lines.push(
			`• "${name}" ${identity}: finished after ${humanElapsed(child.elapsedSeconds)} - its result message is queued and will arrive automatically (do not poll or respawn)`,
		);
		details.push({
			id: child.id,
			name: child.name,
			agent: child.agent ?? null,
			harness: child.harness ?? null,
			status: "delivering",
			contextTokens: null,
			contextWindow: null,
			costUsd: null,
			elapsedSeconds: child.elapsedSeconds,
		});
	}
	return { lines, details };
}

/**
 * The "Launching" bullets: children whose launch pipeline is running right
 * now (slot claimed, not yet in the running map — a window of a few
 * seconds). Folded into the queued section so a child dequeued for launch
 * never disappears from every list between "queued" and "running".
 */
function describeLaunchingChildren(nowMs: number): { lines: string[]; details: unknown[] } {
	const lines: string[] = [];
	const details: unknown[] = [];
	for (const pending of pendingLaunches()) {
		const display = specDisplay(pending.spec);
		const name = sanitizeDisplayText(display.name);
		const agent = display.agent === undefined ? undefined : sanitizeDisplayText(display.agent);
		const identityParts = [`id ${pending.spec.id}`];
		if (agent) identityParts.push(`agent ${agent}`);
		lines.push(
			`• "${name}" (${identityParts.join(", ")}): starting right now - it will appear as running within seconds (do not poll or re-issue)`,
		);
		details.push({
			id: pending.spec.id,
			name: display.name,
			agent: display.agent ?? null,
			kind: pending.spec.kind,
			status: "starting",
			claimedSeconds: Math.max(0, Math.round((nowMs - pending.claimedAt) / 1000)),
		});
	}
	return { lines, details };
}

/**
 * The "Queued" section: launches admitted by subagent_spawn/subagent_resume
 * that are waiting for a concurrency slot (capacity.ts). Without these
 * bullets the model would see a child it queued in NO list and might queue
 * duplicate work. Positions are 1-based in start order.
 */
function describeQueuedChildren(nowMs: number): { lines: string[]; details: unknown[] } {
	const lines: string[] = [];
	const details: unknown[] = [];
	const entries = queuedEntries();
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const display = specDisplay(entry.spec);
		const name = sanitizeDisplayText(display.name);
		const agent = display.agent === undefined ? undefined : sanitizeDisplayText(display.agent);
		const identityParts = [`id ${entry.spec.id}`];
		if (agent) identityParts.push(`agent ${agent}`);
		const waitedSeconds = Math.max(0, Math.round((nowMs - entry.queuedAt) / 1000));
		lines.push(
			`• "${name}" (${identityParts.join(", ")}): queued ${humanElapsed(waitedSeconds)} ago, position ${i + 1} of ${entries.length} - starts automatically when a concurrency slot frees (do not poll or re-issue)`,
		);
		details.push({
			id: entry.spec.id,
			name: display.name,
			agent: display.agent ?? null,
			kind: entry.spec.kind,
			status: "queued",
			position: i + 1,
			waitedSeconds,
		});
	}
	return { lines, details };
}

export function registerSubagentListTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "subagent_list",
		label: "List Subagents",
		description:
			"List the available agent definitions (<name>.md files from the project's .pi/subagents/ or the global subagents dir; project shadows global) usable as the `agent` parameter of subagent_spawn. " +
			"Also reports currently running sub-agents with their live status, context usage, and cost, just-finished sub-agents whose result message is still on its way, and launches queued for a free concurrency slot.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const inventory = collectAgentInventory(ctx.modelRegistry, ctx.cwd);
			// A fresh inventory in hand is the moment to update the system-prompt
			// catalogue snapshot - the two surfaces stay in step for free.
			updateCatalogue(inventory);
			const runningChildren = describeRunningChildren(Date.now());
			const deliveringChildren = describeDeliveringChildren();
			const launchingChildren = describeLaunchingChildren(Date.now());
			const queuedChildren = describeQueuedChildren(Date.now());
			const pendingLines = [...launchingChildren.lines, ...queuedChildren.lines];
			const sections: string[] = [];
			if (runningChildren.lines.length > 0) {
				sections.push(`Currently running (${runningChildren.lines.length}):\n${runningChildren.lines.join("\n")}`);
			}
			if (deliveringChildren.lines.length > 0) {
				sections.push(`Finished, result on its way (${deliveringChildren.lines.length}):\n${deliveringChildren.lines.join("\n")}`);
			}
			if (pendingLines.length > 0) {
				sections.push(`Starting or queued for a concurrency slot (${pendingLines.length}):\n${pendingLines.join("\n")}`);
			}
			const childrenSection = sections.length === 0 ? undefined : sections.join("\n\n");

			if (inventory.length === 0) {
				const noAgents =
					`No agent definitions found in ${agentDefsDir()} or ${projectDefsDir(ctx.cwd)}. ` +
					"subagent_spawn defaults to the 'worker' agent, so create worker.md in one of those directories before spawning.";
				return {
					content: [{ type: "text", text: childrenSection ? `${noAgents}\n\n${childrenSection}` : noAgents }],
					details: {
						count: 0,
						running: runningChildren.details,
						delivering: deliveringChildren.details,
						starting: launchingChildren.details,
						queued: queuedChildren.details,
					},
				};
			}
			const lines = inventory.map((agent) => {
				const interactive = agent.autoExit ? "" : " (interactive — a human drives it)";
				// Worth surfacing to the model: a worktree agent runs isolated in
				// its own directory, which changes where its edits land.
				const worktree = agent.worktree ? " (worktree)" : "";
				// So is a non-pi harness: the child is a different program with
				// its own model names and tool vocabulary.
				const harness = agent.harness !== "pi" ? ` (harness ${agent.harness})` : "";
				// Problems keep their line breaks in the inventory; this terse
				// view flattens them to keep one bullet per agent.
				const problems = agent.problems.join("; ").replace(/\s*\n\s*/g, " ");
				const warning = agent.problems.length > 0 ? ` [⚠ not spawnable: ${problems}]` : "";
				const isDefault = agent.name === "worker" ? " (default)" : "";
				const source = agent.source === "project" ? " (project)" : "";
				return `• ${agent.name}${isDefault}${source}${interactive}${worktree}${harness}${warning} — ${agent.details ?? agent.description ?? "(no description)"}`;
			});
			const text = childrenSection ? `${lines.join("\n")}\n\n${childrenSection}` : lines.join("\n");
			return {
				content: [{ type: "text", text }],
				details: {
					count: inventory.length,
					running: runningChildren.details,
					delivering: deliveringChildren.details,
					starting: launchingChildren.details,
					queued: queuedChildren.details,
				},
			};
		},
	});
}
