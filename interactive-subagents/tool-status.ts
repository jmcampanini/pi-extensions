/**
 * tool-status.ts — model-facing status for every unresolved subagent launch.
 */

import { keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { oldestActiveTool, toolElapsedSeconds, type ActivityObservation } from "./activity.ts";
import { pendingLaunches, queuedEntries, specDisplay, type LaunchSpec } from "./capacity.ts";
import { sanitizeDisplayText } from "./display-text.ts";
import { humanElapsed } from "./result-message.ts";
import { collectLifecycleWidgetRows } from "./running-widget.ts";
import { delivering, running } from "./state.ts";
import { STALL_AFTER_MS } from "./status.ts";
import { clampToolName, formatCost, formatTokens, formatToolElapsed } from "./widget.ts";

export type SubagentRuntimeState = "starting" | "active" | "waiting" | "stalled" | "delivering" | "queued";

export interface StatusPresentationEntry {
	id: string;
	agent: string;
	name: string;
	state: SubagentRuntimeState;
	description: string;
	harness: string | null;
	elapsedSeconds: number;
	contextTokens: number | null;
	contextWindow: number | null;
	costUsd: number | null;
	queuePosition: number | null;
}

export interface StatusPresentation {
	version: 1;
	entries: StatusPresentationEntry[];
}

export interface StatusToolDetails {
	presentation: StatusPresentation;
}

const plainText = (text: string): string => text;

export interface StatusCardStyle {
	id?: (text: string) => string;
	agent?: (text: string) => string;
	name?: (text: string) => string;
	separator?: (text: string) => string;
	state?: (state: SubagentRuntimeState, text: string) => string;
	body?: (text: string) => string;
}

function stalledCondition(obs: ActivityObservation | undefined, nowMs: number): string {
	if (!obs || obs.problemSinceMs === undefined || nowMs - obs.problemSinceMs < STALL_AFTER_MS) {
		return "the task did not begin within 60s";
	}
	let reason: string;
	if (obs.lastProblemKind === "invalid") reason = "its liveness report is unreadable";
	else if (obs.lastProblemKind === "stale") reason = "its liveness reports moved backwards in time";
	else if (obs.snapshot !== undefined) reason = "its liveness reports stopped";
	else reason = "no liveness report appeared";
	return `no trustworthy liveness report for 60s (${reason})`;
}

function economics(child: { harness?: string; activity?: ActivityObservation }): {
	text: string[];
	contextTokens: number | null;
	contextWindow: number | null;
	costUsd: number | null;
} {
	if (child.harness) {
		return { text: [`harness ${sanitizeDisplayText(child.harness)}`], contextTokens: null, contextWindow: null, costUsd: null };
	}
	const snapshot = child.activity?.snapshot;
	const context = snapshot?.context;
	const text: string[] = [];
	if (snapshot === undefined || context == null) text.push("context unknown");
	else if (context.tokens === null) text.push("context unknown (just compacted)");
	else text.push(`context ${formatTokens(context.tokens)}/${formatTokens(context.window)} tokens`);
	if (snapshot !== undefined) text.push(`cost this run ${formatCost(snapshot.costUsd)}`);
	return {
		text,
		contextTokens: context?.tokens ?? null,
		contextWindow: context?.window ?? null,
		costUsd: snapshot?.costUsd ?? null,
	};
}

function runningEntry(id: string, state: SubagentRuntimeState, nowMs: number): StatusPresentationEntry | undefined {
	const child = running.get(id);
	if (!child) return undefined;
	const elapsedSeconds = Math.max(0, Math.round((nowMs - child.startTime) / 1000));
	const runEconomics = economics(child);
	const clauses = [...runEconomics.text, `elapsed ${humanElapsed(elapsedSeconds)}`];
	let description: string;
	if (state === "active") {
		const snapshot = child.activity?.snapshot;
		const tool = snapshot?.inRun ? oldestActiveTool(snapshot.activeTools) : undefined;
		const activity = tool && snapshot && child.activity?.acceptedAtMs !== undefined
			? `running ${clampToolName(tool.name)} for ${formatToolElapsed(toolElapsedSeconds(snapshot, tool, child.activity.acceptedAtMs, nowMs))}`
			: "working";
		description = `${activity} · ${clauses.join(" · ")}`;
	} else if (state === "waiting") {
		description = `healthy but idle and may be waiting for human input in its pane · ${clauses.join(" · ")}`;
	} else if (state === "stalled") {
		const hasReportedEconomics = Boolean(child.harness) || child.activity?.snapshot !== undefined;
		const telemetry = hasReportedEconomics
			? ` · ${runEconomics.text.map((clause) => `last reported ${clause}`).join(" · ")}`
			: "";
		description = `${stalledCondition(child.activity, nowMs)}; this is a warning, not a failure; wait or inspect its pane through /subagent-status${telemetry} · elapsed ${humanElapsed(elapsedSeconds)}`;
	} else {
		description = `launch is underway; no active run has been observed · elapsed ${humanElapsed(elapsedSeconds)}; do not poll or reissue`;
	}
	return {
		id: child.id,
		agent: child.agent ?? "unknown",
		name: child.name,
		state,
		description,
		harness: child.harness ?? null,
		elapsedSeconds,
		contextTokens: runEconomics.contextTokens,
		contextWindow: runEconomics.contextWindow,
		costUsd: runEconomics.costUsd,
		queuePosition: null,
	};
}

function launchEntry(
	spec: LaunchSpec,
	elapsedSeconds: number,
	queue?: { position: number; total: number },
): StatusPresentationEntry {
	const display = specDisplay(spec);
	const harness = spec.harness === "pi" ? null : spec.harness;
	const harnessPrefix = harness === null ? "" : `harness ${sanitizeDisplayText(harness)} · `;
	const description = queue
		? `position ${queue.position} of ${queue.total}; starts automatically when capacity frees; do not poll or reissue`
		: `launch is underway; no activity report yet · elapsed ${humanElapsed(elapsedSeconds)}; do not poll or reissue`;
	return {
		id: spec.id,
		agent: display.agent ?? "unknown",
		name: display.name,
		state: queue ? "queued" : "starting",
		description: `${harnessPrefix}${description}`,
		harness,
		elapsedSeconds,
		contextTokens: null,
		contextWindow: null,
		costUsd: null,
		queuePosition: queue?.position ?? null,
	};
}

export function collectStatusEntries(nowMs = Date.now()): StatusPresentationEntry[] {
	const pendingById = new Map(pendingLaunches().map((pending) => [pending.spec.id, pending]));
	const queue = queuedEntries();
	const queuedById = new Map(queue.map((entry, index) => [entry.spec.id, { entry, position: index + 1 }]));
	const entries: StatusPresentationEntry[] = [];

	for (const row of collectLifecycleWidgetRows(nowMs)) {
		const state = row.status as SubagentRuntimeState;
		if (row.lifecycle === "running") {
			const entry = runningEntry(row.id, state, nowMs);
			if (entry) entries.push(entry);
			continue;
		}
		if (row.lifecycle === "delivering") {
			const child = delivering.get(row.id);
			if (!child) continue;
			const harness = child.harness ? `harness ${sanitizeDisplayText(child.harness)} · ` : "";
			entries.push({
				id: child.id,
				agent: child.agent ?? "unknown",
				name: child.name,
				state: "delivering",
				description: `${harness}finished after ${humanElapsed(child.elapsedSeconds)}; its result is queued and will arrive automatically; do not poll or respawn`,
				harness: child.harness ?? null,
				elapsedSeconds: child.elapsedSeconds,
				contextTokens: null,
				contextWindow: null,
				costUsd: null,
				queuePosition: null,
			});
			continue;
		}
		if (row.lifecycle === "pending") {
			const pending = pendingById.get(row.id);
			if (!pending) continue;
			const elapsedSeconds = Math.max(0, Math.round((nowMs - pending.claimedAt) / 1000));
			entries.push(launchEntry(pending.spec, elapsedSeconds));
			continue;
		}
		const queued = queuedById.get(row.id);
		if (!queued) continue;
		const elapsedSeconds = Math.max(0, Math.round((nowMs - queued.entry.queuedAt) / 1000));
		entries.push(launchEntry(queued.entry.spec, elapsedSeconds, {
			position: queued.position,
			total: queue.length,
		}));
	}
	return entries;
}

function safeInline(text: string): string {
	return sanitizeDisplayText(text).replace(/\s+/g, " ").trim();
}

export function formatStatusModelText(entries: readonly StatusPresentationEntry[]): string {
	if (entries.length === 0) return "No unresolved subagents.";
	return entries.map((entry) =>
		`• id ${safeInline(entry.id)} | agent ${safeInline(entry.agent)} | name ${JSON.stringify(safeInline(entry.name))} | ${entry.state} — ${safeInline(entry.description)}`
	).join("\n");
}

export function formatStatusCardLines(
	entries: readonly StatusPresentationEntry[],
	width: number,
	expanded: boolean,
	style: StatusCardStyle = {},
): string[] {
	const safeWidth = Math.max(0, Math.floor(width));
	if (safeWidth === 0) return [];
	const id = style.id ?? plainText;
	const agent = style.agent ?? plainText;
	const name = style.name ?? plainText;
	const separator = style.separator ?? plainText;
	const state = style.state ?? ((_state, text) => text);
	const body = style.body ?? plainText;
	if (entries.length === 0) return ["", ...new Text(body("No unresolved subagents."), 0, 0).render(safeWidth)];

	const lines: string[] = [""];
	for (const entry of entries) {
		const core = id(safeInline(entry.id)) +
			separator(" · ") +
			agent(safeInline(entry.agent)) +
			separator(" · ") +
			name(safeInline(entry.name)) +
			separator(" · ") +
			state(entry.state, entry.state);
		const text = expanded ? core + body(` — ${safeInline(entry.description)}`) : core;
		lines.push(...new Text(text, 0, 0).render(safeWidth));
	}
	return lines.map((line) => truncateToWidth(line, safeWidth, ""));
}

const RUNTIME_STATES = new Set<SubagentRuntimeState>([
	"starting",
	"active",
	"waiting",
	"stalled",
	"delivering",
	"queued",
]);

function isStatusEntry(value: unknown): value is StatusPresentationEntry {
	if (!value || typeof value !== "object") return false;
	const entry = value as Partial<StatusPresentationEntry>;
	return typeof entry.id === "string"
		&& typeof entry.agent === "string"
		&& typeof entry.name === "string"
		&& typeof entry.state === "string"
		&& RUNTIME_STATES.has(entry.state as SubagentRuntimeState)
		&& typeof entry.description === "string"
		&& typeof entry.elapsedSeconds === "number";
}

function parseDetails(details: unknown): StatusPresentation | undefined {
	if (!details || typeof details !== "object") return undefined;
	const presentation = (details as { presentation?: unknown }).presentation;
	if (!presentation || typeof presentation !== "object") return undefined;
	const candidate = presentation as Partial<StatusPresentation>;
	if (candidate.version !== 1 || !Array.isArray(candidate.entries) || !candidate.entries.every(isStatusEntry)) return undefined;
	return candidate as StatusPresentation;
}

export function registerSubagentStatusTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "subagent_status",
		label: "Subagent Status",
		description:
			"Report every unresolved subagent instance in attention order: delivering, stalled, waiting, starting, active, then queued. " +
			"Each row starts with the stable id that identifies the instance in later result and resume flows, followed by agent definition, display name, exact lifecycle state, relevant telemetry, and what—if anything—to do. " +
			"This is a snapshot for coordination, not a polling primitive: never repeatedly call it while waiting for results.",
		parameters: Type.Object({}),
		renderCall(_args, theme, context) {
			const hint = context.expanded ? "" : keyHint("app.tools.expand", "to expand");
			const heading = theme.fg("toolTitle", theme.bold("subagent status")) +
				(hint ? theme.fg("dim", " (") + hint + theme.fg("dim", ")") : "");
			return new Text(heading, 0, 0);
		},
		renderResult(result, { expanded }, theme, context) {
			const presentation = parseDetails(result.details);
			if (!presentation) {
				const text = result.content.find((part) => part.type === "text");
				const output = sanitizeDisplayText(text?.type === "text" ? text.text : "");
				const component = new Text(
					context.isError
						? theme.fg("error", output || "Unable to read subagent status.")
						: theme.fg("toolOutput", output),
					0,
					0,
				);
				return {
					invalidate(): void {
						component.invalidate();
					},
					render(width: number): string[] {
						if (width <= 0) return [];
						return ["", ...component.render(width)];
					},
				};
			}
			return {
				invalidate(): void {},
				render(width: number): string[] {
					return formatStatusCardLines(presentation.entries, width, expanded, {
						id: (text) => theme.fg("muted", text),
						agent: (text) => theme.fg("muted", text),
						name: (text) => theme.fg("accent", text),
						separator: (text) => theme.fg("muted", text),
						state: (status, text) => theme.fg(status === "stalled" ? "warning" : "muted", text),
						body: (text) => theme.fg("toolOutput", text),
					});
				},
			};
		},
		async execute() {
			const entries = collectStatusEntries(Date.now());
			return {
				content: [{ type: "text", text: formatStatusModelText(entries) }],
				details: {
					presentation: { version: 1, entries },
				} satisfies StatusToolDetails,
			};
		},
	});
}
