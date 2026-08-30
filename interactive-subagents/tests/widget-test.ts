import { describe, it } from "node:test";
import assert from "node:assert/strict";
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

const rows = [
	{ name: "Scout: Auth", agent: "scout", elapsedSeconds: 23 },
	{ name: "quick fix", agent: "worker", elapsedSeconds: 4 },
];

const familyEmoji = "👨‍👩‍👧‍👦";

const stateRows = [
	{ name: "Auth", agent: "scout", elapsedSeconds: 23, forked: true, worktree: true },
	{ name: "quick fix", agent: "worker", elapsedSeconds: 4 },
	{ name: "API review", agent: "judge", elapsedSeconds: 72, worktree: true },
];

const mixedTierRows: WidgetRow[] = [
	{ name: "Auth", agent: "scout", elapsedSeconds: 192, status: "active",
	  toolName: "bash", toolElapsedSeconds: 420, contextTokens: 84_000 },
	{ name: "API review", agent: "judge", elapsedSeconds: 72, status: "stalled" },
];

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

const contextDelimiterIndex = (line: string) => line.lastIndexOf("·", line.lastIndexOf("·") - 1);

describe("formatElapsed", () => {
	it("mm:ss", () => {
		assert.strictEqual(formatElapsed(83), "01:23");
	});

	it("h:mm:ss past an hour", () => {
		assert.strictEqual(formatElapsed(3723), "1:02:03");
	});
});

describe("stripAgentPrefix", () => {
	it("strips 'Scout: Auth'", () => {
		assert.strictEqual(stripAgentPrefix("Scout: Auth", "scout"), "Auth");
	});

	it("strips dash separator", () => {
		assert.strictEqual(stripAgentPrefix("worker - quick fix", "worker"), "quick fix");
	});

	it("keeps non-matching prefix", () => {
		assert.strictEqual(stripAgentPrefix("Scouting: Auth", "scout"), "Scouting: Auth");
	});

	it("keeps name without separator", () => {
		assert.strictEqual(stripAgentPrefix("Scout Auth", "scout"), "Scout Auth");
	});

	it("keeps name when strip would empty it", () => {
		assert.strictEqual(stripAgentPrefix("scout: ", "scout"), "scout: ");
	});

	it("no agent, no strip", () => {
		assert.strictEqual(stripAgentPrefix("Scout: Auth", undefined), "Scout: Auth");
	});

	it("prefix stripping removes terminal controls first", () => {
		assert.strictEqual(stripAgentPrefix("Scout: Au\x1b]52;c;Zm9v\x07th\0", "scout\x1b[2J"), "Auth");
	});
});

describe("formatRunningWidgetLines", () => {
	const lines = formatRunningWidgetLines(rows, 60);

	it("border rule + child rows, no footer", () => {
		assert.strictEqual(lines.length, 3);
	});

	it("top rule spans width", () => {
		assert.strictEqual(lines[0], "─".repeat(60));
	});

	it("row 1 omits brackets and the unused marker group", () => {
		assert.strictEqual(lines[1], " scout  Auth" + " ".repeat(60 - 12 - 6) + "00:23 ");
	});

	it("row 2 omits brackets and the unused marker group", () => {
		assert.strictEqual(lines[2], " worker quick fix" + " ".repeat(60 - 17 - 6) + "00:04 ");
	});

	it("rows exactly width wide", () => {
		assert.strictEqual(lines.every((l) => l.length === 60), true);
	});

	// Valid identifiers occupy at most 20 display columns and render in full.
	// The renderer still clamps hostile persisted input defensively.
	const tagRows = formatRunningWidgetLines([
		{ name: "short child", agent: "scout", elapsedSeconds: 1 },
		{ name: "boundary child", agent: "abcdefghijklmnopqrst", elapsedSeconds: 2 },
		{ name: "long child", agent: "abcdefghijklmnopqrstu", elapsedSeconds: 3 },
	], 72);

	it("short agent identifier remains unchanged and unbracketed", () => {
		assert.strictEqual(tagRows[1].includes("scout"), true);
	});

	it("20-column agent identifier remains unchanged", () => {
		assert.strictEqual(tagRows[2].includes("abcdefghijklmnopqrst"), true);
	});

	it("hostile overlong identifier is defensively clamped", () => {
		assert.strictEqual(tagRows[3].includes("abcdefghijklmnopqrs…"), true);
	});

	it("agent identifiers never render brackets", () => {
		assert.strictEqual(tagRows.slice(1).some((line) => line.includes("[")), false);
	});

	it("mixed identifier widths keep task names aligned", () => {
		assert.deepStrictEqual(
			tagRows.slice(1).map((line, index) => line.indexOf(["short child", "boundary child", "long child"][index])),
			[22, 22, 22],
		);
	});

	const wideTagRows = formatRunningWidgetLines([
		{ name: "CJK boundary", agent: "検索".repeat(5), elapsedSeconds: 1 },
		{ name: "CJK long", agent: "検索".repeat(5) + "検", elapsedSeconds: 2 },
		{ name: "emoji long", agent: "💥".repeat(11), elapsedSeconds: 3 },
		{ name: "emoji cluster long", agent: familyEmoji.repeat(11), elapsedSeconds: 4 },
	], 72);

	it("20-column wide identifier remains unchanged", () => {
		assert.strictEqual(wideTagRows[1].includes("検索".repeat(5)), true);
	});

	it("wide identifier clamp does not split a glyph", () => {
		assert.strictEqual(wideTagRows[2].includes("検索検索検索検索検…"), true);
	});

	it("emoji identifier clamp does not split a surrogate pair", () => {
		assert.strictEqual(wideTagRows[3].includes(`${"💥".repeat(9)}…`), true);
	});

	it("emoji identifier clamp does not split a grapheme cluster", () => {
		assert.strictEqual(wideTagRows[4].includes(`${familyEmoji.repeat(9)}…`), true);
	});

	const fullAgent = "abcdefghijklmnopqrstuvwx";
	const fullPrefixRow = formatRunningWidgetLines(
		[{ name: `${fullAgent}: Auth`, agent: fullAgent, elapsedSeconds: 4 }], 50);

	it("prefix de-duplication compares against the full agent identifier", () => {
		assert.strictEqual(fullPrefixRow[1].includes("abcdefghijklmnopqrs… Auth"), true);
	});

	it("clamped identifier is not used for prefix de-duplication", () => {
		assert.strictEqual(fullPrefixRow[1].includes(`${fullAgent}: Auth`), false);
	});

	const narrowLongTag = formatRunningWidgetLines(
		[{ name: "Task details that should reclaim width", agent: "a-very-long-agent-x", elapsedSeconds: 4 }], 30);

	it("maximum-width identity leaves the narrow task a final ellipsis", () => {
		assert.strictEqual(narrowLongTag[1].includes("a-very-long-agent-x …"), true);
	});

	it("narrow identifier row fits terminal columns", () => {
		assert.strictEqual(visibleWidth(narrowLongTag[1]) <= 30, true);
	});

	// style hooks wrap ONLY the clock, marker group, and rule; layout math stays
	// plain
	const styled = formatRunningWidgetLines(rows, 60, { dim: (t) => `<D>${t}</D>`, border: (t) => `<B>${t}</B>` });

	it("border styled", () => {
		assert.strictEqual(styled[0], `<B>${"─".repeat(60)}</B>`);
	});

	it("clock styled + trailing space", () => {
		assert.strictEqual(styled[1].endsWith("<D>00:23</D> "), true);
	});

	it("styled row plain-length preserved", () => {
		assert.strictEqual(styled[1].replaceAll("<D>", "").replaceAll("</D>", "").length, 60);
	});

	// narrow width: name truncates, tag + clock survive
	const narrow = formatRunningWidgetLines(
		[{ name: "a very long task name that cannot possibly fit", agent: "scout", elapsedSeconds: 61 }], 30);

	it("narrow keeps clock one off the edge", () => {
		assert.strictEqual(narrow[1].endsWith("01:01 "), true);
	});

	it("narrow keeps identifier", () => {
		assert.strictEqual(narrow[1].startsWith(" scout"), true);
	});

	it("narrow truncates with ellipsis", () => {
		assert.strictEqual(narrow[1].includes("…"), true);
	});

	it("narrow row fits width", () => {
		assert.strictEqual(narrow[1].length <= 30, true);
	});

	// bare (pre-worker resume) row: blank tag column, still aligned
	it("missing identifier keeps the shared column aligned", () => {
		const mixed = formatRunningWidgetLines(
			[{ name: "old resume", agent: undefined, elapsedSeconds: 10 },
			 { name: "Auth", agent: "scout", elapsedSeconds: 20 }], 50);
		assert.strictEqual(mixed[1].startsWith(" ".repeat(7) + "old resume"), true);
	});

	// Marker columns appear between the tag and name only when at least one row
	// uses them; blank cells keep the remaining rows aligned.
	const stateLines = formatRunningWidgetLines(stateRows, 60);

	it("forked worktree row shows both marks", () => {
		assert.strictEqual(stateLines[1],
			` scout  ${FORK_MARK}${WORKTREE_MARK} Auth` + " ".repeat(39) + "00:23 ");
	});

	it("stateless row gets a blank slot, name still aligned", () => {
		assert.strictEqual(stateLines[2], " worker    quick fix" + " ".repeat(34) + "00:04 ");
	});

	it("worktree-only row leaves the fork column blank", () => {
		assert.strictEqual(stateLines[3],
			` judge   ${WORKTREE_MARK} API review` + " ".repeat(33) + "01:12 ");
	});

	it("state rows exactly width wide", () => {
		assert.strictEqual(stateLines.every((l) => l.length === 60), true);
	});

	const allMarkerRows = formatRunningWidgetLines([
		{ name: "all", agent: "worker", elapsedSeconds: 1, forked: true, interactive: true, worktree: true, external: true },
		{ name: "interactive external", agent: "worker", elapsedSeconds: 2, interactive: true, external: true },
		{ name: "worktree", agent: "worker", elapsedSeconds: 3, worktree: true },
		{ name: "none", agent: "worker", elapsedSeconds: 4 },
	], 60);

	it("markers use canonical e,f,i,w order", () => {
		assert.strictEqual(allMarkerRows[1],
			` worker ${EXTERNAL_MARK}${FORK_MARK}${INTERACTIVE_MARK}${WORKTREE_MARK} all` + " ".repeat(38) + "00:01 ");
	});

	it("used marker columns stay aligned with blank cells", () => {
		assert.strictEqual(allMarkerRows[2],
			` worker ${EXTERNAL_MARK} ${INTERACTIVE_MARK}  interactive external` + " ".repeat(21) + "00:02 ");
	});

	it("rows without flags retain blanks for every used marker", () => {
		assert.strictEqual(allMarkerRows[4], " worker      none" + " ".repeat(37) + "00:04 ");
	});

	it("unused f and i columns disappear while e,w remain aligned", () => {
		const subsetMarkers = formatRunningWidgetLines([
			{ name: "external", agent: "worker", elapsedSeconds: 1, external: true },
			{ name: "worktree", agent: "worker", elapsedSeconds: 2, worktree: true },
		], 50);
		assert.deepStrictEqual(subsetMarkers.slice(1), [
			` worker ${EXTERNAL_MARK}  external` + " ".repeat(25) + "00:01 ",
			` worker  ${WORKTREE_MARK} worktree` + " ".repeat(25) + "00:02 ",
		]);
	});

	const summaryLines = formatRunningWidgetLines(
		[{ name: "only", agent: "worker", elapsedSeconds: 1 }],
		80,
		{},
		{ summary: { hiddenRows: 5, stalledRows: 1, waitingRows: 2, queuedRows: 1 } },
	);

	it("compact summary reports nonzero hidden categories in attention order", () => {
		assert.strictEqual(summaryLines[2], " +5 more · 1 stalled · 2 waiting · 1 queued · /subagent-status");
	});

	it("hidden summary adds exactly one line", () => {
		assert.strictEqual(summaryLines.length, 3);
	});

	it("summary disappears when no rows are hidden", () => {
		const zeroSummary = formatRunningWidgetLines(
			[{ name: "only", agent: "worker", elapsedSeconds: 1 }],
			60,
			{},
			{ summary: { hiddenRows: 0, stalledRows: 0, waitingRows: 0, queuedRows: 0 } },
		);
		assert.strictEqual(zeroSummary.length, 2);
	});

	it("summary and detailed rows remain width-safe together", () => {
		for (let width = -2; width <= 60; width++) {
			for (const line of formatRunningWidgetLines(rows, width, {}, {
				summary: { hiddenRows: 99, stalledRows: 2, waitingRows: 3, queuedRows: 42 },
			})) {
				assert.ok(visibleWidth(line) <= Math.max(0, width), `summary row fits width ${width}`);
			}
		}
	});

	// without a slot hook the marks fall back to dim; layout math stays plain
	const stateStyled = formatRunningWidgetLines(stateRows, 60, { dim: (t) => `<D>${t}</D>` });

	it("mark slot falls back to dim", () => {
		assert.strictEqual(stateStyled[1].includes(`<D>${FORK_MARK}${WORKTREE_MARK}</D> Auth`), true);
	});

	it("styled state row plain-length preserved", () => {
		assert.strictEqual(stateStyled[1].replaceAll("<D>", "").replaceAll("</D>", "").length, 60);
	});

	// Dedicated hooks style identifiers and marker letters as secondary metadata.
	const slotStyled = formatRunningWidgetLines(stateRows, 60, {
		dim: (t) => `<D>${t}</D>`,
		agent: (t) => `<A>${t}</A>`,
		slot: (t) => `<M>${t}</M>`,
	});

	it("agent hook styles the unbracketed identifier", () => {
		assert.strictEqual(slotStyled[1].includes(`<A>scout</A>  `), true);
	});

	it("marker hook styles the secondary metadata letters", () => {
		assert.strictEqual(slotStyled[1].includes(`<M>${FORK_MARK}${WORKTREE_MARK}</M> Auth`), true);
	});

	it("widget styles add no SGR faint sequence", () => {
		assert.strictEqual(slotStyled.join("\n").includes("\x1b[2m"), false);
	});

	it("clock still uses dim", () => {
		assert.strictEqual(slotStyled[1].endsWith("<D>00:23</D> "), true);
	});

	// narrow width with a marker group: markers survive, the name gives way
	const narrowState = formatRunningWidgetLines(
		[{ name: "a very long task name that cannot possibly fit", agent: "scout", elapsedSeconds: 61, forked: true }], 30);

	it("narrow keeps the marker group", () => {
		assert.strictEqual(narrowState[1].includes(` scout ${FORK_MARK} `), true);
	});

	it("narrow state row truncates with ellipsis", () => {
		assert.strictEqual(narrowState[1].includes("…"), true);
	});

	it("narrow state row fits width", () => {
		assert.strictEqual(narrowState[1].length <= 30, true);
	});

	// no width may overflow - pi's TUI crashes on a widget line wider than the
	// terminal. Worst case: long tag, both marks, H:MM:SS clock, long name.
	it("no line ever exceeds the render width", () => {
		const overflowRows = [
			{ name: "a very long task name that cannot possibly fit", agent: "code-reviewer", elapsedSeconds: 3723, forked: true, worktree: true },
			{ name: "x", elapsedSeconds: 0 },
		];
		// Negative widths must not throw and must emit empty lines (max(0, w)).
		for (let w = -2; w <= 45; w++) {
			for (const line of formatRunningWidgetLines(overflowRows, w)) {
				assert.ok(line.length <= Math.max(0, w), `line fits width ${w}`);
			}
		}
	});

	const hostileRow = formatRunningWidgetLines(
		[{ name: "safe\x1b]52;c;Zm9v\x07 name\0", agent: "worker\x1b[2J", elapsedSeconds: 1 }],
		50,
	);

	it("widget removes input terminal controls", () => {
		assert.strictEqual(hostileRow.join("").includes("\x1b"), false);
	});

	it("widget preserves safe identity text", () => {
		assert.strictEqual(hostileRow[1].includes("worker safe name"), true);
	});

	// ── v2 liveness: the status segment ──────────────────────────────────────

	// A row without a status renders byte-identical to the v1 row even when the
	// other segment fields are present - the whole v1 block above is the oracle.
	it("rows without status retain the identity-name-clock layout", () => {
		const v2NoStatusRows: WidgetRow[] = [
			{ name: "Scout: Auth", agent: "scout", elapsedSeconds: 23, toolName: "bash", toolElapsedSeconds: 420, contextTokens: 84_000 },
			{ name: "quick fix", agent: "worker", elapsedSeconds: 4 },
		];
		assert.deepStrictEqual(formatRunningWidgetLines(v2NoStatusRows, 60), lines);
	});

	// The example block, pinned exactly at width 78: full segment on the active
	// row, fixed context cells on every row, and blanks when context is unknown.
	const exampleRows: WidgetRow[] = [
		{ name: "Auth", agent: "scout", elapsedSeconds: 192, forked: true, worktree: true,
		  status: "active", toolName: "bash", toolElapsedSeconds: 420, contextTokens: 84_000 },
		{ name: "quick fix", agent: "worker", elapsedSeconds: 41, status: "waiting", contextTokens: 5_700 },
		{ name: "API review", agent: "judge", elapsedSeconds: 72, worktree: true, status: "stalled" },
	];
	const exampleLines = formatRunningWidgetLines(exampleRows, 78);

	it("example block: active row", () => {
		assert.strictEqual(exampleLines[1],
			" scout  fw Auth" + " ".repeat(31) + "bash 7m · active ·  84k · 03:12 ");
	});

	it("example block: waiting row rounds and pads the tokens", () => {
		assert.strictEqual(exampleLines[2],
			" worker    quick fix" + " ".repeat(35) + "waiting ·   6k · 00:41 ");
	});

	it("example block: stalled row reserves unknown context columns", () => {
		assert.strictEqual(exampleLines[3],
			" judge   w API review" + " ".repeat(34) + "stalled" + " ".repeat(8) + "· 01:12 ");
	});

	it("example block rows exactly width wide", () => {
		assert.strictEqual(exampleLines.every((l) => l.length === 78), true);
	});

	it("starting row reserves unknown context columns", () => {
		const startingLines = formatRunningWidgetLines(
			[{ name: "boot up", agent: "worker", elapsedSeconds: 5, status: "starting" }] as WidgetRow[], 50);
		assert.strictEqual(startingLines[1],
			" worker boot up" + " ".repeat(11) + "starting" + " ".repeat(8) + "· 00:05 ");
	});

	it("stalled-only row", () => {
		const stalledLines = formatRunningWidgetLines(
			[{ name: "API review", agent: "judge", elapsedSeconds: 72, status: "stalled" }] as WidgetRow[], 40);
		assert.strictEqual(stalledLines[1], " judge API rev…  stalled" + " ".repeat(8) + "· 01:12 ");
	});

	// The degradation ladder on one row at descending widths: the tool drops,
	// then the name truncates around the fixed state/context/clock core. Once the
	// core cannot coexist with identity and clock, the safe v1 ladder takes over.
	const ladderRow: WidgetRow[] = [{ name: "Auth refactor", agent: "scout", elapsedSeconds: 192,
		status: "active", toolName: "bash", toolElapsedSeconds: 420, contextTokens: 84_000 }];
	const ladderAt = (w: number) => formatRunningWidgetLines(ladderRow, w)[1];

	it("ladder 54: full tool segment returns beside the full name", () => {
		assert.strictEqual(ladderAt(54), " scout Auth refactor  bash 7m · active ·  84k · 03:12 ");
	});

	it("tool remains absent through the full-name boundary", () => {
		assert.strictEqual(
			[44, 45, 46, 47, 48, 49, 50, 51, 52, 53].every((width) => !ladderAt(width).includes("bash") && ladderAt(width).includes("Auth refactor")),
			true,
		);
	});

	it("tool returns only when it and the full name fit", () => {
		assert.strictEqual(ladderAt(54).includes("Auth refactor  bash 7m"), true);
	});

	it("ladder 53: fixed core remains aligned", () => {
		assert.strictEqual(ladderAt(53), " scout Auth refactor" + " ".repeat(11) + "active ·  84k · 03:12 ");
	});

	it("ladder 44: full name fits beside the fixed core", () => {
		assert.strictEqual(ladderAt(44), " scout Auth refactor  active ·  84k · 03:12 ");
	});

	it("ladder 43: fixed core takes the first name column", () => {
		assert.strictEqual(ladderAt(43), " scout Auth refact…  active ·  84k · 03:12 ");
	});

	it("ladder 38: fixed core remains while the name shrinks", () => {
		assert.strictEqual(ladderAt(38), " scout Auth r…  active ·  84k · 03:12 ");
	});

	it("ladder 32: fixed core remains at its identity-width limit", () => {
		assert.strictEqual(ladderAt(32), " scout …  active ·  84k · 03:12 ");
	});

	it("ladder 28: core no longer fits, so the safe name row returns", () => {
		assert.strictEqual(ladderAt(28), " scout Auth refactor  03:12 ");
	});

	it("ladder 17: identity-only plain clamp", () => {
		assert.strictEqual(ladderAt(17), " scout A…  03:12 ");
	});

	// A short name is never truncated to keep the optional tool. Once the tool
	// drops, the required core can truncate a long name below the old floor.
	it("required core may shrink a long name below 10 columns", () => {
		assert.strictEqual(ladderAt(39).includes(" Auth re… "), true);
	});

	const shortNameRow: WidgetRow[] = [{ name: "Auth", agent: "scout", elapsedSeconds: 192,
		status: "active", toolName: "bash", toolElapsedSeconds: 420, contextTokens: 84_000 }];

	it("short name 44: tool drops before truncating the whole name", () => {
		assert.strictEqual(formatRunningWidgetLines(shortNameRow, 44)[1],
			" scout Auth" + " ".repeat(11) + "active ·  84k · 03:12 ");
	});

	it("short name 45: tool returns with the whole name", () => {
		assert.strictEqual(formatRunningWidgetLines(shortNameRow, 45)[1],
			" scout Auth  bash 7m · active ·  84k · 03:12 ");
	});

	it("short name never gains an ellipsis for a segment", () => {
		assert.strictEqual(formatRunningWidgetLines(shortNameRow, 45)[1].includes("…"), false);
	});

	// Mixed tiers at ONE width: a full-segment row and a stalled row sharing a
	// tagWidth - every line exactly the width, both clocks on the right edge.
	const mixedTier = formatRunningWidgetLines(mixedTierRows, 60);

	it("mixed tiers: full-segment row", () => {
		assert.strictEqual(mixedTier[1], " scout Auth" + " ".repeat(17) + "bash 7m · active ·  84k · 03:12 ");
	});

	it("mixed tiers: stalled row", () => {
		assert.strictEqual(mixedTier[2],
			" judge API review" + " ".repeat(20) + "stalled" + " ".repeat(8) + "· 01:12 ");
	});

	it("mixed tiers: rows exactly width wide", () => {
		assert.strictEqual(mixedTier.every((l) => l.length === 60), true);
	});

	it("mixed tiers: both clocks end at the right edge", () => {
		assert.strictEqual(mixedTier[1].endsWith("03:12 ") && mixedTier[2].endsWith("01:12 "), true);
	});

	// Style hooks: the segment renders dim normally and warn iff stalled; the
	// clock stays dim; stripping the tags recovers the exact plain width.
	const segStyled = formatRunningWidgetLines(mixedTierRows, 60,
		{ dim: (t) => `<D>${t}</D>`, warn: (t) => `<W>${t}</W>` });

	it("segment dim on active", () => {
		assert.strictEqual(segStyled[1].includes("<D>bash 7m · active ·  84k</D><D> · </D><D>03:12</D> "), true);
	});

	it("segment warn on stalled, clock separator and clock stay dim", () => {
		assert.strictEqual(segStyled[2].includes(`<W>stalled${" ".repeat(7)}</W><D> · </D><D>01:12</D> `), true);
	});

	it("warn never touches a non-stalled row", () => {
		assert.strictEqual(segStyled[1].includes("<W>"), false);
	});

	it("stripped active row length still exact", () => {
		assert.strictEqual(segStyled[1].replaceAll("<D>", "").replaceAll("</D>", "").length, 60);
	});

	it("stripped stalled row length still exact", () => {
		assert.strictEqual(segStyled[2]
			.replaceAll("<D>", "").replaceAll("</D>", "").replaceAll("<W>", "").replaceAll("</W>", "").length, 60);
	});

	it("warn falls back to dim", () => {
		const warnFallback = formatRunningWidgetLines(mixedTierRows, 60, { dim: (t) => `<D>${t}</D>` });
		assert.strictEqual(warnFallback[2].includes(`<D>stalled${" ".repeat(7)}</D><D> · </D><D>01:12</D> `), true);
	});

	// Tool part renders only while active - waiting rows keep the tokens alone.
	const waitingTool = formatRunningWidgetLines(
		[{ name: "Auth", agent: "scout", elapsedSeconds: 41, status: "waiting",
		   toolName: "bash", toolElapsedSeconds: 9, contextTokens: 6_000 }] as WidgetRow[], 60);

	it("tool part only renders while active", () => {
		assert.strictEqual(waitingTool[1].includes("bash"), false);
	});

	it("waiting keeps and pads the tokens", () => {
		assert.strictEqual(waitingTool[1].includes("waiting ·   6k"), true);
	});

	// Unknown context renders as absence, not "?"; tokens render as whole
	// thousands and clamp at 0 below.
	const noTokens = formatRunningWidgetLines(
		[{ name: "Auth", agent: "scout", elapsedSeconds: 192, status: "active",
		   toolName: "bash", toolElapsedSeconds: 420 }] as WidgetRow[], 60);

	it("unknown context renders as a reserved blank cell", () => {
		assert.strictEqual(noTokens[1].includes(`bash 7m · active${" ".repeat(8)}· 03:12 `), true);
	});

	it("no stray tokens part", () => {
		assert.strictEqual(/\d+k/.test(noTokens[1]), false);
	});

	it("counts above the fixed field saturate at 999k", () => {
		const bigTokens = formatRunningWidgetLines(
			[{ name: "Auth", agent: "scout", elapsedSeconds: 41, status: "waiting", contextTokens: 1_234_900 }] as WidgetRow[], 60);
		assert.strictEqual(bigTokens[1].includes("waiting · 999k"), true);
	});

	it("negative counts clamp and pad to 0k", () => {
		const negativeTokens = formatRunningWidgetLines(
			[{ name: "Auth", agent: "scout", elapsedSeconds: 41, status: "waiting", contextTokens: -5 }] as WidgetRow[], 60);
		assert.strictEqual(negativeTokens[1].includes("waiting ·   0k"), true);
	});

	// Tool content has no reserved width or padding. The state ends at the same
	// context delimiter on every known-context row, and token right edges align.
	const alignedTelemetry = formatRunningWidgetLines([
		{ name: "Auth", agent: "scout", elapsedSeconds: 47, status: "active",
		  toolName: "bash", toolElapsedSeconds: 29, contextTokens: 6_000 },
		{ name: "boot", agent: "worker", elapsedSeconds: 48, status: "starting", contextTokens: 106_000 },
		{ name: "wait", agent: "worker", elapsedSeconds: 49, status: "waiting", contextTokens: 25_000 },
		{ name: "stall", agent: "worker", elapsedSeconds: 50, status: "stalled", contextTokens: 18_000 },
	] as WidgetRow[], 78);

	it("bash telemetry has ordered dot-separated fields and a fixed context cell", () => {
		assert.strictEqual(alignedTelemetry[1].includes("bash 29s · active ·   6k · 00:47 "), true);
	});

	it("state-to-context delimiters align", () => {
		assert.deepStrictEqual(alignedTelemetry.slice(1).map(contextDelimiterIndex), [63, 63, 63, 63]);
	});

	it("context suffixes align at their right edge", () => {
		assert.deepStrictEqual(alignedTelemetry.slice(1).map((line) => line.lastIndexOf("k")), [68, 68, 68, 68]);
	});

	it("context-to-clock separators align", () => {
		assert.deepStrictEqual(alignedTelemetry.slice(1).map((line) => line.lastIndexOf("·")), [70, 70, 70, 70]);
	});

	// Clock cells reserve the widest current clock so crossing one hour does not
	// move the state or context columns on shorter-running rows.
	const mixedClockWidths = formatRunningWidgetLines([
		{ name: "short", agent: "scout", elapsedSeconds: 47, status: "active", contextTokens: 6_000 },
		{ name: "long", agent: "scout", elapsedSeconds: 3_723, status: "active", contextTokens: 106_000 },
	] as WidgetRow[], 78);

	it("mixed clock widths keep context delimiters aligned", () => {
		assert.deepStrictEqual(mixedClockWidths.slice(1).map(contextDelimiterIndex), [61, 61]);
	});

	it("mixed clock widths keep context right edges aligned", () => {
		assert.deepStrictEqual(mixedClockWidths.slice(1).map((line) => line.lastIndexOf("k")), [66, 66]);
	});

	it("mixed clock widths keep context-to-clock separators aligned", () => {
		assert.deepStrictEqual(mixedClockWidths.slice(1).map((line) => line.lastIndexOf("·")), [68, 68]);
	});

	it("mixed clock widths keep clocks on the right edge", () => {
		assert.strictEqual(mixedClockWidths[1].endsWith("00:47 ") && mixedClockWidths[2].endsWith("1:02:03 "), true);
	});

	// Hostile toolName: child-written, so the renderer re-sanitizes it and no
	// escape byte may survive into the joined output.
	const hostileTool = formatRunningWidgetLines(
		[{ name: "Auth", agent: "scout", elapsedSeconds: 192, status: "active",
		   toolName: "ba\x1b]52;c;Zm9v\x07sh\x1b[2J\0", toolElapsedSeconds: 420, contextTokens: 84_000 }] as WidgetRow[], 60);

	it("hostile tool name yields no escape bytes", () => {
		assert.strictEqual(hostileTool.join("").includes("\x1b"), false);
	});

	it("hostile tool name yields no NUL bytes", () => {
		assert.strictEqual(hostileTool.join("").includes("\0"), false);
	});

	it("hostile tool name keeps the safe text", () => {
		assert.strictEqual(hostileTool[1].includes("bash 7m · active ·  84k"), true);
	});

	// A 40-char tool name clamps to 12 chars plus a trailing ellipsis.
	const longTool = formatRunningWidgetLines(
		[{ name: "Auth", agent: "scout", elapsedSeconds: 192, status: "active",
		   toolName: "0123456789012345678901234567890123456789", toolElapsedSeconds: 420, contextTokens: 84_000 }] as WidgetRow[], 70);

	it("long tool name clamps at 12 chars + ellipsis", () => {
		assert.strictEqual(longTool[1].includes("012345678901… 7m · active ·  84k"), true);
	});

	it("no 13th tool char leaks", () => {
		assert.strictEqual(longTool[1].includes("0123456789012"), false);
	});

	// ── display-column safety: wide glyphs, whitespace, surrogate pairs ───────
	// pi-tui's fatal overflow check measures display columns, so these use its
	// public visibleWidth implementation as an independent sweep oracle.

	// Tabs/newlines/CRs in child-controlled text become single spaces: the shared
	// sanitizer whitelists them for multi-line surfaces, but this renderer emits
	// one terminal row per child - a surviving tab is 3 columns in pi-tui (fatal
	// overflow) and a raw \n or \r corrupts the TUI's row accounting.
	const whitespaceRows = formatRunningWidgetLines(
		[{ name: "Au\tth", agent: "sc\nout", elapsedSeconds: 192, status: "active",
		   toolName: "a\tb\nc\rd", toolElapsedSeconds: 420, contextTokens: 84_000 }] as WidgetRow[], 70);

	it("no tab/newline/CR ever survives into a widget line", () => {
		assert.strictEqual(/[\t\n\r]/.test(whitespaceRows.join("")), false);
	});

	it("tab and newline in toolName become single spaces", () => {
		assert.strictEqual(whitespaceRows[1].includes("a b c d 7m"), true);
	});

	it("newline in agent becomes a single space", () => {
		assert.strictEqual(whitespaceRows[1].includes("sc out"), true);
	});

	it("tab in name becomes a single space", () => {
		assert.strictEqual(whitespaceRows[1].includes("Au th"), true);
	});

	// Wide names and tools must truncate without exceeding pi-tui's metric.
	it("wide-glyph rows never overflow or emit a lone surrogate at any width", () => {
		const hostileWideRows: WidgetRow[] = [
			{ name: "検索統合テストの実行", agent: "scout", elapsedSeconds: 192, status: "active",
			  toolName: "検索工具調用器検索工具調用器", toolElapsedSeconds: 420, contextTokens: 84_000 },
			{ name: "e" + "💥".repeat(10), agent: "worker", elapsedSeconds: 41, status: "waiting", contextTokens: 6_000 },
			{ name: "🇺🇸".repeat(10), agent: "judge", elapsedSeconds: 72, status: "active", contextTokens: 25_000 },
			{ name: "♥️".repeat(10), agent: "worker", elapsedSeconds: 73, status: "waiting", contextTokens: 106_000 },
			{ name: "Auth", agent: "judge", elapsedSeconds: 74, status: "stalled" },
		];
		for (let w = -2; w <= 120; w++) {
			for (const line of formatRunningWidgetLines(hostileWideRows, w)) {
				assert.ok(visibleWidth(line) <= Math.max(0, w), `wide-glyph row fits pi-tui's visible width at ${w}`);
				assert.ok(!hasLoneSurrogate(line), `no lone surrogate emitted at width ${w}`);
			}
		}
	});

	const flagRegression = formatRunningWidgetLines(
		[{ name: "🇺🇸".repeat(6), agent: "scout", elapsedSeconds: 47 }] as WidgetRow[], 22)[1];

	it("regional-indicator truncation fits pi-tui at the reported width", () => {
		assert.strictEqual(visibleWidth(flagRegression) <= 22, true);
	});

	it("regional-indicator truncation keeps complete flag graphemes", () => {
		assert.strictEqual(flagRegression, " scout 🇺🇸🇺🇸🇺🇸…  00:47 ");
	});

	it("wide names truncate before the fixed telemetry core", () => {
		const wideNameCore = formatRunningWidgetLines(
			[{ name: "検索検索検索検索検索検索", agent: "scout", elapsedSeconds: 47,
			   status: "active", contextTokens: 6_000 }] as WidgetRow[], 50);
		assert.strictEqual(wideNameCore[1].endsWith("active ·   6k · 00:47 "), true);
	});

	// Column-aware rows retain styling whenever the complete layout fits.
	it("ASCII rows keep the styled branch under the column guard", () => {
		const asciiGuardCheck = formatRunningWidgetLines(mixedTierRows, 60, { dim: (t) => `<D>${t}</D>` });
		assert.strictEqual(asciiGuardCheck[1].includes("<D>"), true);
	});

	// Width sweep with the v2 worst case: the longest possible segment on the
	// long-tag long-name row, plus a stalled row. No width - including negative
	// widths - may ever overflow (pi's TUI crashes on an overflowing line).
	const v2OverflowRows: WidgetRow[] = [
		{ name: "a very long task name that cannot possibly fit", agent: "code-reviewer", elapsedSeconds: 3723,
		  forked: true, worktree: true, status: "active", toolName: "twelvechartool",
		  toolElapsedSeconds: 86340, contextTokens: 100_000 },
		{ name: "x", elapsedSeconds: 0, status: "stalled" },
	];

	it("worst-case segment appears once the full name and tool fit", () => {
		assert.strictEqual(
			formatRunningWidgetLines(v2OverflowRows, 130)[1].includes("twelvecharto… 23h59m · active · 100k"),
			true,
		);
	});

	it("no v2 line ever exceeds the render width", () => {
		for (let w = -2; w <= 90; w++) {
			for (const line of formatRunningWidgetLines(v2OverflowRows, w)) {
				assert.ok(visibleWidth(line) <= Math.max(0, w), `v2 line fits width ${w}`);
			}
		}
	});

	// ── the queued pre-launch state ──────────────────────────────────────────
	// Supplied by the controller from capacity.ts's launch queue, never by
	// computeStatus: the clock counts time waiting for a concurrency slot, and
	// there is no process yet, so no tool/token telemetry and never warn.
	const queuedRow: WidgetRow[] = [{ name: "Auth", agent: "scout", elapsedSeconds: 42, status: "queued" }];

	it("queued row exact string", () => {
		assert.strictEqual(formatRunningWidgetLines(queuedRow, 50)[1],
			" scout Auth                 queued        · 00:42 ");
	});

	const queuedStyled = formatRunningWidgetLines(queuedRow, 50,
		{ dim: (t) => `<D>${t}</D>`, warn: (t) => `<W>${t}</W>` });

	it("queued core and clock separator render dim", () => {
		assert.strictEqual(queuedStyled[1].includes(`<D>queued${" ".repeat(7)}</D><D> · </D><D>00:42</D> `), true);
	});

	it("queued never uses the warn hook", () => {
		assert.strictEqual(queuedStyled[1].includes("<W>"), false);
	});

	// ── the delivering exit state ────────────────────────────────────────────
	// An exit-lifecycle state supplied by the controller from the delivering
	// map, never by computeStatus: frozen clock, no tool/token telemetry, dim
	// (never warn). "delivering" is 10 chars - the widest status word - so the
	// fixed telemetry core and the sweep must absorb it.
	const deliveringRow: WidgetRow[] = [{ name: "Auth", agent: "scout", elapsedSeconds: 192, status: "delivering" }];

	it("delivering row exact string", () => {
		assert.strictEqual(formatRunningWidgetLines(deliveringRow, 50)[1],
			" scout Auth             delivering        · 03:12 ");
	});

	it("delivering truncates the name around the fixed telemetry core", () => {
		assert.strictEqual(
			formatRunningWidgetLines(
				[{ name: "API review", agent: "judge", elapsedSeconds: 72, status: "delivering" }] as WidgetRow[], 43)[1],
			" judge API rev…  delivering        · 01:12 ");
	});

	const deliveringStyled = formatRunningWidgetLines(deliveringRow, 50,
		{ dim: (t) => `<D>${t}</D>`, warn: (t) => `<W>${t}</W>` });

	it("delivering core and clock separator render dim", () => {
		assert.strictEqual(deliveringStyled[1].includes(`<D>delivering${" ".repeat(7)}</D><D> · </D><D>03:12</D> `), true);
	});

	it("delivering never uses the warn hook", () => {
		assert.strictEqual(deliveringStyled[1].includes("<W>"), false);
	});

	const stoppedRow: WidgetRow[] = [{ name: "Auth", agent: "scout", elapsedSeconds: 192, status: "stopped" }];
	const stoppedLines = formatRunningWidgetLines(stoppedRow, 50);

	it("stopped delivery renders the human-facing stopped status", () => {
		assert.strictEqual(stoppedLines[1].includes("stopped") && !stoppedLines[1].includes("delivering"), true);
	});

	it("stopped delivery row remains exact-width", () => {
		assert.strictEqual(visibleWidth(stoppedLines[1]), 50);
	});

	it("stopped delivery uses dim rather than warning styling", () => {
		const stoppedStyled = formatRunningWidgetLines(stoppedRow, 50,
			{ dim: (t) => `<D>${t}</D>`, warn: (t) => `<W>${t}</W>` });
		assert.strictEqual(stoppedStyled[1].includes("<D>stopped") && !stoppedStyled[1].includes("<W>"), true);
	});

	// The fixed core remains while it fits with identity and clock, sacrificing
	// the name first. Once the core no longer fits, the row uses v1 geometry.
	const deliveringLadder: WidgetRow[] = [{ name: "Auth refactor", agent: "scout", elapsedSeconds: 192, status: "delivering" }];

	it("delivering ladder 42: fixed core truncates the name", () => {
		assert.strictEqual(formatRunningWidgetLines(deliveringLadder, 42)[1],
			" scout Auth r…  delivering        · 03:12 ");
	});

	it("delivering ladder 32: fixed core drops to name-and-clock geometry", () => {
		assert.strictEqual(formatRunningWidgetLines(deliveringLadder, 32)[1], " scout Auth refactor      03:12 ");
	});

	// Width sweep with delivering rows: worst-case tag, both marks, H:MM:SS
	// clock. No width - including negative - may ever overflow.
	it("no delivering line ever exceeds the render width", () => {
		const deliveringOverflowRows: WidgetRow[] = [
			{ name: "a very long task name that cannot possibly fit", agent: "code-reviewer", elapsedSeconds: 3723,
			  forked: true, worktree: true, status: "delivering" },
			{ name: "x", elapsedSeconds: 0, status: "delivering" },
		];
		for (let w = -2; w <= 70; w++) {
			for (const line of formatRunningWidgetLines(deliveringOverflowRows, w)) {
				assert.ok(visibleWidth(line) <= Math.max(0, w), `delivering line fits width ${w}`);
			}
		}
	});
});

describe("formatToolElapsed", () => {
	it("tool elapsed seconds", () => {
		assert.strictEqual(formatToolElapsed(42), "42s");
	});

	it("tool elapsed minutes", () => {
		assert.strictEqual(formatToolElapsed(420), "7m");
	});

	it("tool elapsed hours+minutes", () => {
		assert.strictEqual(formatToolElapsed(3780), "1h3m");
	});

	it("tool elapsed near a day", () => {
		assert.strictEqual(formatToolElapsed(86340), "23h59m");
	});

	it("tool elapsed minute boundary", () => {
		assert.strictEqual(formatToolElapsed(60), "1m");
	});

	it("tool elapsed hour boundary", () => {
		assert.strictEqual(formatToolElapsed(3600), "1h0m");
	});

	it("tool elapsed negative clamps to zero", () => {
		assert.strictEqual(formatToolElapsed(-5), "0s");
	});
});

describe("formatWidgetContextTokens", () => {
	// The context cell is always three right-aligned digits plus `k`.
	it("widget context one digit", () => {
		assert.strictEqual(formatWidgetContextTokens(6_000), "  6k");
	});

	it("widget context two digits", () => {
		assert.strictEqual(formatWidgetContextTokens(25_000), " 25k");
	});

	it("widget context three digits", () => {
		assert.strictEqual(formatWidgetContextTokens(106_000), "106k");
	});

	it("widget context saturates without widening", () => {
		assert.strictEqual(formatWidgetContextTokens(1_234_900), "999k");
	});

	it("widget context cells are fixed at four characters", () => {
		assert.strictEqual(
			[6_000, 25_000, 106_000, 1_234_900].every((count) => formatWidgetContextTokens(count).length === 4),
			true,
		);
	});
});

describe("displayColumns", () => {
	it("ASCII is 1 column per char", () => {
		assert.strictEqual(displayColumns("active, bash 7m"), 15);
	});

	it("the middle dot separator is 1 column", () => {
		assert.strictEqual(displayColumns("active · 84k"), 12);
	});

	it("CJK is 2 columns each", () => {
		assert.strictEqual(displayColumns("検索"), 4);
	});

	it("Hangul is 2 columns each", () => {
		assert.strictEqual(displayColumns("한글"), 4);
	});

	it("emoji is 2 columns", () => {
		assert.strictEqual(displayColumns("💥"), 2);
	});

	it("regional-indicator flag is 2 columns", () => {
		assert.strictEqual(displayColumns("🇺🇸"), 2);
	});

	it("BMP emoji grapheme is 2 columns", () => {
		assert.strictEqual(displayColumns("♥️"), 2);
	});

	it("fullwidth forms are 2 columns", () => {
		assert.strictEqual(displayColumns("Ａ１"), 4);
	});

	it("empty string is 0", () => {
		assert.strictEqual(displayColumns(""), 0);
	});
});

describe("clampToolName", () => {
	// The code-unit clamps never split a surrogate pair: the dangling high
	// surrogate is stripped, not emitted as mojibake.
	it("strips a split pair's dangling high surrogate", () => {
		assert.strictEqual(clampToolName("x𝐀𝐁𝐂𝐃𝐄𝐅"), "x𝐀𝐁𝐂𝐃𝐄…");
	});

	it("leaves a whole-pair boundary alone", () => {
		assert.strictEqual(clampToolName("012345678901💥"), "012345678901…");
	});
});

describe("formatTokens", () => {
	// pinned to pi's own footer tiers
	it("tokens under 1k", () => {
		assert.strictEqual(formatTokens(999), "999");
	});

	it("tokens decimal k", () => {
		assert.strictEqual(formatTokens(9500), "9.5k");
	});

	it("tokens whole k", () => {
		assert.strictEqual(formatTokens(372000), "372k");
	});

	it("tokens decimal M", () => {
		assert.strictEqual(formatTokens(1200000), "1.2M");
	});

	it("tokens whole M", () => {
		assert.strictEqual(formatTokens(12000000), "12M");
	});
});
