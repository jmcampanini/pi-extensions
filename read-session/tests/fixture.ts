import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = {
	api: "openai-responses" as const,
	provider: "openai",
	model: "fixture",
	usage,
	timestamp: 0,
};

export const answerMarkdown = `## What changed

The session reader gives the agent's response more room. **Your words and the agent's words stay intact.** The browser opens at the latest message, with earlier context below it to follow the conversation.

### A command you can try

Run the command from Pi after reloading the extensions:

\`\`\`typescript
const newestFirst = [...messages].reverse();
\`\`\`

### How to read the session

| Content | Where to find it |
| --- | --- |
| Your prompts | Beside the agent responses they prompted |
| Agent headings | In the outline on the left |
| Tool activity | Between the messages where the calls happened |
| Earlier context | Below the newest messages |

### What to look for

- Can you follow a long paragraph without losing your place?
- Does the prompt provide enough context without competing with the answer?
- Are tool counts helpful, or do they interrupt the reading?

> Start with the latest answer. Scroll down when you need context. Copy a passage when you want to reply to it in Pi.

The code block and table use their own horizontal scroll area on a small screen. Normal paragraphs stay within the reading column.

### Next step

- [x] Open the whole session in one page.
- [x] Keep generation deterministic.
- [ ] Reply in Pi after reading the response.

You can copy a passage from the response and paste it into your reply in Pi.`;

const messages: SessionMessageEntry["message"][] = [
	{ role: "user", content: "The first question in this session.", timestamp: 0 },
	{
		...assistant,
		role: "assistant",
		content: [{ type: "text", text: "The first answer in this session." }],
		stopReason: "stop",
	},
	{
		role: "user",
		content:
			"I want to read this session in the browser. Keep the agent's response easy to follow, with my prompt beside it and an outline of the headings.",
		timestamp: 0,
	},
	{
		...assistant,
		role: "assistant",
		content: [
			{ type: "text", text: "I'll inspect the command registration and build a reader for the whole session." },
			{ type: "thinking", thinking: "PRIVATE_THINKING_NOT_FOR_READER" },
			{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "README.md" } },
		],
		stopReason: "toolUse",
	},
	{
		role: "toolResult",
		toolCallId: "read-1",
		toolName: "read",
		content: [{ type: "text", text: "RAW_TOOL_OUTPUT_NOT_FOR_READER" }],
		isError: false,
		timestamp: 0,
	},
	{
		...assistant,
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "edit-1",
				name: "edit",
				arguments: { path: "read-session/index.ts", oldText: "old", newText: "new" },
			},
		],
		stopReason: "toolUse",
	},
	{
		role: "toolResult",
		toolCallId: "edit-1",
		toolName: "edit",
		content: [{ type: "text", text: "RAW_FAILURE_NOT_FOR_READER" }],
		isError: true,
		timestamp: 0,
	},
	{ ...assistant, role: "assistant", content: [{ type: "text", text: answerMarkdown }], stopReason: "stop" },
	{
		role: "user",
		content: [
			{ type: "text", text: "Could the tool summaries be shorter?" },
			{ type: "image", data: "IMAGE_BYTES_NOT_FOR_READER", mimeType: "image/png" },
		],
		timestamp: 0,
	},
	{
		...assistant,
		role: "assistant",
		content: [{ type: "toolCall", id: "pending-1", name: "bash", arguments: { command: "npm test" } }],
		stopReason: "toolUse",
	},
];

export const entries: SessionEntry[] = messages.map((message, index) => ({
	type: "message",
	id: `entry-${index}`,
	parentId: index === 0 ? null : `entry-${index - 1}`,
	timestamp: "2026-09-07T12:00:00.000Z",
	message,
}));
