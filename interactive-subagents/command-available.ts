/**
 * command-available.ts — /subagents-available: the HUMAN's view of the agents.
 *
 * Shows the full inventory (description, resolved model, thinking, tools,
 * mode, problems, source file) in a widget above the editor. It is shown as
 * a WIDGET, not a message or session entry, deliberately: it lives only on
 * screen, so it never enters the model's context and costs zero tokens.
 * Run the command again to hide it, or it clears on your next submitted
 * message.
 *
 * pi API in play: `pi.registerCommand(name, { description, handler })` adds
 * a /command the human can type. The handler gets the live ExtensionContext.
 * `pi.on("input", ...)` fires on every submitted input — that's the
 * auto-dismiss hook.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentDefsDir, collectAgentInventory, formatAgentOverviewLines, projectDefsDir } from "./agents.ts";
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

export function registerSubagentsAvailableCommand(pi: ExtensionAPI): void {
	pi.registerCommand("subagents-available", {
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
			const lines = formatAgentOverviewLines(collectAgentInventory(ctx.modelRegistry, ctx.cwd), {
				global: agentDefsDir(),
				project: projectDefsDir(ctx.cwd),
			});
			ctx.ui.setWidget(OVERVIEW_WIDGET_KEY, lines, { placement: "aboveEditor" });
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
