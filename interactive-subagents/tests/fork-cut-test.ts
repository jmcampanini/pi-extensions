import { seedForkSession } from "../session.ts";
import { readFileSync, writeFileSync } from "node:fs";

function entry(o: unknown): string { return JSON.stringify(o); }
function readTypes(f: string): string[] {
	return readFileSync(f, "utf8").trim().split("\n").map((l) => {
		const e = JSON.parse(l);
		return e.type === "message" ? `message:${e.message.role}` : e.type;
	});
}

// Case A: wake turn triggered by a custom_message (steered subagent result),
// with an in-flight assistant toolCall. Cut must land at the custom_message,
// preserving the completed first exchange.
const parentA = "/tmp/fork-test-parent-a.jsonl";
writeFileSync(parentA, [
	entry({ type: "session", version: 3, id: "p", cwd: "/tmp" }),
	entry({ type: "message", id: "1", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
	entry({ type: "message", id: "2", message: { role: "assistant", content: [{ type: "text", text: "spawning..." }] } }),
	entry({ type: "custom_message", id: "3", customType: "subagent_result", content: "child A done" }),
	entry({ type: "message", id: "4", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "subagent" }] } }),
].join("\n") + "\n");
const childA = "/tmp/fork-test-child-a.jsonl";
seedForkSession({ parentSessionFile: parentA, childSessionFile: childA, childCwd: "/tmp" });
const gotA = readTypes(childA);
const wantA = ["session", "message:user", "message:assistant"];
console.log("A:", JSON.stringify(gotA), gotA.join(",") === wantA.join(",") ? "PASS" : "FAIL");

// Case B: old behavior check — plain user-triggered turn still cuts at the
// last user message.
const parentB = "/tmp/fork-test-parent-b.jsonl";
writeFileSync(parentB, [
	entry({ type: "session", version: 3, id: "p", cwd: "/tmp" }),
	entry({ type: "message", id: "1", message: { role: "user", content: [{ type: "text", text: "first" }] } }),
	entry({ type: "message", id: "2", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } }),
	entry({ type: "message", id: "3", message: { role: "user", content: [{ type: "text", text: "spawn a fork" }] } }),
	entry({ type: "message", id: "4", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "subagent" }] } }),
].join("\n") + "\n");
const childB = "/tmp/fork-test-child-b.jsonl";
seedForkSession({ parentSessionFile: parentB, childSessionFile: childB, childCwd: "/tmp" });
const gotB = readTypes(childB);
const wantB = ["session", "message:user", "message:assistant"];
console.log("B:", JSON.stringify(gotB), gotB.join(",") === wantB.join(",") ? "PASS" : "FAIL");

// Case C: no turn-start entry found at all + trailing dangling toolCall —
// the safety net must trim the dangling assistant message.
const parentC = "/tmp/fork-test-parent-c.jsonl";
writeFileSync(parentC, [
	entry({ type: "session", version: 3, id: "p", cwd: "/tmp" }),
	entry({ type: "message", id: "1", message: { role: "assistant", content: [{ type: "text", text: "odd" }] } }),
	entry({ type: "message", id: "2", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash" }] } }),
].join("\n") + "\n");
const childC = "/tmp/fork-test-child-c.jsonl";
seedForkSession({ parentSessionFile: parentC, childSessionFile: childC, childCwd: "/tmp" });
const gotC = readTypes(childC);
const wantC = ["session", "message:assistant"];
console.log("C:", JSON.stringify(gotC), gotC.join(",") === wantC.join(",") ? "PASS" : "FAIL");
