import { appendSessionName, readSessionName, seedForkSession, seedFreshSession } from "../session.ts";
import { readFileSync, writeFileSync } from "node:fs";

function entry(o: unknown): string { return JSON.stringify(o); }
function lines(f: string): Array<Record<string, unknown>> {
	return readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}
function check(label: string, ok: boolean, detail = ""): void {
	console.log(`${label}: ${ok ? "PASS" : `FAIL ${detail}`}`);
}

// Case A: a fresh seed is exactly header + session_info, with the header
// pointing at the parent (threading) and the name readable back.
const freshFile = "/tmp/naming-test-fresh.jsonl";
seedFreshSession({
	parentSessionFile: "/tmp/naming-test-parent.jsonl",
	childSessionFile: freshFile,
	childCwd: "/tmp/work",
	name: "subagent › scout › wait 1",
});
const fresh = lines(freshFile);
check("A1 shape", fresh.length === 2 && fresh[0].type === "session" && fresh[1].type === "session_info");
check(
	"A2 header",
	fresh[0].version === 3 && fresh[0].cwd === "/tmp/work" && fresh[0].parentSession === "/tmp/naming-test-parent.jsonl",
);
check(
	"A3 UUIDv7 session id",
	typeof fresh[0].id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(fresh[0].id as string),
);
check("A4 name entry", fresh[1].name === "subagent › scout › wait 1" && fresh[1].parentId === null);
check("A5 readSessionName", readSessionName(freshFile) === "subagent › scout › wait 1");
// Full-uuid entry id: an 8-hex id could collide with a copied parent entry's
// id, which would shadow that entry in pi's index and hang its context walk.
check("A6 full-uuid id", typeof fresh[1].id === "string" && (fresh[1].id as string).length === 36);

// Case B: a fork seed keeps the copied conversation byte-identical and puts
// the session_info LAST, linked to the last copied entry's id.
const forkParent = "/tmp/naming-test-fork-parent.jsonl";
const parentLines = [
	entry({ type: "session", version: 3, id: "p", cwd: "/tmp" }),
	entry({ type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
	entry({ type: "message", id: "m2", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }),
	entry({ type: "message", id: "m3", message: { role: "user", content: [{ type: "text", text: "spawn a fork" }] } }),
];
writeFileSync(forkParent, parentLines.join("\n") + "\n");
const forkFile = "/tmp/naming-test-fork.jsonl";
seedForkSession({ parentSessionFile: forkParent, childSessionFile: forkFile, childCwd: "/tmp", name: "subagent › worker › follow-up" });
const forkRaw = readFileSync(forkFile, "utf8").trim().split("\n");
const fork = lines(forkFile);
check("B1 copied bytes", forkRaw[1] === parentLines[1] && forkRaw[2] === parentLines[2]);
check("B2 name last", fork[fork.length - 1].type === "session_info" && fork[fork.length - 1].parentId === "m2");
check("B3 readSessionName", readSessionName(forkFile) === "subagent › worker › follow-up");

// Case C: readSessionName semantics — missing entry is undefined, the
// LATEST entry wins, and an empty name is an explicit clear.
const plainFile = "/tmp/naming-test-plain.jsonl";
writeFileSync(plainFile, parentLines.join("\n") + "\n");
check("C1 unnamed", readSessionName(plainFile) === undefined);
const renamedFile = "/tmp/naming-test-renamed.jsonl";
writeFileSync(renamedFile, [
	...parentLines,
	entry({ type: "session_info", id: "s1", parentId: "m3", name: "first name" }),
	entry({ type: "session_info", id: "s2", parentId: "s1", name: "second name" }),
].join("\n") + "\n");
check("C2 latest wins", readSessionName(renamedFile) === "second name");
const clearedFile = "/tmp/naming-test-cleared.jsonl";
writeFileSync(clearedFile, [
	...parentLines,
	entry({ type: "session_info", id: "s1", parentId: "m3", name: "was named" }),
	entry({ type: "session_info", id: "s2", parentId: "s1", name: "" }),
].join("\n") + "\n");
check("C3 empty clears", readSessionName(clearedFile) === undefined);

// Case E: a fork whose cut leaves ZERO copied entries (the parent's only
// message is the in-flight one) still seeds a valid named session.
const emptyForkParent = "/tmp/naming-test-empty-fork-parent.jsonl";
writeFileSync(emptyForkParent, [
	entry({ type: "session", version: 3, id: "p", cwd: "/tmp" }),
	entry({ type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: "spawn now" }] } }),
].join("\n") + "\n");
const emptyForkFile = "/tmp/naming-test-empty-fork.jsonl";
seedForkSession({ parentSessionFile: emptyForkParent, childSessionFile: emptyForkFile, childCwd: "/tmp", name: "subagent › scout › empty" });
const emptyFork = lines(emptyForkFile);
check("E1 shape", emptyFork.length === 2 && emptyFork[1].type === "session_info" && emptyFork[1].parentId === null);

// Case F: a CORRUPT trailing line in the copied conversation must not become
// the name entry's parent — the name links to the last PARSEABLE entry, the
// same one pi treats as the leaf when it skips the corrupt line.
const corruptForkParent = "/tmp/naming-test-corrupt-fork-parent.jsonl";
writeFileSync(corruptForkParent, [
	entry({ type: "session", version: 3, id: "p", cwd: "/tmp" }),
	entry({ type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
	entry({ type: "message", id: "m2", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }),
	'{"type":"message","id":"torn', // torn write from a crashed pi
	entry({ type: "message", id: "m3", message: { role: "user", content: [{ type: "text", text: "spawn a fork" }] } }),
].join("\n") + "\n");
const corruptForkFile = "/tmp/naming-test-corrupt-fork.jsonl";
seedForkSession({ parentSessionFile: corruptForkParent, childSessionFile: corruptForkFile, childCwd: "/tmp", name: "subagent › scout › corrupt" });
const corruptForkRaw = readFileSync(corruptForkFile, "utf8").trim().split("\n");
const corruptLast = JSON.parse(corruptForkRaw[corruptForkRaw.length - 1]);
check("F1 corrupt line kept", corruptForkRaw.length === 5 && corruptForkRaw[3] === '{"type":"message","id":"torn');
check("F2 links past corruption", corruptLast.type === "session_info" && corruptLast.parentId === "m2");

// Case G: names are sanitized the way pi's own rename sanitizes them —
// newlines flattened to spaces — before they reach the session file.
const multilineFile = "/tmp/naming-test-multiline.jsonl";
seedFreshSession({
	parentSessionFile: "/tmp/naming-test-parent.jsonl",
	childSessionFile: multilineFile,
	childCwd: "/tmp/work",
	name: "subagent › scout › line one\nline two",
});
check("G1 newlines flattened", readSessionName(multilineFile) === "subagent › scout › line one line two");

// Case D: appendSessionName links to the last real entry (never the header)
// and survives a file that ends without a trailing newline.
const backfillFile = "/tmp/naming-test-backfill.jsonl";
writeFileSync(backfillFile, parentLines.join("\n")); // no trailing newline
appendSessionName(backfillFile, "subagent › scout › old child");
const backfill = lines(backfillFile);
check("D1 all lines parse", backfill.length === 5);
check("D2 linked to last entry", backfill[4].type === "session_info" && backfill[4].parentId === "m3");
check("D3 readSessionName", readSessionName(backfillFile) === "subagent › scout › old child");
