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

// End-to-end: a real branched session fixture drives the complete frame.

const fixtureDirectory = resolve(".sandbox/fuzzy-explorer-frame-test");
mkdirSync(fixtureDirectory, { recursive: true });
const fixture = buildFixtureSession(fixtureDirectory);
const session = SessionManager.open(fixture.sessionFile);
const blocks: readonly Block[] = extractBlocks(session.getBranch(), (id) => session.getLabel(id));
eq("fixture extracts the expected active-branch blocks", blocks.length, 12);

function localShortTime(timestamp: string): string {
	const date = new Date(timestamp);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
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
component.focused = true;

function frameChecks(width: number, lines: string[], label: string): void {
	ok(`${label}: every line is exactly ${width} columns`, lines.every((line) => visibleWidth(line) === width));
	ok(`${label}: square corners frame the surface`,
		lines[0]?.startsWith("┌") === true && lines[0]?.endsWith("┐") === true
		&& lines.at(-1)?.startsWith("└") === true && lines.at(-1)?.endsWith("┘") === true);
	ok(`${label}: interior lines are bordered content`,
		lines.slice(1, -1).every((line) => (line.startsWith("│") && line.endsWith("│")) || (line.startsWith("├") && line.endsWith("┤"))));
}

// Search frame: chronological list anchored on the newest block.

for (const width of [120, 100]) {
	const lines = component.render(width);
	frameChecks(width, lines, `list@${width}`);
	eq(`list@${width}: frame height uses the 90% budget`, lines.length, 27);
	ok(`list@${width}: top border embeds title and totals`,
		lines[0]?.startsWith("┌ fuzzy ") === true && lines[0]?.endsWith(" 12/12 ┐") === true);
	ok(`list@${width}: input line advertises filtering`, lines[1]?.startsWith("│ › / to filter") === true);
	ok(`list@${width}: newest user block is selected`, lines.join("\n").includes("▸ User"));
	ok(`list@${width}: selected row shows its first body line`,
		lines.some((line) => line.includes("▸ User") && line.includes("latest active user block")));
	ok(`list@${width}: tool rows show their argument details`,
		lines.some((line) => line.includes("read") && line.includes("path=gone.log")));
	ok(`list@${width}: preview rule carries the block identity`, lines.some((line) => line.startsWith(`├ User · ${newestTime} `)));
	ok(`list@${width}: preview shows the selected body`, lines.some((line) => line.startsWith("│ latest active user block")));
	ok(`list@${width}: hints render in the bottom border`, lines.at(-1)?.startsWith("└ l/enter detail · / filter · q/esc quit") === true);
}

// Rows: filter down to the merged read tool block.

component.handleInput("/");
component.handleInput("sconf");
eq("fuzzy query narrows to the read invocation", state.results.map((result) => result.block.toolCallId), ["call-read"]);
const filtered = component.render(120);
frameChecks(120, filtered, "filter@120");
ok("filter@120: counts show narrowed matches", filtered[0]?.includes(" 1/12 ┐") === true);
ok("filter@120: the read row is selected with its argument detail",
	filtered.some((line) => line.includes("▸ read") && line.includes("path=src/config.ts")));
ok("filter@120: preview shows the stored result body",
	filtered.some((line) => line.includes("STORED_RESULT_ONLY_NEEDLE")));

// Body-only match: the row swaps its detail for a grep-style excerpt.

component.handleInput("\x15");
component.handleInput("STORED_RESULT_ONLY_NEEDLE");
eq("body needle finds the merged tool result", state.results.map((result) => result.block.toolCallId), ["call-read"]);
const excerptFrame = component.render(120);
ok("body-only rows swap in the matching excerpt",
	excerptFrame.some((line) => line.includes("▸ read") && line.includes("STORED_RESULT_ONLY_NEEDLE") && !line.includes("path=")));

// Detail frame: identity in the border, content from line one.

component.handleInput("\r");
eq("enter opens detail", state.mode, "detail");
for (const width of [120, 100]) {
	const lines = component.render(width);
	frameChecks(width, lines, `detail@${width}`);
	eq(`detail@${width}: frame height uses the 90% budget`, lines.length, 27);
	ok(`detail@${width}: border shows identity and position`,
		lines[0]?.startsWith(`┌ tool/read · ${readTime} `) === true && lines[0]?.endsWith(" 1/1 ┐") === true);
	ok(`detail@${width}: content starts on the first interior line`, lines[1]?.startsWith("│ read {") === true);
	ok(`detail@${width}: canonical content includes the stored result`,
		lines.some((line) => line.includes("STORED_RESULT_ONLY_NEEDLE")));
	ok(`detail@${width}: hints render in the bottom border`, lines.at(-1)?.startsWith("└ j/k scroll") === true);
	ok(`detail@${width}: hints include the smart-open target`, lines.at(-1)?.includes("o open src/config.ts:12") === true);
	ok(`detail@${width}: raw-by-default tool detail offers the markdown toggle`, lines.at(-1)?.includes("m md") === true);
}

// Round trip back to the list frame.

component.handleInput("\x1b");
eq("escape returns to the list", state.mode, "list");
const roundTrip = component.render(120);
ok("round trip keeps the filtered selection", roundTrip.some((line) => line.includes("▸ read")));
component.dispose();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
