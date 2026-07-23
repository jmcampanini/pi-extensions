import { initTheme, type ExtensionAPI, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { config } from "../config.ts";
import { ledger } from "../state.ts";
import * as subagentCall from "../subagent-call.ts";
import { registerSubagentResumeTool } from "../tool-resume.ts";
import { registerSubagentSpawnTool } from "../tool-spawn.ts";

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown): void {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}:\n    got  ${g}\n    want ${w}`); }
}
async function rejects(label: string, fn: () => Promise<unknown>, contains: string): Promise<void> {
	try { await fn(); fail++; console.log(`  FAIL ${label}: expected rejection`); }
	catch (error) {
		if (String(error).includes(contains)) { pass++; console.log(`  ok  ${label}`); }
		else { fail++; console.log(`  FAIL ${label}: ${String(error)}`); }
	}
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

const {
	formatCollapsedSubagentCall,
	formatCollapsedSubagentResumeCall,
	formatExpandedSubagentCall,
	formatExpandedSubagentResumeCall,
} = subagentCall;
eq("module exports only production formatters", Object.keys(subagentCall).sort(), [
	"formatCollapsedSubagentCall",
	"formatCollapsedSubagentResumeCall",
	"formatExpandedSubagentCall",
	"formatExpandedSubagentResumeCall",
]);

const task = "Trace authentication from the HTTP entry point.";
const args = { name: "Auth flow", agent: "scout", task };
const plainLines = (lines: string[]): string[] => lines.map((line) => stripVTControlCharacters(line).trimEnd());
const comfortable = formatCollapsedSubagentCall(args, 100, 3, metrics);
eq("collapsed call has heading, model metadata, spacer, and task", comfortable.length, 4);
eq("comfortable heading", plainLines(comfortable)[0], "subagent spawn · scout · Auth flow");
eq("comfortable inherited model", plainLines(comfortable)[1], "inherits model");
eq("comfortable spacer", plainLines(comfortable)[2], "");
eq("comfortable task preview", plainLines(comfortable)[3], task);

const resumeArgs = { name: "Auth flow", agent: "scout", message: "Apply the fix and rerun the tests." };
const comfortableResume = formatCollapsedSubagentResumeCall(resumeArgs, 100, 3, metrics);
eq("resume call matches the spawn identity grammar", plainLines(comfortableResume)[0], "subagent resume · scout · Auth flow");
eq("resume call separates its follow-up with a blank line", plainLines(comfortableResume)[1], "");
eq("resume call previews its follow-up", plainLines(comfortableResume)[2], resumeArgs.message);
eq(
	"multiline resume follow-up advertises expansion",
	plainLines(formatCollapsedSubagentResumeCall(
		{ ...resumeArgs, message: "Apply the fix.\nRerun the tests." },
		100,
		3,
		metrics,
		{},
		"Ctrl+O to expand",
	))[0],
	"subagent resume · scout · Auth flow (Ctrl+O to expand)",
);
eq(
	"resume without a follow-up has a neutral preview and no expansion hint",
	plainLines(formatCollapsedSubagentResumeCall(
		{ name: "Auth flow", agent: "scout" },
		100,
		3,
		metrics,
		{},
		"Ctrl+O to expand",
	)),
	["subagent resume · scout · Auth flow", "", "No follow-up message."],
);
eq(
	"expanded resume preserves the complete follow-up",
	plainLines(formatExpandedSubagentResumeCall(
		{ ...resumeArgs, message: "Apply the fix.\n\nRerun the tests." },
		100,
		metrics,
	)),
	["subagent resume · scout · Auth flow", "", "Apply the fix.", "", "Rerun the tests."],
);
for (const width of [0, 1, 2, 8, 20, 36]) {
	const lines = formatCollapsedSubagentResumeCall(
		{ name: "界e\u0301 🙂 review", agent: "偵察", message: "漢字 e\u0301 🙂 continue the investigation" },
		width,
		3,
		metrics,
		{},
		"Ctrl+O to expand",
	);
	eq(`resume width ${width} never exceeds terminal columns`, lines.every((line) => metrics.visibleWidth(line) <= width), true);
}

const narrow = formatCollapsedSubagentCall(args, 44, 3, metrics);
eq("narrow heading preserves identity", plainLines(narrow)[0], "subagent spawn · scout · Auth flow");
eq("narrow preview starts with the task", plainLines(narrow)[3].startsWith("Trace authentication"), true);
eq("narrow preview has no ellipsis", plainLines(narrow)[3].includes("…"), false);
eq("narrow lines fit terminal columns", narrow.every((line) => metrics.visibleWidth(line) <= 44), true);

const longTask = Array.from({ length: 80 }, (_, index) => `step-${index}`).join(" ");
const threeLinePreview = formatCollapsedSubagentCall(
	{ name: "Long task", task: longTask },
	60,
	3,
	metrics,
	{},
	"Ctrl+O to expand",
);
eq("configured call previews include one header, model metadata, one spacer, and three visual lines", threeLinePreview.length, 6);
eq("configured call previews advertise detail hidden by the line limit",
	plainLines(threeLinePreview)[0].includes("Ctrl+O to expand"), true);
eq("call previews do not add result-style ellipses", plainLines(threeLinePreview).slice(2).some((line) => line.includes("…")), false);
const headerOnlyCall = formatCollapsedSubagentCall(
	{ name: "Long task", task: longTask },
	100,
	0,
	metrics,
	{},
	"Ctrl+O to expand",
);
eq("zero call preview lines retain the heading and model metadata", headerOnlyCall.length, 2);
eq("header-only calls retain the expansion hint", plainLines(headerOnlyCall)[0].includes("Ctrl+O to expand"), true);
const headerOnlyEmptyResume = formatCollapsedSubagentResumeCall(
	{ name: "No follow-up" },
	100,
	0,
	metrics,
	{},
	"Ctrl+O to expand",
);
eq("zero-line empty resumes have no spacer or misleading expansion hint",
	plainLines(headerOnlyEmptyResume), ["subagent resume · worker · No follow-up"]);
const twentyLinePreview = formatCollapsedSubagentCall(
	{ name: "Maximum", task: longTask },
	10,
	20,
	metrics,
);
eq("maximum call preview line limit is honored after wrapped model metadata", twentyLinePreview.length, 24);

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
eq("ANSI styles are retained", styled.join("").includes("\x1b["), true);
eq("ANSI and wide/combining lines obey terminal width", styled.every((line) => metrics.visibleWidth(line) <= 36), true);
eq("wide/combining identity is preserved", plainLines(styled)[0], "subagent spawn · 偵察 · 界e\u0301");

const hostileArgs = {
	name: "Auth\x1b[2J flow\0",
	agent: "scout\x1b]52;c;Zm9v\x07",
	task: "Trace \x1b]52;c;YmFy\x1b\\authentication.\b",
};
const hostileCollapsed = formatCollapsedSubagentCall(hostileArgs, 100, 3, metrics);
eq("collapsed input terminal controls are removed", hostileCollapsed.join("").includes("\x1b]52"), false);
eq("collapsed input keeps safe text", plainLines(hostileCollapsed), [
	"subagent spawn · scout · Auth flow",
	"inherits model",
	"",
	"Trace authentication.",
]);
const hostileExpanded = formatExpandedSubagentCall(hostileArgs, 100, metrics);
eq("expanded input terminal controls are removed", hostileExpanded.join("").includes("\x1b]52"), false);
eq("expanded input keeps safe text", plainLines(hostileExpanded).slice(0, 4), [
	"subagent spawn · scout · Auth flow",
	"inherits model",
	"",
	"Trace authentication.",
]);
const hostileModel = formatCollapsedSubagentCall(
	{ ...hostileArgs, effectiveModel: "provider/model\x1b]52;c;Zm9v\x07" },
	100,
	3,
	metrics,
);
eq("effective model metadata strips terminal controls", plainLines(hostileModel)[1], "model provider/model");
const hostileResume = formatCollapsedSubagentResumeCall(
	{ name: hostileArgs.name, agent: hostileArgs.agent, message: hostileArgs.task },
	100,
	3,
	metrics,
);
eq("resume input terminal controls are removed", hostileResume.join("").includes("\x1b]52"), false);
eq("resume input keeps safe text", plainLines(hostileResume), ["subagent resume · scout · Auth flow", "", "Trace authentication."]);

eq(
	"multiline task is normalized for preview",
	plainLines(formatCollapsedSubagentCall({ name: "N", task: "Trace auth.\n\nReturn  file:\tline pointers." }, 100, 3, metrics)),
	["subagent spawn · worker · N", "inherits model", "", "Trace auth. Return file: line pointers."],
);
eq("an omitted agent displays worker without brackets", plainLines(formatCollapsedSubagentCall({ name: "Tests", task: "Run" }, 100, 3, metrics))[0], "subagent spawn · worker · Tests");
eq(
	"collapsed call advertises expansion when task detail is hidden",
	plainLines(formatCollapsedSubagentCall({ name: "Tests", task: "first\nsecond" }, 100, 3, metrics, {}, "Ctrl+O to expand"))[0],
	"subagent spawn · worker · Tests (Ctrl+O to expand)",
);
eq(
	"collapsed call omits the expansion hint when the full task is already visible",
	plainLines(formatCollapsedSubagentCall({ name: "Tests", task: "Run" }, 100, 3, metrics, {}, "Ctrl+O to expand"))[0],
	"subagent spawn · worker · Tests",
);
const longIdentityHeading = plainLines(formatCollapsedSubagentCall(
	{ name: "A very long invocation name that must yield space to metadata", agent: "code-reviewer", task: "first\nsecond" },
	80,
	3,
	metrics,
	{},
	"Ctrl+O to expand",
))[0];
eq("long names retain the agent profile before the clipped name", longIdentityHeading.includes("· code-reviewer ·"), true);
eq("long names clip before the expansion hint", longIdentityHeading.endsWith("(Ctrl+O to expand)"), true);
eq("long identity headings still fit", metrics.visibleWidth(longIdentityHeading) <= 80, true);
const narrowLongAgentHeading = plainLines(formatCollapsedSubagentCall(
	{ name: "Auth flow", agent: "code-reviewer", task: "Run" },
	30,
	3,
	metrics,
))[0];
eq("narrow headers preserve the separator after a clipped agent", narrowLongAgentHeading.includes("… · "), true);
eq("narrow long-agent headings still fit", metrics.visibleWidth(narrowLongAgentHeading) <= 30, true);
eq("collapsed width zero is empty", formatCollapsedSubagentCall(args, 0, 3, metrics), []);
eq("collapsed width one obeys the width contract", formatCollapsedSubagentCall(args, 1, 3, metrics).every((line) => metrics.visibleWidth(line) <= 1), true);
eq(
	"collapsed extreme width retains all content",
	plainLines(formatCollapsedSubagentCall(args, 1_000_000, 3, metrics)),
	["subagent spawn · scout · Auth flow", "inherits model", "", task],
);

const original = "first\tcolumn\rsecond\r\n界e\u0301";
const expanded = formatExpandedSubagentCall({ name: "Auth flow", agent: "scout", task: original }, 120, metrics).map((line) => line.trimEnd());
eq("expanded heading keeps identity and model", expanded.slice(0, 3), [
	"subagent spawn · scout · Auth flow",
	"inherits model",
	"",
]);
eq("expanded uses Text tab display and safe CR line breaks", expanded.slice(3), ["first   column", "second", "界e\u0301"]);
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
let registeredSpawnTool: ToolDefinition | undefined;
registerSubagentSpawnTool({
	registerTool(tool: ToolDefinition): void {
		registeredSpawnTool = tool;
	},
} as unknown as ExtensionAPI);
eq("registered spawn tool uses the canonical name", registeredSpawnTool?.name, "subagent_spawn");
if (registeredSpawnTool) {
	const spawnTool = registeredSpawnTool;
	await rejects("spawn rejects whitespace in an explicit agent before launch guards", () =>
		spawnTool.execute(
			"invalid-agent",
			{ name: "Invalid", task: "Never launches", agent: "code reviewer" },
			new AbortController().signal,
			() => {},
			{} as never,
		), "whitespace");
	await rejects("spawn rejects an explicit agent over 20 display columns", () =>
		spawnTool.execute(
			"overlong-agent",
			{ name: "Invalid", task: "Never launches", agent: "abcdefghijklmnopqrstu" },
			new AbortController().signal,
			() => {},
			{} as never,
		), "20 display columns");
}
// The advertised limit must be the ENFORCED limit: the description is built
// from the same config singleton capacity.ts counts against, so it cannot
// drift — this assertion pins that derivation.
eq(
	"spawn description advertises the configured concurrency limit",
	registeredSpawnTool?.description?.includes(
		`or status 'queued' when ${config.maxConcurrentSubagents} sub-agents (the concurrency limit, shared with subagent_resume) are already running`,
	),
	true,
);
const callRenderer = registeredSpawnTool?.renderCall;
if (callRenderer === undefined) {
	eq("registered subagent_spawn tool has a call renderer", false, true);
} else {
	const sandboxRoot = join(process.cwd(), ".sandbox");
	mkdirSync(sandboxRoot, { recursive: true });
	const rendererCwd = mkdtempSync(join(sandboxRoot, "spawn-call-test-"));
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
	}) as Parameters<typeof callRenderer>[2];
	const renderArgs = { name: "Auth flow", agent: "worker", task: "first\nsecond" } as Parameters<typeof callRenderer>[0];
	const collapsedOutput = callRenderer(renderArgs, markedTheme, renderContext(false)).render(120).join("\n");
	const collapsedPlain = stripVTControlCharacters(collapsedOutput);
	eq("registered renderer styles the action title as a bold tool title", collapsedOutput.includes("\x1b[31m\x1b[1msubagent spawn"), true);
	eq("registered renderer styles the invocation name as the primary accent", collapsedOutput.includes("\x1b[32mAuth flow\x1b[0m"), true);
	eq("registered renderer styles the leading separator as muted metadata", collapsedOutput.includes("\x1b[33m · \x1b[0m"), true);
	eq("registered renderer styles the unbracketed agent as muted metadata", collapsedOutput.includes("\x1b[33mworker\x1b[0m"), true);
	eq("registered renderer displays an expansion hint", collapsedPlain.includes("to expand"), true);
	eq("registered renderer styles the task preview as dim", collapsedOutput.includes("\x1b[2mfirst second\x1b[0m"), true);
	eq(
		"registered renderer shows inherited model and effective spawn modes on a separate metadata line",
		collapsedPlain.includes("inherits model · context forked · interactive · worktree"),
		true,
	);
	const externalOutput = stripVTControlCharacters(callRenderer(
		{ name: "External", agent: "external", task: "Run" } as Parameters<typeof callRenderer>[0],
		markedTheme,
		renderContext(false),
	).render(120).join("\n"));
	eq("registered renderer names the external harness default model and effective harness",
		externalOutput.includes("model harness default · context new · harness claude-code"), true);
	const modelOverrideOutput = stripVTControlCharacters(callRenderer(
		{ name: "Model override", agent: "worker", task: "Run", model: "provider/model" } as Parameters<typeof callRenderer>[0],
		markedTheme,
		renderContext(false),
	).render(120).join("\n"));
	eq("registered renderer avoids claiming an unresolved Pi model override",
		modelOverrideOutput.split("\n")[1].trimEnd(), "model resolving · context forked · interactive · worktree");
	const errorState: Record<string, unknown> = {};
	const errorArgs = {
		name: "Model error",
		agent: "worker",
		task: "Run",
		model: "provider/model",
	} as Parameters<typeof callRenderer>[0];
	const errorComponent = callRenderer(errorArgs, markedTheme, renderContext(false, errorState));
	registeredSpawnTool?.renderResult?.(
		{ content: [{ type: "text", text: "Model resolution failed." }], details: undefined },
		{ expanded: false, isPartial: false },
		markedTheme,
		{ ...renderContext(false, errorState), isError: true },
	);
	eq("settled spawn errors do not remain in a resolving state",
		stripVTControlCharacters(errorComponent.render(120).join("\n")).split("\n")[1].trimEnd(),
		"model unknown · context forked · interactive · worktree");
	const candidateState: Record<string, unknown> = {};
	const candidateArgs = { name: "Candidate fallback", agent: "modeled", task: "Run" } as Parameters<typeof callRenderer>[0];
	const candidateComponent = callRenderer(candidateArgs, markedTheme, renderContext(false, candidateState));
	eq("registered renderer does not present the first raw Pi model candidate as effective",
		stripVTControlCharacters(candidateComponent.render(120).join("\n")).split("\n")[1].trimEnd(),
		"model resolving · context new");
	registeredSpawnTool?.renderResult?.(
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
	eq("settled rendering replaces candidate resolution with the canonical effective model",
		stripVTControlCharacters(candidateComponent.render(120).join("\n")).split("\n")[1].trimEnd(),
		"model openai-codex/gpt-5.5 · context new");
	const overriddenOutput = stripVTControlCharacters(callRenderer(
		{
			name: "Overrides",
			agent: "worker",
			task: "Run",
			context: "new",
			autoExit: true,
			worktree: false,
		} as Parameters<typeof callRenderer>[0],
		markedTheme,
		renderContext(false),
	).render(120).join("\n"));
	eq("explicit call values override inherited spawn modes", overriddenOutput.split("\n")[1].trimEnd(),
		"inherits model · context new");
	const cwdOverrideOutput = stripVTControlCharacters(callRenderer(
		{ name: "Cwd override", agent: "worker", task: "Run", cwd: "nested" } as Parameters<typeof callRenderer>[0],
		markedTheme,
		renderContext(false),
	).render(120).join("\n"));
	eq("an explicit cwd disables an inherited worktree mode", cwdOverrideOutput.split("\n")[1].trimEnd(),
		"inherits model · context forked · interactive");
	const toolSource = readFileSync(new URL("../tool-spawn.ts", import.meta.url), "utf8");
	eq("registered renderer resolves the configured expansion binding", toolSource.includes('keyHint("app.tools.expand", "to expand")'), true);
	eq("execution-time presentation persists the resolved model", toolSource.includes("model: model ?? null"), true);
	const expandedOutput = callRenderer(renderArgs, markedTheme, renderContext(true)).render(120).join("\n");
	eq("registered renderer styles the expanded task body as tool output", expandedOutput.includes("\x1b[36mfirst"), true);
	eq("expanded renderer retains effective modes", stripVTControlCharacters(expandedOutput).includes("context forked · interactive · worktree"), true);
	const sharedState: Record<string, unknown> = {};
	writeFileSync(join(rendererDefs, "worker.md"), "---\ncontext: new\nauto-exit: true\nworktree: false\n---\nChanged.\n", "utf8");
	const reopenedComponent = callRenderer(renderArgs, markedTheme, renderContext(false, sharedState));
	eq("a reopened call initially falls back to current definition defaults",
		stripVTControlCharacters(reopenedComponent.render(120).join("\n")).split("\n")[1].trimEnd(),
		"inherits model · context new");
	registeredSpawnTool?.renderResult?.(
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
	eq("persisted execution-time model and behavior replace changed definition defaults",
		stripVTControlCharacters(reopenedComponent.render(120).join("\n")).split("\n")[1].trimEnd(),
		"model openai-codex/gpt-5.5 · context forked · interactive · worktree");
	const legacyState: Record<string, unknown> = {};
	const legacyComponent = callRenderer(candidateArgs, markedTheme, renderContext(false, legacyState));
	registeredSpawnTool?.renderResult?.(
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
	eq("settled historical v1 rows without model metadata do not remain in a resolving state",
		stripVTControlCharacters(legacyComponent.render(120).join("\n")).split("\n")[1].trimEnd(),
		"model unknown · context forked · interactive");
	rmSync(rendererCwd, { recursive: true, force: true });
}

let registeredResumeTool: ToolDefinition | undefined;
registerSubagentResumeTool({
	registerTool(tool: ToolDefinition): void {
		registeredResumeTool = tool;
	},
} as unknown as ExtensionAPI);
const resumeParameters = registeredResumeTool?.parameters as {
	properties?: { autoExit?: { description?: string } };
} | undefined;
eq(
	"resume autoExit schema documents restored launch identity and fallback",
	resumeParameters?.properties?.autoExit?.description,
	"Override auto-exit behavior. If omitted, the child's original value is restored from launch metadata, falling back to true. " +
		"An effective true requires a message; false stays open for a human and permits a message-free handoff.",
);
eq("registered resume tool uses the canonical name", registeredResumeTool?.name, "subagent_resume");
eq(
	"resume description advertises the same configured concurrency limit",
	registeredResumeTool?.description?.includes(
		`or 'queued' when the concurrency limit of ${config.maxConcurrentSubagents} sub-agents (shared with subagent_spawn) is reached`,
	),
	true,
);
const resumeCallRenderer = registeredResumeTool?.renderCall;
if (resumeCallRenderer === undefined) {
	eq("registered subagent_resume tool has a call renderer", false, true);
} else {
	const sandboxRoot = join(process.cwd(), ".sandbox");
	mkdirSync(sandboxRoot, { recursive: true });
	const sandbox = mkdtempSync(join(sandboxRoot, "resume-call-test-"));
	const sessionPath = join(sandbox, "child.jsonl");
	const id = "resume01";
	writeFileSync(`${sessionPath}.meta`, JSON.stringify({ name: "Auth flow", agent: "scout" }), "utf8");
	ledger.set(id, { sessionFile: sessionPath, name: "Ledger fallback" });
	try {
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
		}) as Parameters<typeof resumeCallRenderer>[2];
		const renderArgs = { id, message: "Apply the fix.\nRerun the tests." } as Parameters<typeof resumeCallRenderer>[0];
		const collapsedOutput = resumeCallRenderer(renderArgs, markedTheme, renderContext(false)).render(120).join("\n");
		const collapsedPlain = stripVTControlCharacters(collapsedOutput);
		eq("resume renderer resolves the original name through the short-id ledger", collapsedPlain.includes("Auth flow"), true);
		eq("resume renderer resolves the original agent through launch metadata", collapsedPlain.includes("· scout ·"), true);
		eq("resume renderer styles the action title as a bold tool title", collapsedOutput.includes("\x1b[31m\x1b[1msubagent resume"), true);
		eq("resume renderer styles the resolved name as the primary accent", collapsedOutput.includes("\x1b[32mAuth flow\x1b[0m"), true);
		eq("resume renderer styles the agent as muted metadata", collapsedOutput.includes("\x1b[33mscout\x1b[0m"), true);
		eq("resume renderer styles the follow-up preview as dim", collapsedOutput.includes("\x1b[2mApply the fix. Rerun the tests.\x1b[0m"), true);
		eq("resume renderer displays an expansion hint for hidden detail", collapsedPlain.includes("to expand"), true);
		const expandedOutput = resumeCallRenderer(renderArgs, markedTheme, renderContext(true)).render(120).join("\n");
		eq("resume renderer styles the expanded follow-up as tool output", expandedOutput.includes("\x1b[36mApply the fix."), true);
		const expandedPlainLines = plainLines(expandedOutput.split("\n"));
		const followUpStart = expandedPlainLines.indexOf("Apply the fix.");
		eq("resume renderer preserves expanded follow-up line structure", expandedPlainLines[followUpStart + 1], "Rerun the tests.");
		const noMessageOutput = resumeCallRenderer(
			{ sessionPath, autoExit: false } as Parameters<typeof resumeCallRenderer>[0],
			markedTheme,
			renderContext(false),
		).render(120).join("\n");
		eq("resume renderer shows the neutral missing-message preview", stripVTControlCharacters(noMessageOutput).includes("No follow-up message."), true);
		eq("resume renderer does not advertise expansion for a missing message", stripVTControlCharacters(noMessageOutput).includes("to expand"), false);
		const renamedOutput = resumeCallRenderer(
			{ sessionPath, name: "Verification" } as Parameters<typeof resumeCallRenderer>[0],
			markedTheme,
			renderContext(false),
		).render(120).join("\n");
		eq("explicit resume names override launch metadata", stripVTControlCharacters(renamedOutput).includes("· Verification"), true);
		const resumeSource = readFileSync(new URL("../tool-resume.ts", import.meta.url), "utf8");
		eq("resume renderer resolves the configured expansion binding", resumeSource.includes('keyHint("app.tools.expand", "to expand")'), true);
		eq("resume name schema documents original-name fallback", resumeSource.includes("defaults to the child's original name, then 'Resumed'"), true);
	} finally {
		ledger.delete(id);
		rmSync(sandbox, { recursive: true, force: true });
	}
}

console.log(`\n${pass} passed, ${fail} failed (${tui ? "pi-tui metrics" : "faithful fallback metrics"})`);
process.exit(fail === 0 ? 0 : 1);
