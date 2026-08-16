import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAgentDir, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	nodeEditorProcessRunner,
	parseEditorCommand,
	resolveExternalEditor,
	type EditorTui,
} from "../shared/external-editor.ts";
import { formatQuotedEditorText, getLastAssistantText } from "./quote.ts";

export interface EditOutcome {
	exitCode: number | null;
	text?: string;
	error?: Error;
}

// Same TUI handoff lifecycle as fuzzy-explorer's smartOpenBlock: nothing may
// leave Pi's TUI stopped, so restart lives in the finally.
export async function editTextExternally(
	tui: EditorTui,
	editorCommand: string,
	initialText: string,
): Promise<EditOutcome> {
	const tmpFile = path.join(os.tmpdir(), `pi-comment-${Date.now()}.md`);
	let tuiStopped = false;
	try {
		const [command, ...args] = parseEditorCommand(editorCommand);
		fs.writeFileSync(tmpFile, initialText, "utf-8");
		tui.stop();
		tuiStopped = true;
		const exitCode = await nodeEditorProcessRunner.run(command, [...args, tmpFile]);
		if (exitCode !== 0) {
			return { exitCode };
		}
		return { exitCode, text: fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "") };
	} catch (error) {
		return { exitCode: null, error: error instanceof Error ? error : new Error(String(error)) };
	} finally {
		try {
			fs.unlinkSync(tmpFile);
		} catch {
			// Cleanup failure must not leave Pi's TUI stopped.
		}
		if (tuiStopped) {
			tui.start();
			tui.requestRender(true);
		}
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("comment", {
		description: "Open the last assistant message in $EDITOR and load the result into the editor",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("comment requires Pi's interactive TUI", "error");
				return;
			}

			const lastAssistantText = getLastAssistantText(ctx.sessionManager.getBranch());
			if (!lastAssistantText) {
				ctx.ui.notify("No completed assistant message found on the current branch", "error");
				return;
			}

			const settingsManager = SettingsManager.create(ctx.cwd, getAgentDir(), {
				projectTrusted: ctx.isProjectTrusted(),
			});
			const editorCommand = resolveExternalEditor({
				externalEditor: settingsManager.getProjectSettings().externalEditor
					?? settingsManager.getGlobalSettings().externalEditor,
			});

			const outcome = await ctx.ui.custom<EditOutcome>((tui, theme, _keybindings, done) => {
				void editTextExternally(tui, editorCommand, formatQuotedEditorText(lastAssistantText)).then(done);
				return {
					render: () => [theme.fg("dim", "waiting for external editor…")],
					invalidate: () => {},
				};
			});

			if (outcome.error) {
				ctx.ui.notify(outcome.error.message, "error");
			} else if (outcome.exitCode === 0 && outcome.text !== undefined) {
				ctx.ui.setEditorText(outcome.text);
				ctx.ui.notify("Loaded edited quoted assistant text into the editor", "info");
			} else {
				ctx.ui.notify("comment cancelled", "info");
			}
		},
	});
}
