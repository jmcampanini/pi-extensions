import {
	getAgentDir,
	getMarkdownTheme,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { copyBlockCanonicalText, smartOpenBlock } from "./actions.ts";
import { ExplorerComponent } from "./component.ts";
import { config } from "./config.ts";
import { BranchBlockIndex } from "./indexer.ts";
import { ExplorerState } from "./state.ts";

/** Register both human entry points around one guarded overlay launcher. */
export function registerFuzzyExplorer(pi: ExtensionAPI): void {
	let opening = false;

	const open = async (ctx: ExtensionContext): Promise<void> => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("fuzzy-explorer requires Pi's interactive TUI.", "warning");
			return;
		}
		if (opening) return;
		opening = true;

		try {
			const branchIndex = new BranchBlockIndex();
			const state = new ExplorerState(config.openMode);
			const settingsManager = SettingsManager.create(ctx.cwd, getAgentDir(), {
				projectTrusted: ctx.isProjectTrusted(),
			});
			const externalEditor = settingsManager.getProjectSettings().externalEditor
				?? settingsManager.getGlobalSettings().externalEditor;

			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => new ExplorerComponent({
					tui,
					theme,
					state,
					getBlocks: () => branchIndex.update(ctx.sessionManager),
					actions: {
						copy: async (block) => { await copyBlockCanonicalText(block); },
						open: async (block) => {
							const result = await smartOpenBlock(block, {
								tui,
								settings: { externalEditor },
								repositoryRoot: ctx.cwd,
							});
							return result.exitCode;
						},
					},
					notify: (message, level) => ctx.ui.notify(message, level),
					done,
					markdownTheme: getMarkdownTheme(),
				}),
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "92%",
						minWidth: 40,
						maxHeight: "90%",
						margin: 1,
					},
				},
			);
		} catch (error) {
			ctx.ui.notify(`Could not open fuzzy-explorer: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			opening = false;
		}
	};

	pi.registerCommand("fuzzy-explorer", {
		description: "Search and inspect blocks on the active transcript branch",
		handler: async (_args, ctx) => { await open(ctx); },
	});
	pi.registerShortcut(config.openShortcut, {
		description: "Open fuzzy explorer for the active transcript branch",
		handler: open,
	});
}

export default registerFuzzyExplorer;
