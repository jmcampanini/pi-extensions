import { visibleWidth } from "@earendil-works/pi-tui";
import {
	EXTERNAL_MARK,
	FORK_MARK,
	INTERACTIVE_MARK,
	WORKTREE_MARK,
	clampToolName,
	displayColumns,
	formatElapsed,
	formatRunningWidgetLines,
	formatTokens,
	formatToolElapsed,
	formatWidgetContextTokens,
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
eq("row 1 omits brackets and the unused marker group", lines[1],
	" scout  Auth" + " ".repeat(60 - 12 - 6) + "00:23 ");
eq("row 2 omits brackets and the unused marker group", lines[2],
	" worker quick fix" + " ".repeat(60 - 17 - 6) + "00:04 ");
eq("rows exactly width wide", lines.every((l) => l.length === 60), true);

// Valid identifiers occupy at most 20 display columns and render in full.
// The renderer still clamps hostile persisted input defensively.
const tagRows = formatRunningWidgetLines([
	{ name: "short child", agent: "scout", elapsedSeconds: 1 },
	{ name: "boundary child", agent: "abcdefghijklmnopqrst", elapsedSeconds: 2 },
	{ name: "long child", agent: "abcdefghijklmnopqrstu", elapsedSeconds: 3 },
], 72);
eq("short agent identifier remains unchanged and unbracketed", tagRows[1].includes("scout"), true);
eq("20-column agent identifier remains unchanged", tagRows[2].includes("abcdefghijklmnopqrst"), true);
eq("hostile overlong identifier is defensively clamped", tagRows[3].includes("abcdefghijklmnopqrs…"), true);
eq("agent identifiers never render brackets", tagRows.slice(1).some((line) => line.includes("[")), false);
eq("mixed identifier widths keep task names aligned",
	tagRows.slice(1).map((line, index) => line.indexOf(["short child", "boundary child", "long child"][index])),
	[22, 22, 22]);

const familyEmoji = "👨‍👩‍👧‍👦";
const wideTagRows = formatRunningWidgetLines([
	{ name: "CJK boundary", agent: "検索".repeat(5), elapsedSeconds: 1 },
	{ name: "CJK long", agent: "検索".repeat(5) + "検", elapsedSeconds: 2 },
	{ name: "emoji long", agent: "💥".repeat(11), elapsedSeconds: 3 },
	{ name: "emoji cluster long", agent: familyEmoji.repeat(11), elapsedSeconds: 4 },
], 72);
eq("20-column wide identifier remains unchanged", wideTagRows[1].includes("検索".repeat(5)), true);
eq("wide identifier clamp does not split a glyph", wideTagRows[2].includes("検索検索検索検索検…"), true);
eq("emoji identifier clamp does not split a surrogate pair",
	wideTagRows[3].includes(`${"💥".repeat(9)}…`), true);
eq("emoji identifier clamp does not split a grapheme cluster",
	wideTagRows[4].includes(`${familyEmoji.repeat(9)}…`), true);

const fullAgent = "abcdefghijklmnopqrstuvwx";
const fullPrefixRow = formatRunningWidgetLines(
	[{ name: `${fullAgent}: Auth`, agent: fullAgent, elapsedSeconds: 4 }], 50);
eq("prefix de-duplication compares against the full agent identifier",
	fullPrefixRow[1].includes("abcdefghijklmnopqrs… Auth"), true);
eq("clamped identifier is not used for prefix de-duplication",
	fullPrefixRow[1].includes(`${fullAgent}: Auth`), false);

const narrowLongTag = formatRunningWidgetLines(
	[{ name: "Task details that should reclaim width", agent: "a-very-long-agent-x", elapsedSeconds: 4 }], 30);
eq("maximum-width identity leaves the narrow task a final ellipsis",
	narrowLongTag[1].includes("a-very-long-agent-x …"), true);
eq("narrow identifier row fits terminal columns", visibleWidth(narrowLongTag[1]) <= 30, true);

// style hooks wrap ONLY the clock, marker group, and rule; layout math stays
// plain
const styled = formatRunningWidgetLines(rows, 60, { dim: (t) => `<D>${t}</D>`, border: (t) => `<B>${t}</B>` });
eq("border styled", styled[0], `<B>${"─".repeat(60)}</B>`);
eq("clock styled + trailing space", styled[1].endsWith("<D>00:23</D> "), true);
eq("styled row plain-length preserved", styled[1].replaceAll("<D>", "").replaceAll("</D>", "").length, 60);

// narrow width: name truncates, tag + clock survive
const narrow = formatRunningWidgetLines(
	[{ name: "a very long task name that cannot possibly fit", agent: "scout", elapsedSeconds: 61 }], 30);
eq("narrow keeps clock one off the edge", narrow[1].endsWith("01:01 "), true);
eq("narrow keeps identifier", narrow[1].startsWith(" scout"), true);
eq("narrow truncates with ellipsis", narrow[1].includes("…"), true);
eq("narrow row fits width", narrow[1].length <= 30, true);

// bare (pre-worker resume) row: blank tag column, still aligned
const mixed = formatRunningWidgetLines(
	[{ name: "old resume", agent: undefined, elapsedSeconds: 10 },
	 { name: "Auth", agent: "scout", elapsedSeconds: 20 }], 50);
eq("missing identifier keeps the shared column aligned", mixed[1].startsWith(" ".repeat(7) + "old resume"), true);

// Marker columns appear between the tag and name only when at least one row
// uses them; blank cells keep the remaining rows aligned.
const stateRows = [
	{ name: "Auth", agent: "scout", elapsedSeconds: 23, forked: true, worktree: true },
	{ name: "quick fix", agent: "worker", elapsedSeconds: 4 },
	{ name: "API review", agent: "judge", elapsedSeconds: 72, worktree: true },
];
const stateLines = formatRunningWidgetLines(stateRows, 60);
eq("forked worktree row shows both marks", stateLines[1],
	` scout  ${FORK_MARK}${WORKTREE_MARK} Auth` + " ".repeat(39) + "00:23 ");
eq("stateless row gets a blank slot, name still aligned", stateLines[2],
	" worker    quick fix" + " ".repeat(34) + "00:04 ");
eq("worktree-only row leaves the fork column blank", stateLines[3],
	` judge   ${WORKTREE_MARK} API review` + " ".repeat(33) + "01:12 ");
eq("state rows exactly width wide", stateLines.every((l) => l.length === 60), true);

const allMarkerRows = formatRunningWidgetLines([
	{ name: "all", agent: "worker", elapsedSeconds: 1, forked: true, interactive: true, worktree: true, external: true },
	{ name: "interactive external", agent: "worker", elapsedSeconds: 2, interactive: true, external: true },
	{ name: "worktree", agent: "worker", elapsedSeconds: 3, worktree: true },
	{ name: "none", agent: "worker", elapsedSeconds: 4 },
], 60);
eq("markers use canonical e,f,i,w order", allMarkerRows[1],
	` worker ${EXTERNAL_MARK}${FORK_MARK}${INTERACTIVE_MARK}${WORKTREE_MARK} all` + " ".repeat(38) + "00:01 ");
eq("used marker columns stay aligned with blank cells", allMarkerRows[2],
	` worker ${EXTERNAL_MARK} ${INTERACTIVE_MARK}  interactive external` + " ".repeat(21) + "00:02 ");
eq("rows without flags retain blanks for every used marker", allMarkerRows[4],
	" worker      none" + " ".repeat(37) + "00:04 ");

const subsetMarkers = formatRunningWidgetLines([
	{ name: "external", agent: "worker", elapsedSeconds: 1, external: true },
	{ name: "worktree", agent: "worker", elapsedSeconds: 2, worktree: true },
], 50);
eq("unused f and i columns disappear while e,w remain aligned", subsetMarkers.slice(1), [
	` worker ${EXTERNAL_MARK}  external` + " ".repeat(25) + "00:01 ",
	` worker  ${WORKTREE_MARK} worktree` + " ".repeat(25) + "00:02 ",
]);

const summaryLines = formatRunningWidgetLines(
	[{ name: "only", agent: "worker", elapsedSeconds: 1 }],
	80,
	{},
	{ summary: { hiddenRows: 5, stalledRows: 1, waitingRows: 2, queuedRows: 1 } },
);
eq("compact summary reports nonzero hidden categories in attention order",
	summaryLines[2], " +5 more · 1 stalled · 2 waiting · 1 queued · /subagent-running");
eq("hidden summary adds exactly one line", summaryLines.length, 3);
const zeroSummary = formatRunningWidgetLines(
	[{ name: "only", agent: "worker", elapsedSeconds: 1 }],
	60,
	{},
	{ summary: { hiddenRows: 0, stalledRows: 0, waitingRows: 0, queuedRows: 0 } },
);
eq("summary disappears when no rows are hidden", zeroSummary.length, 2);
let summaryWidthViolations = 0;
for (let width = -2; width <= 60; width++) {
	for (const line of formatRunningWidgetLines(rows, width, {}, {
		summary: { hiddenRows: 99, stalledRows: 2, waitingRows: 3, queuedRows: 42 },
	})) {
		if (visibleWidth(line) > Math.max(0, width)) summaryWidthViolations++;
	}
}
eq("summary and detailed rows remain width-safe together", summaryWidthViolations, 0);

// without a slot hook the marks fall back to dim; layout math stays plain
const stateStyled = formatRunningWidgetLines(stateRows, 60, { dim: (t) => `<D>${t}</D>` });
eq("mark slot falls back to dim", stateStyled[1].includes(`<D>${FORK_MARK}${WORKTREE_MARK}</D> Auth`), true);
eq("styled state row plain-length preserved",
	stateStyled[1].replaceAll("<D>", "").replaceAll("</D>", "").length, 60);

// Dedicated hooks style identifiers and marker letters as secondary metadata.
const slotStyled = formatRunningWidgetLines(stateRows, 60, {
	dim: (t) => `<D>${t}</D>`,
	agent: (t) => `<A>${t}</A>`,
	slot: (t) => `<M>${t}</M>`,
});
eq("agent hook styles the unbracketed identifier", slotStyled[1].includes(`<A>scout</A>  `), true);
eq("marker hook styles the secondary metadata letters", slotStyled[1].includes(`<M>${FORK_MARK}${WORKTREE_MARK}</M> Auth`), true);
eq("widget styles add no SGR faint sequence", slotStyled.join("\n").includes("\x1b[2m"), false);
eq("clock still uses dim", slotStyled[1].endsWith("<D>00:23</D> "), true);

// narrow width with a marker group: markers survive, the name gives way
const narrowState = formatRunningWidgetLines(
	[{ name: "a very long task name that cannot possibly fit", agent: "scout", elapsedSeconds: 61, forked: true }], 30);
eq("narrow keeps the marker group", narrowState[1].includes(` scout ${FORK_MARK} `), true);
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
eq("widget preserves safe identity text", hostileRow[1].includes("worker safe name"), true);

// ── v2 liveness: the status segment ──────────────────────────────────────

// A row without a status renders byte-identical to the v1 row even when the
// other segment fields are present — the whole v1 block above is the oracle.
const v2NoStatusRows: WidgetRow[] = [
	{ name: "Scout: Auth", agent: "scout", elapsedSeconds: 23, toolName: "bash", toolElapsedSeconds: 420, contextTokens: 84_000 },
	{ name: "quick fix", agent: "worker", elapsedSeconds: 4 },
];
eq("rows without status retain the identity-name-clock layout", formatRunningWidgetLines(v2NoStatusRows, 60), lines);

// The example block, pinned exactly at width 78: full segment on the active
// row, fixed context cells on every row, and blanks when context is unknown.
const exampleRows: WidgetRow[] = [
	{ name: "Auth", agent: "scout", elapsedSeconds: 192, forked: true, worktree: true,
	  status: "active", toolName: "bash", toolElapsedSeconds: 420, contextTokens: 84_000 },
	{ name: "quick fix", agent: "worker", elapsedSeconds: 41, status: "waiting", contextTokens: 5_700 },
	{ name: "API review", agent: "judge", elapsedSeconds: 72, worktree: true, status: "stalled" },
];
const exampleLines = formatRunningWidgetLines(exampleRows, 78);
eq("example block: active row", exampleLines[1],
	" scout  fw Auth" + " ".repeat(31) + "bash 7m · active ·  84k · 03:12 ");
eq("example block: waiting row rounds and pads the tokens", exampleLines[2],
	" worker    quick fix" + " ".repeat(35) + "waiting ·   6k · 00:41 ");
eq("example block: stalled row reserves unknown context columns", exampleLines[3],
	" judge   w API review" + " ".repeat(34) + "stalled" + " ".repeat(8) + "· 01:12 ");
eq("example block rows exactly width wide", exampleLines.every((l) => l.length === 78), true);

// starting row exact string
const startingLines = formatRunningWidgetLines(
	[{ name: "boot up", agent: "worker", elapsedSeconds: 5, status: "starting" }] as WidgetRow[], 50);
eq("starting row reserves unknown context columns", startingLines[1],
	" worker boot up" + " ".repeat(11) + "starting" + " ".repeat(8) + "· 00:05 ");

// stalled-only row exact string
const stalledLines = formatRunningWidgetLines(
	[{ name: "API review", agent: "judge", elapsedSeconds: 72, status: "stalled" }] as WidgetRow[], 40);
eq("stalled-only row", stalledLines[1], " judge API rev…  stalled" + " ".repeat(8) + "· 01:12 ");

// The degradation ladder on one row at descending widths: the tool drops,
// then the name truncates around the fixed state/context/clock core. Once the
// core cannot coexist with identity and clock, the safe v1 ladder takes over.
const ladderRow: WidgetRow[] = [{ name: "Auth refactor", agent: "scout", elapsedSeconds: 192,
	status: "active", toolName: "bash", toolElapsedSeconds: 420, contextTokens: 84_000 }];
const ladderAt = (w: number) => formatRunningWidgetLines(ladderRow, w)[1];
eq("ladder 54: full tool segment returns beside the full name", ladderAt(54),
	" scout Auth refactor  bash 7m · active ·  84k · 03:12 ");
eq("tool remains absent through the full-name boundary",
	[44, 45, 46, 47, 48, 49, 50, 51, 52, 53].every((width) => !ladderAt(width).includes("bash") && ladderAt(width).includes("Auth refactor")), true);
eq("tool returns only when it and the full name fit", ladderAt(54).includes("Auth refactor  bash 7m"), true);
eq("ladder 53: fixed core remains aligned", ladderAt(53),
	" scout Auth refactor" + " ".repeat(11) + "active ·  84k · 03:12 ");
eq("ladder 44: full name fits beside the fixed core", ladderAt(44),
	" scout Auth refactor  active ·  84k · 03:12 ");
eq("ladder 43: fixed core takes the first name column", ladderAt(43),
	" scout Auth refact…  active ·  84k · 03:12 ");
eq("ladder 38: fixed core remains while the name shrinks", ladderAt(38),
	" scout Auth r…  active ·  84k · 03:12 ");
eq("ladder 32: fixed core remains at its identity-width limit", ladderAt(32),
	" scout …  active ·  84k · 03:12 ");
eq("ladder 28: core no longer fits, so the safe name row returns", ladderAt(28), " scout Auth refactor  03:12 ");
eq("ladder 17: identity-only plain clamp", ladderAt(17), " scout A…  03:12 ");

// A short name is never truncated to keep the optional tool. Once the tool
// drops, the required core can truncate a long name below the old floor.
eq("required core may shrink a long name below 10 columns", ladderAt(39).includes(" Auth re… "), true);
const shortNameRow: WidgetRow[] = [{ name: "Auth", agent: "scout", elapsedSeconds: 192,
	status: "active", toolName: "bash", toolElapsedSeconds: 420, contextTokens: 84_000 }];
eq("short name 44: tool drops before truncating the whole name",
	formatRunningWidgetLines(shortNameRow, 44)[1],
	" scout Auth" + " ".repeat(11) + "active ·  84k · 03:12 ");
eq("short name 45: tool returns with the whole name",
	formatRunningWidgetLines(shortNameRow, 45)[1],
	" scout Auth  bash 7m · active ·  84k · 03:12 ");
eq("short name never gains an ellipsis for a segment",
	formatRunningWidgetLines(shortNameRow, 45)[1].includes("…"), false);

// Mixed tiers at ONE width: a full-segment row and a stalled row sharing a
// tagWidth — every line exactly the width, both clocks on the right edge.
const mixedTierRows: WidgetRow[] = [
	{ name: "Auth", agent: "scout", elapsedSeconds: 192, status: "active",
	  toolName: "bash", toolElapsedSeconds: 420, contextTokens: 84_000 },
	{ name: "API review", agent: "judge", elapsedSeconds: 72, status: "stalled" },
];
const mixedTier = formatRunningWidgetLines(mixedTierRows, 60);
eq("mixed tiers: full-segment row", mixedTier[1],
	" scout Auth" + " ".repeat(17) + "bash 7m · active ·  84k · 03:12 ");
eq("mixed tiers: stalled row", mixedTier[2],
	" judge API review" + " ".repeat(20) + "stalled" + " ".repeat(8) + "· 01:12 ");
eq("mixed tiers: rows exactly width wide", mixedTier.every((l) => l.length === 60), true);
eq("mixed tiers: both clocks end at the right edge",
	mixedTier[1].endsWith("03:12 ") && mixedTier[2].endsWith("01:12 "), true);

// Style hooks: the segment renders dim normally and warn iff stalled; the
// clock stays dim; stripping the tags recovers the exact plain width.
const segStyled = formatRunningWidgetLines(mixedTierRows, 60,
	{ dim: (t) => `<D>${t}</D>`, warn: (t) => `<W>${t}</W>` });
eq("segment dim on active", segStyled[1].includes("<D>bash 7m · active ·  84k</D><D> · </D><D>03:12</D> "), true);
eq("segment warn on stalled, clock separator and clock stay dim", segStyled[2].includes(`<W>stalled${" ".repeat(7)}</W><D> · </D><D>01:12</D> `), true);
eq("warn never touches a non-stalled row", segStyled[1].includes("<W>"), false);
eq("stripped active row length still exact", segStyled[1]
	.replaceAll("<D>", "").replaceAll("</D>", "").length, 60);
eq("stripped stalled row length still exact", segStyled[2]
	.replaceAll("<D>", "").replaceAll("</D>", "").replaceAll("<W>", "").replaceAll("</W>", "").length, 60);
const warnFallback = formatRunningWidgetLines(mixedTierRows, 60, { dim: (t) => `<D>${t}</D>` });
eq("warn falls back to dim", warnFallback[2].includes(`<D>stalled${" ".repeat(7)}</D><D> · </D><D>01:12</D> `), true);

// Tool part renders only while active — waiting rows keep the tokens alone.
const waitingTool = formatRunningWidgetLines(
	[{ name: "Auth", agent: "scout", elapsedSeconds: 41, status: "waiting",
	   toolName: "bash", toolElapsedSeconds: 9, contextTokens: 6_000 }] as WidgetRow[], 60);
eq("tool part only renders while active", waitingTool[1].includes("bash"), false);
eq("waiting keeps and pads the tokens", waitingTool[1].includes("waiting ·   6k"), true);

// Unknown context renders as absence, not "?"; tokens render as whole
// thousands and clamp at 0 below.
const noTokens = formatRunningWidgetLines(
	[{ name: "Auth", agent: "scout", elapsedSeconds: 192, status: "active",
	   toolName: "bash", toolElapsedSeconds: 420 }] as WidgetRow[], 60);
eq("unknown context renders as a reserved blank cell", noTokens[1].includes(`bash 7m · active${" ".repeat(8)}· 03:12 `), true);
eq("no stray tokens part", /\d+k/.test(noTokens[1]), false);
const bigTokens = formatRunningWidgetLines(
	[{ name: "Auth", agent: "scout", elapsedSeconds: 41, status: "waiting", contextTokens: 1_234_900 }] as WidgetRow[], 60);
eq("counts above the fixed field saturate at 999k", bigTokens[1].includes("waiting · 999k"), true);
const negativeTokens = formatRunningWidgetLines(
	[{ name: "Auth", agent: "scout", elapsedSeconds: 41, status: "waiting", contextTokens: -5 }] as WidgetRow[], 60);
eq("negative counts clamp and pad to 0k", negativeTokens[1].includes("waiting ·   0k"), true);

// The context cell is always three right-aligned digits plus `k`.
eq("widget context one digit", formatWidgetContextTokens(6_000), "  6k");
eq("widget context two digits", formatWidgetContextTokens(25_000), " 25k");
eq("widget context three digits", formatWidgetContextTokens(106_000), "106k");
eq("widget context saturates without widening", formatWidgetContextTokens(1_234_900), "999k");
eq("widget context cells are fixed at four characters",
	[6_000, 25_000, 106_000, 1_234_900].every((count) => formatWidgetContextTokens(count).length === 4), true);

// Tool content has no reserved width or padding. The state ends at the same
// context delimiter on every known-context row, and token right edges align.
const alignedTelemetry = formatRunningWidgetLines([
	{ name: "Auth", agent: "scout", elapsedSeconds: 47, status: "active",
	  toolName: "bash", toolElapsedSeconds: 29, contextTokens: 6_000 },
	{ name: "boot", agent: "worker", elapsedSeconds: 48, status: "starting", contextTokens: 106_000 },
	{ name: "wait", agent: "worker", elapsedSeconds: 49, status: "waiting", contextTokens: 25_000 },
	{ name: "stall", agent: "worker", elapsedSeconds: 50, status: "stalled", contextTokens: 18_000 },
] as WidgetRow[], 78);
eq("bash telemetry has ordered dot-separated fields and a fixed context cell",
	alignedTelemetry[1].includes("bash 29s · active ·   6k · 00:47 "), true);
const contextDelimiterIndex = (line: string) => line.lastIndexOf("·", line.lastIndexOf("·") - 1);
eq("state-to-context delimiters align",
	alignedTelemetry.slice(1).map(contextDelimiterIndex), [63, 63, 63, 63]);
eq("context suffixes align at their right edge",
	alignedTelemetry.slice(1).map((line) => line.lastIndexOf("k")), [68, 68, 68, 68]);
eq("context-to-clock separators align",
	alignedTelemetry.slice(1).map((line) => line.lastIndexOf("·")), [70, 70, 70, 70]);

// Clock cells reserve the widest current clock so crossing one hour does not
// move the state or context columns on shorter-running rows.
const mixedClockWidths = formatRunningWidgetLines([
	{ name: "short", agent: "scout", elapsedSeconds: 47, status: "active", contextTokens: 6_000 },
	{ name: "long", agent: "scout", elapsedSeconds: 3_723, status: "active", contextTokens: 106_000 },
] as WidgetRow[], 78);
eq("mixed clock widths keep context delimiters aligned",
	mixedClockWidths.slice(1).map(contextDelimiterIndex), [61, 61]);
eq("mixed clock widths keep context right edges aligned",
	mixedClockWidths.slice(1).map((line) => line.lastIndexOf("k")), [66, 66]);
eq("mixed clock widths keep context-to-clock separators aligned",
	mixedClockWidths.slice(1).map((line) => line.lastIndexOf("·")), [68, 68]);
eq("mixed clock widths keep clocks on the right edge",
	mixedClockWidths[1].endsWith("00:47 ") && mixedClockWidths[2].endsWith("1:02:03 "), true);

// Hostile toolName: child-written, so the renderer re-sanitizes it and no
// escape byte may survive into the joined output.
const hostileTool = formatRunningWidgetLines(
	[{ name: "Auth", agent: "scout", elapsedSeconds: 192, status: "active",
	   toolName: "ba\x1b]52;c;Zm9v\x07sh\x1b[2J\0", toolElapsedSeconds: 420, contextTokens: 84_000 }] as WidgetRow[], 60);
eq("hostile tool name yields no escape bytes", hostileTool.join("").includes("\x1b"), false);
eq("hostile tool name yields no NUL bytes", hostileTool.join("").includes("\0"), false);
eq("hostile tool name keeps the safe text", hostileTool[1].includes("bash 7m · active ·  84k"), true);

// A 40-char tool name clamps to 12 chars plus a trailing ellipsis.
const longTool = formatRunningWidgetLines(
	[{ name: "Auth", agent: "scout", elapsedSeconds: 192, status: "active",
	   toolName: "0123456789012345678901234567890123456789", toolElapsedSeconds: 420, contextTokens: 84_000 }] as WidgetRow[], 70);
eq("long tool name clamps at 12 chars + ellipsis", longTool[1].includes("012345678901… 7m · active ·  84k"), true);
eq("no 13th tool char leaks", longTool[1].includes("0123456789012"), false);

// ── display-column safety: wide glyphs, whitespace, surrogate pairs ───────
// pi-tui's fatal overflow check measures display columns, so these use its
// public visibleWidth implementation as an independent sweep oracle.

// displayColumns value table.
eq("displayColumns: ASCII is 1 column per char", displayColumns("active, bash 7m"), 15);
eq("displayColumns: the middle dot separator is 1 column", displayColumns("active · 84k"), 12);
eq("displayColumns: CJK is 2 columns each", displayColumns("検索"), 4);
eq("displayColumns: Hangul is 2 columns each", displayColumns("한글"), 4);
eq("displayColumns: emoji is 2 columns", displayColumns("💥"), 2);
eq("displayColumns: regional-indicator flag is 2 columns", displayColumns("🇺🇸"), 2);
eq("displayColumns: BMP emoji grapheme is 2 columns", displayColumns("♥️"), 2);
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
eq("newline in agent becomes a single space", whitespaceRows[1].includes("sc out"), true);
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

// Wide names and tools must truncate without exceeding pi-tui's metric.
const hostileWideRows: WidgetRow[] = [
	{ name: "検索統合テストの実行", agent: "scout", elapsedSeconds: 192, status: "active",
	  toolName: "検索工具調用器検索工具調用器", toolElapsedSeconds: 420, contextTokens: 84_000 },
	{ name: "e" + "💥".repeat(10), agent: "worker", elapsedSeconds: 41, status: "waiting", contextTokens: 6_000 },
	{ name: "🇺🇸".repeat(10), agent: "judge", elapsedSeconds: 72, status: "active", contextTokens: 25_000 },
	{ name: "♥️".repeat(10), agent: "worker", elapsedSeconds: 73, status: "waiting", contextTokens: 106_000 },
	{ name: "Auth", agent: "judge", elapsedSeconds: 74, status: "stalled" },
];
let wideColumnViolations = 0;
let loneSurrogateLines = 0;
for (let w = -2; w <= 120; w++) {
	for (const line of formatRunningWidgetLines(hostileWideRows, w)) {
		if (visibleWidth(line) > Math.max(0, w)) wideColumnViolations++;
		if (hasLoneSurrogate(line)) loneSurrogateLines++;
	}
}
eq("wide-glyph rows never exceed pi-tui's visible width", wideColumnViolations, 0);
eq("no width ever emits a lone surrogate", loneSurrogateLines, 0);
const flagRegression = formatRunningWidgetLines(
	[{ name: "🇺🇸".repeat(6), agent: "scout", elapsedSeconds: 47 }] as WidgetRow[], 22)[1];
eq("regional-indicator truncation fits pi-tui at the reported width", visibleWidth(flagRegression) <= 22, true);
eq("regional-indicator truncation keeps complete flag graphemes",
	flagRegression, " scout 🇺🇸🇺🇸🇺🇸…  00:47 ");
const wideNameCore = formatRunningWidgetLines(
	[{ name: "検索検索検索検索検索検索", agent: "scout", elapsedSeconds: 47,
	   status: "active", contextTokens: 6_000 }] as WidgetRow[], 50);
eq("wide names truncate before the fixed telemetry core",
	wideNameCore[1].endsWith("active ·   6k · 00:47 "), true);

// Column-aware rows retain styling whenever the complete layout fits.
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
eq("worst-case segment appears once the full name and tool fit",
	formatRunningWidgetLines(v2OverflowRows, 130)[1].includes("twelvecharto… 23h59m · active · 100k"), true);
let v2WidthViolations = 0;
for (let w = -2; w <= 90; w++) {
	for (const line of formatRunningWidgetLines(v2OverflowRows, w)) {
		if (visibleWidth(line) > Math.max(0, w)) v2WidthViolations++;
	}
}
eq("no v2 line ever exceeds the render width", v2WidthViolations, 0);

// ── the queued pre-launch state ──────────────────────────────────────────
// Supplied by the controller from capacity.ts's launch queue, never by
// computeStatus: the clock counts time waiting for a concurrency slot, and
// there is no process yet, so no tool/token telemetry and never warn.
const queuedRow: WidgetRow[] = [{ name: "Auth", agent: "scout", elapsedSeconds: 42, status: "queued" }];
eq("queued row exact string", formatRunningWidgetLines(queuedRow, 50)[1],
	" scout Auth                 queued        · 00:42 ");
const queuedStyled = formatRunningWidgetLines(queuedRow, 50,
	{ dim: (t) => `<D>${t}</D>`, warn: (t) => `<W>${t}</W>` });
eq("queued core and clock separator render dim",
	queuedStyled[1].includes(`<D>queued${" ".repeat(7)}</D><D> · </D><D>00:42</D> `), true);
eq("queued never uses the warn hook", queuedStyled[1].includes("<W>"), false);

// ── the delivering exit state ────────────────────────────────────────────
// An exit-lifecycle state supplied by the controller from the delivering
// map, never by computeStatus: frozen clock, no tool/token telemetry, dim
// (never warn). "delivering" is 10 chars - the widest status word - so the
// fixed telemetry core and the sweep must absorb it.
const deliveringRow: WidgetRow[] = [{ name: "Auth", agent: "scout", elapsedSeconds: 192, status: "delivering" }];
eq("delivering row exact string", formatRunningWidgetLines(deliveringRow, 50)[1],
	" scout Auth             delivering        · 03:12 ");
eq("delivering truncates the name around the fixed telemetry core",
	formatRunningWidgetLines(
		[{ name: "API review", agent: "judge", elapsedSeconds: 72, status: "delivering" }] as WidgetRow[], 43)[1],
	" judge API rev…  delivering        · 01:12 ");
const deliveringStyled = formatRunningWidgetLines(deliveringRow, 50,
	{ dim: (t) => `<D>${t}</D>`, warn: (t) => `<W>${t}</W>` });
eq("delivering core and clock separator render dim",
	deliveringStyled[1].includes(`<D>delivering${" ".repeat(7)}</D><D> · </D><D>03:12</D> `), true);
eq("delivering never uses the warn hook", deliveringStyled[1].includes("<W>"), false);
// The fixed core remains while it fits with identity and clock, sacrificing
// the name first. Once the core no longer fits, the row uses v1 geometry.
const deliveringLadder: WidgetRow[] = [{ name: "Auth refactor", agent: "scout", elapsedSeconds: 192, status: "delivering" }];
eq("delivering ladder 42: fixed core truncates the name",
	formatRunningWidgetLines(deliveringLadder, 42)[1], " scout Auth r…  delivering        · 03:12 ");
eq("delivering ladder 32: fixed core drops to name-and-clock geometry",
	formatRunningWidgetLines(deliveringLadder, 32)[1], " scout Auth refactor      03:12 ");
// Width sweep with delivering rows: worst-case tag, both marks, H:MM:SS
// clock. No width - including negative - may ever overflow.
const deliveringOverflowRows: WidgetRow[] = [
	{ name: "a very long task name that cannot possibly fit", agent: "code-reviewer", elapsedSeconds: 3723,
	  forked: true, worktree: true, status: "delivering" },
	{ name: "x", elapsedSeconds: 0, status: "delivering" },
];
let deliveringWidthViolations = 0;
for (let w = -2; w <= 70; w++) {
	for (const line of formatRunningWidgetLines(deliveringOverflowRows, w)) {
		if (visibleWidth(line) > Math.max(0, w)) deliveringWidthViolations++;
	}
}
eq("no delivering line ever exceeds the render width", deliveringWidthViolations, 0);

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
