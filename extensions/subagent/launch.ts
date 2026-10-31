import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, Usage } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	DefaultResourceLoader,
	type Extension,
	type FileEntry,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

export interface ChildOutcome {
	status: "completed" | "failed" | "cancelled";
	text: string;
	error?: string;
	usage: Usage;
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
	parentSessionFile: string | undefined;
	/** Present for fork mode: the complete child session file, header first. */
	forkEntries?: (childSessionId: string) => FileEntry[];
	/** Directory of this extension, so the child does not load it and cannot start grandchildren. */
	selfDir: string;
	onProgress?: (line: string) => void;
}

const CHILD_NOTE =
	"You are a subagent: a separate Pi session started by a parent agent to carry out one task. " +
	"Work only on that task. Your last message is the report the parent receives, so end with a clear, " +
	"self-contained summary of what you did, what you found, and anything the parent must still decide. " +
	"You cannot ask the parent or the user questions; make reasonable assumptions and state them.";

/** Starts a child Pi session in this process and runs the task to completion. */
export async function startChild(input: StartChildInput): Promise<ChildHandle> {
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(input.cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd: input.cwd,
		agentDir,
		settingsManager,
		extensionFactories: [createCodemodeExtension({ mode: "on" }), createToolSearchExtension(), createMcpExtension()],
		extensionsOverride: (base) => ({ ...base, extensions: base.extensions.filter((ext) => !isThisExtension(ext, input.selfDir)) }),
		appendSystemPromptOverride: (base) => [...base, CHILD_NOTE],
	});
	await resourceLoader.reload();

	const sessionManager = input.forkEntries ? forkedSessionManager(input.cwd, input.parentSessionFile, input.forkEntries) : SessionManager.create(input.cwd, undefined, parentOptions(input.parentSessionFile));
	const { session } = await createAgentSession({
		cwd: input.cwd,
		agentDir,
		model: input.model,
		thinkingLevel: input.thinkingLevel,
		resourceLoader,
		settingsManager,
		sessionManager,
		// codemode registers inactive; a "+name" modifier adds it to the child's default loadout.
		tools: ["+codemode"],
	});
	await session.bindExtensions({ mode: "print" });

	let aborted = false;
	const startedAt = Date.now();
	const unsubscribe = session.subscribe((event) => reportProgress(event, input.onProgress));
	const done = session
		.prompt(input.task, { expandPromptTemplates: false })
		.then(() => finish(session, aborted ? "cancelled" : "completed", undefined, startedAt))
		.catch((error: unknown) => finish(session, aborted ? "cancelled" : "failed", errorMessage(error), startedAt))
		.finally(() => {
			unsubscribe();
			session.dispose();
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

function finish(session: AgentSession, status: ChildOutcome["status"], error: string | undefined, startedAt: number): ChildOutcome {
	const stats = session.getSessionStats();
	const failure = status === "completed" ? providerFailure(session) : undefined;
	if (failure) {
		status = failure.status;
		error = failure.error;
	}
	const outcome: ChildOutcome = {
		status,
		text: session.getLastAssistantText() ?? "",
		usage: {
			input: stats.tokens.input,
			output: stats.tokens.output,
			cacheRead: stats.tokens.cacheRead,
			cacheWrite: stats.tokens.cacheWrite,
			totalTokens: stats.tokens.total,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: stats.cost },
		},
		durationMs: Date.now() - startedAt,
	};
	if (error !== undefined) outcome.error = error;
	return outcome;
}

/**
 * Pi resolves prompt() even when the provider request failed or was aborted; the outcome is recorded
 * on the last assistant message instead, so read it from there.
 */
function providerFailure(session: AgentSession): { status: "failed" | "cancelled"; error: string } | undefined {
	for (let i = session.messages.length - 1; i >= 0; i--) {
		const message = session.messages[i];
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "error") return { status: "failed", error: message.errorMessage ?? "the model request failed" };
		if (message.stopReason === "aborted") return { status: "cancelled", error: "the subagent was aborted" };
		return undefined;
	}
	return undefined;
}

function parentOptions(parentSessionFile: string | undefined): { parentSession?: string } {
	return parentSessionFile ? { parentSession: parentSessionFile } : {};
}

/**
 * Writes the fork entries as the child's session file and opens it, so the child is persisted and
 * resumable like any other session. SessionManager.create picks the file location and id for us.
 */
function forkedSessionManager(cwd: string, parentSessionFile: string | undefined, forkEntries: (childSessionId: string) => FileEntry[]): SessionManager {
	const placeholder = SessionManager.create(cwd, undefined, parentOptions(parentSessionFile));
	const file = placeholder.getSessionFile();
	if (!file) throw new Error("fork needs a persisted session file, but Pi did not create one");

	mkdirSync(dirname(file), { recursive: true });
	const lines = forkEntries(placeholder.getSessionId()).map((entry) => JSON.stringify(entry));
	writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
	return SessionManager.open(file, undefined, cwd);
}

function isThisExtension(extension: Extension, selfDir: string): boolean {
	const resolved = resolve(extension.resolvedPath);
	return resolved === selfDir || resolved.startsWith(`${selfDir}/`);
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

function summarizeArgs(args: unknown): string {
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
