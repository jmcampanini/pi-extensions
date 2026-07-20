import { ExplorerState } from "../state.ts";
import type { Block } from "../types.ts";

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown): void {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}: got ${g}, want ${w}`); }
}

function block(index: number, body = `body ${index}`): Block {
	return {
		id: `entry-${index}:user`, kind: "user", entryId: `entry-${index}`,
		entryIds: [`entry-${index}`], timestamp: new Date(index * 1000).toISOString(),
		fields: `user entry-${index}`, body, title: "user", canonicalText: body,
	};
}

const blocks = Array.from({ length: 8 }, (_, index) => block(index));
const state = new ExplorerState("list", "chronological");
state.setListPageSize(3);
state.syncBlocks(blocks);
eq("cursor starts at newest chronological block", state.selected?.block.id, "entry-7:user");
eq("viewport follows newest selection", state.listViewport, 5);
state.moveSelection(-2);
eq("k-style movement selects earlier blocks", state.selected?.block.id, "entry-5:user");
state.pageSelection(-1);
eq("u pages by visible list size", state.selected?.block.id, "entry-2:user");
state.selectFirst();
eq("g selects first row", state.selected?.block.id, "entry-0:user");
state.selectLast();
eq("G selects last row", state.selected?.block.id, "entry-7:user");

state.setQuery("body 7");
eq("filter keeps a surviving selection pinned by id", state.selected?.block.id, "entry-7:user");
state.setQuery("does-not-exist");
state.setQuery("body");
eq("a newly nonempty result set selects its newest match", state.selected?.block.id, "entry-7:user");
state.syncBlocks([...blocks, block(8)]);
eq("live append keeps the selected id", state.selected?.block.id, "entry-7:user");
state.setListPageSize(1);
eq("resize keeps selection and only changes viewport", [state.selected?.block.id, state.listViewport], ["entry-7:user", 7]);

state.enterFilter();
eq("slash enters filter mode", state.mode, "filter");
eq("first Escape leaves filter and keeps query", [state.escape(), state.mode, state.query], [false, "list", "body"]);
eq("Escape in list closes", state.escape(), true);
state.enterDetail();
eq("Enter opens detail", state.mode, "detail");
state.jumpDetail(1);
eq("J changes blocks without leaving detail", [state.selected?.block.id, state.mode], ["entry-8:user", "detail"]);
state.setDetailPageSize(4);
state.pageDetail(1, 20);
eq("d pages detail content", state.detailOffset, 4);
eq("Escape returns from detail with selection synced", [state.escape(), state.mode, state.selected?.block.id], [false, "list", "entry-8:user"]);

const reverse = new ExplorerState("filter", "reverse-chronological");
reverse.syncBlocks(blocks);
eq("newest is selected even when it is the first displayed row", [reverse.mode, reverse.selectedIndex, reverse.selected?.block.id], ["filter", 0, "entry-7:user"]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
