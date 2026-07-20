import { ExplorerState } from "../state.ts";
import type { Block } from "../types.ts";
import { makeBlock } from "./block-factory.ts";

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown): void {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}: got ${g}, want ${w}`); }
}

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
const state = new ExplorerState("list");
state.setListPageSize(3);
state.syncBlocks(blocks);
eq("first load reports totals", state.totalBlocks, 8);
eq("cursor starts at the newest chronological block", state.selected?.block.id, "entry-7:user");
eq("viewport follows newest selection", state.listViewport, 5);
state.moveSelection(-2);
eq("k-style movement selects earlier blocks", state.selected?.block.id, "entry-5:user");
state.pageSelection(-1);
eq("u pages by visible list size", state.selected?.block.id, "entry-2:user");
state.selectFirst();
eq("g selects first row", state.selected?.block.id, "entry-0:user");
state.selectLast();
eq("G selects last row", state.selected?.block.id, "entry-7:user");

// Typing resets selection to the best result; block sync stays sticky.

state.selectFirst();
state.setQuery("body");
eq("query change re-selects the top result even when the old selection survives",
	[state.selectedIndex, state.selected?.block.id], [0, "entry-7:user"]);
eq("active-query results rank newest first among score ties",
	state.results.slice(0, 3).map((result) => result.block.id),
	["entry-7:user", "entry-6:user", "entry-5:user"]);
state.setQuery("body 3");
eq("narrowing re-selects the new best result", [state.selectedIndex, state.selected?.block.id], [0, "entry-3:user"]);
state.setQuery("does-not-exist");
eq("no results clears the selection", [state.results.length, state.selected], [0, undefined]);
state.setQuery("body");
eq("a newly nonempty result set selects its best match", state.selected?.block.id, "entry-7:user");

state.moveSelection(2);
eq("manual movement holds within active-query results", state.selected?.block.id, "entry-5:user");
state.setQuery("body");
eq("re-setting an identical query is not a query change and keeps selection",
	state.selected?.block.id, "entry-5:user");
state.syncBlocks([...blocks, block(8)]);
eq("live append keeps the selected id sticky", state.selected?.block.id, "entry-5:user");
eq("live append still joins the result set", state.results[0]?.block.id, "entry-8:user");
state.setListPageSize(1);
eq("resize keeps selection and only changes viewport", [state.selected?.block.id, state.listViewport],
	["entry-5:user", 3]);

state.setQuery("");
eq("an empty query re-anchors on the newest block",
	[state.selected?.block.id, state.selectedIndex], ["entry-8:user", 8]);
eq("empty-query results return to chronological order",
	[state.results[0]?.block.id, state.results.at(-1)?.block.id], ["entry-0:user", "entry-8:user"]);

// Mode transitions

state.setQuery("body");
state.enterFilter();
eq("slash enters filter mode", state.mode, "filter");
eq("first Escape leaves filter and keeps query", [state.escape(), state.mode, state.query], [false, "list", "body"]);
eq("Escape in list closes", state.escape(), true);
state.enterDetail();
eq("Enter opens detail", state.mode, "detail");
state.jumpDetail(1);
eq("J changes blocks without leaving detail", [state.selected?.block.id, state.mode], ["entry-7:user", "detail"]);
state.setDetailPageSize(4);
state.pageDetail(1, 20);
eq("d pages detail content", state.detailOffset, 4);
eq("Escape returns from detail with selection synced", [state.escape(), state.mode, state.selected?.block.id],
	[false, "list", "entry-7:user"]);

const filterOpen = new ExplorerState("filter");
filterOpen.syncBlocks(blocks);
eq("filter open mode anchors on the newest block",
	[filterOpen.mode, filterOpen.selected?.block.id], ["filter", "entry-7:user"]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
