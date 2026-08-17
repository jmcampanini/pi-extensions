import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { seedForkSession } from "../session.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sandbox = join(process.cwd(), ".sandbox");
mkdirSync(sandbox, { recursive: true });
const root = mkdtempSync(join(sandbox, "fork-cut-"));

after(() => {
	rmSync(root, { recursive: true, force: true });
});

function entry(o: unknown): string { return JSON.stringify(o); }
function readTypes(f: string): string[] {
	return readFileSync(f, "utf8").trim().split("\n").map((l) => {
		const e = JSON.parse(l);
		return e.type === "message" ? `message:${e.message.role}` : e.type;
	});
}

describe("seedForkSession", () => {
	it("a custom_message wake turn cuts at the custom_message, preserving the completed exchange", () => {
		const parentA = join(root, "fork-test-parent-a.jsonl");
		writeFileSync(parentA, [
			entry({ type: "session", version: 3, id: "p", cwd: "/tmp" }),
			entry({ type: "message", id: "1", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
			entry({ type: "message", id: "2", message: { role: "assistant", content: [{ type: "text", text: "spawning..." }] } }),
			entry({ type: "custom_message", id: "3", customType: "subagent_result", content: "child A done" }),
			entry({ type: "message", id: "4", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "subagent_spawn" }] } }),
		].join("\n") + "\n");
		const childA = join(root, "fork-test-child-a.jsonl");
		seedForkSession({ parentSessionFile: parentA, childSessionFile: childA, childCwd: root });
		assert.deepStrictEqual(readTypes(childA), ["session", "message:user", "message:assistant"]);
	});

	it("a plain user-triggered turn still cuts at the last user message", () => {
		const parentB = join(root, "fork-test-parent-b.jsonl");
		writeFileSync(parentB, [
			entry({ type: "session", version: 3, id: "p", cwd: "/tmp" }),
			entry({ type: "message", id: "1", message: { role: "user", content: [{ type: "text", text: "first" }] } }),
			entry({ type: "message", id: "2", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } }),
			entry({ type: "message", id: "3", message: { role: "user", content: [{ type: "text", text: "spawn a fork" }] } }),
			entry({ type: "message", id: "4", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "subagent_spawn" }] } }),
		].join("\n") + "\n");
		const childB = join(root, "fork-test-child-b.jsonl");
		seedForkSession({ parentSessionFile: parentB, childSessionFile: childB, childCwd: root });
		assert.deepStrictEqual(readTypes(childB), ["session", "message:user", "message:assistant"]);
	});

	it("with no turn-start entry, the safety net trims a trailing dangling toolCall", () => {
		const parentC = join(root, "fork-test-parent-c.jsonl");
		writeFileSync(parentC, [
			entry({ type: "session", version: 3, id: "p", cwd: "/tmp" }),
			entry({ type: "message", id: "1", message: { role: "assistant", content: [{ type: "text", text: "odd" }] } }),
			entry({ type: "message", id: "2", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash" }] } }),
		].join("\n") + "\n");
		const childC = join(root, "fork-test-child-c.jsonl");
		seedForkSession({ parentSessionFile: parentC, childSessionFile: childC, childCwd: root });
		assert.deepStrictEqual(readTypes(childC), ["session", "message:assistant"]);
	});
});
