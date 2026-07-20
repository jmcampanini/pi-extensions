import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	formatDetailLines,
	formatHelpFooter,
	formatPreviewLines,
	formatResultRow,
	formatTruncationMarker,
	sanitizeTerminalText,
	type RenderStyles,
} from "../render.ts";
import type { Block, SearchResult } from "../types.ts";

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

const block: Block = {
	id: "entry001:0",
	kind: "tool",
	entryId: "entry001",
	entryIds: ["entry001", "entry002"],
	timestamp: "2026-03-01T12:34:56.000Z",
	fields: "tool read src/config.ts label settings",
	body: "alpha needle omega",
	title: "read",
	subtitle: "src/config.ts",
	canonicalText: "read src/config.ts\nalpha needle omega",
	canonicalBodyOffset: "read src/config.ts\n".length,
	toolName: "read",
	fileReference: { path: "src/config.ts", line: 8 },
	label: "settings",
};

const result: SearchResult = {
	block,
	match: {
		matches: true,
		score: 10,
		highlightSpans: [
			{ zone: "fields", start: block.fields.indexOf("config"), end: block.fields.indexOf("config") + "config".length },
			{ zone: "body", start: block.body.indexOf("needle"), end: block.body.indexOf("needle") + "needle".length },
		],
	},
};

// Sanitization

eq(
	"strips CSI, cursor controls, and OSC clipboard data",
	sanitizeTerminalText("before\x1b[31mred\x1b[0m\x1b[2J\x1b]52;c;Zm9v\x07after"),
	"beforeredafter",
);
eq("strips C1 controls and unsafe C0 controls", sanitizeTerminalText("a\x9b2Jb\0c\bd\x7fe"), "abcde");
eq("normalizes carriage returns into logical line breaks", sanitizeTerminalText("a\r\nb\rc"), "a\nb\nc");
eq("keeps tabs, newlines, and ordinary Unicode", sanitizeTerminalText("界\te\u0301\n🙂"), "界\te\u0301\n🙂");

const hostileBlock: Block = {
	...block,
	title: "read\x1b[2J",
	subtitle: "src/界\x1b]52;c;Zm9v\x07.ts",
	fields: "tool\x1b[31m read\x1b[0m wide 界界界",
	canonicalText: "safe\x1b]52;c;Zm9v\x07 text\nwide 界界 e\u0301 🙂 " + "long-output ".repeat(20),
	body: "safe text\nwide 界界 e\u0301 🙂 " + "long-output ".repeat(20),
};
const hostileResult: SearchResult = {
	block: hostileBlock,
	match: { matches: true, score: 1, highlightSpans: [] },
};

// Semantic styling and width safety
const ansi = (code: number) => (text: string): string => `\x1b[${code}m${text}\x1b[0m`;
const ansiStyles: RenderStyles = {
	title: ansi(1),
	accent: ansi(36),
	muted: ansi(90),
	dim: ansi(2),
	body: ansi(37),
	selected: ansi(7),
	highlight: ansi(43),
	border: ansi(34),
};
for (const width of [1, 2, 8, 19, 40, 80]) {
	const lines = [
		formatResultRow(hostileResult, true, width, ansiStyles),
		...formatPreviewLines(hostileResult, width, 6, ansiStyles),
		...formatDetailLines(hostileResult, width, ansiStyles),
		...formatHelpFooter(width, "open src/界.ts", ansiStyles),
	];
	ok(`ANSI and wide text fit width ${width}`, lines.every((line) => visibleWidth(line) <= width));
}
const denseBody = "e".repeat(12_000);
const denseResult: SearchResult = {
	block: { ...block, body: denseBody, canonicalText: denseBody, canonicalBodyOffset: 0 },
	match: {
		matches: true,
		score: 0,
		highlightSpans: Array.from({ length: denseBody.length }, (_, index) => ({
			zone: "body" as const,
			start: index,
			end: index + 1,
		})),
	},
};
const denseStartedAt = Date.now();
formatResultRow(denseResult, true, 100, ansiStyles);
formatPreviewLines(denseResult, 100, 8, ansiStyles);
ok("dense one-character highlights render without quadratic slowdown", Date.now() - denseStartedAt < 2_000);

const selectedRow = stripVTControlCharacters(formatResultRow(result, true, 200, ansiStyles));
ok("selected row has a visible marker", selectedRow.startsWith("› "));
ok("row keeps title, primary path, kind, label, and timestamp metadata",
	["read", "src/config.ts", "tool", "settings", "2026-03-01 12:34:56"].every((part) => selectedRow.includes(part)));

// Highlights happen on sanitized plain text before injected styles.
const markedStyles = {
	highlight: (text: string): string => `⟦${text}⟧`,
};
const fieldOnlyResult: SearchResult = {
	block,
	match: { ...result.match, highlightSpans: result.match.highlightSpans.filter((span) => span.zone === "fields") },
};
const highlightedRow = formatResultRow(fieldOnlyResult, false, 200, markedStyles);
ok("field highlight is applied to the matching plain substring", highlightedRow.includes("⟦config⟧"));
const highlightedPreview = formatPreviewLines(result, 200, 8, markedStyles).join("\n");
ok("body-only match is exposed and highlighted in its result row",
	formatResultRow(result, false, 200, markedStyles).includes("⟦needle⟧"));
const longHeaderResult: SearchResult = {
	block: { ...block, subtitle: "argument".repeat(50), fileReference: undefined, label: "label".repeat(30) },
	match: { ...result.match, highlightSpans: result.match.highlightSpans.filter((span) => span.zone === "body") },
};
ok("body-only highlight survives long row metadata",
	formatResultRow(longHeaderResult, false, 100, markedStyles).includes("⟦needle⟧"));
ok("fuzzy field highlight is exposed in preview metadata", highlightedPreview.includes("⟦config⟧"));
ok("body highlight is mapped into canonical preview content", highlightedPreview.includes("⟦needle⟧"));
const repeatedCanonicalBlock: Block = {
	...block,
	kind: "bash",
	body: "hi",
	canonicalText: "echo hi\n\nhi\n\nexit code 0",
	canonicalBodyOffset: "echo hi\n\n".length,
};
const repeatedCanonicalResult: SearchResult = {
	block: repeatedCanonicalBlock,
	match: { matches: true, score: 0, highlightSpans: [{ zone: "body", start: 0, end: 2 }] },
};
const repeatedCanonicalPreview = formatPreviewLines(repeatedCanonicalResult, 100, 8, markedStyles).join("\n");
ok("canonical body offset highlights output instead of repeated command text",
	!repeatedCanonicalPreview.includes("echo ⟦hi⟧") && repeatedCanonicalPreview.includes("\n⟦hi⟧"));
const controlledHighlightBlock: Block = {
	...block,
	fields: "prefix \x1b[31mneedle\x1b[0m suffix",
};
const controlledHighlight: SearchResult = {
	block: controlledHighlightBlock,
	match: {
		matches: true,
		score: 1,
		highlightSpans: [{
			zone: "fields",
			start: controlledHighlightBlock.fields.indexOf("needle"),
			end: controlledHighlightBlock.fields.indexOf("needle") + 6,
		}],
	},
};
const safeHighlightedRow = formatResultRow(controlledHighlight, false, 200, markedStyles);
ok("sanitization removes session ANSI before highlighting", !safeHighlightedRow.includes("\x1b") && safeHighlightedRow.includes("⟦needle⟧"));

// Help remains discoverable and accepts the selection-specific smart-open action.
const help = formatHelpFooter(32, "open src/config.ts at line 8").map(stripVTControlCharacters).join("\n");
ok("help advertises is operator", help.includes("is:<type>"));
ok("help advertises tool operator", help.includes("tool:<name>"));
ok("help includes copy, open, detail, paging, and filter keys",
	["y copy", "o open", "enter detail", "u/d page", "/ filter"].every((part) => help.replace(/\n/gu, " ").includes(part)));
ok("help includes the injected smart-open behavior", help.replace(/\n/gu, " ").includes("open src/"));
const filterHelp = formatHelpFooter(120, "open block text", {}, "filter").join(" ");
ok("filter help reflects that u/d type instead of page",
	filterHelp.includes("type query") && filterHelp.includes("↑/↓ move") && !filterHelp.includes("u/d page"));

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
const truncatedBlock = { ...block, truncation };
const availablePreview = formatPreviewLines(truncatedBlock, 100, 8, {}, () => true).join("\n");
const missingPreview = formatPreviewLines(truncatedBlock, 100, 8, {}, () => false).join("\n");
ok("preview shows canonical content beside source truncation status",
	availablePreview.includes("alpha needle omega") && availablePreview.includes("12/90 lines kept"));
ok("preview distinguishes surviving and missing output files",
	availablePreview.includes("full output available") && missingPreview.includes("full-output file missing"));
ok("one-line truncated preview prioritizes its honesty marker",
	formatPreviewLines(truncatedBlock, 100, 1, {}, () => false)[0]?.includes("full-output file missing") === true);

// Detail wraps rather than clipping the complete stored canonical text.
const tokens = Array.from({ length: 80 }, (_, index) => `token-${index}`);
const completeBlock: Block = {
	...block,
	canonicalText: `invoke read\n${tokens.join(" ")}\nTAIL_SENTINEL`,
	body: `${tokens.join(" ")}\nTAIL_SENTINEL`,
};
const detailLines = formatDetailLines(completeBlock, 17);
ok("detail emits multiple scrollable wrapped lines", detailLines.length > 30);
ok("every detail line is width-clamped", detailLines.every((line) => visibleWidth(line) <= 17));
const detailText = detailLines.join("\n");
ok("detail retains every stored content token", tokens.every((token) => detailText.includes(token)));
ok("detail retains invocation prefix and final stored content", detailText.includes("invoke read") && detailText.includes("TAIL_SENTINEL"));
const safeDetail = formatDetailLines(hostileBlock, 30).join("\n").replaceAll("\x1b[0m", "");
ok("rendered session data contains no data-controlled terminal escapes",
	!safeDetail.includes("\x1b") && !safeDetail.includes("\x9b") && !safeDetail.includes("Zm9v"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
