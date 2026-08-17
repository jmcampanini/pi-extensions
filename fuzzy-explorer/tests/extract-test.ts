import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	contentToText,
	extractBlocks,
	extractFileReferences,
	extractorRegistry,
	flattenArguments,
	formatTimestamp,
	formatToolArguments,
} from "../extract.ts";
import { stripSeparators } from "../search.ts";

let sequence = 0;
function base(id: string): { id: string; parentId: string | null; timestamp: string } {
	const timestamp = new Date(Date.UTC(2025, 0, 2, 3, 4, sequence++)).toISOString();
	return { id, parentId: null, timestamp };
}

function message(id: string, value: unknown): SessionEntry {
	return { type: "message", ...base(id), message: value } as unknown as SessionEntry;
}

function entry(id: string, value: Record<string, unknown>): SessionEntry {
	return { ...base(id), ...value } as unknown as SessionEntry;
}

const userImageData = "USER_BASE64_SHOULD_NOT_APPEAR";
const resultImageData = "RESULT_BASE64_SHOULD_NOT_APPEAR";
const argumentImageData = "ARGUMENT_BASE64_SHOULD_NOT_APPEAR";
const fullBody = `first stored line\n${"x".repeat(4_000)}\nlast stored line`;

const user = message("user0001", {
	role: "user",
	content: [
		{ type: "text", text: "Please inspect this image." },
		{ type: "image", data: userImageData, mimeType: "image/png" },
		{ type: "text", text: "The prompt continues." },
	],
	timestamp: 1,
});
const assistant = message("asst0001", {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "PRIVATE THINKING MUST STAY OUT" },
		{ type: "text", text: "First answer." },
		{
			type: "toolCall",
			id: "call-read",
			name: "read",
			arguments: {
				path: "@src/config.ts",
				offset: 42,
				options: { image: { type: "image", data: argumentImageData, mimeType: "image/png" } },
			},
		},
		{ type: "text", text: "Second answer." },
		{
			type: "toolCall",
			id: "call-write",
			name: "write",
			arguments: { path: "src/other.ts#L9", content: "complete argument content" },
		},
	],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "fixture",
	usage: {},
	stopReason: "toolUse",
	timestamp: 2,
});
const mergedResult = message("rslt0001", {
	role: "toolResult",
	toolCallId: "call-read",
	toolName: "read",
	content: [
		{ type: "text", text: fullBody },
		{ type: "image", data: resultImageData, mimeType: "image/jpeg" },
	],
	details: {
		secretPayload: "DETAIL SECRET MUST STAY OUT",
		truncation: {
			content: "TRUNCATION CONTENT MUST STAY OUT",
			truncated: true,
			truncatedBy: "lines",
			totalLines: 9_000,
			outputLines: 2_000,
			totalBytes: 90_000,
			outputBytes: 20_000,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines: 2_000,
			maxBytes: 50_000,
			privateMetadata: "PRIVATE TRUNCATION METADATA",
		},
		fullOutputPath: "/surviving/full-read-output.txt",
	},
	isError: false,
	timestamp: 3,
});
const orphanResult = message("orph0001", {
	role: "toolResult",
	toolCallId: "missing-call",
	toolName: "grep",
	content: [{ type: "text", text: "orphan output" }],
	details: { ignored: "ORPHAN DETAIL SECRET" },
	isError: true,
	timestamp: 4,
});
const bash = message("bash0001", {
	role: "bashExecution",
	command: "printf 'hello'",
	output: "complete bash output",
	exitCode: 7,
	cancelled: false,
	truncated: true,
	fullOutputPath: "/surviving/full-bash-output.txt",
	timestamp: 5,
});
const visibleCustomRole = message("cust0001", {
	role: "custom",
	customType: "visible-role",
	content: [{ type: "text", text: "displayable custom role" }],
	display: true,
	details: { hidden: "CUSTOM ROLE DETAIL SECRET" },
	timestamp: 6,
});
const hiddenCustomRole = message("cust0002", {
	role: "custom",
	customType: "hidden-role",
	content: "HIDDEN CUSTOM ROLE",
	display: false,
	timestamp: 7,
});
const visibleCustomEntry = entry("cmsg0001", {
	type: "custom_message",
	customType: "visible-entry",
	content: [
		{ type: "text", text: "displayable custom entry" },
		{ type: "image", data: "CUSTOM_ENTRY_BASE64", mimeType: "image/png" },
	],
	display: true,
	details: { hidden: "CUSTOM ENTRY DETAIL SECRET" },
});
const hiddenCustomEntry = entry("cmsg0002", {
	type: "custom_message",
	customType: "hidden-entry",
	content: "HIDDEN CUSTOM ENTRY",
	display: false,
});
const compaction = entry("comp0001", {
	type: "compaction",
	summary: "top-level compaction summary",
	firstKeptEntryId: "user0001",
	tokensBefore: 50_000,
	details: { hidden: "COMPACTION DETAIL SECRET" },
});
const branchSummary = entry("brch0001", {
	type: "branch_summary",
	fromId: "old-leaf",
	summary: "top-level branch summary",
	details: { hidden: "BRANCH DETAIL SECRET" },
});
const branchSummaryRole = message("brmsg001", {
	role: "branchSummary",
	summary: "message-role branch summary",
	fromId: "old-leaf",
	timestamp: 8,
});
const compactionSummaryRole = message("cpmsg001", {
	role: "compactionSummary",
	summary: "message-role compaction summary",
	tokensBefore: 10_000,
	timestamp: 9,
});

const excludedEntries = [
	entry("state001", { type: "custom", customType: "state", data: { secret: "CUSTOM STATE" } }),
	entry("model001", { type: "model_change", provider: "test", modelId: "hidden-model" }),
	entry("think001", { type: "thinking_level_change", thinkingLevel: "hidden-level" }),
	entry("info0001", { type: "session_info", name: "hidden-session-name" }),
];
const labels = [
	entry("label001", { type: "label", targetId: "rslt0001", label: "result checkpoint" }),
	entry("label002", { type: "label", targetId: "orph0001", label: "cleared checkpoint" }),
	entry("label003", { type: "label", targetId: "orph0001", label: undefined }),
];

const entries: SessionEntry[] = [
	user,
	assistant,
	mergedResult,
	orphanResult,
	bash,
	visibleCustomRole,
	hiddenCustomRole,
	visibleCustomEntry,
	hiddenCustomEntry,
	compaction,
	branchSummary,
	branchSummaryRole,
	compactionSummaryRole,
	...excludedEntries,
	...labels,
];

describe("extractBlocks", () => {
	const blocks = extractBlocks(entries, (id) => id === "user0001" ? "getter bookmark" : undefined);
	const byEntry = (id: string) => blocks.filter((block) => block.entryId === id);
	const readBlock = blocks.find((block) => block.toolCallId === "call-read");
	const writeBlock = blocks.find((block) => block.toolCallId === "call-write");
	const orphanBlock = blocks.find((block) => block.entryId === "orph0001");
	const bashBlock = blocks.find((block) => block.entryId === "bash0001");

	it("expected number of rows", () => {
		assert.strictEqual(blocks.length, 12);
	});

	it("block kinds", () => {
		assert.deepStrictEqual(blocks.map((block) => block.kind), [
			"user",
			"assistant",
			"tool",
			"tool",
			"tool",
			"bash",
			"custom",
			"custom",
			"summary",
			"summary",
			"summary",
			"summary",
		]);
	});

	it("assistant combines text and keeps part order", () => {
		assert.deepStrictEqual(byEntry("asst0001").map((block) => [block.kind, block.body]), [
			["assistant", "First answer.\nSecond answer."],
			["tool", `${fullBody}\n[image]`],
			["tool", ""],
		]);
	});

	it("assistant thinking is excluded", () => {
		assert.ok(!JSON.stringify(blocks).includes("PRIVATE THINKING"));
	});

	it("matched result folds into call entry ids", () => {
		assert.deepStrictEqual(readBlock?.entryIds, ["asst0001", "rslt0001"]);
	});

	it("matched result has no orphan row", () => {
		assert.strictEqual(byEntry("rslt0001").length, 0);
	});

	it("orphan result gets a tool row", () => {
		assert.deepStrictEqual([orphanBlock?.kind, orphanBlock?.body, orphanBlock?.isError],
			["tool", "orphan output", true]);
	});

	it("tool fields include role, type, name, id, args, paths, line, time, entries, and label", () => {
		assert.ok([
			"role:assistant",
			"type:tool",
			"tool:read",
			"toolCallId:call-read",
			"args:path=@src/config.ts",
			"path:src/config.ts",
			"line:42",
			"timestamp:2025-01-02 03:04:01Z",
			"entry:asst0001",
			"entry:rslt0001",
			"label:result checkpoint",
		].every((field) => readBlock?.fields.includes(field)));
	});

	it("file reference strips @ and uses read offset", () => {
		assert.deepStrictEqual(readBlock?.fileReference, { path: "src/config.ts", line: 42 });
	});

	it("tool call carries redacted structured arguments", () => {
		assert.deepStrictEqual(readBlock?.toolArguments, {
			path: "@src/config.ts",
			offset: 42,
			options: { image: "[image]" },
		});
	});

	it("tool search key is kind, tool, and argument subtitle", () => {
		assert.strictEqual(readBlock?.searchKey,
			"tool read path=@src/config.ts offset=42 options.image=[image]");
	});

	it("prose search keys fold duplicate titles", () => {
		assert.deepStrictEqual([
			byEntry("user0001")[0]?.searchKey,
			byEntry("asst0001")[0]?.searchKey,
		], ["user", "assistant"]);
	});

	it("bash search key carries the command subtitle", () => {
		assert.strictEqual(bashBlock?.searchKey, "bash printf 'hello'");
	});

	it("custom search key carries the custom type", () => {
		assert.strictEqual(byEntry("cust0001")[0]?.searchKey, "custom visible-role");
	});

	it("any haystack is the fields blob plus canonical text", () => {
		assert.ok(readBlock?.anyText === `${readBlock?.fields}\n${readBlock?.canonicalText}`);
	});

	it("label decoration keeps the any haystack in sync", () => {
		assert.ok(readBlock?.anyText.includes("label:result checkpoint") === true);
	});

	it("stripped body mirrors the body without separators", () => {
		assert.ok(readBlock?.strippedBody === stripSeparators(readBlock?.body ?? ""));
	});

	it("stripped any haystack mirrors the any haystack", () => {
		assert.ok(readBlock?.strippedAnyText === stripSeparators(readBlock?.anyText ?? ""));
	});

	it("blocks without bodies still index their invocation through any", () => {
		assert.ok(writeBlock?.anyText.includes("complete argument content") === true);
	});

	it("path suffix supplies a line", () => {
		assert.deepStrictEqual(writeBlock?.fileReference, { path: "src/other.ts", line: 9 });
	});

	it("label getter decorates target block", () => {
		assert.deepStrictEqual(
			[byEntry("user0001")[0]?.label, byEntry("user0001")[0]?.fields.includes("label:getter bookmark")],
			["getter bookmark", true],
		);
	});

	it("label on folded result decorates tool block", () => {
		assert.strictEqual(readBlock?.label, "result checkpoint");
	});

	it("cleared label is absent", () => {
		assert.strictEqual(orphanBlock?.label, undefined);
	});

	it("stable ids derive from entry and part", () => {
		assert.ok(blocks.every((block) => block.id.startsWith(`${block.entryId}:part:`)));
	});

	it("same entries produce stable ids", () => {
		assert.deepStrictEqual(extractBlocks(entries).map((block) => block.id), blocks.map((block) => block.id));
	});

	it("user images become placeholders", () => {
		assert.strictEqual(byEntry("user0001")[0]?.body,
			"Please inspect this image.\n[image]\nThe prompt continues.");
	});

	it("user canonical text is the complete body", () => {
		assert.strictEqual(byEntry("user0001")[0]?.canonicalText, byEntry("user0001")[0]?.body);
	});

	it("merged tool body is complete stored output", () => {
		assert.strictEqual(readBlock?.body, `${fullBody}\n[image]`);
	});

	it("merged tool canonical text has invocation and complete result", () => {
		assert.ok(readBlock?.canonicalText.startsWith("read {\n") === true
			&& readBlock.canonicalText.endsWith(`${fullBody}\n[image]`));
	});

	it("merged tool records its exact canonical body offset", () => {
		assert.strictEqual(readBlock?.canonicalBodyOffset,
			(readBlock?.canonicalText.length ?? 0) - (readBlock?.body.length ?? 0));
	});

	it("unmatched call canonical text retains complete arguments", () => {
		assert.ok(writeBlock?.canonicalText.includes("complete argument content") === true);
	});

	it("bash body remains stored output", () => {
		assert.strictEqual(bashBlock?.body, "complete bash output");
	});

	it("bash canonical text includes command, output, and exit", () => {
		assert.strictEqual(bashBlock?.canonicalText, "printf 'hello'\n\ncomplete bash output\n\nexit code 7");
	});

	it("bash records the output section offset", () => {
		assert.strictEqual(bashBlock?.canonicalBodyOffset, "printf 'hello'\n\n".length);
	});

	it("bash fields include command and exit", () => {
		assert.ok(bashBlock?.fields.includes("command:printf 'hello'") === true
			&& bashBlock.fields.includes("exit:7"));
	});

	it("forbidden payloads are never indexed", () => {
		const serializedBlocks = JSON.stringify(blocks);
		for (const forbidden of [
			userImageData,
			resultImageData,
			argumentImageData,
			"CUSTOM_ENTRY_BASE64",
			"DETAIL SECRET MUST STAY OUT",
			"TRUNCATION CONTENT MUST STAY OUT",
			"PRIVATE TRUNCATION METADATA",
			"ORPHAN DETAIL SECRET",
			"CUSTOM ROLE DETAIL SECRET",
			"CUSTOM ENTRY DETAIL SECRET",
			"COMPACTION DETAIL SECRET",
			"BRANCH DETAIL SECRET",
		]) {
			assert.ok(!serializedBlocks.includes(forbidden), `forbidden payload is not indexed: ${forbidden}`);
		}
	});

	it("tool truncation metadata", () => {
		assert.deepStrictEqual(readBlock?.truncation, {
			truncated: true,
			metadata: {
				truncated: true,
				truncatedBy: "lines",
				totalLines: 9_000,
				totalBytes: 90_000,
				outputLines: 2_000,
				outputBytes: 20_000,
				maxLines: 2_000,
				maxBytes: 50_000,
				lastLinePartial: false,
				firstLineExceedsLimit: false,
			},
			fullOutputPath: "/surviving/full-read-output.txt",
		});
	});

	it("bash truncation keeps full-output path", () => {
		assert.deepStrictEqual(bashBlock?.truncation, {
			truncated: true,
			fullOutputPath: "/surviving/full-bash-output.txt",
		});
	});

	it("displayable custom sources", () => {
		assert.deepStrictEqual(
			blocks.filter((block) => block.kind === "custom").map((block) => [block.title, block.body]),
			[
				["visible-role", "displayable custom role"],
				["visible-entry", "displayable custom entry\n[image]"],
			],
		);
	});

	it("summary sources", () => {
		assert.deepStrictEqual(blocks.filter((block) => block.kind === "summary").map((block) => block.body), [
			"top-level compaction summary",
			"top-level branch summary",
			"message-role branch summary",
			"message-role compaction summary",
		]);
	});

	it("excluded entries have no rows", () => {
		for (const excludedId of ["cust0002", "cmsg0002", "state001", "model001", "think001", "info0001"]) {
			assert.strictEqual(byEntry(excludedId).length, 0, `excluded entry has no row: ${excludedId}`);
		}
	});
});

describe("extraction helpers", () => {
	it("registry exposes every current entry type", () => {
		assert.ok([
			"message",
			"custom_message",
			"compaction",
			"branch_summary",
			"custom",
			"label",
			"model_change",
			"thinking_level_change",
			"session_info",
		].every((type) => typeof extractorRegistry[type] === "function"));
	});

	it("content helper never returns image data", () => {
		assert.strictEqual(contentToText([{ type: "image", data: "raw" }]), "[image]");
	});

	it("embedded image data becomes a placeholder", () => {
		assert.strictEqual(contentToText("before data:image/png;base64,QUJDRA== after"), "before [image] after");
	});

	it("argument helper is flattened and compact", () => {
		assert.strictEqual(flattenArguments({ path: "src/a.ts", nested: { limit: 2 } }), "path=src/a.ts nested.limit=2");
	});

	it("long base64-shaped plain arguments remain canonical", () => {
		assert.ok(formatToolArguments({ content: "a".repeat(128) }).includes("a".repeat(128)));
	});

	it("generic non-image base64 arguments remain canonical", () => {
		assert.ok(formatToolArguments({ base64: "QUJDRA==" }).includes("QUJDRA=="));
	});

	it("raw image-key base64 arguments are redacted", () => {
		assert.ok(!formatToolArguments({ image: "a".repeat(128) }).includes("a".repeat(128)));
	});

	it("formatted arguments redact image data", () => {
		assert.ok(formatToolArguments({ image: { type: "image", data: "raw", mimeType: "image/png" } }).includes("raw") === false);
	});

	it("file helper extracts plural paths and explicit lines", () => {
		assert.deepStrictEqual(extractFileReferences({ files: ["a.ts", "b.ts"], line: 12 }), [
			{ path: "a.ts", line: 12 },
			{ path: "b.ts", line: 12 },
		]);
	});

	it("timestamp helper is deterministic", () => {
		assert.strictEqual(formatTimestamp("2025-01-02T03:04:05.678Z"), "2025-01-02 03:04:05Z");
	});
});
