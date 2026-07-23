import type {
	ExtensionAPI,
	MessageRenderer,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { buildSubagentResultEnvelope } from "../result-content.ts";
import {
	estimateResultTokens,
	formatCollapsedSubagentResult,
	humanElapsed,
	parseSubagentResultDetails,
	registerSubagentResultRenderer,
	resultPresentation,
	resultPreview,
	type SubagentResultDetails,
} from "../result-message.ts";

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown): void {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}:\n    got  ${g}\n    want ${w}`); }
}

const plain = (line: string): string => stripVTControlCharacters(line).trimEnd();
const details = (
	status: "completed" | "failed" | "stopped",
	preview = "Found two authentication bypass risks in the token refresh path.",
): SubagentResultDetails => ({
	id: "abc12345",
	name: "API review",
	agent: "code-reviewer",
	contextTokens: 84_000,
	resultTokens: 1_800,
	expanded: { version: 1 },
	presentation: resultPresentation(status, 134, preview),
});

eq("human elapsed seconds", humanElapsed(42), "42s");
eq("human elapsed minutes retain seconds", humanElapsed(134), "2m 14s");
eq("human elapsed clamps negative values", humanElapsed(-2), "0s");
eq("preview flattens whitespace", resultPreview("  First\n\nsecond\titem  "), "First second item");
eq("preview removes terminal controls", resultPreview("safe\x1b]52;c;Zm9v\x07 text\0"), "safe text");
eq("result tokens use pi's conservative estimate", estimateResultTokens("12345678"), 2);
eq("result tokens omit empty sanitized text", estimateResultTokens(" \x1b]52;c;Zm9v\x07\0 "), undefined);
const oversizedPresentation = resultPresentation("completed", 1, "x".repeat(10_000));
eq("persisted preview is bounded without affecting message content", Array.from(oversizedPresentation.preview).length, 2001);
eq("bounded persisted preview marks omitted text", oversizedPresentation.preview.endsWith("…"), true);

const completed = formatCollapsedSubagentResult(details("completed"), 120, 5, "Ctrl+O").map(plain);
eq("completed uses compact native tool identity and size metadata", completed[0],
	"subagent result · code-reviewer · API review · done 2m14s · 84k ctx · ~1.8k result (Ctrl+O)");
eq("completed separates its preview from the header", completed[1], "");
eq("completed includes its preview without extra indentation", completed[2], "Found two authentication bypass risks in the token refresh path.");
const failed = formatCollapsedSubagentResult(details("failed", "Provider authentication expired."), 120, 5, "Ctrl+O").map(plain);
eq("failed is explicit without a status icon", failed[0],
	"subagent result · code-reviewer · API review · failed 2m14s · 84k ctx · ~1.8k result (Ctrl+O)");
const stoppedDetails = { ...details("stopped", "No final result was delivered."), resultTokens: undefined };
const stopped = formatCollapsedSubagentResult(stoppedDetails, 120, 5, "Ctrl+O").map(plain);
eq("stopped omits unavailable result size", stopped[0],
	"subagent result · code-reviewer · API review · stopped 2m14s · 84k ctx (Ctrl+O)");
eq("status headers have no leading symbols", [completed[0], failed[0], stopped[0]].every((line) => line.startsWith("subagent result ")), true);
const styledHint = formatCollapsedSubagentResult(
	details("completed"),
	500,
	5,
	"Ctrl+O",
	{
		visibleWidth,
		truncateToWidth,
		renderText: (text, width) => new Text(text, 0, 0).render(width),
	},
	{
		title: (text) => text,
		name: (text) => text,
		metadata: (text) => text,
		hint: (text) => `<dim>${text}</dim>`,
		preview: (text) => text,
	},
).join("\n");
eq("collapsed expansion key supports dim hint styling", styledHint.includes("<dim>Ctrl+O</dim>"), true);

const longPreview = Array.from({ length: 40 }, (_, index) => `finding-${index}`).join(" ");
const bounded = formatCollapsedSubagentResult(details("completed", longPreview), 42, 5, "Ctrl+O");
eq("collapsed output has one header, one spacer, and five preview lines", bounded.length, 7);
eq("truncated preview advertises omitted content", plain(bounded[6]).endsWith("…"), true);
const headerOnly = formatCollapsedSubagentResult(details("completed", longPreview), 120, 0, "Ctrl+O");
eq("zero result preview lines render only the header", headerOnly.length, 1);
eq("header-only results retain the compact expansion key", plain(headerOnly[0]).endsWith("(Ctrl+O)"), true);
const twentyLineResult = formatCollapsedSubagentResult(details("completed", longPreview.repeat(4)), 16, 20, "");
eq("maximum result preview line limit is honored", twentyLineResult.length, 22);
eq("maximum result preview still marks omitted content", plain(twentyLineResult.at(-1) ?? "").endsWith("…"), true);
const narrowHeader = plain(formatCollapsedSubagentResult(details("completed"), 40, 5, "Ctrl+O")[0] ?? "");
eq("narrow headers preserve a clipped agent profile before the name", narrowHeader.includes("· co"), true);
eq("narrow headers preserve the result status", narrowHeader.endsWith("· done"), true);
const statusOnlyHeader = plain(formatCollapsedSubagentResult(details("failed"), 20, 5, "Ctrl+O")[0] ?? "");
eq("very narrow headers prioritize exceptional status", statusOnlyHeader.includes("failed"), true);
for (const width of [0, 1, 2, 8, 20, 40, 80]) {
	const hostile: SubagentResultDetails = {
		id: "wide0001",
		name: "界e\u0301 🙂\x1b[2J review",
		agent: "偵察\x1b]52;c;Zm9v\x07",
		expanded: { version: 1 },
		presentation: resultPresentation("failed", 9, `漢字 e\u0301 🙂 ${longPreview}`),
	};
	const lines = formatCollapsedSubagentResult(hostile, width, 5, "Ctrl+O");
	eq(`width ${width} never exceeds terminal columns`, lines.every((line) => visibleWidth(line) <= width), true);
	eq(`width ${width} never exposes child terminal controls`, lines.join("").includes("\x1b]52"), false);
}

const current = details("completed");
eq("current structured details parse", parseSubagentResultDetails(current)?.presentation.status, "completed");
eq("current structured details preserve sizes", parseSubagentResultDetails(current), current);
eq("persisted result rejects an invalid agent identifier", parseSubagentResultDetails({
	...current,
	agent: "code reviewer",
}), undefined);
eq("invalid optional sizes are omitted", parseSubagentResultDetails({
	...current,
	contextTokens: -1,
	resultTokens: Number.NaN,
}), { ...current, contextTokens: undefined, resultTokens: undefined });
eq("unknown presentation version uses normal renderer fallback", parseSubagentResultDetails({
	...current,
	presentation: { ...current.presentation, version: 3 },
}), undefined);
eq("missing expanded details use normal renderer fallback", parseSubagentResultDetails({
	...current,
	expanded: undefined,
}), undefined);
eq("malformed details use normal renderer fallback", parseSubagentResultDetails(null), undefined);

initTheme(undefined, false);
let registeredType = "";
let renderer: MessageRenderer | undefined;
let registrations = 0;
registerSubagentResultRenderer({
	registerMessageRenderer(customType: string, callback: MessageRenderer): void {
		registrations++;
		registeredType = customType;
		renderer = callback;
	},
} as unknown as ExtensionAPI);
eq("one message renderer is registered", registrations, 1);
eq("only delivered results get the renderer", registeredType, "subagent_result");

const backgroundColors: string[] = [];
const theme = {
	fg: (_color: string, text: string) => text,
	bg: (color: string, text: string) => {
		backgroundColors.push(color);
		return text;
	},
	bold: (text: string) => text,
} as unknown as Theme;
const responseMarkdown = [
	"# Complete report",
	"",
	"Child response with **Markdown** and safe Unicode 界.",
	"",
	"```ts",
	"const complete = true;",
	"```",
	"",
	"TAIL_SENTINEL\x1b]52;c;Zm9v\x07",
].join("\n");
const worktreeNote = "Worktree: kept at /repo/worktree on branch pi/api-review.";
const envelope = buildSubagentResultEnvelope({
	status: "completed",
	name: current.name,
	agent: current.agent ?? "worker",
	id: current.id,
	elapsed: "2m 14s",
	contextTokens: current.contextTokens,
	resultTokens: current.resultTokens,
	costUsd: 0.31,
	response: responseMarkdown,
	action: "Resume",
	actionMessage: "...",
	sessionFile: "/sessions/child.jsonl",
	worktreeNote,
});
const messageDetails: SubagentResultDetails = {
	...current,
	costUsd: 0.31,
	sessionFile: "/sessions/child.jsonl",
	expanded: { version: 1, response: envelope.response, worktreeNote },
};
const message = {
	role: "custom" as const,
	customType: "subagent_result",
	content: envelope.content,
	display: true,
	details: messageDetails,
	timestamp: 1,
};
const originalContent = message.content;
const collapsedComponent = renderer?.(message, { expanded: false }, theme);
const expandedComponent = renderer?.(message, { expanded: true }, theme);
eq("current details receive collapsed custom rendering", collapsedComponent !== undefined, true);
eq("current details receive expanded custom rendering", expandedComponent !== undefined, true);
const collapsedShellLines = collapsedComponent?.render(120).map(plain) ?? [];
eq("collapsed renderer uses native vertical padding", [collapsedShellLines[0], collapsedShellLines.at(-1)], ["", ""]);
eq("collapsed header receives native horizontal padding", collapsedShellLines[1]?.startsWith(" subagent result"), true);
eq("collapsed body keeps a native spacer", collapsedShellLines[2], "");
eq("collapsed preview relies only on boxed horizontal padding", collapsedShellLines[3]?.startsWith(" Found two"), true);
eq("collapsed result hint omits redundant explanatory copy", collapsedShellLines.join("\n").includes("to expand"), false);
eq("completed shell uses the tool-success background", backgroundColors.includes("toolSuccessBg"), true);
eq("completed shell does not use the custom-message background", backgroundColors.includes("customMessageBg"), false);
for (const status of ["completed", "failed", "stopped"] as const) {
	const usedBackgrounds: string[] = [];
	const statusTheme = {
		...theme,
		bg: (color: string, text: string) => {
			usedBackgrounds.push(color);
			return text;
		},
	} as unknown as Theme;
	const statusMessage = { ...message, details: details(status) };
	renderer?.(statusMessage, { expanded: false }, statusTheme)?.render(120);
	const expectedBackground = status === "completed" ? "toolSuccessBg" : "toolErrorBg";
	eq(`${status} uses ${expectedBackground}`, usedBackgrounds.includes(expectedBackground), true);
}
const markedTheme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;
for (const status of ["completed", "failed", "stopped"] as const) {
	const styledMessage = { ...message, details: details(status) };
	const styledOutput = renderer?.(styledMessage, { expanded: false }, markedTheme)?.render(500).join("") ?? "";
	eq(`${status} uses tool-title styling`, styledOutput.includes("<toolTitle>subagent result</toolTitle>"), true);
	eq(`${status} uses accent styling for the task name`, styledOutput.includes("<accent>API review</accent>"), true);
	eq(`${status} uses muted separator and agent metadata`, styledOutput.includes("<muted> · </muted><muted>code-reviewer</muted><muted> · </muted>"), true);
	eq(`${status} uses muted status metadata`, styledOutput.includes(`<muted> · ${status === "completed" ? "done" : status} 2m14s</muted>`), true);
	eq(`${status} uses muted size metadata`, styledOutput.includes("<muted> · 84k ctx · ~1.8k result</muted>"), true);
	eq(`${status} has no legacy status icon`, /[✓✗■]/u.test(styledOutput), false);
}
const expandedLines = expandedComponent?.render(60) ?? [];
const expandedPlainLines = expandedLines.map(plain);
const expandedText = expandedPlainLines.join("\n");
const expandedWideText = expandedComponent?.render(120).map(plain).join("\n") ?? "";
eq("expanded renderer uses native vertical padding", [expandedPlainLines[0], expandedPlainLines.at(-1)], ["", ""]);
eq("expanded content receives native horizontal padding",
	expandedPlainLines.filter(Boolean).every((line) => line.startsWith(" ")), true);
eq("expanded result uses the compact native header",
	expandedWideText.includes("subagent result · code-reviewer · API review · done 2m14s · 84k ctx · ~1.8k result"), true);
eq("expanded result renders the complete child response", expandedText.includes("TAIL_SENTINEL"), true);
eq("expanded result does not render envelope labels", expandedText.includes("Status: completed"), false);
eq("expanded result does not render response delimiters", expandedText.includes("<result>"), false);
eq("expanded result shows compact cost metadata", expandedText.includes("cost this run $0.31"), true);
eq("expanded result shows the session path", expandedText.includes("/sessions/child.jsonl"), true);
eq("expanded result shows resume guidance", expandedText.includes("resume subagent_resume"), true);
eq("expanded result shows the worktree outcome", expandedText.includes("Worktree: kept"), true);
eq("expanded result strips terminal controls", expandedLines.join("").includes("\x1b]52"), false);
eq("expanded rendering does not mutate model-facing content", message.content, originalContent);

const structuredMarked = renderer?.(message, { expanded: true }, markedTheme)?.render(500).join("") ?? "";
eq("expanded result styles its title as a tool title",
	structuredMarked.includes("<toolTitle>subagent result</toolTitle>"), true);
eq("expanded result styles session paths as accents",
	structuredMarked.includes("<accent>/sessions/child.jsonl</accent>"), true);
eq("expanded result styles footer labels as metadata",
	structuredMarked.includes("<muted>cost this run $0.31</muted>"), true);

const failedResponse = "The provider returned partial output.";
const failedEnvelope = buildSubagentResultEnvelope({
	status: "failed",
	name: "API review",
	agent: "code-reviewer",
	id: "abc12345",
	elapsed: "2m 14s",
	contextTokens: 84_000,
	resultTokens: 9,
	costUsd: 0.04,
	response: failedResponse,
	failureReason: "exit code 1",
	action: "Retry",
	actionMessage: "<guidance>",
	sessionFile: "/sessions/failed.jsonl",
});
const failedStructuredMessage = {
	...message,
	content: failedEnvelope.content,
	details: {
		...details("failed", failedResponse),
		resultTokens: 9,
		costUsd: 0.04,
		sessionFile: "/sessions/failed.jsonl",
		expanded: {
			version: 1 as const,
			failureReason: "exit code 1",
			response: failedEnvelope.response,
		},
	},
};
const failedStructuredText = renderer?.(failedStructuredMessage, { expanded: true }, theme)?.render(100).map(plain).join("\n") ?? "";
eq("expanded failed result shows its failure reason", failedStructuredText.includes("failure · exit code 1"), true);
eq("expanded failed result labels partial output", failedStructuredText.includes("last output"), true);
eq("expanded failed result shows retry guidance", failedStructuredText.includes("retry subagent_resume"), true);
eq("expanded failed result renders the partial response", failedStructuredText.includes(failedResponse), true);

const stoppedNotice = "Stopped by the user. Do not treat this as a subagent failure.";
const stoppedEnvelope = buildSubagentResultEnvelope({
	status: "stopped",
	name: "API review",
	agent: "code-reviewer",
	id: "abc12345",
	elapsed: "2m 14s",
	contextTokens: 84_000,
	costUsd: 0.02,
	notice: stoppedNotice,
	action: "Resume",
	actionMessage: "...",
	sessionFile: "/sessions/stopped.jsonl",
});
const stoppedStructuredMessage = {
	...message,
	content: stoppedEnvelope.content,
	details: {
		...stoppedDetails,
		costUsd: 0.02,
		sessionFile: "/sessions/stopped.jsonl",
		expanded: { version: 1 as const, notice: stoppedNotice },
	},
};
const stoppedStructuredText = renderer?.(stoppedStructuredMessage, { expanded: true }, theme)?.render(100).map(plain).join("\n") ?? "";
eq("expanded stopped result shows its notice", stoppedStructuredText.includes(stoppedNotice), true);
eq("expanded stopped result shows resume guidance", stoppedStructuredText.includes("resume subagent_resume"), true);

for (const width of [1, 2, 8, 20, 60]) {
	const lines = expandedComponent?.render(width) ?? [];
	eq(`expanded width ${width} stays within terminal columns`, lines.every((line) => visibleWidth(line) <= width), true);
}
const collapsedAgain = renderer?.(message, { expanded: false }, theme)?.render(80).map(plain);
eq("collapse is stable after expansion", collapsedAgain, collapsedComponent?.render(80).map(plain));
const restored = JSON.parse(JSON.stringify(message)) as typeof message;
eq("persisted current message restores identically",
	renderer?.(restored, { expanded: false }, theme)?.render(80).map(plain), collapsedAgain);

eq("non-current details defer to Pi's renderer", renderer?.({ ...message, details: null }, { expanded: false }, theme), undefined);

const directory = fileURLToPath(new URL("..", import.meta.url));
const watcherSource = readFileSync(`${directory}/watcher.ts`, "utf8");
const indexSource = readFileSync(`${directory}/index.ts`, "utf8");
const resultMessageSource = readFileSync(`${directory}/result-message.ts`, "utf8");
eq("watcher emits completed presentation details", watcherSource.includes('resultPresentation("completed"'), true);
eq("watcher emits failed presentation details", watcherSource.includes('resultPresentation("failed"'), true);
eq("watcher emits stopped presentation details", watcherSource.includes('"stopped",\n'), true);
eq("watcher estimates extracted result tokens", watcherSource.includes("estimateResultTokens(generatedSummary)"), true);
eq("watcher emits result token details", watcherSource.includes("resultTokens,\n"), true);
eq("watcher builds labeled model-facing envelopes", watcherSource.includes("buildSubagentResultEnvelope({"), true);
eq("watcher passes envelope response boundaries to the TUI", watcherSource.includes("response: envelope.response"), true);
eq("watcher keeps structured expanded details out of model-facing content",
	watcherSource.includes("expanded,\n\t\t\tpresentation,"), true);
eq("result renderer resolves the configured expansion binding",
	resultMessageSource.includes('keyText("app.tools.expand")'), true);
eq("parent extension registers the result renderer", indexSource.includes("registerSubagentResultRenderer(pi)"), true);
eq("help requests do not get a compact renderer", indexSource.includes('registerMessageRenderer("subagent_ping"'), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
