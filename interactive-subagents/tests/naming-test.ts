import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendSessionName, readSessionName, seedForkSession, seedNewSession } from "../session.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sandbox = join(process.cwd(), ".sandbox");
mkdirSync(sandbox, { recursive: true });
const testRoot = mkdtempSync(join(sandbox, "subagents-naming-"));

after(() => {
	rmSync(testRoot, { recursive: true, force: true });
});

function entry(o: unknown): string { return JSON.stringify(o); }
function lines(f: string): Array<Record<string, unknown>> {
	return readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

const parentLines = [
	entry({ type: "session", version: 3, id: "p", cwd: "/tmp" }),
	entry({ type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
	entry({ type: "message", id: "m2", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }),
	entry({ type: "message", id: "m3", message: { role: "user", content: [{ type: "text", text: "spawn a fork" }] } }),
];

describe("seedNewSession", () => {
	// A new-context seed is exactly header + session_info, with the header
	// pointing at the parent (threading) and the name readable back.
	it("seeds header plus session_info threaded to the parent with a readable name", () => {
		const parentFile = join(testRoot, "parent.jsonl");
		const newFile = join(testRoot, "new.jsonl");
		seedNewSession({
			parentSessionFile: parentFile,
			childSessionFile: newFile,
			childCwd: "/tmp/work",
			name: "subagent › scout › wait 1",
		});
		const newEntries = lines(newFile);
		assert.ok(
			newEntries.length === 2 && newEntries[0].type === "session" && newEntries[1].type === "session_info",
			"A1 shape",
		);
		assert.ok(
			newEntries[0].version === 3 && newEntries[0].cwd === "/tmp/work" && newEntries[0].parentSession === parentFile,
			"A2 header",
		);
		assert.ok(
			typeof newEntries[0].id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(newEntries[0].id as string),
			"A3 UUIDv7 session id",
		);
		assert.ok(newEntries[1].name === "subagent › scout › wait 1" && newEntries[1].parentId === null, "A4 name entry");
		assert.strictEqual(readSessionName(newFile), "subagent › scout › wait 1", "A5 readSessionName");
		// Full-uuid entry id: an 8-hex id could collide with a copied parent entry's
		// id, which would shadow that entry in pi's index and hang its context walk.
		assert.ok(typeof newEntries[1].id === "string" && (newEntries[1].id as string).length === 36, "A6 full-uuid id");
	});

	// Names are sanitized the way pi's own rename sanitizes them - newlines
	// flattened to spaces - before they reach the session file.
	it("flattens newlines in names the way pi's rename does", () => {
		const multilineFile = join(testRoot, "multiline.jsonl");
		seedNewSession({
			parentSessionFile: join(testRoot, "parent.jsonl"),
			childSessionFile: multilineFile,
			childCwd: "/tmp/work",
			name: "subagent › scout › line one\nline two",
		});
		assert.strictEqual(readSessionName(multilineFile), "subagent › scout › line one line two", "G1 newlines flattened");
	});
});

describe("seedForkSession", () => {
	// A fork seed keeps the copied conversation byte-identical and puts the
	// session_info LAST, linked to the last copied entry's id.
	it("keeps copied bytes identical and links the name to the last copied entry", () => {
		const forkParent = join(testRoot, "fork-parent.jsonl");
		writeFileSync(forkParent, parentLines.join("\n") + "\n");
		const forkFile = join(testRoot, "fork.jsonl");
		seedForkSession({ parentSessionFile: forkParent, childSessionFile: forkFile, childCwd: "/tmp", name: "subagent › worker › follow-up" });
		const forkRaw = readFileSync(forkFile, "utf8").trim().split("\n");
		const fork = lines(forkFile);
		assert.ok(forkRaw[1] === parentLines[1] && forkRaw[2] === parentLines[2], "B1 copied bytes");
		assert.ok(
			fork[fork.length - 1].type === "session_info" && fork[fork.length - 1].parentId === "m2",
			"B2 name last",
		);
		assert.strictEqual(readSessionName(forkFile), "subagent › worker › follow-up", "B3 readSessionName");
	});

	// A fork whose cut leaves ZERO copied entries (the parent's only message is
	// the in-flight one) still seeds a valid named session.
	it("seeds a valid named session when the cut leaves zero copied entries", () => {
		const emptyForkParent = join(testRoot, "empty-fork-parent.jsonl");
		writeFileSync(emptyForkParent, [
			entry({ type: "session", version: 3, id: "p", cwd: "/tmp" }),
			entry({ type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: "spawn now" }] } }),
		].join("\n") + "\n");
		const emptyForkFile = join(testRoot, "empty-fork.jsonl");
		seedForkSession({ parentSessionFile: emptyForkParent, childSessionFile: emptyForkFile, childCwd: "/tmp", name: "subagent › scout › empty" });
		const emptyFork = lines(emptyForkFile);
		assert.ok(
			emptyFork.length === 2 && emptyFork[1].type === "session_info" && emptyFork[1].parentId === null,
			"E1 shape",
		);
	});

	// A CORRUPT trailing line in the copied conversation must not become the
	// name entry's parent - the name links to the last PARSEABLE entry, the
	// same one pi treats as the leaf when it skips the corrupt line.
	it("links the name past a corrupt trailing line to the last parseable entry", () => {
		const corruptForkParent = join(testRoot, "corrupt-fork-parent.jsonl");
		writeFileSync(corruptForkParent, [
			entry({ type: "session", version: 3, id: "p", cwd: "/tmp" }),
			entry({ type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
			entry({ type: "message", id: "m2", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }),
			'{"type":"message","id":"torn', // torn write from a crashed pi
			entry({ type: "message", id: "m3", message: { role: "user", content: [{ type: "text", text: "spawn a fork" }] } }),
		].join("\n") + "\n");
		const corruptForkFile = join(testRoot, "corrupt-fork.jsonl");
		seedForkSession({ parentSessionFile: corruptForkParent, childSessionFile: corruptForkFile, childCwd: "/tmp", name: "subagent › scout › corrupt" });
		const corruptForkRaw = readFileSync(corruptForkFile, "utf8").trim().split("\n");
		const corruptLast = JSON.parse(corruptForkRaw[corruptForkRaw.length - 1]);
		assert.ok(
			corruptForkRaw.length === 5 && corruptForkRaw[3] === '{"type":"message","id":"torn',
			"F1 corrupt line kept",
		);
		assert.ok(corruptLast.type === "session_info" && corruptLast.parentId === "m2", "F2 links past corruption");
	});
});

describe("readSessionName", () => {
	it("a session without a name entry reads undefined", () => {
		const plainFile = join(testRoot, "plain.jsonl");
		writeFileSync(plainFile, parentLines.join("\n") + "\n");
		assert.strictEqual(readSessionName(plainFile), undefined, "C1 unnamed");
	});

	it("the latest name entry wins", () => {
		const renamedFile = join(testRoot, "renamed.jsonl");
		writeFileSync(renamedFile, [
			...parentLines,
			entry({ type: "session_info", id: "s1", parentId: "m3", name: "first name" }),
			entry({ type: "session_info", id: "s2", parentId: "s1", name: "second name" }),
		].join("\n") + "\n");
		assert.strictEqual(readSessionName(renamedFile), "second name", "C2 latest wins");
	});

	it("an empty name is an explicit clear", () => {
		const clearedFile = join(testRoot, "cleared.jsonl");
		writeFileSync(clearedFile, [
			...parentLines,
			entry({ type: "session_info", id: "s1", parentId: "m3", name: "was named" }),
			entry({ type: "session_info", id: "s2", parentId: "s1", name: "" }),
		].join("\n") + "\n");
		assert.strictEqual(readSessionName(clearedFile), undefined, "C3 empty clears");
	});
});

describe("appendSessionName", () => {
	// appendSessionName links to the last real entry (never the header) and
	// survives a file that ends without a trailing newline.
	it("links to the last real entry and survives a missing trailing newline", () => {
		const backfillFile = join(testRoot, "backfill.jsonl");
		writeFileSync(backfillFile, parentLines.join("\n")); // no trailing newline
		appendSessionName(backfillFile, "subagent › scout › old child");
		const backfill = lines(backfillFile);
		assert.strictEqual(backfill.length, 5, "D1 all lines parse");
		assert.ok(backfill[4].type === "session_info" && backfill[4].parentId === "m3", "D2 linked to last entry");
		assert.strictEqual(readSessionName(backfillFile), "subagent › scout › old child", "D3 readSessionName");
	});
});
