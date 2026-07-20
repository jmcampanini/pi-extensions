import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { extractBlocks } from "./extract.ts";
import type { Block } from "./types.ts";

type ToolResultEntry = SessionMessageEntry & { message: ToolResultMessage };

function isToolResult(entry: SessionEntry): entry is ToolResultEntry {
	return entry.type === "message" && entry.message.role === "toolResult";
}

function toolCallIds(entry: SessionEntry): string[] {
	if (entry.type !== "message" || entry.message.role !== "assistant") return [];
	return entry.message.content
		.filter((part) => part.type === "toolCall")
		.map((part) => part.id);
}

/**
 * Keeps the active branch projection fresh. Ordinary appends only extract the
 * new suffix; a result appended after its call re-extracts that one correlated
 * tool block. Re-branching and label mutations rebuild the projection.
 */
export class BranchBlockIndex {
	private entries: readonly SessionEntry[] = [];
	private entryIds: string[] = [];
	private blocks: Block[] = [];

	update(sessionManager: { getBranch(): SessionEntry[]; getLabel(entryId: string): string | undefined }): readonly Block[] {
		return this.updateEntries(sessionManager.getBranch(), (id) => sessionManager.getLabel(id));
	}

	updateEntries(entries: readonly SessionEntry[], getLabel?: (entryId: string) => string | undefined): readonly Block[] {
		const ids = entries.map((entry) => entry.id);
		if (ids.length === this.entryIds.length && ids.every((id, index) => id === this.entryIds[index])) {
			return this.blocks;
		}

		const isAppend = this.entryIds.length > 0
			&& this.entryIds.length < ids.length
			&& this.entryIds.every((id, index) => ids[index] === id);
		if (!isAppend) return this.rebuild(entries, getLabel);

		const appended = entries.slice(this.entries.length);
		if (appended.some((entry) => entry.type === "label")) return this.rebuild(entries, getLabel);

		const oldCallEntries = new Map<string, SessionEntry>();
		for (const entry of this.entries) {
			for (const callId of toolCallIds(entry)) oldCallEntries.set(callId, entry);
		}

		const delayedResults = appended.filter((entry) => isToolResult(entry) && oldCallEntries.has(entry.message.toolCallId));
		const delayedIds = new Set(delayedResults.map((entry) => entry.id));
		const additions = extractBlocks(appended.filter((entry) => !delayedIds.has(entry.id)), getLabel);
		const replacements: Block[] = [];

		for (const result of delayedResults) {
			if (!isToolResult(result)) continue;
			const callEntry = oldCallEntries.get(result.message.toolCallId);
			if (!callEntry) continue;
			const relatedResults = entries.filter(
				(entry) => isToolResult(entry) && entry.message.toolCallId === result.message.toolCallId,
			);
			for (const block of extractBlocks([callEntry, ...relatedResults], getLabel)) {
				if (block.toolCallId === result.message.toolCallId) replacements.push(block);
			}
		}

		const replacementsById = new Map(replacements.map((block) => [block.id, block]));
		const existingIds = new Set(this.blocks.map((block) => block.id));
		this.blocks = this.blocks.map((block) => replacementsById.get(block.id) ?? block);
		for (const block of additions) {
			if (!existingIds.has(block.id)) {
				this.blocks.push(block);
				existingIds.add(block.id);
			}
		}
		this.entries = entries.slice();
		this.entryIds = ids;
		return this.blocks;
	}

	private rebuild(entries: readonly SessionEntry[], getLabel?: (entryId: string) => string | undefined): readonly Block[] {
		this.entries = entries.slice();
		this.entryIds = entries.map((entry) => entry.id);
		this.blocks = extractBlocks(entries, getLabel);
		return this.blocks;
	}
}
