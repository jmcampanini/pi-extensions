import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { initTheme, type ExtensionAPI, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { config } from "../config.ts";
import { ledger } from "../state.ts";
import * as subagentCall from "../subagent-call.ts";
import { registerSubagentResumeTool } from "../tool-resume.ts";
import { registerSubagentSpawnTool } from "../tool-spawn.ts";

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

const END_STYLES = "\x1b[39;22;23;24;27;29m";
function fallbackCut(text: string, maxWidth: number, ellipsis: string): string {
	const ellipsisWidth = fallbackVisibleWidth(ellipsis);
	if (ellipsisWidth >= maxWidth) {
		let result = "", used = 0;
		for (const token of tokens(ellipsis)) {
			if (used + token.width > maxWidth) break;
			result += token.text;
			used += token.width;
		}
		return result;
	}
	let kept = "", used = 0;
	for (const token of tokens(text)) {
		if (used + token.width > maxWidth - ellipsisWidth) break;
		kept += token.text;
		used += token.width;
	}
	return kept.includes("\x1b") ? kept + END_STYLES + ellipsis : kept + ellipsis;
}

function fallbackFitText(text: string, maxWidth: number, ellipsis = "…"): string {
	if (maxWidth <= 0) return "";
	if (fallbackVisibleWidth(text) <= maxWidth) return text;
	return fallbackCut(text, maxWidth, ellipsis);
}

function fallbackClampStyled(line: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (fallbackVisibleWidth(line) <= maxWidth) return line;
	return fallbackCut(line, maxWidth, "");
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
		Text: new (text: string, paddingX: number, paddingY: number) => { render(width: number): string[] };
	}
	| undefined;
const textFitModule = "../../shared/text-fit.ts";
const textFit = tui
	? await import(textFitModule) as {
		fitText: (text: string, maxWidth: number, ellipsis?: string) => string;
		clampStyled: (line: string, maxWidth: number) => string;
	}
	: undefined;
const metrics = tui && textFit
	? {
		visibleWidth: tui.visibleWidth,
		fitText: textFit.fitText,
		clampStyled: textFit.clampStyled,
		renderText: (text: string, width: number) => new tui.Text(text, 0, 0).render(width),
	}
	: {
		visibleWidth: fallbackVisibleWidth,
		fitText: fallbackFitText,
		clampStyled: fallbackClampStyled,
		renderText: fallbackRenderText,
	};

const {
	formatCollapsedSubagentCall,
	formatCollapsedSubagentResumeCall,
	formatExpandedSubagentCall,
	formatExpandedSubagentResumeCall,
} = subagentCall;

const task = "Trace authentication from the HTTP entry point.";
const args = { name: "Auth flow", agent: "scout", task };
const resumeArgs = { name: "Auth flow", agent: "scout", message: "Apply the fix and rerun the tests." };
const longTask = Array.from({ length: 80 }, (_, index) => `step-${index}`).join(" ");
const hostileArgs = {
	name: "Auth\x1b[2J flow\0",
	agent: "scout\x1b]52;c;Zm9v\x07",
	task: "Trace \x1b]52;c;YmFy\x1b\\authentication.\b",
};
const plainLines = (lines: string[]): string[] => lines.map((line) => stripVTControlCharacters(line).trimEnd());

describe("subagent-call module", () => {
	it("module exports only production formatters", () => {
		assert.deepStrictEqual(Object.keys(subagentCall).sort(), [
			"formatCollapsedSubagentCall",
			"formatCollapsedSubagentResumeCall",
			"formatExpandedSubagentCall",
			"formatExpandedSubagentResumeCall",
		]);
	});
});

describe("formatCollapsedSubagentCall", () => {
	const comfortable = formatCollapsedSubagentCall(args, 100, 3, metrics);

	it("collapsed call has heading, model metadata, spacer, and task", () => {
		assert.strictEqual(comfortable.length, 4);
	});

	it("comfortable heading", () => {
		assert.strictEqual(plainLines(comfortable)[0], "subagent spawn · scout · Auth flow");
	});

	it("comfortable inherited model", () => {
		assert.strictEqual(plainLines(comfortable)[1], "inherits model");
	});

	it("comfortable spacer", () => {
		assert.strictEqual(plainLines(comfortable)[2], "");
	});

	it("comfortable task preview", () => {
		assert.strictEqual(plainLines(comfortable)[3], task);
	});

	const narrow = formatCollapsedSubagentCall(args, 44, 3, metrics);

	it("narrow heading preserves identity", () => {
		assert.strictEqual(plainLines(narrow)[0], "subagent spawn · scout · Auth flow");
	});

	it("narrow preview starts with the task", () => {
		assert.strictEqual(plainLines(narrow)[3].startsWith("Trace authentication"), true);
	});

	it("narrow preview has no ellipsis", () => {
		assert.strictEqual(plainLines(narrow)[3].includes("…"), false);
	});

	it("narrow lines fit terminal columns", () => {
		assert.strictEqual(narrow.every((line) => metrics.visibleWidth(line) <= 44), true);
	});

	const threeLinePreview = formatCollapsedSubagentCall(
		{ name: "Long task", task: longTask },
		60,
		3,
		metrics,
		{},
		"Ctrl+O",
	);

	it("configured call previews include a header, model metadata, three visual lines, and a hint footer", () => {
		assert.strictEqual(threeLinePreview.length, 8);
	});

	it("call headings no longer carry the expansion hint", () => {
		assert.strictEqual(plainLines(threeLinePreview)[0].includes("to expand"), false);
	});

	it("clipped call previews mark omitted text with an ellipsis", () => {
		assert.strictEqual(plainLines(threeLinePreview)[5].endsWith("…"), true);
	});

	it("call preview footers advertise detail hidden by the line limit", () => {
		assert.strictEqual(plainLines(threeLinePreview).at(-1), "(Ctrl+O to expand)");
	});

	const headerOnlyCall = formatCollapsedSubagentCall(
		{ name: "Long task", task: longTask },
		100,
		0,
		metrics,
		{},
		"Ctrl+O",
	);

	it("zero call preview lines retain the heading, model metadata, and hint footer", () => {
		assert.strictEqual(headerOnlyCall.length, 4);
	});

	it("header-only calls retain the expansion hint in the footer", () => {
		assert.strictEqual(plainLines(headerOnlyCall).at(-1), "(Ctrl+O to expand)");
	});

	it("maximum call preview line limit is honored after wrapped model metadata", () => {
		const twentyLinePreview = formatCollapsedSubagentCall(
			{ name: "Maximum", task: longTask },
			10,
			20,
			metrics,
		);
		assert.strictEqual(twentyLinePreview.length, 24);
	});

	const styled = formatCollapsedSubagentCall(
		{ name: "界e\u0301", agent: "偵察", task: "漢字 and cafe\u0301 continue" },
		36,
		3,
		metrics,
		{
			title: (text) => `\x1b[1;34m${text}\x1b[0m`,
			agent: (text) => `\x1b[35m${text}\x1b[0m`,
			name: (text) => `\x1b[32m${text}\x1b[0m`,
			preview: (text) => `\x1b[2m${text}\x1b[0m`,
		},
	);

	it("ANSI styles are retained", () => {
		assert.strictEqual(styled.join("").includes("\x1b["), true);
	});

	it("ANSI and wide/combining lines obey terminal width", () => {
		assert.strictEqual(styled.every((line) => metrics.visibleWidth(line) <= 36), true);
	});

	it("wide/combining identity is preserved", () => {
		assert.strictEqual(plainLines(styled)[0], "subagent spawn · 偵察 · 界e\u0301");
	});

	const hostileCollapsed = formatCollapsedSubagentCall(hostileArgs, 100, 3, metrics);

	it("collapsed input terminal controls are removed", () => {
		assert.strictEqual(hostileCollapsed.join("").includes("\x1b]52"), false);
	});

	it("collapsed input keeps safe text", () => {
		assert.deepStrictEqual(plainLines(hostileCollapsed), [
			"subagent spawn · scout · Auth flow",
			"inherits model",
			"",
			"Trace authentication.",
		]);
	});

	it("effective model metadata strips terminal controls", () => {
		const hostileModel = formatCollapsedSubagentCall(
			{ ...hostileArgs, effectiveModel: "provider/model\x1b]52;c;Zm9v\x07" },
			100,
			3,
			metrics,
		);
		assert.strictEqual(plainLines(hostileModel)[1], "model provider/model");
	});

	it("multiline task is normalized for preview", () => {
		assert.deepStrictEqual(
			plainLines(formatCollapsedSubagentCall({ name: "N", task: "Trace auth.\n\nReturn  file:\tline pointers." }, 100, 3, metrics)),
			["subagent spawn · worker · N", "inherits model", "", "Trace auth. Return file: line pointers."],
		);
	});

	it("an omitted agent displays worker without brackets", () => {
		assert.strictEqual(
			plainLines(formatCollapsedSubagentCall({ name: "Tests", task: "Run" }, 100, 3, metrics))[0],
			"subagent spawn · worker · Tests",
		);
	});

	it("collapsed call advertises expansion when task detail is hidden", () => {
		assert.strictEqual(
			plainLines(formatCollapsedSubagentCall({ name: "Tests", task: "first\nsecond" }, 100, 3, metrics, {}, "Ctrl+O")).at(-1),
			"(Ctrl+O to expand)",
		);
	});

	it("collapsed call omits the expansion hint when the full task is already visible", () => {
		assert.deepStrictEqual(
			plainLines(formatCollapsedSubagentCall({ name: "Tests", task: "Run" }, 100, 3, metrics, {}, "Ctrl+O")),
			["subagent spawn · worker · Tests", "inherits model", "", "Run"],
		);
	});

	const longIdentity = plainLines(formatCollapsedSubagentCall(
		{ name: "A very long invocation name that must yield space to metadata", agent: "code-reviewer", task: "first\nsecond" },
		80,
		3,
		metrics,
		{},
		"Ctrl+O",
	));

	it("long names retain the agent profile before the clipped name", () => {
		assert.strictEqual(longIdentity[0].includes("· code-reviewer ·"), true);
	});

	it("long names are clipped with an ellipsis", () => {
		assert.strictEqual(longIdentity[0].endsWith("…"), true);
	});

	it("long identity headings still fit", () => {
		assert.strictEqual(metrics.visibleWidth(longIdentity[0]) <= 80, true);
	});

	it("hidden detail keeps its hint in the footer at any heading length", () => {
		assert.strictEqual(longIdentity.at(-1), "(Ctrl+O to expand)");
	});

	it("unstyled narrow renders contain no residual escape codes", () => {
		const narrowUnstyled = formatCollapsedSubagentCall(args, 20, 3, metrics, {}, "Ctrl+O");
		assert.strictEqual(narrowUnstyled.join("").includes("\x1b"), false);
	});

	const narrowLongAgentHeading = plainLines(formatCollapsedSubagentCall(
		{ name: "Auth flow", agent: "code-reviewer", task: "Run" },
		30,
		3,
		metrics,
	))[0];

	it("narrow headers preserve the separator after a clipped agent", () => {
		assert.strictEqual(narrowLongAgentHeading.includes("… · "), true);
	});

	it("narrow long-agent headings still fit", () => {
		assert.strictEqual(metrics.visibleWidth(narrowLongAgentHeading) <= 30, true);
	});

	it("collapsed width zero is empty", () => {
		assert.deepStrictEqual(formatCollapsedSubagentCall(args, 0, 3, metrics), []);
	});

	it("collapsed width one obeys the width contract", () => {
		assert.strictEqual(
			formatCollapsedSubagentCall(args, 1, 3, metrics).every((line) => metrics.visibleWidth(line) <= 1),
			true,
		);
	});

	it("collapsed extreme width retains all content", () => {
		assert.deepStrictEqual(
			plainLines(formatCollapsedSubagentCall(args, 1_000_000, 3, metrics)),
			["subagent spawn · scout · Auth flow", "inherits model", "", task],
		);
	});
});

describe("formatCollapsedSubagentResumeCall", () => {
	const comfortableResume = formatCollapsedSubagentResumeCall(resumeArgs, 100, 3, metrics);

	it("resume call matches the spawn identity grammar", () => {
		assert.strictEqual(plainLines(comfortableResume)[0], "subagent resume · scout · Auth flow");
	});

	it("resume call separates its follow-up with a blank line", () => {
		assert.strictEqual(plainLines(comfortableResume)[1], "");
	});

	it("resume call previews its follow-up", () => {
		assert.strictEqual(plainLines(comfortableResume)[2], resumeArgs.message);
	});

	const multilineResume = plainLines(formatCollapsedSubagentResumeCall(
		{ ...resumeArgs, message: "Apply the fix.\nRerun the tests." },
		100,
		3,
		metrics,
		{},
		"Ctrl+O",
	));

	it("multiline resume follow-up advertises expansion in the footer", () => {
		assert.strictEqual(multilineResume.at(-1), "(Ctrl+O to expand)");
	});

	it("multiline resume keeps its heading free of the hint", () => {
		assert.strictEqual(multilineResume[0], "subagent resume · scout · Auth flow");
	});

	it("resume without a follow-up has a neutral preview and no expansion hint", () => {
		assert.deepStrictEqual(
			plainLines(formatCollapsedSubagentResumeCall(
				{ name: "Auth flow", agent: "scout" },
				100,
				3,
				metrics,
				{},
				"Ctrl+O",
			)),
			["subagent resume · scout · Auth flow", "", "No follow-up message."],
		);
	});

	it("zero-line empty resumes have no spacer or misleading expansion hint", () => {
		const headerOnlyEmptyResume = formatCollapsedSubagentResumeCall(
			{ name: "No follow-up" },
			100,
			0,
			metrics,
			{},
			"Ctrl+O",
		);
		assert.deepStrictEqual(plainLines(headerOnlyEmptyResume), ["subagent resume · worker · No follow-up"]);
	});

	it("resume rendering never exceeds terminal columns at any width", () => {
		for (const width of [0, 1, 2, 8, 20, 36]) {
			const lines = formatCollapsedSubagentResumeCall(
				{ name: "界e\u0301 🙂 review", agent: "偵察", message: "漢字 e\u0301 🙂 continue the investigation" },
				width,
				3,
				metrics,
				{},
				"Ctrl+O",
			);
			assert.strictEqual(
				lines.every((line) => metrics.visibleWidth(line) <= width),
				true,
				`resume width ${width} never exceeds terminal columns`,
			);
		}
	});

	const hostileResume = formatCollapsedSubagentResumeCall(
		{ name: hostileArgs.name, agent: hostileArgs.agent, message: hostileArgs.task },
		100,
		3,
		metrics,
	);

	it("resume input terminal controls are removed", () => {
		assert.strictEqual(hostileResume.join("").includes("\x1b]52"), false);
	});

	it("resume input keeps safe text", () => {
		assert.deepStrictEqual(plainLines(hostileResume),
			["subagent resume · scout · Auth flow", "", "Trace authentication."]);
	});
});

describe("formatExpandedSubagentResumeCall", () => {
	it("expanded resume preserves the complete follow-up", () => {
		assert.deepStrictEqual(
			plainLines(formatExpandedSubagentResumeCall(
				{ ...resumeArgs, message: "Apply the fix.\n\nRerun the tests." },
				100,
				metrics,
			)),
			["subagent resume · scout · Auth flow", "", "Apply the fix.", "", "Rerun the tests."],
		);
	});
});

describe("formatExpandedSubagentCall", () => {
	const original = "first\tcolumn\rsecond\r\n界e\u0301";
	const expanded = formatExpandedSubagentCall({ name: "Auth flow", agent: "scout", task: original }, 120, metrics)
		.map((line) => line.trimEnd());

	it("expanded heading keeps identity and model", () => {
		assert.deepStrictEqual(expanded.slice(0, 3), [
			"subagent spawn · scout · Auth flow",
			"inherits model",
			"",
		]);
	});

	it("expanded uses Text tab display and safe CR line breaks", () => {
		assert.deepStrictEqual(expanded.slice(3), ["first   column", "second", "界e\u0301"]);
	});

	it("expanded width zero emits no lines", () => {
		assert.deepStrictEqual(formatExpandedSubagentCall(args, 0, metrics), []);
	});

	it("expanded ANSI and wide lines fit every narrow width", () => {
		for (const width of [1, 2, 5]) {
			const lines = formatExpandedSubagentCall(
				{ name: "界e\u0301", agent: "偵察", task: "漢字\ne\u0301 and text" },
				width,
				metrics,
				{ title: (text) => `\x1b[1m${text}\x1b[0m` },
			);
			assert.strictEqual(
				lines.every((line) => metrics.visibleWidth(line) <= width),
				true,
				`expanded ANSI/wide lines fit width ${width}`,
			);
		}
	});

	it("wide task remains visible when a grapheme fits", () => {
		assert.strictEqual(
			formatExpandedSubagentCall({ name: "N", task: "界" }, 2, metrics)
				.some((line) => stripVTControlCharacters(line).includes("界")),
			true,
		);
	});

	const hostileExpanded = formatExpandedSubagentCall(hostileArgs, 100, metrics);

	it("expanded input terminal controls are removed", () => {
		assert.strictEqual(hostileExpanded.join("").includes("\x1b]52"), false);
	});

	it("expanded input keeps safe text", () => {
		assert.deepStrictEqual(plainLines(hostileExpanded).slice(0, 4), [
			"subagent spawn · scout · Auth flow",
			"inherits model",
			"",
			"Trace authentication.",
		]);
	});
});

initTheme(undefined, false);
let registeredSpawnTool: ToolDefinition | undefined;
registerSubagentSpawnTool({
	registerTool(tool: ToolDefinition): void {
		registeredSpawnTool = tool;
	},
} as unknown as ExtensionAPI);
assert.ok(registeredSpawnTool, "subagent_spawn did not register");
const spawnTool = registeredSpawnTool;

let registeredResumeTool: ToolDefinition | undefined;
registerSubagentResumeTool({
	registerTool(tool: ToolDefinition): void {
		registeredResumeTool = tool;
	},
} as unknown as ExtensionAPI);
assert.ok(registeredResumeTool, "subagent_resume did not register");
const resumeTool = registeredResumeTool;

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

describe("registerSubagentSpawnTool", () => {
	it("registered spawn tool uses the canonical name", () => {
		assert.strictEqual(spawnTool.name, "subagent_spawn");
	});

	it("spawn rejects whitespace in an explicit agent before launch guards", async () => {
		await assert.rejects(() =>
			spawnTool.execute(
				"invalid-agent",
				{ name: "Invalid", task: "Never launches", agent: "code reviewer" },
				new AbortController().signal,
				() => {},
				{} as never,
			), /whitespace/);
	});

	it("spawn rejects an explicit agent over 20 display columns", async () => {
		await assert.rejects(() =>
			spawnTool.execute(
				"overlong-agent",
				{ name: "Invalid", task: "Never launches", agent: "abcdefghijklmnopqrstu" },
				new AbortController().signal,
				() => {},
				{} as never,
			), /20 display columns/);
	});

	// The advertised limit must be the ENFORCED limit: the description is built
	// from the same config singleton capacity.ts counts against, so it cannot
	// drift - this assertion pins that derivation.
	it("spawn description advertises the configured concurrency limit", () => {
		assert.strictEqual(
			spawnTool.description?.includes(
				`or status 'queued' when ${config.maxConcurrentSubagents} sub-agents (the concurrency limit, shared with subagent_resume) are already running`,
			),
			true,
		);
	});

	it("model schema distinguishes Pi ids, external names, and omission precedence", () => {
		const description = (spawnTool.parameters as { properties?: { model?: { description?: string } } }).properties?.model?.description;
		assert.ok(description?.includes("External harnesses accept their own model names."));
		assert.ok(description?.includes("When omitted, the agent definition's model choice applies"));
	});

	it("registered renderer resolves the configured expansion binding", () => {
		const toolSource = readFileSync(new URL("../tool-spawn.ts", import.meta.url), "utf8");
		assert.strictEqual(toolSource.includes('keyText("app.tools.expand")'), true);
	});

	it("execution-time presentation persists the resolved model", () => {
		const toolSource = readFileSync(new URL("../tool-spawn.ts", import.meta.url), "utf8");
		assert.strictEqual(toolSource.includes("model: model ?? null"), true);
	});

	it("the registered call renderer presents identity, modes, and models across the call lifecycle", () => {
		const callRenderer = spawnTool.renderCall;
		assert.ok(callRenderer, "registered subagent_spawn tool has a call renderer");
		const sandboxRoot = join(process.cwd(), ".sandbox");
		mkdirSync(sandboxRoot, { recursive: true });
		const rendererCwd = mkdtempSync(join(sandboxRoot, "spawn-call-test-"));
		try {
			const rendererDefs = join(rendererCwd, ".pi", "subagents");
			mkdirSync(rendererDefs, { recursive: true });
			writeFileSync(
				join(rendererDefs, "worker.md"),
				"---\ncontext: forked\nauto-exit: false\nworktree: true\n---\nWorker.\n",
				"utf8",
			);
			writeFileSync(
				join(rendererDefs, "external.md"),
				"---\nharness: claude-code\n---\nExternal.\n",
				"utf8",
			);
			writeFileSync(
				join(rendererDefs, "modeled.md"),
				"---\nmodels: unavailable/model, openai-codex/gpt-5.5\n---\nModeled.\n",
				"utf8",
			);
			const renderContext = (expanded: boolean, state: Record<string, unknown> = {}) => ({
				args: {},
				toolCallId: "call-1",
				invalidate(): void {},
				lastComponent: undefined,
				state,
				cwd: rendererCwd,
				executionStarted: true,
				argsComplete: true,
				isPartial: false,
				expanded,
				showImages: false,
				isError: false,
			}) as Parameters<NonNullable<typeof callRenderer>>[2];
			const renderArgs = { name: "Auth flow", agent: "worker", task: "first\nsecond" } as Parameters<NonNullable<typeof callRenderer>>[0];
			const collapsedOutput = callRenderer(renderArgs, markedTheme, renderContext(false)).render(120).join("\n");
			const collapsedPlain = stripVTControlCharacters(collapsedOutput);
			assert.strictEqual(collapsedOutput.includes("\x1b[31m\x1b[1msubagent spawn"), true,
				"registered renderer styles the action title as a bold tool title");
			assert.strictEqual(collapsedOutput.includes("\x1b[32mAuth flow\x1b[0m"), true,
				"registered renderer styles the invocation name as the primary accent");
			assert.strictEqual(collapsedOutput.includes("\x1b[33m · \x1b[0m"), true,
				"registered renderer styles the leading separator as muted metadata");
			assert.strictEqual(collapsedOutput.includes("\x1b[33mworker\x1b[0m"), true,
				"registered renderer styles the unbracketed agent as muted metadata");
			// keyText("app.tools.expand") resolves to no key in this bare process (a
			// live session registers app keybindings), so the footer must be absent
			// rather than dangling an empty "( to expand)".
			assert.strictEqual(collapsedPlain.includes("to expand") || collapsedPlain.includes("()"), false,
				"registered renderer omits the hint footer when no expand binding resolves");
			assert.strictEqual(collapsedOutput.includes("\x1b[2mfirst second\x1b[0m"), true,
				"registered renderer styles the task preview as dim");
			assert.strictEqual(
				collapsedPlain.includes("inherits model · context forked · interactive · worktree"),
				true,
				"registered renderer shows inherited model and effective spawn modes on a separate metadata line",
			);
			const externalOutput = stripVTControlCharacters(callRenderer(
				{ name: "External", agent: "external", task: "Run" } as Parameters<NonNullable<typeof callRenderer>>[0],
				markedTheme,
				renderContext(false),
			).render(120).join("\n"));
			assert.strictEqual(
				externalOutput.includes("model harness default · context new · harness claude-code"), true,
				"registered renderer names the external harness default model and effective harness");
			const modelOverrideOutput = stripVTControlCharacters(callRenderer(
				{ name: "Model override", agent: "worker", task: "Run", model: "provider/model" } as Parameters<NonNullable<typeof callRenderer>>[0],
				markedTheme,
				renderContext(false),
			).render(120).join("\n"));
			assert.strictEqual(modelOverrideOutput.split("\n")[1].trimEnd(),
				"model resolving · context forked · interactive · worktree",
				"registered renderer avoids claiming an unresolved Pi model override");
			const errorState: Record<string, unknown> = {};
			const errorArgs = {
				name: "Model error",
				agent: "worker",
				task: "Run",
				model: "provider/model",
			} as Parameters<NonNullable<typeof callRenderer>>[0];
			const errorComponent = callRenderer(errorArgs, markedTheme, renderContext(false, errorState));
			spawnTool.renderResult?.(
				{ content: [{ type: "text", text: "Model resolution failed." }], details: undefined },
				{ expanded: false, isPartial: false },
				markedTheme,
				{ ...renderContext(false, errorState), isError: true },
			);
			assert.strictEqual(
				stripVTControlCharacters(errorComponent.render(120).join("\n")).split("\n")[1].trimEnd(),
				"model unknown · context forked · interactive · worktree",
				"settled spawn errors do not remain in a resolving state");
			const candidateState: Record<string, unknown> = {};
			const candidateArgs = { name: "Candidate fallback", agent: "modeled", task: "Run" } as Parameters<NonNullable<typeof callRenderer>>[0];
			const candidateComponent = callRenderer(candidateArgs, markedTheme, renderContext(false, candidateState));
			assert.strictEqual(
				stripVTControlCharacters(candidateComponent.render(120).join("\n")).split("\n")[1].trimEnd(),
				"model resolving · context new",
				"registered renderer does not present the first raw Pi model candidate as effective");
			spawnTool.renderResult?.(
				{
					content: [{ type: "text", text: "started" }],
					details: {
						presentation: {
							version: 1,
							behavior: { context: "new", autoExit: true, useWorktree: false, harness: "pi" },
							model: "openai-codex/gpt-5.5",
						},
					},
				},
				{ expanded: false, isPartial: false },
				markedTheme,
				renderContext(false, candidateState),
			);
			assert.strictEqual(
				stripVTControlCharacters(candidateComponent.render(120).join("\n")).split("\n")[1].trimEnd(),
				"model openai-codex/gpt-5.5 · context new",
				"settled rendering replaces candidate resolution with the canonical effective model");
			const overriddenOutput = stripVTControlCharacters(callRenderer(
				{
					name: "Overrides",
					agent: "worker",
					task: "Run",
					context: "new",
					autoExit: true,
					worktree: false,
				} as Parameters<NonNullable<typeof callRenderer>>[0],
				markedTheme,
				renderContext(false),
			).render(120).join("\n"));
			assert.strictEqual(overriddenOutput.split("\n")[1].trimEnd(), "inherits model · context new",
				"explicit call values override inherited spawn modes");
			const cwdOverrideOutput = stripVTControlCharacters(callRenderer(
				{ name: "Cwd override", agent: "worker", task: "Run", cwd: "nested" } as Parameters<NonNullable<typeof callRenderer>>[0],
				markedTheme,
				renderContext(false),
			).render(120).join("\n"));
			assert.strictEqual(cwdOverrideOutput.split("\n")[1].trimEnd(),
				"inherits model · context forked · interactive",
				"an explicit cwd disables an inherited worktree mode");
			const expandedOutput = callRenderer(renderArgs, markedTheme, renderContext(true)).render(120).join("\n");
			assert.strictEqual(expandedOutput.includes("\x1b[36mfirst"), true,
				"registered renderer styles the expanded task body as tool output");
			assert.strictEqual(
				stripVTControlCharacters(expandedOutput).includes("context forked · interactive · worktree"), true,
				"expanded renderer retains effective modes");
			const sharedState: Record<string, unknown> = {};
			writeFileSync(join(rendererDefs, "worker.md"), "---\ncontext: new\nauto-exit: true\nworktree: false\n---\nChanged.\n", "utf8");
			const reopenedComponent = callRenderer(renderArgs, markedTheme, renderContext(false, sharedState));
			assert.strictEqual(
				stripVTControlCharacters(reopenedComponent.render(120).join("\n")).split("\n")[1].trimEnd(),
				"inherits model · context new",
				"a reopened call initially falls back to current definition defaults");
			spawnTool.renderResult?.(
				{
					content: [{ type: "text", text: "started" }],
					details: {
						presentation: {
							version: 1,
							behavior: { context: "forked", autoExit: false, useWorktree: true, harness: "pi" },
							model: "openai-codex/gpt-5.5",
						},
					},
				},
				{ expanded: false, isPartial: false },
				markedTheme,
				renderContext(false, sharedState),
			);
			assert.strictEqual(
				stripVTControlCharacters(reopenedComponent.render(120).join("\n")).split("\n")[1].trimEnd(),
				"model openai-codex/gpt-5.5 · context forked · interactive · worktree",
				"persisted execution-time model and behavior replace changed definition defaults");
			const legacyState: Record<string, unknown> = {};
			const legacyComponent = callRenderer(candidateArgs, markedTheme, renderContext(false, legacyState));
			spawnTool.renderResult?.(
				{
					content: [{ type: "text", text: "started" }],
					details: {
						presentation: {
							version: 1,
							behavior: { context: "forked", autoExit: false, useWorktree: false, harness: "pi" },
						},
					},
				},
				{ expanded: false, isPartial: false },
				markedTheme,
				renderContext(false, legacyState),
			);
			assert.strictEqual(
				stripVTControlCharacters(legacyComponent.render(120).join("\n")).split("\n")[1].trimEnd(),
				"model unknown · context forked · interactive",
				"settled historical v1 rows without model metadata do not remain in a resolving state");
		} finally {
			rmSync(rendererCwd, { recursive: true, force: true });
		}
	});
});

describe("registerSubagentResumeTool", () => {
	it("resume autoExit schema documents restored launch identity and fallback", () => {
		const resumeParameters = resumeTool.parameters as {
			properties?: { autoExit?: { description?: string } };
		} | undefined;
		assert.strictEqual(
			resumeParameters?.properties?.autoExit?.description,
			"Override auto-exit behavior. If omitted, the child's original value is restored from launch metadata, falling back to true. " +
				"An effective true requires a message; false stays open for a human and permits a message-free handoff.",
		);
	});

	it("registered resume tool uses the canonical name", () => {
		assert.strictEqual(resumeTool.name, "subagent_resume");
	});

	it("resume description advertises the same configured concurrency limit", () => {
		assert.strictEqual(
			resumeTool.description?.includes(
				`or 'queued' when the concurrency limit of ${config.maxConcurrentSubagents} sub-agents (shared with subagent_spawn) is reached`,
			),
			true,
		);
	});

	it("resume renderer resolves the configured expansion binding", () => {
		const resumeSource = readFileSync(new URL("../tool-resume.ts", import.meta.url), "utf8");
		assert.strictEqual(resumeSource.includes('keyText("app.tools.expand")'), true);
	});

	it("resume name schema documents original-name fallback", () => {
		const resumeSource = readFileSync(new URL("../tool-resume.ts", import.meta.url), "utf8");
		assert.strictEqual(resumeSource.includes("defaults to the child's original name, then 'Resumed'"), true);
	});

	it("the resume call renderer resolves launch identity through the ledger and metadata", () => {
		const resumeCallRenderer = resumeTool.renderCall;
		assert.ok(resumeCallRenderer, "registered subagent_resume tool has a call renderer");
		const sandboxRoot = join(process.cwd(), ".sandbox");
		mkdirSync(sandboxRoot, { recursive: true });
		const sandbox = mkdtempSync(join(sandboxRoot, "resume-call-test-"));
		const sessionPath = join(sandbox, "child.jsonl");
		const id = "resume01";
		writeFileSync(`${sessionPath}.meta`, JSON.stringify({ name: "Auth flow", agent: "scout" }), "utf8");
		ledger.set(id, { sessionFile: sessionPath, name: "Ledger fallback" });
		try {
			const renderContext = (expanded: boolean) => ({
				args: {},
				toolCallId: "resume-call-1",
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
			}) as Parameters<NonNullable<typeof resumeCallRenderer>>[2];
			const renderArgs = { id, message: "Apply the fix.\nRerun the tests." } as Parameters<NonNullable<typeof resumeCallRenderer>>[0];
			const collapsedOutput = resumeCallRenderer(renderArgs, markedTheme, renderContext(false)).render(120).join("\n");
			const collapsedPlain = stripVTControlCharacters(collapsedOutput);
			assert.strictEqual(collapsedPlain.includes("Auth flow"), true,
				"resume renderer resolves the original name through the short-id ledger");
			assert.strictEqual(collapsedPlain.includes("· scout ·"), true,
				"resume renderer resolves the original agent through launch metadata");
			assert.strictEqual(collapsedOutput.includes("\x1b[31m\x1b[1msubagent resume"), true,
				"resume renderer styles the action title as a bold tool title");
			assert.strictEqual(collapsedOutput.includes("\x1b[32mAuth flow\x1b[0m"), true,
				"resume renderer styles the resolved name as the primary accent");
			assert.strictEqual(collapsedOutput.includes("\x1b[33mscout\x1b[0m"), true,
				"resume renderer styles the agent as muted metadata");
			assert.strictEqual(collapsedOutput.includes("\x1b[2mApply the fix. Rerun the tests.\x1b[0m"), true,
				"resume renderer styles the follow-up preview as dim");
			assert.strictEqual(collapsedPlain.includes("to expand") || collapsedPlain.includes("()"), false,
				"resume renderer omits the hint footer when no expand binding resolves");
			const expandedOutput = resumeCallRenderer(renderArgs, markedTheme, renderContext(true)).render(120).join("\n");
			assert.strictEqual(expandedOutput.includes("\x1b[36mApply the fix."), true,
				"resume renderer styles the expanded follow-up as tool output");
			const expandedPlainLines = plainLines(expandedOutput.split("\n"));
			const followUpStart = expandedPlainLines.indexOf("Apply the fix.");
			assert.strictEqual(expandedPlainLines[followUpStart + 1], "Rerun the tests.",
				"resume renderer preserves expanded follow-up line structure");
			const noMessageOutput = resumeCallRenderer(
				{ sessionPath, autoExit: false } as Parameters<NonNullable<typeof resumeCallRenderer>>[0],
				markedTheme,
				renderContext(false),
			).render(120).join("\n");
			assert.strictEqual(stripVTControlCharacters(noMessageOutput).includes("No follow-up message."), true,
				"resume renderer shows the neutral missing-message preview");
			assert.strictEqual(stripVTControlCharacters(noMessageOutput).includes("to expand"), false,
				"resume renderer does not advertise expansion for a missing message");
			const renamedOutput = resumeCallRenderer(
				{ sessionPath, name: "Verification" } as Parameters<NonNullable<typeof resumeCallRenderer>>[0],
				markedTheme,
				renderContext(false),
			).render(120).join("\n");
			assert.strictEqual(stripVTControlCharacters(renamedOutput).includes("· Verification"), true,
				"explicit resume names override launch metadata");
		} finally {
			ledger.delete(id);
			rmSync(sandbox, { recursive: true, force: true });
		}
	});
});
