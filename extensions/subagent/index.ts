import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, hasTrustRequiringProjectResources, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { canAcceptPrompt, createOutbox } from "./delivery.ts";
import { parentExtensionFlags } from "./environment.ts";
import { startChild } from "./launch.ts";
import { SubagentRegistry } from "./registry.ts";
import { completionPrefix } from "./result.ts";
import { runSubagent, subagentParams } from "./run.ts";
import { readSubagentSettings } from "./settings.ts";
import { installSubagentUi, subagentToolRenderers } from "./ui.ts";
import { createWorktree } from "./worktree.ts";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));

const DESCRIPTION = `Delegate a task to a subagent: a separate Pi agent session with its own context window, running in this process with the same tools, skills, and project instructions.

Modes: "background" (default) returns at once and the result arrives later as a user message beginning ${completionPrefix("<title>")}; reports that finish together arrive in one message. Keep working or end your turn, never poll. "foreground" blocks until the child finishes and returns its report here.
Context: "fresh" (default) gives the child only your task text, so write a self-contained brief with every path, constraint, and acceptance criterion. "fork" copies this conversation into the child first, so the brief can refer to what was discussed.
Location: "cwd" runs the child in another directory. "isolation": "worktree" creates a new git worktree and branch from "from" (default HEAD) of the repo containing cwd and runs the child there; the worktree is left for you to inspect or clean up.
Model: "model" accepts provider/id, an id, or a unique substring such as "opus", "sonnet", "luna"; "effort" is the thinking level. Both default to this session's.`;

export default function subagentExtension(pi: ExtensionAPI) {
	const registry = new SubagentRegistry();
	const trustStore = new ProjectTrustStore(getAgentDir());
	let parentCtx: ExtensionContext | undefined;
	// Set when this session is being replaced or Pi quits. Children that settle afterwards must not
	// touch the stale context or deliver messages.
	let closed = false;

	const notify = (message: string, type: "warning" | "error" = "error") => {
		if (!closed && parentCtx?.hasUI) parentCtx.ui.notify(message, type);
	};
	const outbox = createOutbox({
		canAccept: () => parentCtx === undefined || canAcceptPrompt(parentCtx),
		// Always steer: Pi starts a new turn when idle, and queues when a turn is already running.
		send: (text) => pi.sendUserMessage(text, { deliverAs: "steer" }),
		park: (text) => pi.sendMessage({ customType: "subagent-report", content: text, display: true }, { deliverAs: "nextTurn" }),
		notifyStuck: (count) => notify(`${count} subagent report${count === 1 ? "" : "s"} could not be delivered while the session stayed busy; included in the next turn instead.`, "warning"),
	});

	pi.on("session_start", (_event, ctx) => {
		parentCtx = ctx;
	});
	// Pi clears its compaction guard only after these handlers return, so each flush re-checks.
	pi.on("session_compact", () => outbox.flush());
	pi.on("session_compact_failed", () => outbox.flush());
	pi.on("session_tree", () => outbox.flush());
	pi.on("agent_settled", () => outbox.flush());
	pi.on("session_shutdown", (_event, ctx) => {
		const running = registry.running();
		if (running.length > 0 && ctx.hasUI) {
			const names = running.map((child) => (child.sessionFile ? `${child.title} (${child.sessionFile})` : child.title)).join("; ");
			ctx.ui.notify(`Cancelled ${running.length} running subagent${running.length === 1 ? "" : "s"}: ${names}`, "warning");
		}
		closed = true;
		parentCtx = undefined;
		outbox.close();
		registry.abortAll();
	});
	installSubagentUi(pi, registry, () => parentCtx);

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: DESCRIPTION,
		exposure: "model-only",
		promptSnippet: "subagent: delegate a task to a separate agent session (background by default, optional worktree, fork, model, effort)",
		promptGuidelines: [
			"Delegate self-contained work with the subagent tool; a fresh child cannot see this conversation, so put every path, constraint, and acceptance criterion in the task.",
			"A background subagent reports back as a user message; do not poll or wait for it, continue with other work or end your turn.",
		],
		parameters: subagentParams,
		...subagentToolRenderers,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			parentCtx = ctx;
			const settings = readSubagentSettings(pi.getSettings() as Record<string, unknown>);
			const parent = {
				cwd: ctx.cwd,
				model: ctx.model,
				thinkingLevel: ctx.thinkingLevel,
				scopedModels: ctx.scopedModels.map((entry) => entry.model),
				availableModels: ctx.modelRegistry.getAvailable(),
				activeTools: pi.getActiveTools(),
				projectTrusted: ctx.isProjectTrusted(),
				sessionFile: ctx.sessionManager.getSessionFile(),
				leafId: ctx.sessionManager.getLeafId(),
				branch: ctx.sessionManager.getBranch(),
			};
			return runSubagent(
				{ params, toolCallId, signal, onUpdate, parent },
				{
					settings,
					extensions: parentExtensionFlags(process.argv.slice(2)),
					registry,
					startChild,
					createWorktree: (request) =>
						createWorktree({
							exec: (command, args, options) => pi.exec(command, args, options),
							cwd: request.cwd,
							slug: request.slug,
							from: request.from,
							template: settings.worktreePath,
							branchTemplate: settings.worktreeBranch,
							env: process.env,
							home: homedir(),
							exists: existsSync,
						}),
					deliver: (report) => outbox.push(report),
					notify,
					trust: { storedDecision: (cwd) => trustStore.get(cwd), requiresTrust: hasTrustRequiringProjectResources },
					selfDir: SELF_DIR,
					now: Date.now,
				},
			);
		},
	});
}
