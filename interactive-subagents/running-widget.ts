/**
 * running-widget.ts — lifecycle projection plus the compact widget controller.
 *
 * widget.ts is the pure renderer. This file snapshots every lifecycle
 * registry, orders rows by attention priority then launch time, caps the
 * compact rows, and owns the 1-second UI refresh timer. /subagent-running
 * consumes the uncapped projection.
 */

import { oldestActiveTool, toolElapsedSeconds } from "./activity.ts";
import { pendingLaunchCount, pendingLaunches, queuedCount, queuedEntries, specDisplay } from "./capacity.ts";
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
const slots = globalThis as Record<symbol, unknown>;

function currentTimer(): ReturnType<typeof setInterval> | null {
	return (slots[TIMER_KEY] as ReturnType<typeof setInterval> | undefined) ?? null;
}

function rememberTimer(timer: ReturnType<typeof setInterval> | null): void {
	slots[TIMER_KEY] = timer;
}

{
	const previous = currentTimer();
	if (previous) clearInterval(previous);
	rememberTimer(null);
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
			status: "delivering",
		});
	}

	for (const pending of pendingLaunches()) {
		if (running.has(pending.spec.id)) continue;
		const display = specDisplay(pending.spec);
		rows.push({
			id: pending.spec.id,
			lifecycle: "pending",
			startedAt: pending.claimedAt,
			name: display.name,
			agent: display.agent,
			harness: pending.spec.harness === "pi" ? undefined : pending.spec.harness,
			elapsedSeconds: Math.round((now - pending.claimedAt) / 1000),
			forked: pending.spec.context === "forked",
			interactive: !pending.spec.autoExit,
			worktree: pending.spec.kind === "spawn" ? pending.spec.useWorktree : pending.spec.worktree !== undefined,
			external: pending.spec.harness !== "pi",
			status: "starting",
		});
	}

	for (const entry of queuedEntries()) {
		const display = specDisplay(entry.spec);
		rows.push({
			id: entry.spec.id,
			lifecycle: "queued",
			startedAt: entry.queuedAt,
			name: display.name,
			agent: display.agent,
			harness: entry.spec.harness === "pi" ? undefined : entry.spec.harness,
			elapsedSeconds: Math.round((now - entry.queuedAt) / 1000),
			forked: entry.spec.context === "forked",
			interactive: !entry.spec.autoExit,
			worktree: entry.spec.kind === "spawn" ? entry.spec.useWorktree : entry.spec.worktree !== undefined,
			external: entry.spec.harness !== "pi",
			status: "queued",
		});
	}
	return rows.sort((left, right) => {
		const priority = rowPriority(left) - rowPriority(right);
		return priority !== 0 ? priority : left.startedAt - right.startedAt;
	});
}

function rowPriority(row: LifecycleWidgetRow): number {
	switch (row.status) {
		case "delivering": return 0;
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
	const ctx = getLatestCtx();
	if (!ctx || !ctx.hasUI) return;

	if (running.size === 0 && delivering.size === 0 && queuedCount() === 0 && pendingLaunchCount() === 0) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		stopWidgetTimer();
		return;
	}
	if (running.size === 0 && queuedCount() === 0 && pendingLaunchCount() === 0) stopWidgetTimer();

	const snapshot = compactWidgetSnapshot();
	ctx.ui.setWidget(
		WIDGET_KEY,
		(_tui, theme) => ({
			invalidate(): void {},
			render(width: number): string[] {
				return formatRunningWidgetLines(snapshot.rows, width, {
					dim: (text) => theme.fg("dim", text),
					border: (text) => theme.fg("borderMuted", text),
					agent: (text) => theme.fg("dim", text),
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

export function ensureWidgetTimer(): void {
	if (currentTimer()) return;
	rememberTimer(setInterval(updateRunningWidget, 1000));
}

export function stopWidgetTimer(): void {
	const timer = currentTimer();
	if (timer) clearInterval(timer);
	rememberTimer(null);
}
