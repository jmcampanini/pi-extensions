/**
 * running-widget.ts — lifecycle projection plus the compact widget controller.
 *
 * widget.ts is the pure renderer. This file snapshots every lifecycle
 * registry, orders rows by attention priority then launch time, caps the
 * compact rows, and owns the 1-second UI refresh timer. /subagent-status
 * consumes the uncapped projection.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { oldestActiveTool, toolElapsedSeconds } from "./activity.ts";
import { pendingLaunchCount, pendingLaunches, queuedCount, queuedEntries, specDisplay, type LaunchSpec } from "./capacity.ts";
import { config } from "./config.ts";
import { computeStatus } from "./status.ts";
import { formatRunningWidgetLines, type WidgetRow } from "./widget.ts";
import { delivering, getLatestCtx, running } from "./state.ts";

export type WidgetLifecycle = "running" | "delivering" | "pending" | "queued";

export interface LifecycleWidgetRow extends WidgetRow {
	id: string;
	lifecycle: WidgetLifecycle;
	startedAt: number;
	/** Exact non-pi harness name for detailed surfaces. */
	harness?: string;
}

export interface CompactWidgetSnapshot {
	rows: LifecycleWidgetRow[];
	hiddenRows: number;
	hiddenStalledRows: number;
	hiddenWaitingRows: number;
	hiddenQueuedRows: number;
	totalRows: number;
}

const WIDGET_KEY = "interactive-subagents";
const TIMER_KEY = Symbol.for("interactive-subagents/widget-timer");
const SUSPENSIONS_KEY = Symbol.for("interactive-subagents/widget-suspensions");
const slots = globalThis as Record<symbol, unknown>;

interface WidgetSuspensionState {
	generation: number;
	count: number;
}

const widgetSuspensions = (slots[SUSPENSIONS_KEY] as WidgetSuspensionState | undefined) ?? {
	generation: 0,
	count: 0,
};
slots[SUSPENSIONS_KEY] = widgetSuspensions;

function currentTimer(): ReturnType<typeof setInterval> | null {
	return (slots[TIMER_KEY] as ReturnType<typeof setInterval> | undefined) ?? null;
}

function rememberTimer(timer: ReturnType<typeof setInterval> | null): void {
	slots[TIMER_KEY] = timer;
}

export function activateRunningWidgetGeneration(generation: number): void {
	if (generation <= widgetSuspensions.generation) return;
	widgetSuspensions.generation = generation;
	widgetSuspensions.count = 0;
}

stopWidgetTimer();

function launchWidgetRow(
	spec: LaunchSpec,
	lifecycle: "pending" | "queued",
	startedAt: number,
	now: number,
): LifecycleWidgetRow {
	const display = specDisplay(spec);
	const external = spec.harness !== "pi";
	return {
		id: spec.id,
		lifecycle,
		startedAt,
		name: display.name,
		agent: display.agent,
		harness: external ? spec.harness : undefined,
		elapsedSeconds: Math.round((now - startedAt) / 1000),
		forked: spec.context === "forked",
		interactive: !spec.autoExit,
		worktree: spec.kind === "spawn" ? spec.useWorktree : spec.worktree !== undefined,
		external,
		status: lifecycle === "pending" ? "starting" : "queued",
	};
}

/** Snapshot every lifecycle, then order by delivering, stalled, waiting,
 * starting, active, and queued. Launch time is the stable tiebreaker. */
export function collectLifecycleWidgetRows(now = Date.now()): LifecycleWidgetRow[] {
	const rows: LifecycleWidgetRow[] = [...running.values()].map((child) => {
		const obs = child.activity;
		const snap = obs?.snapshot;
		const status = obs
			? computeStatus({
					nowMs: now,
					watchdogStartMs: obs.watchdogStartMs,
					expectsRun: child.expectsRun,
					everSawRun: obs.everSawRun ?? false,
					snapshot: snap,
					problemSinceMs: obs.problemSinceMs,
				})
			: ("starting" as const);
		const tool = snap?.inRun ? oldestActiveTool(snap.activeTools) : undefined;
		return {
			id: child.id,
			lifecycle: "running",
			startedAt: child.startTime,
			name: child.name,
			agent: child.agent,
			harness: child.harness,
			elapsedSeconds: Math.round((now - child.startTime) / 1000),
			forked: child.context === "forked",
			interactive: !child.autoExit,
			worktree: child.worktree !== undefined,
			external: child.harness !== undefined,
			status,
			toolName: tool?.name,
			toolElapsedSeconds:
				tool && snap && obs?.acceptedAtMs !== undefined
					? toolElapsedSeconds(snap, tool, obs.acceptedAtMs, now)
					: undefined,
			contextTokens: snap?.context?.tokens ?? undefined,
		};
	});

	for (const child of delivering.values()) {
		rows.push({
			id: child.id,
			lifecycle: "delivering",
			startedAt: child.startedAt,
			name: child.name,
			agent: child.agent,
			harness: child.harness,
			elapsedSeconds: child.elapsedSeconds,
			forked: child.forked,
			interactive: child.interactive,
			worktree: child.worktree,
			external: child.harness !== undefined,
			status: child.stopped ? "stopped" : "delivering",
		});
	}

	for (const pending of pendingLaunches()) {
		if (running.has(pending.spec.id)) continue;
		rows.push(launchWidgetRow(pending.spec, "pending", pending.claimedAt, now));
	}

	for (const entry of queuedEntries()) {
		rows.push(launchWidgetRow(entry.spec, "queued", entry.queuedAt, now));
	}
	return rows.sort((left, right) => {
		const priority = rowPriority(left) - rowPriority(right);
		return priority !== 0 ? priority : left.startedAt - right.startedAt;
	});
}

function rowPriority(row: LifecycleWidgetRow): number {
	switch (row.status) {
		case "delivering":
		case "stopped": return 0;
		case "stalled": return 1;
		case "waiting": return 2;
		case "starting": return 3;
		case "active": return 4;
		case "queued": return 5;
		default: return 6;
	}
}

export function compactWidgetSnapshot(
	now = Date.now(),
	maxRows = config.widgetMaxRows,
): CompactWidgetSnapshot {
	const allRows = collectLifecycleWidgetRows(now);
	const rowLimit = Number.isFinite(maxRows) ? Math.max(1, Math.floor(maxRows)) : config.widgetMaxRows;
	const rows = allRows.slice(0, rowLimit);
	const hiddenRows = allRows.slice(rows.length);
	return {
		rows,
		hiddenRows: hiddenRows.length,
		hiddenStalledRows: hiddenRows.filter((row) => row.status === "stalled").length,
		hiddenWaitingRows: hiddenRows.filter((row) => row.status === "waiting").length,
		hiddenQueuedRows: hiddenRows.filter((row) => row.status === "queued").length,
		totalRows: allRows.length,
	};
}

export function updateRunningWidget(): void {
	if (widgetSuspensions.count > 0) return;
	const idle = running.size === 0 && queuedCount() === 0 && pendingLaunchCount() === 0;
	if (idle) stopWidgetTimer();

	const ctx = getLatestCtx();
	if (!ctx || !ctx.hasUI) return;

	if (idle && delivering.size === 0) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}

	const snapshot = compactWidgetSnapshot();
	ctx.ui.setWidget(
		WIDGET_KEY,
		(_tui, theme) => ({
			invalidate(): void {},
			render(width: number): string[] {
				return formatRunningWidgetLines(snapshot.rows, width, {
					dim: (text) => theme.fg("dim", text),
					border: (text) => theme.fg("borderMuted", text),
					agent: (text) => theme.fg("muted", text),
					slot: (text) => theme.fg("muted", text),
					warn: (text) => theme.fg("warning", text),
				}, {
					summary: snapshot.hiddenRows > 0
						? {
							hiddenRows: snapshot.hiddenRows,
							stalledRows: snapshot.hiddenStalledRows,
							waitingRows: snapshot.hiddenWaitingRows,
							queuedRows: snapshot.hiddenQueuedRows,
						}
						: undefined,
				});
			},
		}),
		{ placement: "aboveEditor" },
	);
}

export function suspendRunningWidget(ctx: ExtensionContext): () => void {
	if (!ctx.hasUI) return () => {};
	const generation = widgetSuspensions.generation;
	widgetSuspensions.count++;
	ctx.ui.setWidget(WIDGET_KEY, undefined);
	let restored = false;
	return () => {
		if (restored) return;
		restored = true;
		if (widgetSuspensions.generation !== generation) return;
		widgetSuspensions.count = Math.max(0, widgetSuspensions.count - 1);
		if (widgetSuspensions.count === 0) updateRunningWidget();
	};
}

export function ensureWidgetTimer(): void {
	if (currentTimer()) return;
	rememberTimer(setInterval(updateRunningWidget, 1000));
}

export function stopWidgetTimer(): void {
	const timer = currentTimer();
	if (timer) clearInterval(timer);
	rememberTimer(null);
}
