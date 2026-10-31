import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Model, StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, AgentToolUpdateCallback, SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { ChildContext, ChildMode, ChildSummary, Worktree } from "./child.ts";
import { type ChildTrustInput, childToolNames, type ParentExtensionFlags, resolveChildTrust } from "./environment.ts";
import type { ChildHandle, StartChildInput } from "./launch.ts";
import { describeModel, formatModelMatchError, matchModel } from "./models.ts";
import { type ChildRecord, newChildId, type SubagentRegistry, summarize } from "./registry.ts";
import { backgroundStartedText, type CompletionSummary, deriveTitle, formatCompletionMessage, formatForegroundReport, truncateResult } from "./result.ts";
import type { SubagentSettings } from "./settings.ts";
import { slugify } from "./worktree.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const DEFAULT_MODE: ChildMode = "background";
export const DEFAULT_CONTEXT: ChildContext = "fresh";

export const subagentParams = Type.Object({
	task: Type.String({ description: "The complete brief for the child. Its first and only user message." }),
	title: Type.Optional(Type.String({ description: "Short label shown in the UI and used for the worktree name. Defaults to the first line of task." })),
	mode: Type.Optional(StringEnum(["background", "foreground"] as const, { description: "background (default): return now, result arrives later as a user message. foreground: wait and return the result here." })),
	context: Type.Optional(StringEnum(["fresh", "fork"] as const, { description: "fresh (default): child starts with only the task. fork: child starts with this conversation so far." })),
	cwd: Type.Optional(Type.String({ description: "Directory the child runs in. Defaults to the current working directory." })),
	isolation: Type.Optional(StringEnum(["none", "worktree"] as const, { description: "none (default): run in cwd. worktree: create a git worktree and branch from `from` and run there." })),
	from: Type.Optional(Type.String({ description: "Git ref the worktree branch starts from. Default HEAD. Only with isolation worktree." })),
	model: Type.Optional(Type.String({ description: "Model for the child: provider/id, id, or a unique substring. Defaults to this session's model." })),
	effort: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Thinking level for the child. Defaults to this session's level." })),
});

export type SubagentParams = Static<typeof subagentParams>;

/** Details every `subagent` tool result carries; Pi writes them to the parent's session file. */
export interface SubagentToolDetails extends ChildSummary {
	durationMs?: number | undefined;
	progress?: string[] | undefined;
}

/** What the parent session looks like at the moment of the call. */
export interface ParentSession {
	cwd: string;
	model: Model<any> | undefined;
	thinkingLevel: ThinkingLevel | undefined;
	scopedModels: Model<any>[];
	availableModels: Model<any>[];
	activeTools: string[];
	projectTrusted: boolean;
	sessionFile: string | undefined;
	leafId: string | null;
	branch: SessionEntry[];
}

export interface WorktreeRequest {
	cwd: string;
	slug: string;
	from: string;
}

export interface RunDeps {
	settings: SubagentSettings;
	extensions: ParentExtensionFlags;
	registry: SubagentRegistry;
	startChild: (input: StartChildInput) => Promise<ChildHandle>;
	createWorktree: (request: WorktreeRequest) => Promise<Worktree>;
	/** Queues a background report for the parent. */
	deliver: (report: string) => void;
	/** Tells the user something a report cannot carry, such as a delivery failure. */
	notify: (message: string) => void;
	trust: Pick<ChildTrustInput, "storedDecision" | "requiresTrust">;
	selfDir: string;
	now: () => number;
}

export interface RunInput {
	params: SubagentParams;
	toolCallId: string;
	signal: AbortSignal | undefined;
	onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined;
	parent: ParentSession;
}

/** One `subagent` tool call: resolve, launch, register, and either return at once or wait. */
export async function runSubagent(input: RunInput, deps: RunDeps): Promise<AgentToolResult<SubagentToolDetails>> {
	const { params, parent } = input;
	const mode = params.mode ?? DEFAULT_MODE;
	const context = params.context ?? DEFAULT_CONTEXT;
	const title = deriveTitle(params.task, params.title);
	const id = newChildId();
	const model = params.model ? resolveModel(params.model, parent) : parent.model;
	if (!model) throw new Error("No model is selected in this session and none was given.");
	const effort: ThinkingLevel = params.effort ?? parent.thinkingLevel ?? "medium";

	// Startup can take a while (worktree creation, extension loading), so cancellation is watched
	// from the start. Background children outlive the turn, so they stop listening once running.
	const cancellation = watchCancellation(input.signal);
	try {
		let cwd = resolveDirectory(params.cwd, parent.cwd);
		let worktree: Worktree | undefined;
		if (params.isolation === "worktree") {
			worktree = await deps.createWorktree({ cwd, slug: slugify(title), from: params.from ?? "HEAD" });
			cwd = worktree.path;
		}
		if (cancellation.requested) throw new Error(worktree ? `cancelled before the subagent started; worktree ${worktree.path} on branch ${worktree.branch} was left in place` : "cancelled before the subagent started");

		const handle = await deps.startChild({
			cwd,
			task: params.task,
			model,
			thinkingLevel: effort,
			tools: childToolNames(parent.activeTools),
			projectTrusted: resolveChildTrust({ childCwd: cwd, parentCwd: parent.cwd, parentTrusted: parent.projectTrusted, createdWorktree: worktree !== undefined, ...deps.trust }),
			extensions: deps.extensions,
			parentSessionFile: parent.sessionFile,
			fork: context === "fork" ? { source: { parentSessionFile: parent.sessionFile, leafId: parent.leafId, branch: parent.branch }, toolCallId: input.toolCallId } : undefined,
			selfDir: deps.selfDir,
			onProgress: (line) => {
				deps.registry.addProgress(id, line);
				const child = deps.registry.get(id);
				if (mode !== "foreground" || !child) return;
				input.onUpdate?.({ content: [{ type: "text", text: child.progress.join("\n") }], details: detailsFor(child) });
			},
		});
		cancellation.attach(handle.abort);

		const record: ChildRecord = {
			id,
			title,
			task: params.task,
			mode,
			context,
			cwd,
			model: describeModel(model),
			effort,
			startedAt: deps.now(),
			status: "running",
			progress: [],
			worktree,
			sessionFile: handle.sessionFile,
			abort: handle.abort,
		};
		deps.registry.add(record);

		const settled = handle.done.then((outcome): CompletionSummary => {
			const { text, truncated } = truncateResult(outcome.text, { maxChars: deps.settings.resultMaxChars, maxLines: deps.settings.resultMaxLines });
			const finished = deps.registry.update(id, { status: outcome.status, finishedAt: deps.now(), result: text, error: outcome.error }) ?? record;
			return { ...summarize(finished), durationMs: outcome.durationMs, result: text, truncated };
		});

		if (mode === "background") {
			settled
				.then((summary) => deps.deliver(formatCompletionMessage(summary)))
				.catch((error: unknown) => deps.notify(`Subagent "${title}" (id ${id}) could not report back: ${error instanceof Error ? error.message : String(error)}`));
			return { content: [{ type: "text", text: backgroundStartedText(record) }], details: detailsFor(record) };
		}

		const summary = await settled;
		return {
			content: [{ type: "text", text: formatForegroundReport(summary) }],
			details: detailsFor(deps.registry.get(id) ?? record),
			...(summary.status === "completed" ? {} : { isError: true }),
		};
	} finally {
		cancellation.dispose();
	}
}

function watchCancellation(signal: AbortSignal | undefined) {
	let requested = signal?.aborted ?? false;
	let abortChild: (() => void) | undefined;
	const onAbort = () => {
		requested = true;
		abortChild?.();
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	return {
		get requested() {
			return requested;
		},
		attach(abort: () => void) {
			abortChild = abort;
			if (requested) abort();
		},
		dispose() {
			signal?.removeEventListener("abort", onAbort);
		},
	};
}

function resolveModel(reference: string, parent: ParentSession): Model<any> {
	const match = matchModel(reference, parent.scopedModels, parent.availableModels);
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

export function detailsFor(record: ChildRecord): SubagentToolDetails {
	return {
		...summarize(record),
		progress: record.progress,
		durationMs: record.finishedAt !== undefined ? record.finishedAt - record.startedAt : undefined,
	};
}
