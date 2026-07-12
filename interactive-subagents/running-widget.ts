/**
 * running-widget.ts — the live "what's running" widget above the editor.
 *
 * widget.ts is the PURE renderer (rows in, styled lines out — unit-tested
 * under plain node); this file is its stateful controller: it owns the
 * 1-second refresh timer, feeds the renderer from the running map, and
 * pushes the result into pi's UI.
 *
 * pi API in play: `ctx.ui.setWidget(key, content, options)` shows persistent
 * lines anchored to the TUI (here: above the editor). Passing a COMPONENT
 * FACTORY instead of plain lines lets the widget render at the real terminal
 * width — that is what right-anchors the elapsed clock. Passing `undefined`
 * removes the widget.
 */

import { oldestActiveTool, toolElapsedSeconds } from "./activity.ts";
import { computeStatus } from "./status.ts";
import { formatRunningWidgetLines } from "./widget.ts";
import { getLatestCtx, running } from "./state.ts";

const WIDGET_KEY = "interactive-subagents";

// The refresh timer is parked on globalThis (see state.ts for why): a
// /reload must stop the PREVIOUS import's timer, or two of them would fight
// over the widget forever. The two accessors are the only slot access.
const TIMER_KEY = Symbol.for("interactive-subagents/widget-timer");
const slots = globalThis as Record<symbol, unknown>;

function currentTimer(): ReturnType<typeof setInterval> | null {
	return (slots[TIMER_KEY] as ReturnType<typeof setInterval> | undefined) ?? null;
}

function rememberTimer(timer: ReturnType<typeof setInterval> | null): void {
	slots[TIMER_KEY] = timer;
}

// On import (fresh load or /reload): stop whatever timer a previous import
// left running.
{
	const previous = currentTimer();
	if (previous) clearInterval(previous);
	rememberTimer(null);
}

/** Re-render the widget from the running map; remove it when nothing runs. */
export function updateRunningWidget(): void {
	const ctx = getLatestCtx();
	if (!ctx || !ctx.hasUI) return;

	if (running.size === 0) {
		// Passing undefined for content removes the widget.
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		stopWidgetTimer();
		return;
	}

	// Snapshot the rows now; the component form gets the real terminal width
	// at render time, which is what lets the elapsed clock right-anchor.
	// The liveness fields are derived HERE, synchronously off the record (no
	// fs, nothing async), from the same observation fields the watcher uses —
	// so render(width) below stays layout-only and the two surfaces can never
	// disagree. Worst case the widget lags a status flip by ~1s (the two 1 Hz
	// timers are unsynchronized), which is display-only: steer decisions live
	// in the watcher path, never in widget renders.
	const now = Date.now();
	const rows = [...running.values()].map((child) => {
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
			name: child.name,
			agent: child.agent,
			elapsedSeconds: Math.round((now - child.startTime) / 1000),
			forked: child.context === "forked",
			worktree: child.worktree !== undefined,
			status,
			toolName: tool?.name,
			toolElapsedSeconds:
				tool && snap && obs?.acceptedAtMs !== undefined
					? toolElapsedSeconds(snap, tool, obs.acceptedAtMs, now)
					: undefined,
			contextTokens: snap?.context?.tokens ?? undefined,
		};
	});
	ctx.ui.setWidget(
		WIDGET_KEY,
		(_tui, theme) => ({
			invalidate(): void {},
			render(width: number): string[] {
				return formatRunningWidgetLines(rows, width, {
					dim: (text) => theme.fg("dim", text),
					border: (text) => theme.fg("borderMuted", text),
					// The state marks stack the terminal's faint attribute (SGR 2)
					// on top of the theme's dim color, so they sit a notch quieter
					// than the clock. \x1b[22m turns only the faintness back off.
					slot: (text) => `\x1b[2m${theme.fg("dim", text)}\x1b[22m`,
					// Stalled is the only status that should pop: the theme's
					// warning color, same precedent as the implant banner.
					warn: (text) => theme.fg("warning", text),
				});
			},
		}),
		{ placement: "aboveEditor" },
	);
}

/** Start the 1-second refresh timer if it isn't already running. */
export function ensureWidgetTimer(): void {
	if (currentTimer()) return;
	rememberTimer(setInterval(updateRunningWidget, 1000));
}

export function stopWidgetTimer(): void {
	const timer = currentTimer();
	if (timer) clearInterval(timer);
	rememberTimer(null);
}
