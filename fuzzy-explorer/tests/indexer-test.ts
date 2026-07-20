import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { BranchBlockIndex } from "../indexer.ts";

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown): void {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}: got ${g}, want ${w}`); }
}
function ok(label: string, value: boolean): void {
	if (value) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}`); }
}

const base = (id: string, parentId: string | null) => ({ id, parentId, timestamp: `2026-01-01T00:00:${id}.000Z` });
const user = {
	...base("01", null), type: "message", message: { role: "user", content: "start", timestamp: 1 },
} as SessionEntry;
const call = {
	...base("02", "01"), type: "message", message: {
		role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/a.ts" } }],
		api: "x", provider: "x", model: "x", usage: {}, stopReason: "toolUse", timestamp: 2,
	},
} as unknown as SessionEntry;
const result = {
	...base("03", "02"), type: "message", message: {
		role: "toolResult", toolCallId: "call-1", toolName: "read",
		content: [{ type: "text", text: "complete stored result" }], isError: false, timestamp: 3,
	},
} as SessionEntry;

const index = new BranchBlockIndex();
const first = index.updateEntries([user, call]);
const userObject = first.find((block) => block.kind === "user");
const callBefore = first.find((block) => block.toolCallId === "call-1");
const unchanged = index.updateEntries([user, call]);
eq("unchanged branch returns the same block array", unchanged === first, true);

const appended = index.updateEntries([user, call, result]);
const callAfter = appended.find((block) => block.toolCallId === "call-1");
eq("delayed result merges into its original tool row", callAfter?.body, "complete stored result");
ok("ordinary old blocks are reused across append", appended.find((block) => block.kind === "user") === userObject);
ok("the correlated tool block is replaced", callAfter !== callBefore);
eq("merged result does not create an orphan row", appended.filter((block) => block.kind === "tool").length, 1);

const alternate = {
	...base("04", "01"), type: "message", message: { role: "user", content: "alternate active branch", timestamp: 4 },
} as SessionEntry;
const rebuilt = index.updateEntries([user, alternate]);
eq("branch change rebuild removes abandoned entries", rebuilt.map((block) => block.body), ["start", "alternate active branch"]);

const label = { ...base("05", "04"), type: "label", targetId: "04", label: "checkpoint" } as SessionEntry;
const labeled = index.updateEntries([user, alternate, label], (id) => id === "04" ? "checkpoint" : undefined);
eq("label append refreshes target metadata without a row", [labeled.length, labeled[1]?.label], [2, "checkpoint"]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
