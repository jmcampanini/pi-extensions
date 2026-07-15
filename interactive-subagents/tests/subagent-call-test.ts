import { initTheme, type ExtensionAPI, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import * as subagentCall from "../subagent-call.ts";
import { registerSubagentTool } from "../tool-subagent.ts";

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown): void {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}:\n    got  ${g}\n    want ${w}`); }
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const wide = /^(?:\p{Extended_Pictographic}|\p{Script_Extensions=Han}|\p{Script_Extensions=Hiragana}|\p{Script_Extensions=Katakana}|\p{Script_Extensions=Hangul})$/u;
const ansiAtStart = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/;

function graphemeWidth(grapheme: string): number {
	if (/^[\p{Mark}\p{Control}\p{Default_Ignorable_Code_Point}]+$/u.test(grapheme)) return 0;
	return wide.test(grapheme) || /[\uFF01-\uFF60\uFFE0-\uFFE6]/u.test(grapheme) ? 2 : 1;
}

function fallbackVisibleWidth(text: string): number {
	let width = 0;
	for (const { segment } of segmenter.segment(stripVTControlCharacters(text).replace(/\t/g, "   "))) {
		width += graphemeWidth(segment);
	}
	return width;
}

function tokens(text: string): Array<{ text: string; width: number }> {
	const result: Array<{ text: string; width: number }> = [];
	let offset = 0;
	while (offset < text.length) {
		const ansi = text.slice(offset).match(ansiAtStart)?.[0];
		if (ansi) {
			result.push({ text: ansi, width: 0 });
			offset += ansi.length;
			continue;
		}
		const escape = text.indexOf("\x1b", offset);
		const end = escape === -1 ? text.length : escape;
		for (const { segment } of segmenter.segment(text.slice(offset, end))) {
			result.push({ text: segment, width: graphemeWidth(segment) });
		}
		offset = end;
	}
	return result;
}

function fallbackTruncate(text: string, width: number, ellipsis = "..."): string {
	if (width <= 0) return "";
	if (fallbackVisibleWidth(text) <= width) return text;
	const ellipsisWidth = fallbackVisibleWidth(ellipsis);
	if (ellipsisWidth >= width) {
		let result = "", used = 0;
		for (const token of tokens(ellipsis)) {
			if (used + token.width > width) break;
			result += token.text;
			used += token.width;
		}
		return result;
	}
	let result = "", used = 0;
	for (const token of tokens(text)) {
		if (used + token.width > width - ellipsisWidth) break;
		result += token.text;
		used += token.width;
	}
	return `${result}\x1b[0m${ellipsis}\x1b[0m`;
}

function fallbackRenderText(text: string, width: number): string[] {
	const lines: string[] = [];
	for (const logicalLine of text.replace(/\t/g, "   ").split("\n")) {
		if (logicalLine === "") {
			lines.push("");
			continue;
		}
		let line = "", used = 0;
		for (const token of tokens(logicalLine)) {
			if (token.width > 0 && used > 0 && used + token.width > width) {
				lines.push(line);
				line = "";
				used = 0;
			}
			line += token.text;
			used += token.width;
		}
		lines.push(line);
	}
	return lines;
}

const packageName = "@earendil-works/pi-tui";
const tui = await import(packageName).catch(() => undefined) as
	| {
		visibleWidth: (text: string) => number;
		truncateToWidth: (text: string, width: number, ellipsis?: string) => string;
		Text: new (text: string, paddingX: number, paddingY: number) => { render(width: number): string[] };
	}
	| undefined;
const metrics = tui
	? {
		visibleWidth: tui.visibleWidth,
		truncateToWidth: tui.truncateToWidth,
		renderText: (text: string, width: number) => new tui.Text(text, 0, 0).render(width),
	}
	: {
		visibleWidth: fallbackVisibleWidth,
		truncateToWidth: fallbackTruncate,
		renderText: fallbackRenderText,
	};

const { formatCollapsedSubagentCall, formatExpandedSubagentCall } = subagentCall;
eq("module exports only production formatters", Object.keys(subagentCall).sort(), ["formatCollapsedSubagentCall", "formatExpandedSubagentCall"]);

const task = "Trace authentication from the HTTP entry point.";
const args = { name: "Auth flow", agent: "scout", task };
const plainLines = (lines: string[]): string[] => lines.map((line) => stripVTControlCharacters(line).trimEnd());
const comfortable = formatCollapsedSubagentCall(args, 100, metrics);
eq("collapsed call has two content lines separated by a blank line", comfortable.length, 3);
eq("comfortable heading", plainLines(comfortable)[0], "subagent Auth flow · scout");
eq("comfortable spacer", plainLines(comfortable)[1], "");
eq("comfortable task preview", plainLines(comfortable)[2], task);

const narrow = formatCollapsedSubagentCall(args, 44, metrics);
eq("narrow heading preserves identity", plainLines(narrow)[0], "subagent Auth flow · scout");
eq("narrow preview starts with the task", plainLines(narrow)[2].startsWith("Trace authentication"), true);
eq("narrow preview has no ellipsis", plainLines(narrow)[2].includes("…"), false);
eq("narrow lines fit terminal columns", narrow.every((line) => metrics.visibleWidth(line) <= 44), true);

const styled = formatCollapsedSubagentCall(
	{ name: "界e\u0301", agent: "偵察", task: "漢字 and cafe\u0301 continue" },
	36,
	metrics,
	{
		title: (text) => `\x1b[1;34m${text}\x1b[0m`,
		agent: (text) => `\x1b[35m${text}\x1b[0m`,
		name: (text) => `\x1b[32m${text}\x1b[0m`,
		preview: (text) => `\x1b[2m${text}\x1b[0m`,
	},
);
eq("ANSI styles are retained", styled.join("").includes("\x1b["), true);
eq("ANSI and wide/combining lines obey terminal width", styled.every((line) => metrics.visibleWidth(line) <= 36), true);
eq("wide/combining identity is preserved", plainLines(styled)[0], "subagent 界e\u0301 · 偵察");

const hostileArgs = {
	name: "Auth\x1b[2J flow\0",
	agent: "scout\x1b]52;c;Zm9v\x07",
	task: "Trace \x1b]52;c;YmFy\x1b\\authentication.\b",
};
const hostileCollapsed = formatCollapsedSubagentCall(hostileArgs, 100, metrics);
eq("collapsed input terminal controls are removed", hostileCollapsed.join("").includes("\x1b]52"), false);
eq("collapsed input keeps safe text", plainLines(hostileCollapsed), ["subagent Auth flow · scout", "", "Trace authentication."]);
const hostileExpanded = formatExpandedSubagentCall(hostileArgs, 100, metrics);
eq("expanded input terminal controls are removed", hostileExpanded.join("").includes("\x1b]52"), false);
eq("expanded input keeps safe text", plainLines(hostileExpanded).slice(0, 3), ["subagent Auth flow · scout", "", "Trace authentication."]);

eq(
	"multiline task is normalized for preview",
	plainLines(formatCollapsedSubagentCall({ name: "N", task: "Trace auth.\n\nReturn  file:\tline pointers." }, 100, metrics)),
	["subagent N · worker", "", "Trace auth. Return file: line pointers."],
);
eq("an omitted agent displays worker without brackets", plainLines(formatCollapsedSubagentCall({ name: "Tests", task: "Run" }, 100, metrics))[0], "subagent Tests · worker");
eq("an explicit blank agent falls back to worker", plainLines(formatCollapsedSubagentCall({ name: "Tests", agent: "", task: "Run" }, 100, metrics))[0], "subagent Tests · worker");
eq("an explicit whitespace agent falls back to worker", plainLines(formatCollapsedSubagentCall({ name: "Tests", agent: " \t ", task: "Run" }, 100, metrics))[0], "subagent Tests · worker");
eq(
	"collapsed call advertises expansion when task detail is hidden",
	plainLines(formatCollapsedSubagentCall({ name: "Tests", task: "first\nsecond" }, 100, metrics, {}, "Ctrl+O to expand"))[0],
	"subagent Tests · worker (Ctrl+O to expand)",
);
eq(
	"collapsed call omits the expansion hint when the full task is already visible",
	plainLines(formatCollapsedSubagentCall({ name: "Tests", task: "Run" }, 100, metrics, {}, "Ctrl+O to expand"))[0],
	"subagent Tests · worker",
);
const longIdentityHeading = plainLines(formatCollapsedSubagentCall(
	{ name: "A very long invocation name that must yield space to metadata", agent: "code-reviewer", task: "first\nsecond" },
	80,
	metrics,
	{},
	"Ctrl+O to expand",
))[0];
eq("long names clip before the agent profile", longIdentityHeading.includes("· code-reviewer"), true);
eq("long names clip before the expansion hint", longIdentityHeading.endsWith("(Ctrl+O to expand)"), true);
eq("long identity headings still fit", metrics.visibleWidth(longIdentityHeading) <= 80, true);
eq("collapsed width zero is empty", formatCollapsedSubagentCall(args, 0, metrics), []);
eq("collapsed width one obeys the width contract", formatCollapsedSubagentCall(args, 1, metrics).every((line) => metrics.visibleWidth(line) <= 1), true);
eq(
	"collapsed extreme width retains all content",
	plainLines(formatCollapsedSubagentCall(args, 1_000_000, metrics)),
	["subagent Auth flow · scout", "", task],
);

const original = "first\tcolumn\rsecond\r\n界e\u0301";
const expanded = formatExpandedSubagentCall({ name: "Auth flow", agent: "scout", task: original }, 120, metrics).map((line) => line.trimEnd());
eq("expanded heading keeps identity", expanded.slice(0, 2), ["subagent Auth flow · scout", ""]);
eq("expanded uses Text tab display and safe CR line breaks", expanded.slice(2), ["first   column", "second", "界e\u0301"]);
eq("expanded width zero emits no lines", formatExpandedSubagentCall(args, 0, metrics), []);
for (const width of [1, 2, 5]) {
	const lines = formatExpandedSubagentCall(
		{ name: "界e\u0301", agent: "偵察", task: "漢字\ne\u0301 and text" },
		width,
		metrics,
		{ title: (text) => `\x1b[1m${text}\x1b[0m` },
	);
	eq(`expanded ANSI/wide lines fit width ${width}`, lines.every((line) => metrics.visibleWidth(line) <= width), true);
}
eq(
	"wide task remains visible when a grapheme fits",
	formatExpandedSubagentCall({ name: "N", task: "界" }, 2, metrics).some((line) => stripVTControlCharacters(line).includes("界")),
	true,
);

initTheme(undefined, false);
let registeredTool: ToolDefinition | undefined;
registerSubagentTool({
	registerTool(tool: ToolDefinition): void {
		registeredTool = tool;
	},
} as unknown as ExtensionAPI);
const callRenderer = registeredTool?.renderCall;
if (callRenderer === undefined) {
	eq("registered subagent tool has a call renderer", false, true);
} else {
	const colorCode: Record<string, number> = {
		toolTitle: 31,
		accent: 32,
		muted: 33,
		dim: 2,
		toolOutput: 36,
	};
	const markedTheme = {
		fg: (color: string, text: string) => `\x1b[${colorCode[color] ?? 37}m${text}\x1b[0m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
	} as unknown as Theme;
	const renderContext = (expanded: boolean) => ({
		args: {},
		toolCallId: "call-1",
		invalidate(): void {},
		lastComponent: undefined,
		state: {},
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded,
		showImages: false,
		isError: false,
	}) as Parameters<typeof callRenderer>[2];
	const renderArgs = { name: "Auth flow", agent: "worker", task: "first\nsecond" } as Parameters<typeof callRenderer>[0];
	const collapsedOutput = callRenderer(renderArgs, markedTheme, renderContext(false)).render(120).join("\n");
	const collapsedPlain = stripVTControlCharacters(collapsedOutput);
	eq("registered renderer styles the lowercase keyword as a bold tool title", collapsedOutput.includes("\x1b[31m\x1b[1msubagent"), true);
	eq("registered renderer styles the invocation name as the primary accent", collapsedOutput.includes("\x1b[32mAuth flow\x1b[0m"), true);
	eq("registered renderer styles the unbracketed agent as muted metadata", collapsedOutput.includes("\x1b[33m · worker\x1b[0m"), true);
	eq("registered renderer displays an expansion hint", collapsedPlain.includes("to expand"), true);
	eq("registered renderer styles the task preview as dim", collapsedOutput.includes("\x1b[2mfirst second\x1b[0m"), true);
	const toolSource = readFileSync(new URL("../tool-subagent.ts", import.meta.url), "utf8");
	eq("registered renderer resolves the configured expansion binding", toolSource.includes('keyHint("app.tools.expand", "to expand")'), true);
	const expandedOutput = callRenderer(renderArgs, markedTheme, renderContext(true)).render(120).join("\n");
	eq("registered renderer styles the expanded task body as tool output", expandedOutput.includes("\x1b[36mfirst"), true);
}

console.log(`\n${pass} passed, ${fail} failed (${tui ? "pi-tui metrics" : "faithful fallback metrics"})`);
process.exit(fail === 0 ? 0 : 1);
