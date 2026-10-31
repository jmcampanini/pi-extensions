import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { type FileEntry, type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

export interface ForkSource {
	parentSessionFile: string | undefined;
	leafId: string | null;
	branch: SessionEntry[];
}

export interface ForkInput {
	source: ForkSource;
	/** The parent's `subagent` call that is creating this child. */
	toolCallId: string;
	childCwd: string;
	now: Date;
}

const FORK_NOTICE =
	"This call created you: you are a forked subagent with the parent's conversation up to this point. " +
	"The task follows as the next user message. Work in {cwd}. Your final message is the report the parent receives.";

const SIBLING_NOTICE = "Not executed in this fork; the parent conversation handles this call.";

/**
 * A session manager for a child that continues the parent's current branch. Pi copies the branch
 * into a new session file and assigns ids and parent links. A parent without a session file gets an
 * in-memory copy. Every tool call of the delegating message that has no result yet gets one, so the
 * transcript stays valid for providers: the delegating call's result tells the child what it is.
 */
export function forkSessionManager(input: ForkInput): SessionManager {
	const manager = copyBranch(input.source, input.childCwd);
	for (const call of pendingToolCalls(input.source.branch)) manager.appendMessage(forkToolResult(call, input));
	return manager;
}

function copyBranch(source: ForkSource, childCwd: string): SessionManager {
	if (!source.parentSessionFile) return SessionManager.inMemory(childCwd, undefined, source.branch as FileEntry[]);
	if (!source.leafId) return SessionManager.create(childCwd, undefined, { parentSession: source.parentSessionFile });

	const manager = SessionManager.open(source.parentSessionFile, undefined, childCwd);
	manager.createBranchedSession(source.leafId);
	return manager;
}

export interface PendingCall {
	id: string;
	name: string;
}

/** Tool calls in the branch's last assistant message that have no result yet. */
export function pendingToolCalls(branch: readonly SessionEntry[]): PendingCall[] {
	const answered = new Set<string>();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!;
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "toolResult" && message.toolCallId) {
			answered.add(message.toolCallId);
			continue;
		}
		if (message.role !== "assistant") continue;

		const content = Array.isArray(message.content) ? message.content : [];
		return content
			.filter((block): block is ToolCall => block.type === "toolCall")
			.filter((block) => block.id && block.name && !answered.has(block.id))
			.map((block) => ({ id: block.id, name: block.name }));
	}
	return [];
}

function forkToolResult(call: PendingCall, input: Pick<ForkInput, "toolCallId" | "childCwd" | "now">): ToolResultMessage {
	const text = call.id === input.toolCallId ? FORK_NOTICE.replace("{cwd}", input.childCwd) : SIBLING_NOTICE;
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: input.now.getTime(),
	};
}
