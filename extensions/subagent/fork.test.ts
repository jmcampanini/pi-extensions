import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildForkEntries } from "./fork.ts";

const now = new Date("2026-10-30T12:00:00.000Z");
const message = (id: string, parentId: string | null, body: Record<string, unknown>): SessionEntry =>
	({ type: "message", id, parentId, timestamp: now.toISOString(), message: { timestamp: now.getTime(), ...body } }) as SessionEntry;

const branch = [
	message("u1", null, { role: "user", content: "hello" }),
	message("a1", "u1", {
		role: "assistant",
		content: [
			{ type: "toolCall", id: "call-sub", name: "subagent", arguments: { task: "t" } },
			{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "x" } },
		],
	}),
];

describe("buildForkEntries", () => {
	it("writes a header for the child and answers every pending call of the delegating message", () => {
		const entries = buildForkEntries({ source: { header: null, branch, parentSessionFile: "/parent.jsonl" }, toolCallId: "call-sub", childSessionId: "child-id", childCwd: "/wt/app", now });

		expect(entries[0]).toEqual({ type: "session", version: 3, id: "child-id", timestamp: now.toISOString(), cwd: "/wt/app", parentSession: "/parent.jsonl" });
		expect(entries.slice(1, 3)).toEqual(branch);

		const results = entries.slice(3) as Array<{ id: string; parentId: string; message: { toolCallId: string; content: Array<{ text: string }> } }>;
		expect(results.map((r) => r.message.toolCallId)).toEqual(["call-sub", "call-read"]);
		expect(results.map((r) => r.parentId)).toEqual(["a1", results[0]!.id]);
		expect(results[0]!.message.content[0]!.text).toContain("forked subagent");
		expect(results[0]!.message.content[0]!.text).toContain("/wt/app");
		expect(results[1]!.message.content[0]!.text).toContain("Not executed in this fork");
	});

	it("leaves calls alone that already have a result on the branch", () => {
		const answered = [...branch, message("r1", "a1", { role: "toolResult", toolCallId: "call-read", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false })];

		const entries = buildForkEntries({ source: { header: null, branch: answered, parentSessionFile: undefined }, toolCallId: "call-sub", childSessionId: "c", childCwd: "/c", now });

		const added = entries.slice(1 + answered.length) as Array<{ parentId: string; message: { toolCallId: string } }>;
		expect(added.map((r) => r.message.toolCallId)).toEqual(["call-sub"]);
		expect(added[0]!.parentId).toBe("r1");
		expect(entries[0]).not.toHaveProperty("parentSession");
	});
});
