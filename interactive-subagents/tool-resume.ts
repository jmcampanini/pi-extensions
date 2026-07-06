/**
 * tool-resume.ts — the `subagent_resume` tool: reopen a child session.
 *
 * Used to answer a caller_ping, retry a failure, or send follow-up work.
 * Context survives because the child's .jsonl file IS the conversation —
 * resuming just points a fresh pi process at the same file. The child's
 * launch identity (system prompt, tools, model, thinking, auto-exit) is
 * restored from its `.meta` sidecar; explicit params always win.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { config } from "./config.ts";
import { artifactBase, buildChildEnv, buildLaunchCommand, clearExitSidecar, readLaunchMeta, slugify } from "./launch.ts";
import { resolveUsableModel } from "./models.ts";
import { countEntries, readSessionCwd } from "./session.ts";
import { createPane, isTmuxAvailable, sendLongCommand, shellQuote, sleep } from "./tmux.ts";
import { ledger, running } from "./state.ts";
import { trackChild } from "./watcher.ts";

const ResumeParams = Type.Object({
	id: Type.Optional(
		Type.String({ description: "The sub-agent's short id from a result/ping message (preferred). Use sessionPath instead if pi was restarted since." }),
	),
	sessionPath: Type.Optional(
		Type.String({ description: "Path to the child session .jsonl file — fallback when the id is no longer known (e.g. after a pi restart)" }),
	),
	message: Type.Optional(Type.String({ description: "Follow-up prompt or answer to send to the resumed subagent" })),
	name: Type.Optional(Type.String({ description: "Display name for the resumed subagent (default: 'Resumed')" })),
	autoExit: Type.Optional(Type.Boolean({ description: "true (default) = exit after finishing the follow-up; false = stay open for a human" })),
	tools: Type.Optional(Type.String({ description: "Override the tool allowlist (default: the child's original tools, restored from its launch metadata)" })),
	model: Type.Optional(Type.String({ description: "Override the model (default: the child's original model, restored from its launch metadata)" })),
});
type ResumeParamsType = Static<typeof ResumeParams>;

export function registerSubagentResumeTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "subagent_resume",
		label: "Resume Subagent",
		description:
			"Resume a previous sub-agent session with an optional follow-up message. Pass the `id` from a " +
			"result/ping message (preferred), or `sessionPath` if the id is no longer known (e.g. after a restart). " +
			"ASYNC — returns immediately; the result steers back automatically. Do not poll.",
		parameters: ResumeParams,
		async execute(_toolCallId, params: ResumeParamsType, _signal, _onUpdate, ctx) {
			if (!isTmuxAvailable()) {
				throw new Error("Subagents need tmux: start pi inside a tmux session.");
			}

			// Resolve which session to reopen: short id via this session's
			// ledger (preferred — no long path to copy around), else an
			// explicit path (survives parent restarts, when the ledger is gone).
			let sessionPath = params.sessionPath;
			if (!sessionPath && params.id) {
				sessionPath = ledger.get(params.id)?.sessionFile;
				if (!sessionPath) {
					throw new Error(
						`Unknown sub-agent id "${params.id}" — pass the sessionPath from the result/ping message instead.`,
					);
				}
			}
			if (!sessionPath) {
				throw new Error("subagent_resume needs either `id` (from a result/ping message) or `sessionPath`.");
			}
			if (!existsSync(sessionPath)) {
				throw new Error(`No session file at ${sessionPath}`);
			}

			// A leftover .exit sidecar from a previous run of this session would
			// fake an instant completion — clear it before launching.
			clearExitSidecar(sessionPath);

			// Refuse to attach a second pi process to a session that is still
			// running — two processes appending to one .jsonl corrupts it.
			// Checked synchronously (before any await) so parallel resume calls
			// cannot race past each other.
			const targetPath = resolve(sessionPath);
			for (const child of running.values()) {
				if (resolve(child.sessionFile) === targetPath) {
					throw new Error(
						`Sub-agent "${child.name}" (id ${child.id}) is still running on this session — wait for its result or ping before resuming.`,
					);
				}
			}

			// Reapply the child's original launch settings from the `.meta`
			// sidecar written at launch. Explicit params always win; a missing
			// meta file (e.g. a session not created by this extension) just
			// means no defaults.
			const meta = readLaunchMeta(sessionPath);

			const name = params.name ?? meta.name ?? "Resumed";
			const autoExit = params.autoExit ?? meta.autoExit ?? true;
			const tools = params.tools ?? meta.tools;
			// Re-resolve the model on THIS machine (an old session may name a
			// provider this computer has no credentials for — fail fast here,
			// not in the pane). Param overrides go through the same check.
			const modelCandidates = params.model ? [params.model] : meta.model ? [meta.model] : [];
			const model =
				modelCandidates.length > 0 ? resolveUsableModel(modelCandidates, ctx.modelRegistry) : undefined;
			const thinking = meta.thinking;

			// An autonomous resume with no message would open an idle session
			// that never completes: nothing prompts the child, so no turn runs,
			// so auto-exit never fires and the watcher polls forever.
			if (autoExit && !params.message) {
				throw new Error(
					"subagent_resume needs a `message` when the child is autonomous (autoExit) — pass your answer/follow-up, or set autoExit: false to hand the pane to a human.",
				);
			}
			const systemPromptFile =
				meta.systemPromptFile && existsSync(meta.systemPromptFile) ? meta.systemPromptFile : undefined;
			const id = randomUUID().slice(0, 8);
			const base = artifactBase(ctx);
			const slug = slugify(name);

			// Only entries added AFTER this point count toward the new summary.
			const skipEntries = countEntries(sessionPath);

			// The follow-up message rides in as an @file, like task delivery.
			let messageArg = "";
			if (params.message) {
				const messageFile = join(base, "resume", `${slug}-${id}.md`);
				mkdirSync(dirname(messageFile), { recursive: true });
				writeFileSync(messageFile, params.message, "utf8");
				messageArg = shellQuote(`@${messageFile}`);
			}

			// Run in the directory the original child used (recorded in its
			// session header) so relative paths and tools behave the same.
			const sessionCwd = readSessionCwd(sessionPath);

			const command = buildLaunchCommand({
				cwd: sessionCwd,
				env: buildChildEnv({
					PI_SUBAGENT_SESSION: sessionPath,
					PI_SUBAGENT_NAME: name,
					PI_SUBAGENT_AUTO_EXIT: autoExit ? "1" : undefined,
				}),
				sessionFile: sessionPath,
				model,
				thinking,
				systemPromptFile,
				tools,
				promptArg: messageArg,
			});

			const paneId = createPane(name);
			await sleep(config.shellReadyDelayMs);
			const scriptPath = join(base, "scripts", `${slug}-${id}-resume.sh`);
			sendLongCommand(paneId, command, scriptPath);

			trackChild(pi, {
				id,
				name,
				agent: meta.agent,
				paneId,
				sessionFile: sessionPath,
				startTime: Date.now(),
				skipEntries,
				tools,
				model,
				autoExit,
				abort: new AbortController(),
			});

			return {
				content: [
					{
						type: "text",
						text: `Resumed sub-agent "${name}" (id ${id}). Its result will arrive automatically — do not poll.`,
					},
				],
				details: { id, sessionFile: sessionPath, paneId },
			};
		},
	});
}
