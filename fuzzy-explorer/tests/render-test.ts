import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	computeTagWidth,
	detailSections,
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
	renderedForm,
	rendersByDefault,
	sanitizeTerminalText,
	subagentSections,
	tailAwareTruncate,
	type RenderStyles,
} from "../render.ts";
import type { Block, SearchResult } from "../types.ts";
import { makeBlock } from "./block-factory.ts";

function localShortTime(timestamp: string): string {
	const date = new Date(timestamp);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
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

const markedStyles: Partial<RenderStyles> = { highlight: (text) => `⟦${text}⟧` };

describe("sanitizeTerminalText", () => {
	it("strips CSI, cursor controls, and OSC clipboard data", () => {
		assert.strictEqual(
			sanitizeTerminalText("before\x1b[31mred\x1b[0m\x1b[2J\x1b]52;c;Zm9v\x07after"),
			"beforeredafter",
		);
	});

	it("strips C1 controls and unsafe C0 controls", () => {
		assert.strictEqual(sanitizeTerminalText("a\x9b2Jb\0c\bd\x7fe"), "abcde");
	});

	it("normalizes carriage returns into logical line breaks", () => {
		assert.strictEqual(sanitizeTerminalText("a\r\nb\rc"), "a\nb\nc");
	});

	it("keeps tabs, newlines, and ordinary Unicode", () => {
		assert.strictEqual(sanitizeTerminalText("界\té\n🙂"), "界\té\n🙂");
	});
});

describe("block identity", () => {
	it("tool rows are tagged with the tool name", () => {
		assert.strictEqual(formatBlockTag(block), "read");
	});

	it("prose rows use full role tags", () => {
		assert.deepStrictEqual([
			formatBlockTag(makeBlock({ kind: "assistant" })),
			formatBlockTag(makeBlock({ kind: "user" })),
		], ["Assistant", "User"]);
	});

	it("custom and summary rows are tagged with their titles", () => {
		assert.deepStrictEqual([
			formatBlockTag(makeBlock({ kind: "custom", title: "fixture-card" })),
			formatBlockTag(makeBlock({ kind: "summary", title: "Branch summary" })),
			formatBlockTag(makeBlock({ kind: "bash", title: "Bash", subtitle: "printf hi" })),
		], ["fixture-card", "Branch summary", "Bash"]);
	});

	it("preview identity is tag plus local short time", () => {
		assert.strictEqual(formatPreviewIdentity(block), `read · ${localShortTime(block.timestamp)}`);
	});

	it("detail identity folds tool name into the kind", () => {
		assert.strictEqual(formatDetailIdentity(block), `tool/read · ${localShortTime(block.timestamp)}`);
	});

	it("detail identity keeps a distinct title", () => {
		assert.strictEqual(
			formatDetailIdentity(makeBlock({ kind: "custom", title: "fixture-card", timestamp: "2026-03-01T21:14:00.000Z" })),
			`custom · ${localShortTime("2026-03-01T21:14:00.000Z")} · fixture-card`,
		);
	});

	it("detail identity drops a title that repeats the kind", () => {
		assert.strictEqual(
			formatDetailIdentity(makeBlock({ kind: "bash", title: "Bash", timestamp: "2026-03-01T21:14:00.000Z" })),
			`bash · ${localShortTime("2026-03-01T21:14:00.000Z")}`,
		);
	});

	it("tag column width follows the widest visible tag", () => {
		assert.strictEqual(computeTagWidth([
			makeBlock({ kind: "tool", toolName: "read", title: "read" }),
			makeBlock({ kind: "tool", toolName: "subagent_spawn", title: "subagent_spawn" }),
		]), "subagent_spawn".length);
	});

	it("tag column width is capped", () => {
		assert.strictEqual(computeTagWidth([
			makeBlock({ kind: "summary", title: "An extremely long summary title" }),
		]), 16);
	});
});

// Rendering policy mirrors Pi's transcript: prose renders as markdown and
// read results follow their file type.

function readBlock(path: string, overrides: Partial<Block> = {}): Block {
	return makeBlock({
		kind: "tool",
		toolName: "read",
		title: "read",
		body: "file content",
		toolArguments: { path },
		fileReference: { path },
		...overrides,
	});
}

describe("rendersByDefault", () => {
	it("prose kinds and subagent tool traffic open rendered", () => {
		assert.deepStrictEqual([
			rendersByDefault(makeBlock({ kind: "assistant" })),
			rendersByDefault(makeBlock({ kind: "user" })),
			rendersByDefault(makeBlock({ kind: "summary", title: "Branch summary" })),
			rendersByDefault(makeBlock({ kind: "custom", title: "subagent_result" })),
			rendersByDefault(makeBlock({ kind: "tool", toolName: "subagent_spawn", title: "subagent_spawn" })),
		], [true, true, true, true, true]);
	});

	it("reads of markdown and recognized code files open rendered", () => {
		assert.deepStrictEqual([
			rendersByDefault(readBlock("docs/GUIDE.MD")),
			rendersByDefault(readBlock("src/config.ts")),
		], [true, true]);
	});

	it("reads that failed, lack a path, or have an unknown extension open raw", () => {
		assert.deepStrictEqual([
			rendersByDefault(readBlock("docs/guide.md", { isError: true })),
			rendersByDefault(readBlock("docs/guide.md", { fileReference: undefined })),
			rendersByDefault(readBlock("build.log")),
		], [false, false, false]);
	});

	it("other tool and bash output stays raw", () => {
		assert.deepStrictEqual([
			rendersByDefault(makeBlock({ kind: "tool", toolName: "grep", title: "grep", fileReference: { path: "src/config.ts" } })),
			rendersByDefault(makeBlock({ kind: "bash", title: "Bash" })),
		], [false, false]);
	});
});

describe("renderedForm", () => {
	it("markdown reads render as markdown and code reads highlight in Pi's language", () => {
		assert.deepStrictEqual([
			renderedForm(readBlock("docs/guide.md")),
			renderedForm(readBlock("src/config.ts")),
			renderedForm(readBlock("scripts/run.py")),
		], [{ mode: "markdown" }, { mode: "code", language: "typescript" }, { mode: "code", language: "python" }]);
	});

	it("everything else toggles into markdown", () => {
		assert.deepStrictEqual([
			renderedForm(readBlock("build.log")),
			renderedForm(makeBlock({ kind: "assistant" })),
			renderedForm(makeBlock({ kind: "bash", title: "Bash" })),
		], [{ mode: "markdown" }, { mode: "markdown" }, { mode: "markdown" }]);
	});
});

describe("detailSections", () => {
	it("a rendered tool call leads with its primitive arguments, then the result", () => {
		assert.deepStrictEqual(
			detailSections(readBlock("docs/guide.md", {
				toolArguments: { path: "docs/guide.md", offset: 3, nested: { skip: true } },
			})),
			[
				{ type: "fields", fields: [{ key: "path", value: "docs/guide.md" }, { key: "offset", value: "3" }] },
				{ type: "content", text: "file content" },
			],
		);
	});

	it("prose blocks are content only", () => {
		assert.deepStrictEqual(
			detailSections(makeBlock({ kind: "assistant", body: "answer" })),
			[{ type: "content", text: "answer" }],
		);
	});
});

describe("formatResultRow", () => {
	const plainRow = stripVTControlCharacters(formatResultRow(result, true, 80, 6));

	it("selected rows carry the marker", () => {
		assert.ok(plainRow.startsWith("▸ "));
	});

	it("unselected rows keep column alignment", () => {
		assert.ok(stripVTControlCharacters(formatResultRow(result, false, 80, 6)).startsWith("  read"));
	});

	it("rows are marker, aligned tag, then detail", () => {
		assert.strictEqual(plainRow, "▸ read    path=src/config.ts");
	});

	it("rows never include timestamps", () => {
		assert.ok(!plainRow.includes(localShortTime(block.timestamp)) && !plainRow.includes("2026"));
	});

	it("prose rows show their first body line", () => {
		const proseRow = stripVTControlCharacters(formatResultRow(
			makeBlock({ kind: "assistant", body: "  First answer line.\nsecond line" }),
			false,
			80,
			9,
		));
		assert.strictEqual(proseRow, "  Assistant  First answer line.");
	});

	it("key-matched characters highlight in place inside the detail", () => {
		const highlightedRow = formatResultRow(result, false, 200, 6, markedStyles);
		assert.ok(highlightedRow.includes("path=src/⟦config⟧.ts"));
	});

	it("key-matched characters highlight the tag column", () => {
		const tagHighlightRow = formatResultRow(
			{ block, match: { matches: true, score: 0, keyTokens: ["read"], bodyTokens: [] } },
			false,
			200,
			6,
			markedStyles,
		);
		assert.ok(tagHighlightRow.includes("⟦read⟧"));
	});

	it("stripped-token matches highlight the original separator-bearing text", () => {
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
		assert.ok(strippedHighlightRow.includes("⟦subagent⟧_spawn"));
	});

	it("body-only match swaps the detail for the excerpt", () => {
		const bodyOnlyRow = formatResultRow(
			{ block, match: { matches: true, score: 0, keyTokens: [], bodyTokens: ["needle"] } },
			false,
			200,
			6,
			markedStyles,
		);
		assert.ok(bodyOnlyRow.includes("⟦needle⟧") && !bodyOnlyRow.includes("path="));
	});

	it("deep body excerpts are marked at both clipped ends", () => {
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
		assert.ok(excerptRow.includes("⋯ ") && excerptRow.trimEnd().endsWith("⋯") && excerptRow.includes("pipefail"));
	});

	it("key-matched rows keep their normal detail", () => {
		const keyAndBodyRow = formatResultRow(result, false, 200, 6, markedStyles);
		assert.ok(keyAndBodyRow.includes("path=src/⟦config⟧.ts"));
	});
});

describe("tailAwareTruncate", () => {
	it("path prefixes collapse so the tail survives", () => {
		assert.strictEqual(
			tailAwareTruncate("path=/Users/jmcampanini/Code/github.com/scripts/create-agent.sh", 31),
			"path=…/scripts/create-agent.sh",
		);
	});

	it("short text is untouched", () => {
		assert.strictEqual(tailAwareTruncate("path=src/a.ts", 40), "path=src/a.ts");
	});

	it("non-path text falls back to end truncation", () => {
		assert.strictEqual(stripVTControlCharacters(tailAwareTruncate("a".repeat(50), 10)), `${"a".repeat(9)}…`);
	});

	it("only the path portion of the longest argument collapses first", () => {
		assert.ok(tailAwareTruncate("cmd=run path=/very/long/path/to/tool.ts flag=1", 38).includes("…/"));
	});
});

describe("formatPreviewLines", () => {
	it("preview shows the block body", () => {
		assert.ok(formatPreviewLines(result, 200, 8, markedStyles).join("\n").includes("alpha"));
	});

	it("preview highlights every body occurrence", () => {
		const lazyBodyResult: SearchResult = {
			block: makeBlock({ body: "Needle and needle; needleness" }),
			match: { matches: true, score: 0, keyTokens: [], bodyTokens: ["needle"] },
		};
		assert.strictEqual(
			formatPreviewLines(lazyBodyResult, 200, 8, markedStyles).join("\n").match(/⟦Needle⟧|⟦needle⟧/g)?.length,
			3,
		);
	});

	it("empty-body blocks fall back to canonical text in the preview", () => {
		const emptyToolCall = makeBlock({ kind: "tool", toolName: "read", title: "read", body: "", canonicalText: "read {}" });
		assert.ok(formatPreviewLines(emptyToolCall, 200, 8).join("\n").includes("read {}"));
	});

	it("preview wraps long lines instead of truncating them", () => {
		const wrapped = formatPreviewLines(makeBlock({ body: "word ".repeat(50) }), 20, 6);
		assert.ok(wrapped.length > 1 && wrapped.every((line) => visibleWidth(line) <= 20));
	});

	it("clipped previews advertise the complete detail", () => {
		assert.ok(
			formatPreviewLines(makeBlock({ body: Array.from({ length: 30 }, (_, i) => `line-${i}`).join("\n") }), 40, 4)
				.join("\n").includes("preview clipped"),
		);
	});

	it("preview carries no match metadata line", () => {
		assert.ok(!formatPreviewLines(result, 200, 8).join("\n").includes("match ·"));
	});

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

	it("bounded result preview keeps the response and labeled divider while clipping the trailing table", () => {
		assert.ok(boundedResultPreview.includes("response one") && boundedResultPreview.includes("response three")
			&& boundedResultPreview.includes("─ result details ─")
			&& boundedResultPreview.includes("preview clipped") && !boundedResultPreview.includes("session"));
	});

	it("response-first transformation sanitizes and preserves body-match highlights", () => {
		assert.ok(boundedResultPreview.includes("response ⟦needle⟧") && !boundedResultPreview.includes("\x1b[2J"));
	});
});

// The section plan is the single owner of subagent display layout.

describe("subagentSections", () => {
	it("result sections order content, divider, table", () => {
		assert.deepStrictEqual(
			subagentSections({ fields: [{ key: "status", value: "completed" }], content: "response", result: true })
				.map((section) => section.type),
			["content", "divider", "table"],
		);
	});

	it("a result without a response drops the divider", () => {
		assert.deepStrictEqual(
			subagentSections({ fields: [{ key: "status", value: "stopped" }], content: "", result: true })
				.map((section) => section.type),
			["table"],
		);
	});

	it("tool sections order fields then content", () => {
		assert.deepStrictEqual(
			subagentSections({ fields: [{ key: "agent", value: "scout" }], content: "task prompt" })
				.map((section) => section.type),
			["fields", "content"],
		);
	});

	it("empty sections are dropped entirely", () => {
		assert.deepStrictEqual(subagentSections({ fields: [], content: "" }), []);
	});
});

// Stored truncation is honest about both line counts and temp-file survival.

describe("truncation reporting", () => {
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
	const truncatedBlock = makeBlock({ ...block, id: "trunc", truncation });
	const availablePreview = formatPreviewLines(truncatedBlock, 100, 8, {}, () => true).join("\n");
	const missingPreview = formatPreviewLines(truncatedBlock, 100, 8, {}, () => false).join("\n");

	it("truncation existence callback receives the stored path", () => {
		assert.strictEqual(checkedPath, "/session/full-output.log");
	});

	it("existing full output is reported with kept and total lines", () => {
		assert.ok(availableMarker?.includes("12/90 lines kept") === true
			&& availableMarker.includes("full output available"));
	});

	it("missing full-output path is reported honestly", () => {
		const missingMarker = formatTruncationMarker(truncation, () => false);
		assert.ok(missingMarker?.includes("full-output file missing") === true);
	});

	it("truncation without a path says omitted data is unavailable", () => {
		const goneMarker = formatTruncationMarker({ truncated: true, metadata: { outputLines: 3, totalLines: 50 } }, () => true);
		assert.ok(goneMarker?.includes("omitted output unavailable") === true);
	});

	it("preview shows content beside source truncation status", () => {
		assert.ok(availablePreview.includes("alpha needle omega") && availablePreview.includes("12/90 lines kept"));
	});

	it("preview distinguishes surviving and missing output files", () => {
		assert.ok(availablePreview.includes("full output available") && missingPreview.includes("full-output file missing"));
	});

	it("one-line truncated preview prioritizes its honesty marker", () => {
		assert.ok(formatPreviewLines(truncatedBlock, 100, 1, {}, () => false)[0]?.includes("full-output file missing") === true);
	});
});

// Detail wraps the complete canonical text and starts directly with content.

describe("formatDetailLines", () => {
	const tokens = Array.from({ length: 80 }, (_, index) => `token-${index}`);
	const completeBlock = makeBlock({
		...block,
		id: "complete",
		canonicalText: `invoke read\n${tokens.join(" ")}\nTAIL_SENTINEL`,
		body: `${tokens.join(" ")}\nTAIL_SENTINEL`,
	});
	const detailLines = formatDetailLines(completeBlock, 17);
	const detailText = detailLines.join("\n");

	it("detail emits multiple scrollable wrapped lines", () => {
		assert.ok(detailLines.length > 30);
	});

	it("every detail line is width-clamped", () => {
		assert.ok(detailLines.every((line) => visibleWidth(line) <= 17));
	});

	it("detail retains every stored content token", () => {
		assert.ok(tokens.every((token) => detailText.includes(token)));
	});

	it("detail retains invocation prefix and final stored content", () => {
		assert.ok(detailText.includes("invoke read") && detailText.includes("TAIL_SENTINEL"));
	});

	it("detail starts with content, not a header", () => {
		assert.ok(stripVTControlCharacters(detailLines[0] ?? "").startsWith("invoke read"));
	});

	it("canonical body offset highlights output instead of repeated command text", () => {
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
		assert.ok(!bashDetail.includes("echo ⟦hi⟧") && bashDetail.includes("\n⟦hi⟧"));
	});
});

// Hostile content stays sanitized and width-safe everywhere.

describe("hostile content", () => {
	const hostileBlock = makeBlock({
		...block,
		id: "hostile",
		title: "read\x1b[2J",
		subtitle: "src/界\x1b]52;c;Zm9v\x07.ts",
		canonicalText: "safe\x1b]52;c;Zm9v\x07 text\nwide 界界 é 🙂 " + "long-output ".repeat(20),
		body: "safe text\nwide 界界 é 🙂 " + "long-output ".repeat(20),
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

	it("ANSI and wide text fit every surface at every width", () => {
		for (const width of [1, 2, 8, 19, 40, 80]) {
			const lines = [
				formatResultRow(hostileResult, true, width, 6, ansiStyles),
				...formatPreviewLines(hostileResult, width, 6, ansiStyles),
				...formatDetailLines(hostileResult, width, ansiStyles),
				formatBorderLine(width, ["┌", "┐"], ansi(1)("fuzzy"), ansi(90)("6/447"), ansi(34)),
				formatHintBorder(width, ["enter detail", "/ filter", "esc"], ansiStyles),
				formatFrameLine(width, ansi(37)("content"), ansi(34)),
			];
			assert.ok(lines.every((line) => visibleWidth(line) <= width), `ANSI and wide text fit width ${width}`);
		}
	});

	it("rendered session data contains no data-controlled terminal escapes", () => {
		const safeDetail = formatDetailLines(hostileBlock, 30).join("\n").replaceAll("\x1b[0m", "");
		assert.ok(!safeDetail.includes("\x1b") && !safeDetail.includes("\x9b") && !safeDetail.includes("Zm9v"));
	});

	it("dense overlapping highlights render without quadratic slowdown", () => {
		const denseBody = "e".repeat(12_000);
		const denseResult: SearchResult = {
			block: makeBlock({ body: denseBody }),
			match: { matches: true, score: 0, keyTokens: [], bodyTokens: ["e", "ee", "eee"] },
		};
		const denseStartedAt = Date.now();
		formatResultRow(denseResult, true, 100, 6, ansiStyles);
		formatPreviewLines(denseResult, 100, 8, ansiStyles);
		assert.ok(Date.now() - denseStartedAt < 2_000);
	});
});

// Border chrome carries the titles, counts, and hints.

describe("border chrome", () => {
	it("top border embeds the title and counts inside square corners", () => {
		assert.strictEqual(
			formatBorderLine(31, ["┌", "┐"], "fuzzy", "6/447"),
			"┌ fuzzy ─────────────── 6/447 ┐",
		);
	});

	it("plain rules fill the width", () => {
		assert.strictEqual(formatBorderLine(10, ["├", "┤"]), "├────────┤");
	});

	it("titled rules embed the preview identity", () => {
		assert.strictEqual(
			formatBorderLine(26, ["├", "┤"], "read · 12:34"),
			"├ read · 12:34 ──────────┤",
		);
	});

	it("narrow borders keep the right text and truncate the title", () => {
		const line = formatBorderLine(18, ["┌", "┐"], "a-very-long-title", "6/447");
		assert.ok(line.includes("6/447") && line.includes("…") && visibleWidth(line) === 18);
	});

	it("hints embed in the bottom border", () => {
		assert.strictEqual(
			formatHintBorder(40, ["enter detail", "/ filter", "esc"]),
			"└ enter detail · / filter · esc ───────┘",
		);
	});

	it("hints degrade to top-priority keys when narrow", () => {
		const line = formatHintBorder(20, ["enter detail", "/ filter", "esc"]);
		assert.ok(line.includes("enter detail") && !line.includes("filter") && visibleWidth(line) === 20);
	});

	it("frame lines pad content inside one-cell borders", () => {
		assert.strictEqual(formatFrameLine(20, "hello"), "│ hello            │");
	});

	it("frame lines are exactly the requested width", () => {
		assert.strictEqual(visibleWidth(formatFrameLine(33, "x".repeat(60))), 33);
	});
});
