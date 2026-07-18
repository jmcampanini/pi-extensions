/**
 * command-available.ts — /subagent-available: the HUMAN's view of the agents.
 *
 * Shows the inventory (description headline, resolved model, non-default
 * config, problems) as one card per agent in a widget above the editor. It
 * is shown as a WIDGET, not a message or session entry, deliberately: it
 * lives only on screen, so it never enters the model's context and costs
 * zero tokens. Run the command again to hide it, or it clears on your next
 * submitted message.
 *
 * pi API in play: `pi.registerCommand(name, { description, handler })` adds
 * a /command the human can type. The handler gets the live ExtensionContext.
 * `ctx.ui.setWidget` with a COMPONENT FACTORY (instead of plain lines) gets
 * the real terminal width and theme at render time — that is what powers
 * the dot leaders, right-anchored source column, and colors (agents.ts does
 * the actual layout). `pi.on("input", ...)` fires on every submitted input —
 * that's the auto-dismiss hook.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentDefsDir, collectAgentInventory, formatAgentOverviewLines, projectDefsDir } from "./agents.ts";
import { updateCatalogue } from "./catalogue.ts";
import { getLatestCtx } from "./state.ts";

const OVERVIEW_WIDGET_KEY = "interactive-subagents-overview";

/** When the overview was shown; null = hidden. */
let overviewShownAt: number | null = null;

function hideOverview(): void {
	overviewShownAt = null;
	const ctx = getLatestCtx();
	if (ctx?.hasUI) {
		// Passing undefined for content removes the widget.
		ctx.ui.setWidget(OVERVIEW_WIDGET_KEY, undefined);
	}
}

/** Forget the overview state at session teardown (the UI is going away). */
export function resetOverview(): void {
	overviewShownAt = null;
}

export function registerSubagentAvailableCommand(pi: ExtensionAPI): void {
	pi.registerCommand("subagent-available", {
		description: "List the available sub-agent definitions and their details",
		handler: async (_args, ctx) => {
			// Toggle: running the command while the overview is up hides it.
			if (overviewShownAt !== null) {
				hideOverview();
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("The sub-agent overview needs the interactive TUI.", "warning");
				return;
			}
			// Snapshot the inventory now; the component re-renders at the
			// real terminal width whenever the TUI needs it. A fresh inventory
			// also updates the system-prompt catalogue snapshot (catalogue.ts).
			const inventory = collectAgentInventory(ctx.modelRegistry, ctx.cwd);
			updateCatalogue(inventory);
			const dirs = { global: agentDefsDir(), project: projectDefsDir(ctx.cwd) };
			ctx.ui.setWidget(
				OVERVIEW_WIDGET_KEY,
				(_tui, theme) => ({
					invalidate(): void {},
					render(width: number): string[] {
						return formatAgentOverviewLines(inventory, width, dirs, {
							dim: (text) => theme.fg("dim", text),
							muted: (text) => theme.fg("muted", text),
							accent: (text) => theme.fg("accent", text),
							error: (text) => theme.fg("error", text),
							warning: (text) => theme.fg("warning", text),
							border: (text) => theme.fg("borderMuted", text),
							bold: (text) => theme.bold(text),
							italic: (text) => theme.italic(text),
						});
					},
				}),
				{ placement: "aboveEditor" },
			);
			overviewShownAt = Date.now();
		},
	});

	// Dismiss the overview on the next submitted input. The grace period
	// keeps the command's own submission from hiding it instantly.
	pi.on("input", () => {
		if (overviewShownAt !== null && Date.now() - overviewShownAt > 500) {
			hideOverview();
		}
	});
}
