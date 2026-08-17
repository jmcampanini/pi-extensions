import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { ExplorerComponent } from "../component.ts";
import { extractBlocks } from "../extract.ts";
import { ExplorerState } from "../state.ts";
import type { Block } from "../types.ts";
import { buildFixtureSession } from "./fixture-session.ts";

const fixtureDirectory = resolve(".sandbox/fuzzy-explorer-frame-test");
mkdirSync(fixtureDirectory, { recursive: true });
const fixture = buildFixtureSession(fixtureDirectory);

function localShortTime(timestamp: string): string {
	const date = new Date(timestamp);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function frameChecks(width: number, lines: string[], label: string): void {
	assert.ok(lines.every((line) => visibleWidth(line) === width),
		`${label}: every line is exactly ${width} columns`);
	assert.ok(lines[0]?.startsWith("┌") === true && lines[0]?.endsWith("┐") === true
		&& lines.at(-1)?.startsWith("└") === true && lines.at(-1)?.endsWith("┘") === true,
		`${label}: square corners frame the surface`);
	assert.ok(lines.slice(1, -1).every((line) => (line.startsWith("│") && line.endsWith("│")) || (line.startsWith("├") && line.endsWith("┤"))),
		`${label}: interior lines are bordered content`);
}

describe("explorer frame end-to-end", () => {
	const session = SessionManager.open(fixture.sessionFile);
	const blocks: readonly Block[] = extractBlocks(session.getBranch(), (id) => session.getLabel(id));

	it("fixture extracts the expected active-branch blocks", () => {
		assert.strictEqual(blocks.length, 12);
	});

	it("a real branched session fixture drives the complete frame", (t) => {
		const newestTime = localShortTime(blocks.at(-1)!.timestamp);
		const readTime = localShortTime(blocks.find((candidate) => candidate.toolCallId === "call-read")!.timestamp);

		const tui = { terminal: { rows: 30 }, requestRender(): void {} } as unknown as TUI;
		const theme = {
			fg: (_token: string, text: string) => text,
			bg: (_token: string, text: string) => text,
			bold: (text: string) => text,
		} as unknown as Theme;
		const state = new ExplorerState("list");
		const component = new ExplorerComponent({
			tui,
			theme,
			state,
			getBlocks: () => blocks,
			actions: {
				async copy(): Promise<void> {},
				async open(): Promise<number | null> { return 0; },
			},
			notify: () => {},
			done: () => {},
			refreshIntervalMs: 60_000,
		});
		t.after(() => component.dispose());
		component.focused = true;

		// Search frame: chronological list anchored on the newest block.

		for (const width of [120, 100]) {
			const lines = component.render(width);
			frameChecks(width, lines, `list@${width}`);
			assert.strictEqual(lines.length, 27, `list@${width}: frame height uses the 90% budget`);
			assert.ok(lines[0]?.startsWith("┌ fuzzy ") === true && lines[0]?.endsWith(" 12/12 ┐") === true,
				`list@${width}: top border embeds title and totals`);
			assert.ok(lines[1]?.startsWith("│ › / to filter") === true,
				`list@${width}: input line advertises filtering`);
			assert.ok(lines.join("\n").includes("▸ User"), `list@${width}: newest user block is selected`);
			assert.ok(lines.some((line) => line.includes("▸ User") && line.includes("latest active user block")),
				`list@${width}: selected row shows its first body line`);
			assert.ok(lines.some((line) => line.includes("read") && line.includes("path=gone.log")),
				`list@${width}: tool rows show their argument details`);
			assert.ok(lines.some((line) => line.startsWith(`├ User · ${newestTime} `)),
				`list@${width}: preview rule carries the block identity`);
			assert.ok(lines.some((line) => line.startsWith("│ latest active user block")),
				`list@${width}: preview shows the selected body`);
			assert.ok(lines.at(-1)?.startsWith("└ l/enter detail · / filter · q/esc quit") === true,
				`list@${width}: hints render in the bottom border`);
		}

		// Rows: filter down to the merged read tool block.

		component.handleInput("/");
		component.handleInput("sconf");
		assert.deepStrictEqual(state.results.map((result) => result.block.toolCallId), ["call-read"],
			"fuzzy query narrows to the read invocation");
		const filtered = component.render(120);
		frameChecks(120, filtered, "filter@120");
		assert.ok(filtered[0]?.includes(" 1/12 ┐") === true, "filter@120: counts show narrowed matches");
		assert.ok(filtered.some((line) => line.includes("▸ read") && line.includes("path=src/config.ts")),
			"filter@120: the read row is selected with its argument detail");
		assert.ok(filtered.some((line) => line.includes("STORED_RESULT_ONLY_NEEDLE")),
			"filter@120: preview shows the stored result body");

		// Body-only match: the row swaps its detail for a grep-style excerpt.

		component.handleInput("\x15");
		component.handleInput("STORED_RESULT_ONLY_NEEDLE");
		assert.deepStrictEqual(state.results.map((result) => result.block.toolCallId), ["call-read"],
			"body needle finds the merged tool result");
		const excerptFrame = component.render(120);
		assert.ok(excerptFrame.some((line) => line.includes("▸ read") && line.includes("STORED_RESULT_ONLY_NEEDLE") && !line.includes("path=")),
			"body-only rows swap in the matching excerpt");

		// Detail frame: identity in the border, content from line one.

		component.handleInput("\r");
		assert.strictEqual(state.mode, "detail", "enter opens detail");
		for (const width of [120, 100]) {
			const lines = component.render(width);
			frameChecks(width, lines, `detail@${width}`);
			assert.strictEqual(lines.length, 27, `detail@${width}: frame height uses the 90% budget`);
			assert.ok(lines[0]?.startsWith(`┌ tool/read · ${readTime} `) === true && lines[0]?.endsWith(" 1/1 ┐") === true,
				`detail@${width}: border shows identity and position`);
			assert.ok(lines[1]?.startsWith("│ read {") === true,
				`detail@${width}: content starts on the first interior line`);
			assert.ok(lines.some((line) => line.includes("STORED_RESULT_ONLY_NEEDLE")),
				`detail@${width}: canonical content includes the stored result`);
			assert.ok(lines.at(-1)?.startsWith("└ j/k scroll") === true,
				`detail@${width}: hints render in the bottom border`);
			assert.ok(lines.at(-1)?.includes("o open src/config.ts:12") === true,
				`detail@${width}: hints include the smart-open target`);
			assert.ok(lines.at(-1)?.includes("m md") === true,
				`detail@${width}: raw-by-default tool detail offers the markdown toggle`);
		}

		// Round trip back to the list frame.

		component.handleInput("\x1b");
		assert.strictEqual(state.mode, "list", "escape returns to the list");
		const roundTrip = component.render(120);
		assert.ok(roundTrip.some((line) => line.includes("▸ read")), "round trip keeps the filtered selection");
	});
});
