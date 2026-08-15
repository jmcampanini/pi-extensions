import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	computeTagWidth,
	formatBlockTag,
	formatBorderLine,
	formatDetailIdentity,
	formatDetailLines,
	formatFrameLine,
	formatHintBorder,
	formatPreviewIdentity,
	formatPreviewLines,
	formatResultRow,
	formatTruncationMarker,
	rendersMarkdownByDefault,
	sanitizeTerminalText,
	tailAwareTruncate,
	type RenderStyles,
} from "../render.ts";
import type { SearchResult } from "../types.ts";
import { makeBlock } from "./block-factory.ts";

let pass = 0;
let fail = 0;

function eq(label: string, got: unknown, want: unknown): void {
	const actual = JSON.stringify(got);
	const expected = JSON.stringify(want);
	if (actual === expected) {
		pass++;
		console.log(`  ok  ${label}`);
	} else {
		fail++;
		console.log(`  FAIL ${label}:\n    got  ${actual}\n    want ${expected}`);
	}
}

function ok(label: string, condition: boolean): void {
	eq(label, condition, true);
}

const block = makeBlock({
	id: "entry001:0",
	kind: "tool",
	timestamp: "2026-03-01T12:34:56.000Z",
	fields: "role:assistant type:tool tool:read entry:entry001",
	body: "alpha needle omega",
	title: "read",
	subtitle: "path=src/config.ts",
	canonicalText: "read src/config.ts\nalpha needle omega",
	canonicalBodyOffset: "read src/config.ts\n".length,
	toolName: "read",
	fileReference: { path: "src/config.ts", line: 8 },
	label: "settings",
});

const result: SearchResult = {
	block,
	match: { matches: true, score: 0, keyTokens: ["config"], bodyTokens: ["needle"] },
};

// Sanitization

eq(
	"strips CSI, cursor controls, and OSC clipboard data",
	sanitizeTerminalText("before\x1b[31mred\x1b[0m\x1b[2J\x1b]52;c;Zm9v\x07after"),
	"beforeredafter",
);
eq("strips C1 controls and unsafe C0 controls", sanitizeTerminalText("a\x9b2Jb\0c\bd\x7fe"), "abcde");
eq("normalizes carriage returns into logical line breaks", sanitizeTerminalText("a\r\nb\rc"), "a\nb\nc");
eq("keeps tabs, newlines, and ordinary Unicode", sanitizeTerminalText("界\té\n🙂"), "界\té\n🙂");

// Block identity

eq("tool rows are tagged with the tool name", formatBlockTag(block), "read");
eq("prose rows use full role tags", [
	formatBlockTag(makeBlock({ kind: "assistant" })),
	formatBlockTag(makeBlock({ kind: "user" })),
], ["Assistant", "User"]);
eq("custom and summary rows are tagged with their titles", [
	formatBlockTag(makeBlock({ kind: "custom", title: "fixture-card" })),
	formatBlockTag(makeBlock({ kind: "summary", title: "Branch summary" })),
	formatBlockTag(makeBlock({ kind: "bash", title: "Bash", subtitle: "printf hi" })),
], ["fixture-card", "Branch summary", "Bash"]);
eq("preview identity is tag plus short time", formatPreviewIdentity(block), "read · 12:34");
eq("detail identity folds tool name into the kind", formatDetailIdentity(block), "tool/read · 12:34");
eq(
	"detail identity keeps a distinct title",
	formatDetailIdentity(makeBlock({ kind: "custom", title: "fixture-card", timestamp: "2026-03-01T21:14:00.000Z" })),
	"custom · 21:14 · fixture-card",
);
eq(
	"detail identity drops a title that repeats the kind",
	formatDetailIdentity(makeBlock({ kind: "bash", title: "Bash", timestamp: "2026-03-01T21:14:00.000Z" })),
	"bash · 21:14",
);
eq("tag column width follows the widest visible tag", computeTagWidth([
	makeBlock({ kind: "tool", toolName: "read", title: "read" }),
	makeBlock({ kind: "tool", toolName: "subagent_spawn", title: "subagent_spawn" }),
]), "subagent_spawn".length);
eq("tag column width is capped", computeTagWidth([
	makeBlock({ kind: "summary", title: "An extremely long summary title" }),
]), 16);

// Markdown policy mirrors what Pi's transcript renders as markdown.

eq("markdown-by-default covers prose kinds and subagent tool traffic", [
	rendersMarkdownByDefault(makeBlock({ kind: "assistant" })),
	rendersMarkdownByDefault(makeBlock({ kind: "user" })),
	rendersMarkdownByDefault(makeBlock({ kind: "summary", title: "Branch summary" })),
	rendersMarkdownByDefault(makeBlock({ kind: "custom", title: "subagent_result" })),
	rendersMarkdownByDefault(makeBlock({ kind: "tool", toolName: "subagent_spawn", title: "subagent_spawn" })),
], [true, true, true, true, true]);
eq("ordinary tool and bash output stays raw", [
	rendersMarkdownByDefault(makeBlock({ kind: "tool", toolName: "read", title: "read" })),
	rendersMarkdownByDefault(makeBlock({ kind: "bash", title: "Bash" })),
], [false, false]);

// Row anatomy

const plainRow = stripVTControlCharacters(formatResultRow(result, true, 80, 6));
ok("selected rows carry the marker", plainRow.startsWith("▸ "));
ok("unselected rows keep column alignment", stripVTControlCharacters(formatResultRow(result, false, 80, 6)).startsWith("  read"));
eq("rows are marker, aligned tag, then detail", plainRow, "▸ read    path=src/config.ts");
ok("rows never include timestamps", !plainRow.includes("12:34") && !plainRow.includes("2026"));

const proseRow = stripVTControlCharacters(formatResultRow(
	makeBlock({ kind: "assistant", body: "  First answer line.\nsecond line" }),
	false,
	80,
	9,
));
eq("prose rows show their first body line", proseRow, "  Assistant  First answer line.");

const markedStyles: Partial<RenderStyles> = { highlight: (text) => `⟦${text}⟧` };
const highlightedRow = formatResultRow(result, false, 200, 6, markedStyles);
ok("key-matched characters highlight in place inside the detail", highlightedRow.includes("path=src/⟦config⟧.ts"));
const tagHighlightRow = formatResultRow(
	{ block, match: { matches: true, score: 0, keyTokens: ["read"], bodyTokens: [] } },
	false,
	200,
	6,
	markedStyles,
);
ok("key-matched characters highlight the tag column", tagHighlightRow.includes("⟦read⟧"));
const strippedHighlightRow = formatResultRow(
	{
		block: makeBlock({ kind: "tool", toolName: "subagent_spawn", title: "subagent_spawn", subtitle: "agent=scout" }),
		match: { matches: true, score: 5, keyTokens: ["subagent"], bodyTokens: [] },
	},
	false,
	200,
	16,
	markedStyles,
);
ok("stripped-token matches highlight the original separator-bearing text", strippedHighlightRow.includes("⟦subagent⟧_spawn"));

// Body-only matches swap the detail for a grep-style excerpt.

const bodyOnlyRow = formatResultRow(
	{ block, match: { matches: true, score: 0, keyTokens: [], bodyTokens: ["needle"] } },
	false,
	200,
	6,
	markedStyles,
);
ok("body-only match swaps the detail for the excerpt", bodyOnlyRow.includes("⟦needle⟧") && !bodyOnlyRow.includes("path="));
const longBody = `${"filler ".repeat(40)}set -euo pipefail${" trailer".repeat(40)}`;
const excerptRow = stripVTControlCharacters(formatResultRow(
	{
		block: makeBlock({ kind: "bash", title: "Bash", subtitle: "run.sh", body: longBody }),
		match: { matches: true, score: 0, keyTokens: [], bodyTokens: ["pipefail"] },
	},
	false,
	60,
	6,
));
ok("deep body excerpts are marked at both clipped ends",
	excerptRow.includes("⋯ ") && excerptRow.trimEnd().endsWith("⋯") && excerptRow.includes("pipefail"));
const keyAndBodyRow = formatResultRow(result, false, 200, 6, markedStyles);
ok("key-matched rows keep their normal detail", keyAndBodyRow.includes("path=src/⟦config⟧.ts"));

// Tail-aware truncation keeps path tails.

eq(
	"path prefixes collapse so the tail survives",
	tailAwareTruncate("path=/Users/jmcampanini/Code/github.com/scripts/create-agent.sh", 31),
	"path=…/scripts/create-agent.sh",
);
eq("short text is untouched", tailAwareTruncate("path=src/a.ts", 40), "path=src/a.ts");
eq("non-path text falls back to end truncation",
	stripVTControlCharacters(tailAwareTruncate("a".repeat(50), 10)), `${"a".repeat(9)}…`);
ok(
	"only the path portion of the longest argument collapses first",
	tailAwareTruncate("cmd=run path=/very/long/path/to/tool.ts flag=1", 38).includes("…/"),
);

// Preview pane

const previewLines = formatPreviewLines(result, 200, 8, markedStyles);
ok("preview shows the block body", previewLines.join("\n").includes("alpha"));
const lazyBodyResult: SearchResult = {
	block: makeBlock({ body: "Needle and needle; needleness" }),
	match: { matches: true, score: 0, keyTokens: [], bodyTokens: ["needle"] },
};
eq(
	"preview highlights every body occurrence",
	formatPreviewLines(lazyBodyResult, 200, 8, markedStyles).join("\n").match(/⟦Needle⟧|⟦needle⟧/g)?.length,
	3,
);
const emptyToolCall = makeBlock({ kind: "tool", toolName: "read", title: "read", body: "", canonicalText: "read {}" });
ok(
	"empty-body blocks fall back to canonical text in the preview",
	formatPreviewLines(emptyToolCall, 200, 8).join("\n").includes("read {}"),
);
const wrapped = formatPreviewLines(makeBlock({ body: "word ".repeat(50) }), 20, 6);
ok("preview wraps long lines instead of truncating them", wrapped.length > 1 && wrapped.every((line) => visibleWidth(line) <= 20));
ok(
	"clipped previews advertise the complete detail",
	formatPreviewLines(makeBlock({ body: Array.from({ length: 30 }, (_, i) => `line-${i}`).join("\n") }), 40, 4)
		.join("\n").includes("preview clipped"),
);
ok("preview carries no match metadata line", !formatPreviewLines(result, 200, 8).join("\n").includes("match ·"));

const subagentResultBlock = makeBlock({
	kind: "custom",
	title: "subagent_result",
	body: `Subagent result
Status: completed
Name: layout check
Agent: scout
ID: abc12345
Elapsed: 2s

<result>
response one
response \x1b[2Jneedle
response three
</result>

Resume: subagent_resume({ id: "abc12345", message: "..." })
Session: /sessions/child.jsonl`,
});
const subagentResult: SearchResult = {
	block: subagentResultBlock,
	match: { matches: true, score: 0, keyTokens: [], bodyTokens: ["needle"] },
};
const boundedResultPreview = formatPreviewLines(subagentResult, 100, 6, markedStyles).join("\n");
ok("bounded result preview keeps the response and clips the trailing table",
	boundedResultPreview.includes("response one") && boundedResultPreview.includes("response three")
	&& boundedResultPreview.includes("preview clipped") && !boundedResultPreview.includes("session"));
ok("response-first transformation sanitizes and preserves body-match highlights",
	boundedResultPreview.includes("response ⟦needle⟧") && !boundedResultPreview.includes("\x1b[2J"));

// Stored truncation is honest about both line counts and temp-file survival.

const truncation = {
	truncated: true as const,
	metadata: { outputLines: 12, totalLines: 90 },
	fullOutputPath: "/session/full-output.log",
};
let checkedPath = "";
const availableMarker = formatTruncationMarker(truncation, (path) => {
	checkedPath = path;
	return true;
});
eq("truncation existence callback receives the stored path", checkedPath, "/session/full-output.log");
ok("existing full output is reported with kept and total lines",
	availableMarker?.includes("12/90 lines kept") === true && availableMarker.includes("full output available"));
const missingMarker = formatTruncationMarker(truncation, () => false);
ok("missing full-output path is reported honestly", missingMarker?.includes("full-output file missing") === true);
const goneMarker = formatTruncationMarker({ truncated: true, metadata: { outputLines: 3, totalLines: 50 } }, () => true);
ok("truncation without a path says omitted data is unavailable", goneMarker?.includes("omitted output unavailable") === true);
const truncatedBlock = makeBlock({ ...block, id: "trunc", truncation });
const availablePreview = formatPreviewLines(truncatedBlock, 100, 8, {}, () => true).join("\n");
const missingPreview = formatPreviewLines(truncatedBlock, 100, 8, {}, () => false).join("\n");
ok("preview shows content beside source truncation status",
	availablePreview.includes("alpha needle omega") && availablePreview.includes("12/90 lines kept"));
ok("preview distinguishes surviving and missing output files",
	availablePreview.includes("full output available") && missingPreview.includes("full-output file missing"));
ok("one-line truncated preview prioritizes its honesty marker",
	formatPreviewLines(truncatedBlock, 100, 1, {}, () => false)[0]?.includes("full-output file missing") === true);

// Detail wraps the complete canonical text and starts directly with content.

const tokens = Array.from({ length: 80 }, (_, index) => `token-${index}`);
const completeBlock = makeBlock({
	...block,
	id: "complete",
	canonicalText: `invoke read\n${tokens.join(" ")}\nTAIL_SENTINEL`,
	body: `${tokens.join(" ")}\nTAIL_SENTINEL`,
});
const detailLines = formatDetailLines(completeBlock, 17);
ok("detail emits multiple scrollable wrapped lines", detailLines.length > 30);
ok("every detail line is width-clamped", detailLines.every((line) => visibleWidth(line) <= 17));
const detailText = detailLines.join("\n");
ok("detail retains every stored content token", tokens.every((token) => detailText.includes(token)));
ok("detail retains invocation prefix and final stored content", detailText.includes("invoke read") && detailText.includes("TAIL_SENTINEL"));
ok("detail starts with content, not a header", stripVTControlCharacters(detailLines[0] ?? "").startsWith("invoke read"));
const bashCanonical: SearchResult = {
	block: makeBlock({
		kind: "bash",
		title: "Bash",
		body: "hi",
		canonicalText: "echo hi\n\nhi\n\nexit code 0",
		canonicalBodyOffset: "echo hi\n\n".length,
	}),
	match: { matches: true, score: 0, keyTokens: [], bodyTokens: ["hi"] },
};
const bashDetail = formatDetailLines(bashCanonical, 100, markedStyles).join("\n");
ok("canonical body offset highlights output instead of repeated command text",
	!bashDetail.includes("echo ⟦hi⟧") && bashDetail.includes("\n⟦hi⟧"));

// Hostile content stays sanitized and width-safe everywhere.

const hostileBlock = makeBlock({
	...block,
	id: "hostile",
	title: "read\x1b[2J",
	subtitle: "src/界\x1b]52;c;Zm9v\x07.ts",
	canonicalText: "safe\x1b]52;c;Zm9v\x07 text\nwide 界界 é 🙂 " + "long-output ".repeat(20),
	body: "safe text\nwide 界界 é 🙂 " + "long-output ".repeat(20),
});
const hostileResult: SearchResult = {
	block: hostileBlock,
	match: { matches: true, score: 1, keyTokens: ["safe"], bodyTokens: ["safe"] },
};
const ansi = (code: number) => (text: string): string => `\x1b[${code}m${text}\x1b[0m`;
const ansiStyles: RenderStyles = {
	title: ansi(1),
	accent: ansi(36),
	muted: ansi(90),
	dim: ansi(2),
	body: ansi(37),
	highlight: ansi(43),
	border: ansi(34),
};
for (const width of [1, 2, 8, 19, 40, 80]) {
	const lines = [
		formatResultRow(hostileResult, true, width, 6, ansiStyles),
		...formatPreviewLines(hostileResult, width, 6, ansiStyles),
		...formatDetailLines(hostileResult, width, ansiStyles),
		formatBorderLine(width, ["┌", "┐"], ansi(1)("fuzzy"), ansi(90)("6/447"), ansi(34)),
		formatHintBorder(width, ["enter detail", "/ filter", "esc"], ansiStyles),
		formatFrameLine(width, ansi(37)("content"), ansi(34)),
	];
	ok(`ANSI and wide text fit width ${width}`, lines.every((line) => visibleWidth(line) <= width));
}
const safeDetail = formatDetailLines(hostileBlock, 30).join("\n").replaceAll("\x1b[0m", "");
ok("rendered session data contains no data-controlled terminal escapes",
	!safeDetail.includes("\x1b") && !safeDetail.includes("\x9b") && !safeDetail.includes("Zm9v"));
const denseBody = "e".repeat(12_000);
const denseResult: SearchResult = {
	block: makeBlock({ body: denseBody }),
	match: { matches: true, score: 0, keyTokens: [], bodyTokens: ["e", "ee", "eee"] },
};
const denseStartedAt = Date.now();
formatResultRow(denseResult, true, 100, 6, ansiStyles);
formatPreviewLines(denseResult, 100, 8, ansiStyles);
ok("dense overlapping highlights render without quadratic slowdown", Date.now() - denseStartedAt < 2_000);

// Border chrome carries the titles, counts, and hints.

eq(
	"top border embeds the title and counts inside square corners",
	formatBorderLine(31, ["┌", "┐"], "fuzzy", "6/447"),
	"┌ fuzzy ─────────────── 6/447 ┐",
);
eq("plain rules fill the width", formatBorderLine(10, ["├", "┤"]), "├────────┤");
eq(
	"titled rules embed the preview identity",
	formatBorderLine(26, ["├", "┤"], "read · 12:34"),
	"├ read · 12:34 ──────────┤",
);
ok(
	"narrow borders keep the right text and truncate the title",
	(() => {
		const line = formatBorderLine(18, ["┌", "┐"], "a-very-long-title", "6/447");
		return line.includes("6/447") && line.includes("…") && visibleWidth(line) === 18;
	})(),
);
eq(
	"hints embed in the bottom border",
	formatHintBorder(40, ["enter detail", "/ filter", "esc"]),
	"└ enter detail · / filter · esc ───────┘",
);
ok(
	"hints degrade to top-priority keys when narrow",
	(() => {
		const line = formatHintBorder(20, ["enter detail", "/ filter", "esc"]);
		return line.includes("enter detail") && !line.includes("filter") && visibleWidth(line) === 20;
	})(),
);
eq("frame lines pad content inside one-cell borders", formatFrameLine(20, "hello"), "│ hello            │");
eq("frame lines are exactly the requested width", visibleWidth(formatFrameLine(33, "x".repeat(60))), 33);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
