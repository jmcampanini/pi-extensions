import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { ExplorerComponent } from "../component.ts";
import { ExplorerState } from "../state.ts";
import type { Block } from "../types.ts";
import { makeBlock } from "./block-factory.ts";

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

function block(index: number): Block {
	const body = `body ${index}\n${Array.from({ length: 20 }, (_, line) => `line-${index}-${line}`).join("\n")}`;
	return makeBlock({
		id: `block-${index}`,
		kind: index % 2 === 0 ? "user" : "assistant",
		entryId: `entry-${index}`,
		entryIds: [`entry-${index}`],
		timestamp: new Date(index * 1000).toISOString(),
		body,
	});
}

let blocks: readonly Block[] = Array.from({ length: 12 }, (_, index) => block(index));
let renders = 0;
const tui = {
	terminal: { rows: 24 },
	requestRender(): void { renders++; },
} as unknown as TUI;
let backgroundFills = 0;
const theme = {
	fg: (_token: string, text: string) => text,
	bg: (_token: string, text: string) => { backgroundFills++; return text; },
	bold: (text: string) => text,
} as unknown as Theme;
const state = new ExplorerState("list");
const copied: string[] = [];
const opened: string[] = [];
const notifications: string[] = [];
let doneCalls = 0;
const component = new ExplorerComponent({
	tui,
	theme,
	state,
	getBlocks: () => blocks,
	actions: {
		async copy(value): Promise<void> { copied.push(value.id); },
		async open(value): Promise<number | null> { opened.push(value.id); return 0; },
	},
	notify: (message) => notifications.push(message),
	done: () => { doneCalls++; },
	refreshIntervalMs: 60_000,
});
component.focused = true;

// Bordered frame anatomy

const initialLines = component.render(70);
const initialFrame = initialLines.join("\n");
eq("initial selection is the newest block", state.selected?.block.id, "block-11");
ok("top border embeds the fuzzy title", initialLines[0]?.startsWith("┌ fuzzy ") === true);
ok("top border embeds the match counts", initialLines[0]?.includes("12/12 ┐") === true);
ok("input line shows the filter affordance", initialLines[1]?.startsWith("│ › ") === true);
ok("a plain rule separates input from rows", initialLines[2]?.startsWith("├─") === true && initialLines[2]?.endsWith("┤") === true);
ok("selected row carries the marker", initialFrame.includes("▸ Assistant"));
ok("a titled rule introduces the preview", initialLines.some((line) => line.startsWith("├ Assistant · ")));
ok("a blank interior line precedes the preview rule",
	initialLines[initialLines.findIndex((line) => line.startsWith("├ Assistant · ")) - 1] === `│ ${" ".repeat(66)} │`);
ok("hints live in the bottom border", initialLines.at(-1)?.startsWith("└ l/enter detail · / filter · q/esc quit") === true);
ok("no interior help footer lines remain", initialLines.filter((line) => line.includes("enter detail")).length === 1);
ok("rows carry no timestamps", !initialFrame.includes("1970-01-01"));
eq("frame uses the default background with no fill", backgroundFills, 0);
ok("every line is exactly frame-width", initialLines.every((line) => visibleWidth(line) === 70));
eq("frame consumes exactly the height budget", initialLines.length, Math.floor(24 * 0.9));
eq("list and preview keep the 35/65 split",
	[initialLines[8], initialLines[9]?.startsWith("├ Assistant · ")],
	[`│ ${" ".repeat(66)} │`, true]);

// List navigation

component.handleInput("k");
eq("k moves to an earlier row", state.selected?.block.id, "block-10");
const beforePageUp = state.selected?.block.id;
component.handleInput("\x1b[5~");
eq("PageUp is deliberately unbound", state.selected?.block.id, beforePageUp);
component.handleInput("\x1b[6~");
eq("PageDown is deliberately unbound", state.selected?.block.id, beforePageUp);
component.handleInput("u");
ok("u pages upward by more than one row", state.selectedIndex < 9);
component.handleInput("G");
eq("G selects the displayed last row", state.selectedIndex, state.results.length - 1);
component.handleInput("g");
eq("g selects the displayed first row", state.selectedIndex, 0);

// Filter mode

component.handleInput("/");
eq("slash enters filter mode", state.mode, "filter");
component.handleInput("u");
component.handleInput("d");
component.handleInput("q");
component.handleInput("h");
component.handleInput("l");
component.handleInput("m");
eq("u, d, q, h, l, and m type while filtering instead of acting", state.query, "udqhlm");
component.handleInput("\x15");
eq("ctrl+u clears the filter query", state.query, "");
component.handleInput("body");
eq("printable filter text is applied live", state.query, "body");
eq("typing re-selects the top-ranked result", [state.selectedIndex, state.selected?.block.id], [0, "block-11"]);
const filterLines = component.render(70);
ok("filter hints replace list hints", filterLines.at(-1)?.includes("ctrl+u clear") === true);
ok("filter counts reflect the narrowed results", filterLines[0]?.includes(`${state.results.length}/12`) === true);
component.handleInput("\x1b[B");
ok("arrow keys navigate while the query remains active", state.query === "body" && state.selected?.block.id === "block-10");
component.handleInput("\x1b[D");
eq("cursor movement keys are not typing and keep the selection",
	[state.query, state.selected?.block.id], ["body", "block-10"]);
ok("the input line carries one prompt, not Input's doubled one",
	component.render(70)[1]?.startsWith("│ › ") === true && !component.render(70)[1]?.includes("› > "));
component.handleInput("\x1b");
eq("Escape leaves filter mode without clearing query", [state.mode, state.query], ["list", "body"]);
const staticQueryLines = component.render(70);
ok("list mode shows the static query text", staticQueryLines[1]?.startsWith("│ › body") === true);

// Detail mode

component.handleInput("\r");
eq("Enter opens full detail from list mode", state.mode, "detail");
const detailLines = component.render(50);
ok("detail top border shows the block identity", detailLines[0]?.startsWith("┌ user · ") === true);
ok("detail top border shows the position", detailLines[0]?.includes(`2/${state.results.length} ┐`) === true);
ok("detail content starts on the first interior line", detailLines[1]?.startsWith("│ body 10") === true);
ok("detail hints live in the bottom border", detailLines.at(-1)?.startsWith("└ j/k scroll") === true);
ok("rendered detail offers the raw toggle when hints fit", component.render(110).at(-1)?.includes("m raw") === true);
component.handleInput("m");
const rawDetail = component.render(110);
ok("m switches the current block to the raw stored text", rawDetail[1]?.startsWith("│ body 10 ") === true);
ok("raw detail offers the markdown toggle", rawDetail.at(-1)?.includes("m md") === true);
component.render(50);
const beforeDetailPage = state.detailOffset;
component.handleInput("d");
ok("d pages detail content", state.detailOffset > beforeDetailPage);
const detailSelected = state.selected?.block.id;
component.handleInput("K");
ok("K changes to the previous filtered block in detail", state.mode === "detail" && state.selected?.block.id !== detailSelected);
component.handleInput("\x1b[106;2u");
eq("Kitty-encoded J returns to the next block without leaving detail", [state.mode, state.selected?.block.id], ["detail", detailSelected]);
component.handleInput("y");
await new Promise<void>((resolve) => setImmediate(resolve));
eq("y copies the selected complete block", copied, [detailSelected]);
component.handleInput("o");
await new Promise<void>((resolve) => setImmediate(resolve));
eq("o smart-opens the selected block", opened, [detailSelected]);
component.handleInput("\x1b");
eq("Escape returns from detail with selection synced", [state.mode, state.selected?.block.id], ["list", detailSelected]);
component.handleInput("\r");
component.handleInput("q");
eq("q also returns from detail to the list without closing", [state.mode, doneCalls], ["list", 0]);
component.handleInput("l");
eq("l moves forward from a list item into its detail", state.mode, "detail");
const wideDetail = component.render(110);
ok("detail hints include the smart-open action", wideDetail.at(-1)?.includes("o open block text") === true);
component.handleInput("h");
eq("h moves backward out of detail to the list", [state.mode, doneCalls], ["list", 0]);

// Live data, resize, and shutdown

const pinned = state.selected?.block.id;
blocks = [...blocks, block(12)];
const resized = component.render(31);
eq("live appends and resize keep selection pinned by id", state.selected?.block.id, pinned);
ok("narrow rerender remains width safe", resized.every((line) => visibleWidth(line) <= 31));
ok("narrow hints degrade to top-priority keys", resized.at(-1)?.includes("enter detail") === true);
(tui.terminal as { rows: number }).rows = 10;
const shortTerminal = component.render(31);
ok("short-terminal render stays inside Pi's 90% height cap", shortTerminal.length <= Math.floor(10 * 0.9));
ok("short-terminal frame keeps its borders",
	shortTerminal[0]?.startsWith("┌") === true && shortTerminal.at(-1)?.startsWith("└") === true);
(tui.terminal as { rows: number }).rows = 4;
const tinyTerminal = component.render(31);
eq("tiny terminals still close the frame",
	[tinyTerminal.length, tinyTerminal[0]?.startsWith("┌"), tinyTerminal.at(-1)?.startsWith("└")],
	[3, true, true]);
(tui.terminal as { rows: number }).rows = 10;
component.handleInput("\x1b");
eq("Escape in list closes the explorer", doneCalls, 1);
component.handleInput("q");
eq("q in list also closes the explorer", doneCalls, 2);
ok("state changes request TUI renders", renders > 0);
ok("copy completion is notified", notifications.some((message) => message.includes("Copied")));
component.dispose();

// Markdown detail: rendered by default for prose kinds, raw behind the toggle.

const markdownState = new ExplorerState("list");
const markdownBlocks = [makeBlock({ id: "md-1", kind: "assistant", body: "Intro **bold** text" })];
const markdownComponent = new ExplorerComponent({
	tui,
	theme,
	state: markdownState,
	getBlocks: () => markdownBlocks,
	actions: {
		async copy(): Promise<void> {},
		async open(): Promise<number | null> { return 0; },
	},
	notify: () => {},
	done: () => {},
	refreshIntervalMs: 60_000,
});
markdownComponent.focused = true;
markdownComponent.render(80);
markdownComponent.handleInput("\r");
const renderedDetail = markdownComponent.render(80);
ok("markdown-default detail renders markup instead of showing it",
	renderedDetail[1]?.includes("Intro bold text") === true);
markdownComponent.handleInput("m");
const rawMarkdownDetail = markdownComponent.render(80);
ok("m reveals the raw markup", rawMarkdownDetail[1]?.includes("Intro **bold** text") === true);
ok("hints flip between raw and md",
	renderedDetail.at(-1)?.includes("m raw") === true && rawMarkdownDetail.at(-1)?.includes("m md") === true);
markdownComponent.dispose();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
