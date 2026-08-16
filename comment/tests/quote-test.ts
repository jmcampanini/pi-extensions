import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { formatQuotedEditorText, getLastAssistantText } from "../quote.ts";

let nextId = 0;

function entry(type: string, fields: Record<string, unknown> = {}): SessionEntry {
	return {
		type,
		id: `e${nextId++}`,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		...fields,
	} as unknown as SessionEntry;
}

function messageEntry(message: unknown): SessionEntry {
	return entry("message", { message });
}

type Part = { type: string; text?: string; thinking?: string };

function assistant(stopReason: string, ...parts: Part[]): SessionEntry {
	return messageEntry({ role: "assistant", content: parts, stopReason });
}

function text(value: string): Part {
	return { type: "text", text: value };
}

const user = messageEntry({ role: "user", content: "question", timestamp: 0 });
const toolResult = messageEntry({ role: "toolResult", content: [], isError: false });

describe("getLastAssistantText", () => {
	it("returns the last completed assistant text", () => {
		assert.strictEqual(getLastAssistantText([user, assistant("stop", text("Answer"))]), "Answer");
	});

	it("joins text parts and drops thinking parts", () => {
		assert.strictEqual(
			getLastAssistantText([
				assistant("stop", text("first"), { type: "thinking", thinking: "hidden" }, text("second")),
			]),
			"first\nsecond",
		);
	});

	it("looks past later non-assistant entries", () => {
		assert.strictEqual(
			getLastAssistantText([
				assistant("stop", text("Answer")),
				user,
				toolResult,
				entry("label"),
			]),
			"Answer",
		);
	});

	it("refuses when the last assistant message did not complete", () => {
		assert.strictEqual(
			getLastAssistantText([assistant("stop", text("Old answer")), user, assistant("aborted", text("Partial"))]),
			undefined,
		);
	});

	it("returns undefined when no assistant message exists", () => {
		assert.strictEqual(getLastAssistantText([user, toolResult]), undefined);
	});

	it("returns undefined for an empty completed message", () => {
		assert.strictEqual(getLastAssistantText([assistant("stop", text("   "))]), undefined);
	});

	it("skips assistant-roled messages without an assistant shape", () => {
		assert.strictEqual(
			getLastAssistantText([
				assistant("stop", text("Real")),
				messageEntry({ role: "assistant", content: "synthetic custom message" }),
			]),
			"Real",
		);
	});
});

describe("formatQuotedEditorText", () => {
	it("quotes every line including empty ones", () => {
		assert.strictEqual(formatQuotedEditorText("first\n\nsecond"), "> first\n> \n> second");
	});
});
