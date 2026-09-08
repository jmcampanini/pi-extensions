import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderSession } from "./render.ts";
import { selectMessages, type ReaderSnapshot } from "./session.ts";

export async function writeSessionPage(directory: string, snapshot: ReaderSnapshot): Promise<string> {
	const html = renderSession(snapshot);
	await mkdir(directory, { recursive: true });
	const filePath = join(directory, "index.html");
	await writeFile(filePath, html, "utf8");
	return filePath;
}

export default function (pi: ExtensionAPI) {
	let exporting = false;
	pi.registerCommand("read-session", {
		description: "Read the whole current session in your browser. Usage: /read-session",
		handler: async (_args, ctx) => {
			if (exporting) {
				ctx.ui.notify("The session reader is already being generated", "info");
				return;
			}

			exporting = true;
			try {
				const snapshot = selectMessages(ctx.sessionManager.getBranch());
				if (snapshot.blocks.length === 0) {
					ctx.ui.notify("No user or agent messages to read on the current branch", "info");
					return;
				}
				const sessionKey = createHash("sha256")
					.update(ctx.sessionManager.getSessionId())
					.digest("hex")
					.slice(0, 16);
				const directory = join(ctx.cwd, ".sandbox", "read-session", sessionKey);
				const filePath = await writeSessionPage(directory, {
					...snapshot,
					cwd: ctx.cwd,
					title: ctx.sessionManager.getSessionName() || basename(ctx.cwd),
				});
				const opened = await pi.exec("open", [filePath]);
				if (opened.code !== 0) {
					ctx.ui.notify(`Generated ${filePath}, but open failed: ${opened.stderr || opened.stdout}`, "error");
					return;
				}
				ctx.ui.notify(
					`Opened the session reader with ${snapshot.messageCount} messages. File: ${filePath}`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(
					`Could not open the session reader: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			} finally {
				exporting = false;
			}
		},
	});
}
