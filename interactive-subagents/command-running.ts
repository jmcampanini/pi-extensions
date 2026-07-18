/**
 * command-running.ts — /subagent-running: pick a running child and act.
 *
 * Opens a focused picker over the running children. Up/down (or j/k) to
 * choose, Enter jumps to the pane (switching tmux windows if needed),
 * z jumps AND zooms it (tmux prefix+z un-zooms), x stops it, Esc cancels.
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
import { sanitizeDisplayText } from "./display-text.ts";
import { formatElapsed } from "./widget.ts";
import { running, type RunningSubagent } from "./state.ts";
import { focusPane } from "./tmux.ts";

export function registerSubagentRunningCommand(pi: ExtensionAPI): void {
	pi.registerCommand("subagent-running", {
		description: "Pick a running sub-agent and jump to its pane (z = jump + zoom)",
		handler: async (_args, ctx) => {
			if (running.size === 0) {
				ctx.ui.notify("No sub-agents running.", "info");
				return;
			}
			const choice = await ctx.ui.custom<{ child: RunningSubagent; action: "goto" | "zoom" | "stop" } | undefined>(
				(tui, theme, _keybindings, done) => {
					const children = [...running.values()];
					let cursor = 0;
					return {
						handleInput(data: string): void {
							if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
								done(undefined);
							} else if (matchesKey(data, "up") || data === "k") {
								cursor = (cursor - 1 + children.length) % children.length;
								tui.requestRender();
							} else if (matchesKey(data, "down") || data === "j") {
								cursor = (cursor + 1) % children.length;
								tui.requestRender();
							} else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
								done({ child: children[cursor], action: "goto" });
							} else if (data === "z") {
								done({ child: children[cursor], action: "zoom" });
							} else if (data === "x") {
								done({ child: children[cursor], action: "stop" });
							}
						},
						invalidate(): void {},
						render(width: number): string[] {
							const th = theme;
							const lines: string[] = [""];
							lines.push(truncateToWidth(th.fg("accent", " Jump to sub-agent "), width));
							for (let i = 0; i < children.length; i++) {
								const child = children[i];
								const elapsed = formatElapsed(Math.round((Date.now() - child.startTime) / 1000));
								const childName = sanitizeDisplayText(child.name);
								const agent = child.agent === undefined ? undefined : sanitizeDisplayText(child.agent);
								const agentTag = agent ? ` (${agent})` : "";
								const row = `${i === cursor ? "→" : " "} ${elapsed}  ${childName}${agentTag}`;
								lines.push(truncateToWidth(i === cursor ? th.fg("accent", row) : th.fg("text", row), width));
							}
							lines.push(truncateToWidth(th.fg("dim", " ↑/↓ or j/k · enter: go · z: go + zoom · x: stop · esc: cancel"), width));
							lines.push("");
							return lines;
						},
					};
				},
			);

			if (!choice) return;
			if (choice.action === "stop") {
				// Mark first, then abort: the watcher reads the flag when its
				// poll loop notices the abort, closes the pane, and steers the
				// "stopped by the user" note to the model.
				choice.child.stoppedByUser = true;
				choice.child.abort.abort();
				return;
			}
			try {
				focusPane(choice.child.paneId, { zoom: choice.action === "zoom" });
			} catch {
				ctx.ui.notify(`Pane for "${sanitizeDisplayText(choice.child.name)}" is gone.`, "warning");
			}
		},
	});
}
