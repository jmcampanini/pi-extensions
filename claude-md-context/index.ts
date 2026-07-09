import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BuildSystemPromptOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ClaudeMemoryLoadState =
	| { status: "missing"; path: string }
	| { status: "empty"; path: string; realPath: string }
	| { status: "loaded"; path: string; realPath: string; content: string }
	| { status: "error"; path: string; message: string };

type ContextFile = NonNullable<BuildSystemPromptOptions["contextFiles"]>[number];

const DEFAULT_CLAUDE_MEMORY_PATH = path.join(os.homedir(), ".claude", "CLAUDE.md");
const CLAUDE_MEMORY_TAG = "<claude_code_user_memory ";

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function escapeXmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function realPath(filePath: string): string | undefined {
	try {
		return fs.realpathSync(filePath);
	} catch {
		return undefined;
	}
}

function loadClaudeMemory(filePath = DEFAULT_CLAUDE_MEMORY_PATH): ClaudeMemoryLoadState {
	if (!fs.existsSync(filePath)) {
		return { status: "missing", path: filePath };
	}

	const resolvedPath = realPath(filePath) ?? filePath;

	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile()) {
			return { status: "error", path: filePath, message: "expected a file" };
		}

		const content = fs.readFileSync(filePath, "utf-8");
		if (!content.trim()) {
			return { status: "empty", path: filePath, realPath: resolvedPath };
		}

		return { status: "loaded", path: filePath, realPath: resolvedPath, content };
	} catch (error) {
		return { status: "error", path: filePath, message: formatError(error) };
	}
}

function contextFilesIncludeClaudeMemory(contextFiles: ContextFile[] | undefined, state: ClaudeMemoryLoadState): boolean {
	if (state.status !== "loaded" && state.status !== "empty") return false;
	if (!contextFiles) return false;

	return contextFiles.some((contextFile) => {
		if (contextFile.path === state.path || contextFile.path === state.realPath) return true;
		return realPath(contextFile.path) === state.realPath;
	});
}

function formatClaudeMemorySection(state: Extract<ClaudeMemoryLoadState, { status: "loaded" }>): string {
	const displayPath = escapeXmlAttribute(state.path);

	return `

## Claude Code User Memory

The following user-level Claude Code memory file was loaded from ${state.path}. Treat it as user-specific instructions and preferences.

<claude_code_user_memory path="${displayPath}">
${state.content}
</claude_code_user_memory>`;
}

export default function claudeMdContext(pi: ExtensionAPI): void {
	let memoryState: ClaudeMemoryLoadState | undefined;

	pi.on("session_start", (_event, ctx) => {
		memoryState = loadClaudeMemory();

		if (memoryState.status !== "error") return;
		if (!ctx.hasUI) return;

		ctx.ui.notify(`claude-md-context: could not load ${memoryState.path}: ${memoryState.message}`, "warning");
	});

	pi.on("before_agent_start", (event) => {
		memoryState ??= loadClaudeMemory();
		if (memoryState.status !== "loaded") return;
		if (event.systemPrompt.includes(CLAUDE_MEMORY_TAG)) return;
		if (contextFilesIncludeClaudeMemory(event.systemPromptOptions.contextFiles, memoryState)) return;

		return {
			systemPrompt: event.systemPrompt + formatClaudeMemorySection(memoryState),
		};
	});
}
