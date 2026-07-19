/**
 * command-running.ts — /subagent-running: pick a running child and act.
 *
 * Opens a focused picker over the running children and any launches still
 * waiting in the concurrency queue (capacity.ts). Up/down (or j/k) to
 * choose, Enter jumps to the pane (switching tmux windows if needed),
 * z jumps AND zooms it (tmux prefix+z un-zooms), x stops it, Esc cancels.
 * Queued entries have no pane yet: only x applies — it removes the entry
 * (pure data, nothing to roll back) and tells the model, which was promised
 * a result that can now never arrive.
 *
 * pi API in play: `ctx.ui.custom(factory)` shows a component with EXCLUSIVE
 * keyboard focus. The factory receives (tui, theme, keybindings, done) and
 * returns a component: `handleInput(data)` sees every keypress while the
 * component is up, `render(width)` produces its lines. Calling `done(value)`
 * closes the overlay and resolves the awaited promise with that value —
 * that's how the user's choice gets back into the handler below.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { cancelQueued, notifyQueueCancelled, queuedCount, queuedEntries, specDisplay } from "./capacity.ts";
import { sanitizeDisplayText } from "./display-text.ts";
import { updateRunningWidget } from "./running-widget.ts";
import { formatElapsed } from "./widget.ts";
import { running, type RunningSubagent } from "./state.ts";
import { focusPane } from "./tmux.ts";

interface PickerRow {
	/** A queued row carries the spec id instead of a live child. */
	child?: RunningSubagent;
	queuedId?: string;
	name: string;
	agent?: string;
	sinceMs: number;
	queued: boolean;
}

export function registerSubagentRunningCommand(pi: ExtensionAPI): void {
	pi.registerCommand("subagent-running", {
		description: "Pick a running sub-agent and jump to its pane (z = jump + zoom, x = stop/cancel)",
		handler: async (_args, ctx) => {
			if (running.size === 0 && queuedCount() === 0) {
				ctx.ui.notify("No sub-agents running.", "info");
				return;
			}
			const rows: PickerRow[] = [
				...[...running.values()].map((child) => ({
					child,
					name: child.name,
					agent: child.agent,
					sinceMs: child.startTime,
					queued: false,
				})),
				...queuedEntries().map((entry) => {
					const display = specDisplay(entry.spec);
					return {
						queuedId: entry.spec.id,
						name: display.name,
						agent: display.agent,
						sinceMs: entry.queuedAt,
						queued: true,
					};
				}),
			];
			const choice = await ctx.ui.custom<{ row: PickerRow; action: "goto" | "zoom" | "stop" } | undefined>(
				(tui, theme, _keybindings, done) => {
					let cursor = 0;
					return {
						handleInput(data: string): void {
							if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
								done(undefined);
							} else if (matchesKey(data, "up") || data === "k") {
								cursor = (cursor - 1 + rows.length) % rows.length;
								tui.requestRender();
							} else if (matchesKey(data, "down") || data === "j") {
								cursor = (cursor + 1) % rows.length;
								tui.requestRender();
							} else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
								done({ row: rows[cursor], action: "goto" });
							} else if (data === "z") {
								done({ row: rows[cursor], action: "zoom" });
							} else if (data === "x") {
								done({ row: rows[cursor], action: "stop" });
							}
						},
						invalidate(): void {},
						render(width: number): string[] {
							const th = theme;
							const lines: string[] = [""];
							lines.push(truncateToWidth(th.fg("accent", " Jump to sub-agent "), width));
							for (let i = 0; i < rows.length; i++) {
								const row = rows[i];
								const elapsed = formatElapsed(Math.round((Date.now() - row.sinceMs) / 1000));
								const rowName = sanitizeDisplayText(row.name);
								const agent = row.agent === undefined ? undefined : sanitizeDisplayText(row.agent);
								const agentTag = agent ? ` (${agent})` : "";
								const queuedTag = row.queued ? " · queued" : "";
								const text = `${i === cursor ? "→" : " "} ${elapsed}  ${rowName}${agentTag}${queuedTag}`;
								lines.push(truncateToWidth(i === cursor ? th.fg("accent", text) : th.fg("text", text), width));
							}
							lines.push(
								truncateToWidth(
									th.fg("dim", " ↑/↓ or j/k · enter: go · z: go + zoom · x: stop/cancel · esc: cancel"),
									width,
								),
							);
							lines.push("");
							return lines;
						},
					};
				},
			);

			if (!choice) return;
			if (choice.row.queued) {
				if (choice.action !== "stop") {
					ctx.ui.notify(`"${sanitizeDisplayText(choice.row.name)}" has not started yet — it is queued.`, "info");
					return;
				}
				const cancelled = cancelQueued(choice.row.queuedId as string);
				// A drain can launch the entry while the picker is open; the
				// launch won (the child is running now), so there is nothing
				// to cancel here.
				if (!cancelled) {
					ctx.ui.notify(`"${sanitizeDisplayText(choice.row.name)}" already started.`, "info");
					return;
				}
				updateRunningWidget();
				notifyQueueCancelled(pi, cancelled.spec);
				return;
			}
			const child = choice.row.child as RunningSubagent;
			if (choice.action === "stop") {
				// Mark first, then abort: the watcher reads the flag when its
				// poll loop notices the abort, closes the pane, and steers the
				// "stopped by the user" note to the model.
				child.stoppedByUser = true;
				child.abort.abort();
				return;
			}
			try {
				focusPane(child.paneId, { zoom: choice.action === "zoom" });
			} catch {
				ctx.ui.notify(`Pane for "${sanitizeDisplayText(child.name)}" is gone.`, "warning");
			}
		},
	});
}
