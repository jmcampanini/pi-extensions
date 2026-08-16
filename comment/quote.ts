import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export function getLastAssistantText(branch: SessionEntry[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") {
			continue;
		}
		const message = entry.message;
		if (message.role !== "assistant") {
			continue;
		}
		// Custom messages may reuse the assistant role; only real assistant
		// messages carry a stopReason and content parts.
		if (!("stopReason" in message) || !Array.isArray(message.content)) {
			continue;
		}
		// Deliberate: when the newest assistant message did not complete
		// (aborted, errored), refuse instead of quoting an older message.
		if (message.stopReason !== "stop") {
			return undefined;
		}
		const text = message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		return text || undefined;
	}
	return undefined;
}

export function formatQuotedEditorText(text: string): string {
	return text
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
}
