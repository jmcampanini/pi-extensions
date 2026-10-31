import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildForkEntries, type ForkSource } from "./fork.ts";
import { startChild } from "./launch.ts";
import { describeModel, formatModelMatchError, matchModel } from "./models.ts";
import { type ChildRecord, newChildId, SubagentRegistry } from "./registry.ts";
import { deriveTitle, formatCompletionMessage, truncateResult } from "./result.ts";
import { readSubagentSettings } from "./settings.ts";
import { installSubagentUi, type SubagentToolDetails, subagentToolRenderers } from "./ui.ts";
import { createWorktree, slugify } from "./worktree.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const SELF_DIR = dirname(fileURLToPath(import.meta.url));

const DESCRIPTION = `Delegate a task to a subagent: a separate Pi agent session with its own context window, running in this process with the same tools, skills, and project instructions.

Modes: "background" (default) returns at once and the result arrives later as a user message that starts with "Subagent \\"<title>\\" completed"; keep working or end your turn, never poll. "foreground" blocks until the child finishes and returns its report here.
Context: "fresh" (default) gives the child only your task text, so write a self-contained brief with every path, constraint, and acceptance criterion. "fork" copies this conversation into the child first, so the brief can refer to what was discussed.
Location: "cwd" runs the child in another directory. "isolation": "worktree" creates a new git worktree and branch (pi/<slug>) from "from" (default HEAD) of the repo containing cwd and runs the child there; the worktree is left for you to inspect or clean up.
Model: "model" accepts provider/id, an id, or a unique substring such as "opus", "sonnet", "luna"; "effort" is the thinking level. Both default to this session's.`;

export default function subagentExtension(pi: ExtensionAPI) {
	const registry = new SubagentRegistry();
	let parentCtx: ExtensionContext | undefined;

	pi.on("session_start", (_event, ctx) => {
		parentCtx = ctx;
	});
	pi.on("session_shutdown", () => {
		registry.abortAll();
	});
	installSubagentUi(pi, registry);

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: DESCRIPTION,
		promptSnippet: "subagent: delegate a task to a separate agent session (background by default, optional worktree, fork, model, effort)",
		promptGuidelines: [
			"Delegate self-contained work with the subagent tool; a fresh child cannot see this conversation, so put every path, constraint, and acceptance criterion in the task.",
			"A background subagent reports back as a user message; do not poll or wait for it, continue with other work or end your turn.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "The complete brief for the child. Its first and only user message." }),
			title: Type.Optional(Type.String({ description: "Short label shown in the UI and used for the worktree name. Defaults to the first line of task." })),
			mode: Type.Optional(StringEnum(["background", "foreground"] as const, { description: "background (default): return now, result arrives later as a user message. foreground: wait and return the result here." })),
			context: Type.Optional(StringEnum(["fresh", "fork"] as const, { description: "fresh (default): child starts with only the task. fork: child starts with this conversation so far." })),
			cwd: Type.Optional(Type.String({ description: "Directory the child runs in. Defaults to the current working directory." })),
			isolation: Type.Optional(StringEnum(["none", "worktree"] as const, { description: "none (default): run in cwd. worktree: create a git worktree and branch from `from` and run there." })),
			from: Type.Optional(Type.String({ description: "Git ref the worktree branch starts from. Default HEAD. Only with isolation worktree." })),
			model: Type.Optional(Type.String({ description: "Model for the child: provider/id, id, or a unique substring. Defaults to this session's model." })),
			effort: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Thinking level for the child. Defaults to this session's level." })),
		}),
		...subagentToolRenderers,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			parentCtx = ctx;
			const settings = readSubagentSettings(pi.getSettings() as Record<string, unknown>);
			const mode = params.mode ?? "background";
			const context = params.context ?? "fresh";
			const title = deriveTitle(params.task, params.title);
			const id = newChildId();

			const model = params.model ? resolveModel(params.model, ctx) : ctx.model;
			if (!model) throw new Error("No model is selected in this session and none was given.");
			const effort: ThinkingLevel = params.effort ?? ctx.thinkingLevel ?? "medium";

			let cwd = resolveDirectory(params.cwd, ctx.cwd);
			let worktree: { path: string; branch: string } | undefined;
			if (params.isolation === "worktree") {
				const created = await createWorktree({
					exec: (command, args, options) => pi.exec(command, args, options),
					cwd,
					slug: slugify(title),
					from: params.from ?? "HEAD",
					template: settings.worktreePath,
					env: process.env,
					home: homedir(),
					exists: existsSync,
				});
				worktree = { path: created.path, branch: created.branch };
				cwd = created.path;
			}

			const forkSource: ForkSource = {
				header: ctx.sessionManager.getHeader(),
				branch: ctx.sessionManager.getBranch(),
				parentSessionFile: ctx.sessionManager.getSessionFile(),
			};
			const handle = await startChild({
				cwd,
				task: params.task,
				model,
				thinkingLevel: effort,
				parentSessionFile: forkSource.parentSessionFile,
				...(context === "fork" ? { forkEntries: (childSessionId: string) => buildForkEntries({ source: forkSource, toolCallId, childSessionId, childCwd: cwd, now: new Date() }) } : {}),
				selfDir: SELF_DIR,
				onProgress: (line) => {
					registry.addProgress(id, line);
					if (mode === "foreground") onUpdate?.({ content: [{ type: "text", text: registry.get(id)?.progress.join("\n") ?? line }], details: detailsFor(registry.get(id)) });
				},
			});

			const record: ChildRecord = {
				id,
				title,
				task: params.task,
				mode,
				context,
				cwd,
				model: describeModel(model),
				effort,
				startedAt: Date.now(),
				status: "running",
				progress: [],
				abort: handle.abort,
				...(handle.sessionFile ? { sessionFile: handle.sessionFile } : {}),
				...(worktree ? { worktree } : {}),
			};
			registry.add(record);

			const settle = handle.done.then((outcome) => {
				const { text, truncated } = truncateResult(outcome.text, { maxChars: settings.resultMaxChars, maxLines: settings.resultMaxLines });
				const finished = registry.update(id, { status: outcome.status, finishedAt: Date.now(), result: text, ...(outcome.error ? { error: outcome.error } : {}) }) ?? record;
				return { outcome, text, truncated, finished };
			});

			if (mode === "background") {
				void settle.then(({ outcome, text, truncated, finished }) => {
					const message = formatCompletionMessage({
						id,
						title,
						status: outcome.status,
						model: finished.model,
						cwd,
						durationMs: outcome.durationMs,
						result: text,
						truncated,
						...(outcome.error ? { error: outcome.error } : {}),
						...(finished.sessionFile ? { sessionFile: finished.sessionFile } : {}),
						...(worktree ? { worktree } : {}),
					});
					const busy = parentCtx ? !parentCtx.isIdle() : false;
					pi.sendUserMessage(message, busy ? { deliverAs: "steer" } : undefined);
				});
				return {
					content: [{ type: "text", text: backgroundStartedText(record) }],
					details: detailsFor(record),
				};
			}

			signal?.addEventListener("abort", handle.abort, { once: true });
			const { outcome, text, truncated, finished } = await settle;
			const report = [text.length > 0 ? text : "(the subagent produced no final text)"];
			if (outcome.error) report.unshift(`Subagent ${outcome.status}: ${outcome.error}`);
			if (truncated) report.push(`\n[Result truncated. Full transcript: ${finished.sessionFile ?? "(not persisted)"}]`);
			if (worktree) report.push(`\nWorktree ${worktree.path} on branch ${worktree.branch} was left in place.`);
			return {
				content: [{ type: "text", text: report.join("\n") }],
				details: detailsFor(finished),
				usage: outcome.usage,
				...(outcome.status === "completed" ? {} : { isError: true }),
			};
		},
	});
}

function resolveModel(reference: string, ctx: ExtensionContext) {
	const scoped = ctx.scopedModels.map((entry) => entry.model);
	const match = matchModel(reference, scoped, ctx.modelRegistry.getAvailable());
	if (match.status !== "resolved") throw new Error(formatModelMatchError(reference, match));
	return match.model;
}

function resolveDirectory(requested: string | undefined, base: string): string {
	if (!requested) return base;
	const expanded = requested === "~" || requested.startsWith("~/") ? homedir() + requested.slice(1) : requested;
	const path = resolve(base, expanded);
	if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`cwd is not an existing directory: ${path}`);
	return path;
}

function backgroundStartedText(record: ChildRecord): string {
	const where = record.worktree ? `worktree ${record.worktree.path} on branch ${record.worktree.branch}` : record.cwd;
	return `Started subagent "${record.title}" (id ${record.id}) in the background with ${record.model} at effort ${record.effort}, working in ${where}. Its report will arrive as a user message beginning "Subagent \\"${record.title}\\"". Do not wait or poll for it.`;
}

function detailsFor(record: ChildRecord | undefined): SubagentToolDetails | undefined {
	if (!record) return undefined;
	return {
		id: record.id,
		title: record.title,
		mode: record.mode,
		context: record.context,
		status: record.status,
		model: record.model,
		effort: record.effort,
		cwd: record.cwd,
		progress: record.progress,
		...(record.worktree ? { worktree: record.worktree } : {}),
		...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
		...(record.finishedAt !== undefined ? { durationMs: record.finishedAt - record.startedAt } : {}),
		...(record.error ? { error: record.error } : {}),
	};
}
