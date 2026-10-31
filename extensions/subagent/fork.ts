import type { ToolCall } from "@earendil-works/pi-ai";
import type { FileEntry, SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";

export interface ForkSource {
	header: SessionHeader | null;
	branch: SessionEntry[];
	parentSessionFile: string | undefined;
}

export interface ForkInput {
	source: ForkSource;
	toolCallId: string;
	childSessionId: string;
	childCwd: string;
	now: Date;
}

const FORK_NOTICE =
	"This call created you: you are a forked subagent with the parent's conversation up to this point. " +
	"The task follows as the next user message. Work in {cwd}. Your final message is the report the parent receives.";

const SIBLING_NOTICE = "Not executed in this fork; the parent conversation handles this call.";

/**
 * Builds the child session file for fork mode: the parent's active branch, then a tool result for
 * every call in the delegating assistant message so the transcript stays valid for providers.
 * The delegating call's result tells the child what it is; sibling calls are marked as the parent's.
 */
export function buildForkEntries(input: ForkInput): FileEntry[] {
	const { source, toolCallId, childCwd } = input;
	const header: SessionHeader = {
		type: "session",
		version: source.header?.version ?? 3,
		id: input.childSessionId,
		timestamp: input.now.toISOString(),
		cwd: childCwd,
		...(source.parentSessionFile ? { parentSession: source.parentSessionFile } : {}),
	};

	const entries: SessionEntry[] = [...source.branch];
	const pending = pendingToolCalls(entries);
	let leafId = entries.length > 0 ? entries[entries.length - 1]!.id : null;
	for (const [index, call] of pending.entries()) {
		const id = `fork${index.toString(16).padStart(4, "0")}`;
		const text = call.id === toolCallId ? FORK_NOTICE.replace("{cwd}", childCwd) : SIBLING_NOTICE;
		entries.push({
			type: "message",
			id,
			parentId: leafId,
			timestamp: input.now.toISOString(),
			message: {
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text }],
				isError: false,
				timestamp: input.now.getTime(),
			},
		});
		leafId = id;
	}

	return [header, ...entries];
}

interface PendingCall {
	id: string;
	name: string;
}

/** Tool calls in the last assistant message that have no result yet on the branch. */
function pendingToolCalls(entries: SessionEntry[]): PendingCall[] {
	const answered = new Set<string>();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
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
