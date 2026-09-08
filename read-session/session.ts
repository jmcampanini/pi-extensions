import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface ReaderMessage {
	kind: "message";
	role: "user" | "assistant";
	text: string;
	status?: "error" | "aborted";
}

export interface ReaderTool {
	name: string;
	argument?: string;
	status: "returned" | "failed" | "pending";
}

export interface ReaderActivity {
	kind: "activity";
	calls: ReaderTool[];
}

export interface ReaderFailure {
	kind: "failure";
	status: "error" | "aborted";
	details?: string;
}

export type ReaderBlock = ReaderMessage | ReaderActivity | ReaderFailure;

export interface ReaderSnapshot {
	title: string;
	cwd: string;
	blocks: ReaderBlock[];
	messageCount: number;
}

export function selectMessages(entries: readonly SessionEntry[]): Omit<ReaderSnapshot, "title" | "cwd"> {
	const results = new Map<string, boolean>();
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "toolResult") {
			results.set(entry.message.toolCallId, entry.message.isError);
		}
	}

	const blocks: ReaderBlock[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.flatMap((part) =>
							part.type === "text" ? [part.text] : part.type === "image" ? ["[Image attachment]"] : [],
						)
						.join("\n\n");
		const status =
			message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")
				? message.stopReason
				: undefined;
		if (text.trim()) {
			blocks.push({ kind: "message", role: message.role, text, status });
		}

		if (message.role !== "assistant") continue;
		const calls = message.content.flatMap((part): ReaderTool[] => {
			if (part.type !== "toolCall") return [];
			return [
				{
					name: part.name,
					argument: describeArgument(part.arguments),
					status: !results.has(part.id) ? "pending" : results.get(part.id) ? "failed" : "returned",
				},
			];
		});
		if (calls.length > 0) {
			const previous = blocks.at(-1);
			if (previous?.kind === "activity") previous.calls.push(...calls);
			else blocks.push({ kind: "activity", calls });
		}
		if (!text.trim() && status) blocks.push({ kind: "failure", status, details: message.errorMessage });
	}

	return {
		blocks,
		messageCount: blocks.filter((block) => block.kind === "message").length,
	};
}

function describeArgument(args: Record<string, unknown>): string | undefined {
	for (const key of ["path", "file_path", "file", "command", "pattern", "query", "url", "agent"]) {
		const value = args[key];
		if (typeof value !== "string" || !value.trim()) continue;
		const compact = value.replace(/\s+/g, " ").trim();
		return compact.length > 180 ? `${compact.slice(0, 179)}…` : compact;
	}
	return undefined;
}
