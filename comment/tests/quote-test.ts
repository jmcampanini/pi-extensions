import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { formatQuotedEditorText, getLastAssistantText } from "../quote.ts";

let pass = 0;
let fail = 0;

function eq(label: string, got: unknown, want: unknown): void {
	const actual = JSON.stringify(got);
	const expected = JSON.stringify(want);
	if (actual === expected) {
		pass++;
		console.log(`  ok  ${label}`);
	} else {
		fail++;
		console.log(`  FAIL ${label}: got ${actual}, want ${expected}`);
	}
}

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

eq(
	"returns the last completed assistant text",
	getLastAssistantText([user, assistant("stop", text("Answer"))]),
	"Answer",
);

eq(
	"joins text parts and drops thinking parts",
	getLastAssistantText([
		assistant("stop", text("first"), { type: "thinking", thinking: "hidden" }, text("second")),
	]),
	"first\nsecond",
);

eq(
	"looks past later non-assistant entries",
	getLastAssistantText([
		assistant("stop", text("Answer")),
		user,
		toolResult,
		entry("label"),
	]),
	"Answer",
);

eq(
	"refuses when the last assistant message did not complete",
	getLastAssistantText([assistant("stop", text("Old answer")), user, assistant("aborted", text("Partial"))]),
	undefined,
);

eq(
	"returns undefined when no assistant message exists",
	getLastAssistantText([user, toolResult]),
	undefined,
);

eq(
	"returns undefined for an empty completed message",
	getLastAssistantText([assistant("stop", text("   "))]),
	undefined,
);

eq(
	"skips assistant-roled messages without an assistant shape",
	getLastAssistantText([
		assistant("stop", text("Real")),
		messageEntry({ role: "assistant", content: "synthetic custom message" }),
	]),
	"Real",
);

eq(
	"quotes every line including empty ones",
	formatQuotedEditorText("first\n\nsecond"),
	"> first\n> \n> second",
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
