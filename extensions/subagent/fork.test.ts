import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { forkSessionManager, pendingToolCalls } from "./fork.ts";

const now = new Date("2026-10-30T12:00:00.000Z");
const user: UserMessage = { role: "user", content: "hello", timestamp: now.getTime() };
const delegating: AssistantMessage = {
	role: "assistant",
	content: [
		{ type: "toolCall", id: "call-sub", name: "subagent", arguments: { task: "t" } },
		{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "x" } },
	],
	api: "openai-responses",
	provider: "test",
	model: "test-model",
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "toolUse",
	timestamp: now.getTime(),
};
const readResult: ToolResultMessage = { role: "toolResult", toolCallId: "call-read", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: now.getTime() };

const messagesOf = (manager: SessionManager) => manager.getBranch().flatMap((entry) => (entry.type === "message" ? [entry.message] : []));

describe("forkSessionManager", () => {
	let dir: string;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("writes a child session that continues the parent's branch and answers the pending calls", () => {
		dir = mkdtempSync(join(tmpdir(), "subagent-fork-"));
		const parentCwd = join(dir, "repo");
		mkdirSync(parentCwd);
		const parent = SessionManager.create(parentCwd, join(dir, "sessions"));
		parent.appendMessage(user);
		parent.appendMessage(delegating);
		parent.appendMessage(readResult);
		const parentFile = parent.getSessionFile()!;
		const parentBytes = readFileSync(parentFile, "utf8");

		const child = forkSessionManager({ source: { parentSessionFile: parentFile, leafId: parent.getLeafId(), branch: parent.getBranch() }, toolCallId: "call-sub", childCwd: join(dir, "wt"), now });

		const reopened = SessionManager.open(child.getSessionFile()!);
		const messages = messagesOf(reopened);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "toolResult"]);
		const added = messages[3] as ToolResultMessage;
		expect(added.toolCallId).toBe("call-sub");
		expect(added.content).toEqual([{ type: "text", text: expect.stringContaining("forked subagent") }]);
		expect((added.content[0] as { text: string }).text).toContain(join(dir, "wt"));
		expect(reopened.getCwd()).toBe(join(dir, "wt"));
		expect(reopened.getHeader()?.parentSession).toBe(parentFile);
		expect(child.getSessionFile()).not.toBe(parentFile);
		expect(readFileSync(parentFile, "utf8")).toBe(parentBytes);
	});

	it("keeps an unpersisted parent's fork in memory, with the same pending results", () => {
		dir = mkdtempSync(join(tmpdir(), "subagent-fork-"));
		const parent = SessionManager.inMemory(dir);
		parent.appendMessage(user);
		parent.appendMessage(delegating);

		const child = forkSessionManager({ source: { parentSessionFile: undefined, leafId: parent.getLeafId(), branch: parent.getBranch() }, toolCallId: "call-sub", childCwd: dir, now });

		expect(child.getSessionFile()).toBeUndefined();
		const results = messagesOf(child).filter((message): message is ToolResultMessage => message.role === "toolResult");
		expect(results.map((result) => result.toolCallId)).toEqual(["call-sub", "call-read"]);
		expect((results[1]!.content[0] as { text: string }).text).toContain("Not executed in this fork");
	});
});

describe("pendingToolCalls", () => {
	it("returns the calls of the last assistant message that have no result on the branch", () => {
		const manager = SessionManager.inMemory("/tmp");
		manager.appendMessage(user);
		manager.appendMessage(delegating);
		manager.appendMessage(readResult);

		expect(pendingToolCalls(manager.getBranch())).toEqual([{ id: "call-sub", name: "subagent" }]);
	});

	it("returns nothing when the branch ends without an assistant message", () => {
		const manager = SessionManager.inMemory("/tmp");
		manager.appendMessage(user);

		expect(pendingToolCalls(manager.getBranch())).toEqual([]);
	});
});
