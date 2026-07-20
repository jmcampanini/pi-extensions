import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { ExplorerComponent } from "../component.ts";
import { ExplorerState } from "../state.ts";
import type { Block } from "../types.ts";

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
	return {
		id: `block-${index}`, kind: index % 2 === 0 ? "user" : "assistant", entryId: `entry-${index}`,
		entryIds: [`entry-${index}`], timestamp: new Date(index * 1000).toISOString(),
		fields: `${index % 2 === 0 ? "user" : "assistant"} entry-${index}`,
		body, title: index % 2 === 0 ? "user" : "assistant", canonicalText: body,
	};
}

let blocks: readonly Block[] = Array.from({ length: 12 }, (_, index) => block(index));
let renders = 0;
const tui = {
	terminal: { rows: 24 },
	requestRender(): void { renders++; },
} as unknown as TUI;
const theme = {
	fg: (_token: string, text: string) => text,
	bg: (_token: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;
const state = new ExplorerState("list", "chronological");
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

const initialLines = component.render(70);
eq("initial selection is the newest block", state.selected?.block.id, "block-11");
ok("list always renders a bottom preview", initialLines.some((line) => line.includes("Preview")));
ok("footer exposes both query operators", initialLines.join("\n").includes("is:<type>") && initialLines.join("\n").includes("tool:<name>"));
ok("boxed overlay remains width safe", initialLines.every((line) => visibleWidth(line) <= 70));
ok("component respects the overlay-height budget", initialLines.length <= Math.floor(24 * 0.9));

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

component.handleInput("/");
eq("slash enters filter mode", state.mode, "filter");
component.handleInput("u");
component.handleInput("d");
eq("u and d type while filtering", state.query, "ud");
component.handleInput("\x15");
eq("ctrl+u clears the filter query", state.query, "");
component.handleInput("body");
eq("printable filter text is applied live", state.query, "body");
const selectedBeforeArrow = state.selected?.block.id;
component.handleInput("\x1b[A");
ok("arrow keys navigate while the query remains active", state.query === "body" && state.selected?.block.id !== selectedBeforeArrow);
component.handleInput("\x1b");
eq("Escape leaves filter mode without clearing query", [state.mode, state.query], ["list", "body"]);

component.handleInput("\r");
eq("Enter opens full detail from list mode", state.mode, "detail");
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

const pinned = state.selected?.block.id;
blocks = [...blocks, block(12)];
const resized = component.render(31);
eq("live appends and resize keep selection pinned by id", state.selected?.block.id, pinned);
ok("narrow rerender remains width safe", resized.every((line) => visibleWidth(line) <= 31));
(tui.terminal as { rows: number }).rows = 10;
const shortTerminal = component.render(31);
ok("short-terminal render stays inside Pi's 90% height cap", shortTerminal.length <= Math.floor(10 * 0.9));
ok("short-terminal footer retains query operators", shortTerminal.join("\n").includes("is:<type>") && shortTerminal.join("\n").includes("tool:<name>"));
component.handleInput("\x1b");
eq("Escape in list closes the explorer", doneCalls, 1);
ok("state changes request TUI renders", renders > 0);
ok("copy completion is notified", notifications.some((message) => message.includes("Copied")));
component.dispose();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
