import {
	FORK_MARK,
	WORKTREE_MARK,
	clampToolName,
	displayColumns,
	formatElapsed,
	formatResultContextLine,
	formatRunningWidgetLines,
	formatTokens,
	formatToolElapsed,
	stripAgentPrefix,
	type WidgetRow,
} from "../widget.ts";

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown) {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}:\n    got  ${g}\n    want ${w}`); }
}

// elapsed formatting
eq("mm:ss", formatElapsed(83), "01:23");
eq("h:mm:ss past an hour", formatElapsed(3723), "1:02:03");

// prefix strip: exact type + separator only
eq("strips 'Scout: Auth'", stripAgentPrefix("Scout: Auth", "scout"), "Auth");
eq("strips dash separator", stripAgentPrefix("worker - quick fix", "worker"), "quick fix");
eq("keeps non-matching prefix", stripAgentPrefix("Scouting: Auth", "scout"), "Scouting: Auth");
eq("keeps name without separator", stripAgentPrefix("Scout Auth", "scout"), "Scout Auth");
eq("keeps name when strip would empty it", stripAgentPrefix("scout: ", "scout"), "scout: ");
eq("no agent, no strip", stripAgentPrefix("Scout: Auth", undefined), "Scout: Auth");
eq(
	"prefix stripping removes terminal controls first",
	stripAgentPrefix("Scout: Au\x1b]52;c;Zm9v\x07th\0", "scout\x1b[2J"),
	"Auth",
);

// full rows at a comfortable width
const rows = [
	{ name: "Scout: Auth", agent: "scout", elapsedSeconds: 23 },
	{ name: "quick fix", agent: "worker", elapsedSeconds: 4 },
];
const lines = formatRunningWidgetLines(rows, 60);
eq("border rule + child rows, no footer", lines.length, 3);
eq("top rule spans width", lines[0], "─".repeat(60));
eq("row 1", lines[1], " [scout]     Auth" + " ".repeat(60 - 17 - 6) + "00:23 ");
eq("row 2", lines[2], " [worker]    quick fix" + " ".repeat(60 - 22 - 6) + "00:04 ");
eq("rows exactly width wide", lines.every((l) => l.length === 60), true);

// style hooks wrap ONLY the clock, the state slot, and the rule; layout math
// stays plain
const styled = formatRunningWidgetLines(rows, 60, { dim: (t) => `<D>${t}</D>`, border: (t) => `<B>${t}</B>` });
eq("border styled", styled[0], `<B>${"─".repeat(60)}</B>`);
eq("clock styled + trailing space", styled[1].endsWith("<D>00:23</D> "), true);
eq("styled row plain-length preserved", styled[1].replaceAll("<D>", "").replaceAll("</D>", "").length, 60);

// narrow width: name truncates, tag + clock survive
const narrow = formatRunningWidgetLines(
	[{ name: "a very long task name that cannot possibly fit", agent: "scout", elapsedSeconds: 61 }], 30);
eq("narrow keeps clock one off the edge", narrow[1].endsWith("01:01 "), true);
eq("narrow keeps tag", narrow[1].startsWith(" [scout]"), true);
eq("narrow truncates with ellipsis", narrow[1].includes("…"), true);
eq("narrow row fits width", narrow[1].length <= 30, true);

// bare (pre-worker resume) row: blank tag column, still aligned
const mixed = formatRunningWidgetLines(
	[{ name: "old resume", agent: undefined, elapsedSeconds: 10 },
	 { name: "Auth", agent: "scout", elapsedSeconds: 20 }], 50);
eq("blank tag pads to column", mixed[1].startsWith(" ".repeat(12) + "old resume"), true);

// state slot: fixed fork + worktree columns between the tag and the name,
// blank when a state doesn't apply, so names align across rows
const stateRows = [
	{ name: "Auth", agent: "scout", elapsedSeconds: 23, forked: true, worktree: true },
	{ name: "quick fix", agent: "worker", elapsedSeconds: 4 },
	{ name: "API review", agent: "judge", elapsedSeconds: 72, worktree: true },
];
const stateLines = formatRunningWidgetLines(stateRows, 60);
eq("forked worktree row shows both marks", stateLines[1],
	` [scout]  ${FORK_MARK}${WORKTREE_MARK} Auth` + " ".repeat(37) + "00:23 ");
eq("stateless row gets a blank slot, name still aligned", stateLines[2],
	" [worker]    quick fix" + " ".repeat(32) + "00:04 ");
eq("worktree-only row leaves the fork column blank", stateLines[3],
	` [judge]   ${WORKTREE_MARK} API review` + " ".repeat(31) + "01:12 ");
eq("state rows exactly width wide", stateLines.every((l) => l.length === 60), true);

// without a slot hook the marks fall back to dim; layout math stays plain
const stateStyled = formatRunningWidgetLines(stateRows, 60, { dim: (t) => `<D>${t}</D>` });
eq("mark slot falls back to dim", stateStyled[1].includes(`<D>${FORK_MARK}${WORKTREE_MARK}</D> Auth`), true);
eq("styled state row plain-length preserved",
	stateStyled[1].replaceAll("<D>", "").replaceAll("</D>", "").length, 60);

// a dedicated slot hook wins over dim, so pi can render the marks fainter
const slotStyled = formatRunningWidgetLines(stateRows, 60,
	{ dim: (t) => `<D>${t}</D>`, slot: (t) => `<S>${t}</S>` });
eq("slot hook styles the marks", slotStyled[1].includes(`<S>${FORK_MARK}${WORKTREE_MARK}</S> Auth`), true);
eq("clock still uses dim", slotStyled[1].endsWith("<D>00:23</D> "), true);

// narrow width with a state slot: icons survive, the name gives way
const narrowState = formatRunningWidgetLines(
	[{ name: "a very long task name that cannot possibly fit", agent: "scout", elapsedSeconds: 61, forked: true }], 30);
eq("narrow keeps the state slot", narrowState[1].includes(` [scout] ${FORK_MARK}  `), true);
eq("narrow state row truncates with ellipsis", narrowState[1].includes("…"), true);
eq("narrow state row fits width", narrowState[1].length <= 30, true);

// no width may overflow — pi's TUI crashes on a widget line wider than the
// terminal. Worst case: long tag, both marks, H:MM:SS clock, long name.
const overflowRows = [
	{ name: "a very long task name that cannot possibly fit", agent: "code-reviewer", elapsedSeconds: 3723, forked: true, worktree: true },
	{ name: "x", elapsedSeconds: 0 },
];
let widthViolations = 0;
for (let w = -2; w <= 45; w++) {
	// Negative widths must not throw and must emit empty lines (max(0, w)).
	for (const line of formatRunningWidgetLines(overflowRows, w)) {
		if (line.length > Math.max(0, w)) widthViolations++;
	}
}
eq("no line ever exceeds the render width", widthViolations, 0);

const hostileRow = formatRunningWidgetLines(
	[{ name: "safe\x1b]52;c;Zm9v\x07 name\0", agent: "worker\x1b[2J", elapsedSeconds: 1 }],
	50,
);
eq("widget removes input terminal controls", hostileRow.join("").includes("\x1b"), false);
eq("widget preserves safe identity text", hostileRow[1].includes("[worker]    safe name"), true);

// ── v2 liveness: the status segment ──────────────────────────────────────

// A row without a status renders byte-identical to the v1 row even when the
// other segment fields are present — the whole v1 block above is the oracle.
const v2NoStatusRows: WidgetRow[] = [
	{ name: "Scout: Auth", agent: "scout", elapsedSeconds: 23, toolName: "bash", toolElapsedSeconds: 420, contextTokens: 84_000 },
	{ name: "quick fix", agent: "worker", elapsedSeconds: 4 },
];
eq("rows without status render exact v1 rows", formatRunningWidgetLines(v2NoStatusRows, 60), lines);

// The section-6 example block, pinned exactly at width 78: full segment on
// the active row, tokens-only on the waiting row, bare word on the stalled.
const exampleRows: WidgetRow[] = [
	{ name: "Auth", agent: "scout", elapsedSeconds: 192, forked: true, worktree: true,
	  status: "active", toolName: "bash", toolElapsedSeconds: 420, contextTokens: 84_000 },
	{ name: "quick fix", agent: "worker", elapsedSeconds: 41, status: "waiting", contextTokens: 5_700 },
	{ name: "API review", agent: "judge", elapsedSeconds: 72, worktree: true, status: "stalled" },
];
const exampleLines = formatRunningWidgetLines(exampleRows, 78);
eq("example block: active row", exampleLines[1],
	" [scout]  fw Auth" + " ".repeat(31) + "active · bash 7m · 84k  03:12 ");
eq("example block: waiting row rounds the tokens", exampleLines[2],
	" [worker]    quick fix" + " ".repeat(36) + "waiting · 6k  00:41 ");
eq("example block: stalled row", exampleLines[3],
	" [judge]   w API review" + " ".repeat(40) + "stalled  01:12 ");
eq("example block rows exactly width wide", exampleLines.every((l) => l.length === 78), true);

// starting row exact string
const startingLines = formatRunningWidgetLines(
	[{ name: "boot up", agent: "worker", elapsedSeconds: 5, status: "starting" }] as WidgetRow[], 50);
eq("starting row", startingLines[1],
	" [worker]    boot up" + " ".repeat(14) + "starting" + "  00:05 ");

// stalled-only row exact string
const stalledLines = formatRunningWidgetLines(
	[{ name: "API review", agent: "judge", elapsedSeconds: 72, status: "stalled" }] as WidgetRow[], 40);
eq("stalled-only row", stalledLines[1], " [judge]    API review   stalled  01:12 ");

// The degradation ladder on one row at descending widths: full segment, then
// the tool drops, then the tokens, then the whole segment, then the name
// goes to ellipsis, then the identity-only plain clamp — in that order.
const ladderRow: WidgetRow[] = [{ name: "Auth refactor", agent: "scout", elapsedSeconds: 192,
	status: "active", toolName: "bash", toolElapsedSeconds: 420, contextTokens: 84_000 }];
const ladderAt = (w: number) => formatRunningWidgetLines(ladderRow, w)[1];
eq("ladder 54: full segment, name clipped to the 10-col floor", ladderAt(54),
	" [scout]    Auth refa…  active · bash 7m · 84k  03:12 ");
eq("ladder 53: tool drops first, full name returns", ladderAt(53),
	" [scout]    Auth refactor" + " ".repeat(8) + "active · 84k  03:12 ");
eq("ladder 44: tokens kept, name back at the floor", ladderAt(44),
	" [scout]    Auth refa…  active · 84k  03:12 ");
eq("ladder 43: status word only, full name", ladderAt(43),
	" [scout]    Auth refactor    active  03:12 ");
eq("ladder 38: status word only, name at the floor", ladderAt(38),
	" [scout]    Auth refa…  active  03:12 ");
eq("ladder 37: no segment — geometrically the exact v1 row", ladderAt(37),
	" [scout]    Auth refactor      03:12 ");
eq("ladder 32: v1 name ellipsis", ladderAt(32), " [scout]    Auth refact…  03:12 ");
eq("ladder 17: identity-only plain clamp", ladderAt(17), " [scout]    03:12");

// Name floor: 10 columns minimum for a long name; a short name only demands
// its own length and is NEVER truncated to make room for a segment.
eq("floor: clipped name is exactly 10 columns", ladderAt(54).includes(" Auth refa… "), true);
const shortNameRow: WidgetRow[] = [{ name: "Auth", agent: "scout", elapsedSeconds: 192,
	status: "active", toolName: "bash", toolElapsedSeconds: 420, contextTokens: 84_000 }];
eq("short name 48: full segment fits alongside the whole name",
	formatRunningWidgetLines(shortNameRow, 48)[1],
	" [scout]    Auth  active · bash 7m · 84k  03:12 ");
eq("short name 47: segment degrades, name stays whole",
	formatRunningWidgetLines(shortNameRow, 47)[1],
	" [scout]    Auth" + " ".repeat(11) + "active · 84k  03:12 ");
eq("short name never gains an ellipsis for a segment",
	formatRunningWidgetLines(shortNameRow, 47)[1].includes("…"), false);

// Mixed tiers at ONE width: a full-segment row and a stalled row sharing a
// tagWidth — every line exactly the width, both clocks on the right edge.
const mixedTierRows: WidgetRow[] = [
	{ name: "Auth", agent: "scout", elapsedSeconds: 192, status: "active",
	  toolName: "bash", toolElapsedSeconds: 420, contextTokens: 84_000 },
	{ name: "API review", agent: "judge", elapsedSeconds: 72, status: "stalled" },
];
const mixedTier = formatRunningWidgetLines(mixedTierRows, 60);
eq("mixed tiers: full-segment row", mixedTier[1],
	" [scout]    Auth" + " ".repeat(14) + "active · bash 7m · 84k  03:12 ");
eq("mixed tiers: stalled row", mixedTier[2],
	" [judge]    API review" + " ".repeat(23) + "stalled  01:12 ");
eq("mixed tiers: rows exactly width wide", mixedTier.every((l) => l.length === 60), true);
eq("mixed tiers: both clocks end at the right edge",
	mixedTier[1].endsWith("03:12 ") && mixedTier[2].endsWith("01:12 "), true);

// Style hooks: the segment renders dim normally and warn iff stalled; the
// clock stays dim; stripping the tags recovers the exact plain width.
const segStyled = formatRunningWidgetLines(mixedTierRows, 60,
	{ dim: (t) => `<D>${t}</D>`, warn: (t) => `<W>${t}</W>` });
eq("segment dim on active", segStyled[1].includes("<D>active · bash 7m · 84k</D>  <D>03:12</D> "), true);
eq("segment warn on stalled, clock still dim", segStyled[2].includes("<W>stalled</W>  <D>01:12</D> "), true);
eq("warn never touches a non-stalled row", segStyled[1].includes("<W>"), false);
eq("stripped active row length still exact", segStyled[1]
	.replaceAll("<D>", "").replaceAll("</D>", "").length, 60);
eq("stripped stalled row length still exact", segStyled[2]
	.replaceAll("<D>", "").replaceAll("</D>", "").replaceAll("<W>", "").replaceAll("</W>", "").length, 60);
const warnFallback = formatRunningWidgetLines(mixedTierRows, 60, { dim: (t) => `<D>${t}</D>` });
eq("warn falls back to dim", warnFallback[2].includes("<D>stalled</D>  <D>01:12</D> "), true);

// Tool part renders only while active — waiting rows keep the tokens alone.
const waitingTool = formatRunningWidgetLines(
	[{ name: "Auth", agent: "scout", elapsedSeconds: 41, status: "waiting",
	   toolName: "bash", toolElapsedSeconds: 9, contextTokens: 6_000 }] as WidgetRow[], 60);
eq("tool part only renders while active", waitingTool[1].includes("bash"), false);
eq("waiting keeps the tokens", waitingTool[1].includes("waiting · 6k"), true);

// Unknown context renders as absence, not "?"; tokens render as whole
// thousands and clamp at 0 below.
const noTokens = formatRunningWidgetLines(
	[{ name: "Auth", agent: "scout", elapsedSeconds: 192, status: "active",
	   toolName: "bash", toolElapsedSeconds: 420 }] as WidgetRow[], 60);
eq("unknown context renders as absence", noTokens[1].includes("active · bash 7m  03:12 "), true);
eq("no stray tokens part", /\d+k/.test(noTokens[1]), false);
const bigTokens = formatRunningWidgetLines(
	[{ name: "Auth", agent: "scout", elapsedSeconds: 41, status: "waiting", contextTokens: 1_234_900 }] as WidgetRow[], 60);
eq("big counts stay whole thousands", bigTokens[1].includes("waiting · 1235k"), true);
const negativeTokens = formatRunningWidgetLines(
	[{ name: "Auth", agent: "scout", elapsedSeconds: 41, status: "waiting", contextTokens: -5 }] as WidgetRow[], 60);
eq("negative counts clamp at 0k", negativeTokens[1].includes("waiting · 0k"), true);

// Hostile toolName: child-written, so the renderer re-sanitizes it and no
// escape byte may survive into the joined output.
const hostileTool = formatRunningWidgetLines(
	[{ name: "Auth", agent: "scout", elapsedSeconds: 192, status: "active",
	   toolName: "ba\x1b]52;c;Zm9v\x07sh\x1b[2J\0", toolElapsedSeconds: 420, contextTokens: 84_000 }] as WidgetRow[], 60);
eq("hostile tool name yields no escape bytes", hostileTool.join("").includes("\x1b"), false);
eq("hostile tool name yields no NUL bytes", hostileTool.join("").includes("\0"), false);
eq("hostile tool name keeps the safe text", hostileTool[1].includes("active · bash 7m · 84k"), true);

// A 40-char tool name clamps to 12 chars plus a trailing ellipsis.
const longTool = formatRunningWidgetLines(
	[{ name: "Auth", agent: "scout", elapsedSeconds: 192, status: "active",
	   toolName: "0123456789012345678901234567890123456789", toolElapsedSeconds: 420, contextTokens: 84_000 }] as WidgetRow[], 70);
eq("long tool name clamps at 12 chars + ellipsis", longTool[1].includes("active · 012345678901… 7m · 84k"), true);
eq("no 13th tool char leaks", longTool[1].includes("0123456789012"), false);

// ── display-column safety: wide glyphs, whitespace, surrogate pairs ───────
// pi-tui's fatal overflow check measures DISPLAY COLUMNS, not code units, so
// these pin the renderer's single-line normalization, the lone-surrogate
// strip, and the displayColumns fallback that keeps wide-glyph rows safe.

// displayColumns value table.
eq("displayColumns: ASCII is 1 column per char", displayColumns("active, bash 7m"), 15);
eq("displayColumns: the middle dot separator is 1 column", displayColumns("active · 84k"), 12);
eq("displayColumns: CJK is 2 columns each", displayColumns("検索"), 4);
eq("displayColumns: Hangul is 2 columns each", displayColumns("한글"), 4);
eq("displayColumns: emoji is 2 columns", displayColumns("💥"), 2);
eq("displayColumns: fullwidth forms are 2 columns", displayColumns("Ａ１"), 4);
eq("displayColumns: empty string is 0", displayColumns(""), 0);

// Tabs/newlines/CRs in child-controlled text become single spaces: the shared
// sanitizer whitelists them for multi-line surfaces, but this renderer emits
// one terminal row per child — a surviving tab is 3 columns in pi-tui (fatal
// overflow) and a raw \n or \r corrupts the TUI's row accounting.
const whitespaceRows = formatRunningWidgetLines(
	[{ name: "Au\tth", agent: "sc\nout", elapsedSeconds: 192, status: "active",
	   toolName: "a\tb\nc\rd", toolElapsedSeconds: 420, contextTokens: 84_000 }] as WidgetRow[], 70);
eq("no tab/newline/CR ever survives into a widget line", /[\t\n\r]/.test(whitespaceRows.join("")), false);
eq("tab and newline in toolName become single spaces", whitespaceRows[1].includes("a b c d 7m"), true);
eq("newline in agent becomes a single space", whitespaceRows[1].includes("[sc out]"), true);
eq("tab in name becomes a single space", whitespaceRows[1].includes("Au th"), true);

// The code-unit clamps never split a surrogate pair: the dangling high
// surrogate is stripped, not emitted as mojibake.
function hasLoneSurrogate(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = text.charCodeAt(i + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
			i++;
		} else if (code >= 0xdc00 && code <= 0xdfff) return true;
	}
	return false;
}
eq("clampToolName strips a split pair's dangling high surrogate",
	clampToolName("x𝐀𝐁𝐂𝐃𝐄𝐅"), "x𝐀𝐁𝐂𝐃𝐄…");
eq("clampToolName leaves a whole-pair boundary alone", clampToolName("012345678901💥"), "012345678901…");

// The finding-6 crash case: a 12-code-unit CJK tool name is 24 display
// columns; the .length math undercounts it, so the row must take the
// column-clamped fallback instead of overflowing pi-tui's fatal check.
const hostileWideRows: WidgetRow[] = [
	{ name: "検索統合テストの実行", agent: "scout", elapsedSeconds: 192, status: "active",
	  toolName: "検索工具調用器検索工具調用器", toolElapsedSeconds: 420, contextTokens: 84_000 },
	{ name: "e" + "💥".repeat(10), agent: "worker", elapsedSeconds: 41, status: "waiting", contextTokens: 6_000 },
	{ name: "Auth", agent: "judge", elapsedSeconds: 72, status: "stalled" },
];
let wideColumnViolations = 0;
let wideLengthViolations = 0;
let loneSurrogateLines = 0;
for (let w = -2; w <= 120; w++) {
	for (const line of formatRunningWidgetLines(hostileWideRows, w)) {
		if (displayColumns(line) > Math.max(0, w)) wideColumnViolations++;
		if (line.length > Math.max(0, w)) wideLengthViolations++;
		if (hasLoneSurrogate(line)) loneSurrogateLines++;
	}
}
eq("wide-glyph rows never exceed the width in display columns", wideColumnViolations, 0);
eq("wide-glyph rows never exceed the width in code units either", wideLengthViolations, 0);
eq("no width ever emits a lone surrogate", loneSurrogateLines, 0);

// ASCII rows still take the styled exact-fit branch (the guard only reroutes
// rows whose columns disagree with their length).
const asciiGuardCheck = formatRunningWidgetLines(mixedTierRows, 60, { dim: (t) => `<D>${t}</D>` });
eq("ASCII rows keep the styled branch under the column guard",
	asciiGuardCheck[1].includes("<D>"), true);

// Width sweep with the v2 worst case: the longest possible segment on the
// long-tag long-name row, plus a stalled row. No width — including negative
// widths — may ever overflow (pi's TUI crashes on an overflowing line).
const v2OverflowRows: WidgetRow[] = [
	{ name: "a very long task name that cannot possibly fit", agent: "code-reviewer", elapsedSeconds: 3723,
	  forked: true, worktree: true, status: "active", toolName: "twelvechartool",
	  toolElapsedSeconds: 86340, contextTokens: 100_000 },
	{ name: "x", elapsedSeconds: 0, status: "stalled" },
];
eq("worst-case segment appears at a wide width",
	formatRunningWidgetLines(v2OverflowRows, 90)[1].includes("active · twelvecharto… 23h59m · 100k"), true);
let v2WidthViolations = 0;
for (let w = -2; w <= 90; w++) {
	for (const line of formatRunningWidgetLines(v2OverflowRows, w)) {
		if (line.length > Math.max(0, w)) v2WidthViolations++;
	}
}
eq("no v2 line ever exceeds the render width", v2WidthViolations, 0);

// value table: formatToolElapsed
eq("tool elapsed seconds", formatToolElapsed(42), "42s");
eq("tool elapsed minutes", formatToolElapsed(420), "7m");
eq("tool elapsed hours+minutes", formatToolElapsed(3780), "1h3m");
eq("tool elapsed near a day", formatToolElapsed(86340), "23h59m");
eq("tool elapsed minute boundary", formatToolElapsed(60), "1m");
eq("tool elapsed hour boundary", formatToolElapsed(3600), "1h0m");
eq("tool elapsed negative clamps to zero", formatToolElapsed(-5), "0s");

// value table: formatTokens, pinned to pi's own footer tiers
eq("tokens under 1k", formatTokens(999), "999");
eq("tokens decimal k", formatTokens(9500), "9.5k");
eq("tokens whole k", formatTokens(372000), "372k");
eq("tokens decimal M", formatTokens(1200000), "1.2M");
eq("tokens whole M", formatTokens(12000000), "12M");

// the four result-line shapes (plus the cost floor)
eq("result line: known context",
	formatResultContextLine({ context: { tokens: 84000, window: 200000, percent: 42.4 }, costUsd: 0.31 }),
	"Context: 84k/200k tokens (42%) · cost this run $0.31");
eq("result line: post-compaction unknown",
	formatResultContextLine({ context: { tokens: null, window: 200000, percent: null }, costUsd: 0.31 }),
	"Context: unknown (just compacted) · cost this run $0.31");
eq("result line: no snapshot omits the line", formatResultContextLine(undefined), undefined);
// The fourth shape: a snapshot arrived but pi never reported a context share
// (null context — e.g. the child died before finishing a turn). The cost is
// still real and must be reported; the context honestly reads unknown.
eq("result line: snapshot with null context reports cost with unknown context",
	formatResultContextLine({ context: null, costUsd: 0.31 }),
	"Context: unknown · cost this run $0.31");
eq("result line: sub-cent cost floors, never $0.00",
	formatResultContextLine({ context: { tokens: 500, window: 200000, percent: 0.25 }, costUsd: 0.003 }),
	"Context: 500/200k tokens (0%) · cost this run < $0.01");
eq("result line: truly zero cost stays $0.00",
	formatResultContextLine({ context: null, costUsd: 0 }),
	"Context: unknown · cost this run $0.00");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
