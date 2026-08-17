import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { ExplorerComponent } from "../component.ts";
import { ExplorerState } from "../state.ts";
import type { Block } from "../types.ts";
import { makeBlock } from "./block-factory.ts";

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

describe("ExplorerComponent", () => {
	it("drives frame anatomy, navigation, filtering, detail, live data, and shutdown through one session", async (t) => {
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
		t.after(() => component.dispose());
		component.focused = true;

		// Bordered frame anatomy

		const initialLines = component.render(70);
		const initialFrame = initialLines.join("\n");
		assert.strictEqual(state.selected?.block.id, "block-11", "initial selection is the newest block");
		assert.ok(initialLines[0]?.startsWith("┌ fuzzy ") === true, "top border embeds the fuzzy title");
		assert.ok(initialLines[0]?.includes("12/12 ┐") === true, "top border embeds the match counts");
		assert.ok(initialLines[1]?.startsWith("│ › ") === true, "input line shows the filter affordance");
		assert.ok(initialLines[2]?.startsWith("├─") === true && initialLines[2]?.endsWith("┤") === true,
			"a plain rule separates input from rows");
		assert.ok(initialFrame.includes("▸ Assistant"), "selected row carries the marker");
		assert.ok(initialLines.some((line) => line.startsWith("├ Assistant · ")),
			"a titled rule introduces the preview");
		assert.ok(initialLines[initialLines.findIndex((line) => line.startsWith("├ Assistant · ")) - 1] === `│ ${" ".repeat(66)} │`,
			"a blank interior line precedes the preview rule");
		assert.ok(initialLines.at(-1)?.startsWith("└ l/enter detail · / filter · q/esc quit") === true,
			"hints live in the bottom border");
		assert.ok(initialLines.filter((line) => line.includes("enter detail")).length === 1,
			"no interior help footer lines remain");
		assert.ok(!initialFrame.includes("1970-01-01"), "rows carry no timestamps");
		assert.strictEqual(backgroundFills, 0, "frame uses the default background with no fill");
		assert.ok(initialLines.every((line) => visibleWidth(line) === 70), "every line is exactly frame-width");
		assert.strictEqual(initialLines.length, Math.floor(24 * 0.9), "frame consumes exactly the height budget");
		assert.deepStrictEqual(
			[initialLines[8], initialLines[9]?.startsWith("├ Assistant · ")],
			[`│ ${" ".repeat(66)} │`, true],
			"list and preview keep the 35/65 split");

		// List navigation

		component.handleInput("k");
		assert.strictEqual(state.selected?.block.id, "block-10", "k moves to an earlier row");
		const beforePageUp = state.selected?.block.id;
		component.handleInput("\x1b[5~");
		assert.strictEqual(state.selected?.block.id, beforePageUp, "PageUp is deliberately unbound");
		component.handleInput("\x1b[6~");
		assert.strictEqual(state.selected?.block.id, beforePageUp, "PageDown is deliberately unbound");
		component.handleInput("u");
		assert.ok(state.selectedIndex < 9, "u pages upward by more than one row");
		component.handleInput("G");
		assert.strictEqual(state.selectedIndex, state.results.length - 1, "G selects the displayed last row");
		component.handleInput("g");
		assert.strictEqual(state.selectedIndex, 0, "g selects the displayed first row");

		// Filter mode

		component.handleInput("/");
		assert.strictEqual(state.mode, "filter", "slash enters filter mode");
		component.handleInput("u");
		component.handleInput("d");
		component.handleInput("q");
		component.handleInput("h");
		component.handleInput("l");
		component.handleInput("m");
		assert.strictEqual(state.query, "udqhlm", "u, d, q, h, l, and m type while filtering instead of acting");
		component.handleInput("\x15");
		assert.strictEqual(state.query, "", "ctrl+u clears the filter query");
		component.handleInput("body");
		assert.strictEqual(state.query, "body", "printable filter text is applied live");
		assert.deepStrictEqual([state.selectedIndex, state.selected?.block.id], [0, "block-11"],
			"typing re-selects the top-ranked result");
		const filterLines = component.render(70);
		assert.ok(filterLines.at(-1)?.includes("ctrl+u clear") === true, "filter hints replace list hints");
		assert.ok(filterLines[0]?.includes(`${state.results.length}/12`) === true,
			"filter counts reflect the narrowed results");
		component.handleInput("\x1b[B");
		assert.ok(state.query === "body" && state.selected?.block.id === "block-10",
			"arrow keys navigate while the query remains active");
		component.handleInput("\x1b[D");
		assert.deepStrictEqual([state.query, state.selected?.block.id], ["body", "block-10"],
			"cursor movement keys are not typing and keep the selection");
		assert.ok(component.render(70)[1]?.startsWith("│ › ") === true && !component.render(70)[1]?.includes("› > "),
			"the input line carries one prompt, not Input's doubled one");
		component.handleInput("\x1b");
		assert.deepStrictEqual([state.mode, state.query], ["list", "body"],
			"Escape leaves filter mode without clearing query");
		const staticQueryLines = component.render(70);
		assert.ok(staticQueryLines[1]?.startsWith("│ › body") === true, "list mode shows the static query text");

		// Detail mode

		component.handleInput("\r");
		assert.strictEqual(state.mode, "detail", "Enter opens full detail from list mode");
		const detailLines = component.render(50);
		assert.ok(detailLines[0]?.startsWith("┌ user · ") === true, "detail top border shows the block identity");
		assert.ok(detailLines[0]?.includes(`2/${state.results.length} ┐`) === true,
			"detail top border shows the position");
		assert.ok(detailLines[1]?.startsWith("│ body 10") === true, "detail content starts on the first interior line");
		assert.ok(detailLines.at(-1)?.startsWith("└ j/k scroll") === true, "detail hints live in the bottom border");
		assert.ok(component.render(110).at(-1)?.includes("m raw") === true,
			"rendered detail offers the raw toggle when hints fit");
		component.handleInput("m");
		const rawDetail = component.render(110);
		assert.ok(rawDetail[1]?.startsWith("│ body 10 ") === true,
			"m switches the current block to the raw stored text");
		assert.ok(rawDetail.at(-1)?.includes("m md") === true, "raw detail offers the markdown toggle");
		component.render(50);
		const beforeDetailPage = state.detailOffset;
		component.handleInput("d");
		assert.ok(state.detailOffset > beforeDetailPage, "d pages detail content");
		const detailSelected = state.selected?.block.id;
		component.handleInput("K");
		assert.ok(state.mode === "detail" && state.selected?.block.id !== detailSelected,
			"K changes to the previous filtered block in detail");
		component.handleInput("\x1b[106;2u");
		assert.deepStrictEqual([state.mode, state.selected?.block.id], ["detail", detailSelected],
			"Kitty-encoded J returns to the next block without leaving detail");
		component.handleInput("y");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepStrictEqual(copied, [detailSelected], "y copies the selected complete block");
		component.handleInput("o");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepStrictEqual(opened, [detailSelected], "o smart-opens the selected block");
		component.handleInput("\x1b");
		assert.deepStrictEqual([state.mode, state.selected?.block.id], ["list", detailSelected],
			"Escape returns from detail with selection synced");
		component.handleInput("\r");
		component.handleInput("q");
		assert.deepStrictEqual([state.mode, doneCalls], ["list", 0],
			"q also returns from detail to the list without closing");
		component.handleInput("l");
		assert.strictEqual(state.mode, "detail", "l moves forward from a list item into its detail");
		const wideDetail = component.render(110);
		assert.ok(wideDetail.at(-1)?.includes("o open block text") === true,
			"detail hints include the smart-open action");
		component.handleInput("h");
		assert.deepStrictEqual([state.mode, doneCalls], ["list", 0], "h moves backward out of detail to the list");

		// Live data, resize, and shutdown

		const pinned = state.selected?.block.id;
		blocks = [...blocks, block(12)];
		const resized = component.render(31);
		assert.strictEqual(state.selected?.block.id, pinned,
			"live appends and resize keep selection pinned by id");
		assert.ok(resized.every((line) => visibleWidth(line) <= 31), "narrow rerender remains width safe");
		assert.ok(resized.at(-1)?.includes("enter detail") === true, "narrow hints degrade to top-priority keys");
		(tui.terminal as { rows: number }).rows = 10;
		const shortTerminal = component.render(31);
		assert.ok(shortTerminal.length <= Math.floor(10 * 0.9),
			"short-terminal render stays inside Pi's 90% height cap");
		assert.ok(shortTerminal[0]?.startsWith("┌") === true && shortTerminal.at(-1)?.startsWith("└") === true,
			"short-terminal frame keeps its borders");
		(tui.terminal as { rows: number }).rows = 4;
		const tinyTerminal = component.render(31);
		assert.deepStrictEqual(
			[tinyTerminal.length, tinyTerminal[0]?.startsWith("┌"), tinyTerminal.at(-1)?.startsWith("└")],
			[3, true, true],
			"tiny terminals still close the frame");
		(tui.terminal as { rows: number }).rows = 10;
		component.handleInput("\x1b");
		assert.strictEqual(doneCalls, 1, "Escape in list closes the explorer");
		component.handleInput("q");
		assert.strictEqual(doneCalls, 2, "q in list also closes the explorer");
		assert.ok(renders > 0, "state changes request TUI renders");
		assert.ok(notifications.some((message) => message.includes("Copied")), "copy completion is notified");
	});

	it("markdown detail renders by default for prose kinds with raw behind the toggle", (t) => {
		const tui = { terminal: { rows: 24 }, requestRender(): void {} } as unknown as TUI;
		const theme = {
			fg: (_token: string, text: string) => text,
			bg: (_token: string, text: string) => text,
			bold: (text: string) => text,
		} as unknown as Theme;
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
		t.after(() => markdownComponent.dispose());
		markdownComponent.focused = true;
		markdownComponent.render(80);
		markdownComponent.handleInput("\r");
		const renderedDetail = markdownComponent.render(80);
		assert.ok(renderedDetail[1]?.includes("Intro bold text") === true,
			"markdown-default detail renders markup instead of showing it");
		markdownComponent.handleInput("m");
		const rawMarkdownDetail = markdownComponent.render(80);
		assert.ok(rawMarkdownDetail[1]?.includes("Intro **bold** text") === true, "m reveals the raw markup");
		assert.ok(renderedDetail.at(-1)?.includes("m raw") === true && rawMarkdownDetail.at(-1)?.includes("m md") === true,
			"hints flip between raw and md");
	});
});
