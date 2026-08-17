import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ExplorerState } from "../state.ts";
import type { Block } from "../types.ts";
import { makeBlock } from "./block-factory.ts";

function block(index: number, body = `body ${index}`): Block {
	return makeBlock({
		id: `entry-${index}:user`,
		kind: "user",
		entryId: `entry-${index}`,
		entryIds: [`entry-${index}`],
		timestamp: new Date(index * 1000).toISOString(),
		body,
	});
}

const blocks = Array.from({ length: 8 }, (_, index) => block(index));

describe("ExplorerState", () => {
	it("navigates, filters, syncs, and transitions modes over one live session", () => {
		const state = new ExplorerState("list");
		state.setListPageSize(3);
		state.syncBlocks(blocks);
		assert.strictEqual(state.totalBlocks, 8, "first load reports totals");
		assert.strictEqual(state.selected?.block.id, "entry-7:user",
			"cursor starts at the newest chronological block");
		assert.strictEqual(state.listViewport, 5, "viewport follows newest selection");
		state.moveSelection(-2);
		assert.strictEqual(state.selected?.block.id, "entry-5:user", "k-style movement selects earlier blocks");
		state.pageSelection(-1);
		assert.strictEqual(state.selected?.block.id, "entry-2:user", "u pages by visible list size");
		state.selectFirst();
		assert.strictEqual(state.selected?.block.id, "entry-0:user", "g selects first row");
		state.selectLast();
		assert.strictEqual(state.selected?.block.id, "entry-7:user", "G selects last row");

		state.selectFirst();
		state.setQuery("body");
		assert.deepStrictEqual([state.selectedIndex, state.selected?.block.id], [0, "entry-7:user"],
			"query change re-selects the top result even when the old selection survives");
		assert.deepStrictEqual(state.results.slice(0, 3).map((result) => result.block.id),
			["entry-7:user", "entry-6:user", "entry-5:user"],
			"active-query results rank newest first among score ties");
		state.setQuery("body 3");
		assert.deepStrictEqual([state.selectedIndex, state.selected?.block.id], [0, "entry-3:user"],
			"narrowing re-selects the new best result");
		state.setQuery("does-not-exist");
		assert.deepStrictEqual([state.results.length, state.selected], [0, undefined],
			"no results clears the selection");
		state.setQuery("body");
		assert.strictEqual(state.selected?.block.id, "entry-7:user",
			"a newly nonempty result set selects its best match");

		state.moveSelection(2);
		assert.strictEqual(state.selected?.block.id, "entry-5:user",
			"manual movement holds within active-query results");
		state.setQuery("body");
		assert.strictEqual(state.selected?.block.id, "entry-5:user",
			"re-setting an identical query is not a query change and keeps selection");
		state.syncBlocks([...blocks, block(8)]);
		assert.strictEqual(state.selected?.block.id, "entry-5:user", "live append keeps the selected id sticky");
		assert.strictEqual(state.results[0]?.block.id, "entry-8:user", "live append still joins the result set");
		state.setListPageSize(1);
		assert.deepStrictEqual([state.selected?.block.id, state.listViewport], ["entry-5:user", 3],
			"resize keeps selection and only changes viewport");

		state.setQuery("");
		assert.deepStrictEqual([state.selected?.block.id, state.selectedIndex], ["entry-8:user", 8],
			"an empty query re-anchors on the newest block");
		assert.deepStrictEqual([state.results[0]?.block.id, state.results.at(-1)?.block.id],
			["entry-0:user", "entry-8:user"],
			"empty-query results return to chronological order");

		state.setQuery("body");
		state.enterFilter();
		assert.strictEqual(state.mode, "filter", "slash enters filter mode");
		assert.deepStrictEqual([state.escape(), state.mode, state.query], [false, "list", "body"],
			"first Escape leaves filter and keeps query");
		assert.strictEqual(state.escape(), true, "Escape in list closes");
		state.enterDetail();
		assert.strictEqual(state.mode, "detail", "Enter opens detail");
		state.jumpDetail(1);
		assert.deepStrictEqual([state.selected?.block.id, state.mode], ["entry-7:user", "detail"],
			"J changes blocks without leaving detail");
		state.setDetailPageSize(4);
		state.pageDetail(1, 20);
		assert.strictEqual(state.detailOffset, 4, "d pages detail content");
		assert.deepStrictEqual([state.escape(), state.mode, state.selected?.block.id],
			[false, "list", "entry-7:user"],
			"Escape returns from detail with selection synced");

		state.enterDetail();
		assert.strictEqual(state.detailMarkdownOverride, undefined,
			"detail opens with the policy-default view");
		state.setDetailPageSize(4);
		state.scrollDetail(2, 20);
		state.toggleDetailMarkdown(true);
		assert.deepStrictEqual([state.detailMarkdownOverride, state.detailOffset], [false, 0],
			"m overrides the default and rescrolls");
		state.toggleDetailMarkdown(true);
		assert.strictEqual(state.detailMarkdownOverride, true, "m toggles back to rendered");
		state.jumpDetail(-1);
		assert.strictEqual(state.detailMarkdownOverride, undefined,
			"visiting another block returns to its policy default");
		state.escape();
	});

	it("filter open mode anchors on the newest block", () => {
		const filterOpen = new ExplorerState("filter");
		filterOpen.syncBlocks(blocks);
		assert.deepStrictEqual([filterOpen.mode, filterOpen.selected?.block.id], ["filter", "entry-7:user"]);
	});
});
