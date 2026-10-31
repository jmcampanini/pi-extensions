import { realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { CredentialStore, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	DefaultResourceLoader,
	type Extension,
	getAgentDir,
	type InlineExtension,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ChildStatus } from "./child.ts";
import type { ParentFlags } from "./environment.ts";
import { type ForkInput, forkSessionManager } from "./fork.ts";

export interface ChildOutcome {
	status: Exclude<ChildStatus, "running">;
	text: string;
	error?: string | undefined;
	durationMs: number;
}

export interface ChildHandle {
	sessionFile: string | undefined;
	done: Promise<ChildOutcome>;
	abort: () => void;
}

export interface StartChildInput {
	cwd: string;
	task: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** The tools the child declares to its model; normally the parent's active tools minus `subagent`. */
	tools: string[];
	projectTrusted: boolean;
	flags: ParentFlags;
	/** The parent's credential store, so the child resolves credentials exactly as the parent does. */
	credentials: CredentialStore | undefined;
	parentSessionFile: string | undefined;
	/** Present for fork mode. */
	fork?: Omit<ForkInput, "childCwd" | "now"> | undefined;
	/** Directory of this extension, so the child does not load it and cannot start grandchildren. */
	selfDir: string;
	onProgress?: ((line: string) => void) | undefined;
}

const CHILD_NOTE =
	"You are a subagent: a separate Pi session started by a parent agent to carry out one task. " +
	"Work only on that task. Your last message is the report the parent receives, so end with a clear, " +
	"self-contained summary of what you did, what you found, and anything the parent must still decide. " +
	"You cannot ask the parent or the user questions; make reasonable assumptions and state them.";

/** Starts a child Pi session in this process and runs the task to completion. */
export async function startChild(input: StartChildInput): Promise<ChildHandle> {
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(input.cwd, agentDir, { projectTrusted: input.projectTrusted });
	const resourceLoader = new DefaultResourceLoader({
		cwd: input.cwd,
		agentDir,
		settingsManager,
		additionalExtensionPaths: input.flags.extensions,
		noExtensions: input.flags.noExtensions,
		extensionFactories: builtinExtensions(),
		extensionsOverride: (base) => ({ ...base, extensions: base.extensions.filter((ext) => !isThisExtension(ext, input.selfDir)) }),
		appendSystemPromptOverride: (base) => [...base, CHILD_NOTE],
	});
	await resourceLoader.reload();

	// The child gets its own runtime, so provider and virtual-model registrations by its extensions
	// stay session-local, while credentials come from the parent's store.
	const modelRuntime = await ModelRuntime.create({ ...(input.credentials ? { credentials: input.credentials } : {}), authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });

	const sessionManager = input.fork ? forkSessionManager({ ...input.fork, childCwd: input.cwd, now: new Date() }) : SessionManager.create(input.cwd, undefined, input.parentSessionFile ? { parentSession: input.parentSessionFile } : {});
	const { session } = await createAgentSession({
		cwd: input.cwd,
		agentDir,
		modelRuntime,
		model: input.model,
		thinkingLevel: input.thinkingLevel,
		resourceLoader,
		settingsManager,
		sessionManager,
		tools: input.tools,
	});
	try {
		await session.bindExtensions({ mode: "print" });
	} catch (error) {
		await teardown(session);
		throw error;
	}

	let aborted = false;
	const startedAt = Date.now();
	const unsubscribe = session.subscribe((event) => {
		// Pi drops an abort that arrives while prompt() is still preparing the run; apply it again
		// once the run exists.
		if (event.type === "agent_start" && aborted) void session.abort();
		reportProgress(event, input.onProgress);
	});
	const done = session
		.prompt(input.task, { expandPromptTemplates: false })
		.then(() => childOutcome(session, aborted ? "cancelled" : "completed", undefined, Date.now() - startedAt))
		.catch((error: unknown) => childOutcome(session, aborted ? "cancelled" : "failed", errorMessage(error), Date.now() - startedAt))
		.finally(() => {
			unsubscribe();
			return teardown(session);
		});

	return {
		sessionFile: session.sessionFile,
		done,
		abort: () => {
			aborted = true;
			void session.abort();
		},
	};
}

/** The same built-ins the CLI loads, in the named form that `-builtin:<name>` and replacements respect. */
function builtinExtensions(): InlineExtension[] {
	return [
		{ name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true },
		{ name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true },
		{ name: "mcp", factory: createMcpExtension(), replaceable: true, builtin: true },
	];
}

/** dispose() alone skips session_shutdown, which is where the MCP extension closes its servers. */
async function teardown(session: AgentSession): Promise<void> {
	try {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	} finally {
		session.dispose();
	}
}

export interface OutcomeSource {
	messages: ReadonlyArray<{ role: string; stopReason?: string | undefined; errorMessage?: string | undefined }>;
	getLastAssistantText(): string | undefined;
}

/**
 * Pi resolves prompt() even when the provider request failed or was aborted; the outcome is recorded
 * on the last assistant message instead, so a completed run is checked there.
 */
export function childOutcome(source: OutcomeSource, status: ChildOutcome["status"], error: string | undefined, durationMs: number): ChildOutcome {
	const failure = status === "completed" ? providerFailure(source.messages) : undefined;
	return {
		status: failure?.status ?? status,
		error: failure?.error ?? error,
		text: source.getLastAssistantText() ?? "",
		durationMs,
	};
}

function providerFailure(messages: OutcomeSource["messages"]): { status: "failed" | "cancelled"; error: string } | undefined {
	const last = [...messages].reverse().find((message) => message.role === "assistant");
	if (last?.stopReason === "error") return { status: "failed", error: last.errorMessage ?? "the model request failed" };
	if (last?.stopReason === "aborted") return { status: "cancelled", error: "the subagent was aborted" };
	return undefined;
}

/** Matches by tool as well as by path, because a symlinked install resolves to a different path. */
function isThisExtension(extension: Extension, selfDir: string): boolean {
	if (extension.tools.has("subagent")) return true;
	const resolved = realpathOr(extension.resolvedPath);
	const self = realpathOr(selfDir);
	return resolved === self || resolved.startsWith(self + sep);
}

function realpathOr(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function reportProgress(event: AgentSessionEvent, onProgress: ((line: string) => void) | undefined): void {
	if (!onProgress) return;
	if (event.type === "tool_execution_start") {
		onProgress(`${event.toolName} ${summarizeArgs(event.args)}`.trim());
		return;
	}
	if (event.type === "message_end" && event.message.role === "assistant") {
		const text = event.message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text.trim())
			.join(" ")
			.trim();
		if (text.length > 0) onProgress(text.length > 160 ? `${text.slice(0, 157)}...` : text);
	}
}

export function summarizeArgs(args: unknown): string {
	if (typeof args !== "object" || args === null) return "";
	const record = args as Record<string, unknown>;
	const key = ["command", "path", "file_path", "pattern", "task", "query"].find((k) => typeof record[k] === "string");
	const value = key ? String(record[key]) : "";
	const firstLine = value.split("\n")[0] ?? "";
	return firstLine.length > 100 ? `${firstLine.slice(0, 97)}...` : firstLine;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
