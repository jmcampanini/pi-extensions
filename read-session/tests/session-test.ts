import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectMessages } from "../session.ts";
import { answerMarkdown, entries } from "./fixture.ts";

describe("selectMessages", () => {
	it("includes every user and agent message with recorded tool activity", () => {
		const snapshot = selectMessages(entries);
		const messages = snapshot.blocks.filter((block) => block.kind === "message");
		const activity = snapshot.blocks.filter((block) => block.kind === "activity");

		assert.equal(snapshot.messageCount, 6);
		assert.deepEqual(
			messages.map((message) => message.role),
			["user", "assistant", "user", "assistant", "assistant", "user"],
		);
		assert.equal(messages[4]?.text, answerMarkdown);
		assert.deepEqual(
			activity.map((block) => block.calls),
			[
				[
					{ name: "read", argument: "README.md", status: "returned" },
					{ name: "edit", argument: "read-session/index.ts", status: "failed" },
				],
				[{ name: "bash", argument: "npm test", status: "pending" }],
			],
		);
		assert.deepEqual(
			snapshot.blocks.map((block) => block.kind),
			["message", "message", "message", "message", "activity", "message", "message", "activity"],
		);
		assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_THINKING|RAW_TOOL_OUTPUT|RAW_FAILURE|IMAGE_BYTES/);
		assert.match(messages[5]!.text, /\[Image attachment\]/);
	});

	it("keeps every message in a long session", () => {
		const entry = entries[0]!;
		assert.ok(entry.type === "message" && entry.message.role === "user");
		const user = entry.message;
		const history = Array.from({ length: 32 }, (_, index) => ({
			...entry,
			id: `message-${index}`,
			message: { ...user, content: `Message ${index}` },
		}));

		const snapshot = selectMessages(history);

		assert.equal(snapshot.messageCount, history.length);
		assert.deepEqual(
			snapshot.blocks.map((block) => block.kind === "message" && block.text),
			history.map(({ message }) => message.content),
		);
	});

	it("keeps separate response text parts as separate paragraphs", () => {
		const entry = entries[1]!;
		assert.ok(entry.type === "message" && entry.message.role === "assistant");
		const message = {
			...entry.message,
			content: [
				{ type: "text" as const, text: "Before the tool call." },
				{ type: "toolCall" as const, id: "read", name: "read", arguments: { path: "README.md" } },
				{ type: "text" as const, text: "After the tool call." },
			],
		};

		const snapshot = selectMessages([{ ...entry, message }]);

		assert.equal(
			snapshot.blocks[0]?.kind === "message" && snapshot.blocks[0].text,
			"Before the tool call.\n\nAfter the tool call.",
		);
	});

	it("retains interrupted agent text and its recorded status", () => {
		const snapshot = selectMessages([
			{
				...entries[1]!,
				type: "message",
				message: {
					...(entries[1]!.type === "message" ? entries[1]!.message : {}),
					role: "assistant",
					stopReason: "aborted",
					content: [{ type: "text", text: "The partial answer." }],
				},
			} as (typeof entries)[number],
		]);

		assert.deepEqual(snapshot.blocks, [
			{ kind: "message", role: "assistant", text: "The partial answer.", status: "aborted" },
		]);
	});

	it("keeps empty failed turns throughout the session without counting them as text messages", () => {
		const entry = entries[1]!;
		assert.ok(entry.type === "message" && entry.message.role === "assistant");
		const failed = {
			...entry,
			message: {
				...entry.message,
				content: [],
				stopReason: "error" as const,
				errorMessage: "Provider unavailable",
			},
		};
		const aborted = {
			...entry,
			message: { ...entry.message, content: [], stopReason: "aborted" as const },
		};

		const snapshot = selectMessages([failed, entries[0]!, aborted]);

		assert.equal(snapshot.messageCount, 1);
		assert.equal(snapshot.blocks[1]?.kind, "message");
		assert.deepEqual(
			snapshot.blocks.filter((block) => block.kind === "failure"),
			[
				{ kind: "failure", status: "error", details: "Provider unavailable" },
				{ kind: "failure", status: "aborted", details: undefined },
			],
		);
	});
});
