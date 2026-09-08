import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectMessages } from "../session.ts";
import { answerMarkdown, entries } from "./fixture.ts";

describe("selectMessages", () => {
	it("counts user and agent text together without spending the window on tool traffic", () => {
		const snapshot = selectMessages(entries, 3);
		const messages = snapshot.blocks.filter((block) => block.kind === "message");
		const activity = snapshot.blocks.filter((block) => block.kind === "activity");

		assert.equal(snapshot.messageCount, 3);
		assert.deepEqual(
			messages.map((message) => message.role),
			["assistant", "assistant", "user"],
		);
		assert.equal(messages[1]?.text, answerMarkdown);
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
			["message", "activity", "message", "message", "activity"],
		);
		assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_THINKING|RAW_TOOL_OUTPUT|RAW_FAILURE|IMAGE_BYTES/);
		assert.match(messages[2]!.text, /\[Image attachment\]/);
	});

	it("excludes tool calls before the first selected message and keeps calls after the latest message", () => {
		const snapshot = selectMessages(entries, 1);

		assert.equal(snapshot.messageCount, 1);
		assert.deepEqual(
			snapshot.blocks
				.filter((block) => block.kind === "activity")
				.flatMap((block) => block.calls.map((call) => call.name)),
			["bash"],
		);
	});

	it("retains interrupted agent text and its recorded status", () => {
		const snapshot = selectMessages(
			[
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
			],
			20,
		);

		assert.deepEqual(snapshot.blocks, [
			{ kind: "message", role: "assistant", text: "The partial answer.", status: "aborted" },
		]);
	});
});
