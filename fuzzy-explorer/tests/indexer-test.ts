import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { BranchBlockIndex } from "../indexer.ts";

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
const alternate = {
	...base("04", "01"), type: "message", message: { role: "user", content: "alternate active branch", timestamp: 4 },
} as SessionEntry;
const label = { ...base("05", "04"), type: "label", targetId: "04", label: "checkpoint" } as SessionEntry;

describe("BranchBlockIndex", () => {
	it("incrementally reuses, merges, and rebuilds blocks across branch updates", () => {
		const index = new BranchBlockIndex();
		const first = index.updateEntries([user, call]);
		const userObject = first.find((block) => block.kind === "user");
		const callBefore = first.find((block) => block.toolCallId === "call-1");
		const unchanged = index.updateEntries([user, call]);
		assert.strictEqual(unchanged === first, true, "unchanged branch returns the same block array");

		const appended = index.updateEntries([user, call, result]);
		const callAfter = appended.find((block) => block.toolCallId === "call-1");
		assert.strictEqual(callAfter?.body, "complete stored result",
			"delayed result merges into its original tool row");
		assert.ok(appended.find((block) => block.kind === "user") === userObject,
			"ordinary old blocks are reused across append");
		assert.ok(callAfter !== callBefore, "the correlated tool block is replaced");
		assert.strictEqual(appended.filter((block) => block.kind === "tool").length, 1,
			"merged result does not create an orphan row");

		const rebuilt = index.updateEntries([user, alternate]);
		assert.deepStrictEqual(rebuilt.map((block) => block.body), ["start", "alternate active branch"],
			"branch change rebuild removes abandoned entries");

		const labeled = index.updateEntries([user, alternate, label], (id) => id === "04" ? "checkpoint" : undefined);
		assert.deepStrictEqual([labeled.length, labeled[1]?.label], [2, "checkpoint"],
			"label append refreshes target metadata without a row");
	});
});
