import type {
	ExtensionAPI,
	MessageRenderer,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
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
const STATUS_ICON = { completed: "✓", failed: "✗", stopped: "■" } as const;
const details = (
	status: "completed" | "failed" | "stopped",
	preview = "Found two authentication bypass risks in the token refresh path.",
): SubagentResultDetails => ({
	id: "abc12345",
	name: "API review",
	agent: "code-reviewer",
	presentation: resultPresentation(status, 134, preview),
});

eq("human elapsed seconds", humanElapsed(42), "42s");
eq("human elapsed minutes retain seconds", humanElapsed(134), "2m 14s");
eq("human elapsed clamps negative values", humanElapsed(-2), "0s");
eq("preview flattens whitespace", resultPreview("  First\n\nsecond\titem  "), "First second item");
eq("preview removes terminal controls", resultPreview("safe\x1b]52;c;Zm9v\x07 text\0"), "safe text");
const oversizedPresentation = resultPresentation("completed", 1, "x".repeat(10_000));
eq("persisted preview is bounded without affecting message content", Array.from(oversizedPresentation.preview).length, 2001);
eq("bounded persisted preview marks omitted text", oversizedPresentation.preview.endsWith("…"), true);

const completed = formatCollapsedSubagentResult(details("completed"), 120, "Ctrl+O to expand").map(plain);
eq("completed uses the natural status sentence", completed[0],
	'✓ Sub-agent "API review" [code-reviewer] completed in 2m 14s · Ctrl+O to expand');
eq("completed includes its preview", completed[1], "  Found two authentication bypass risks in the token refresh path.");
const failed = formatCollapsedSubagentResult(details("failed", "Provider authentication expired."), 120, "Ctrl+O to expand").map(plain);
eq("failed is explicit", failed[0],
	'✗ Sub-agent "API review" [code-reviewer] failed after 2m 14s · Ctrl+O to expand');
const stopped = formatCollapsedSubagentResult(details("stopped", "No final result was delivered."), 120, "Ctrl+O to expand").map(plain);
eq("stopped is distinct from failure", stopped[0],
	'■ Sub-agent "API review" [code-reviewer] was stopped after 2m 14s · Ctrl+O to expand');

const longPreview = Array.from({ length: 40 }, (_, index) => `finding-${index}`).join(" ");
const bounded = formatCollapsedSubagentResult(details("completed", longPreview), 42, "Ctrl+O to expand");
eq("collapsed output has one status plus at most two preview lines", bounded.length, 3);
eq("truncated preview advertises omitted content", plain(bounded[2]).endsWith("…"), true);

for (const width of [0, 1, 2, 8, 20, 40, 80]) {
	const hostile: SubagentResultDetails = {
		id: "wide0001",
		name: "界e\u0301 🙂\x1b[2J review",
		agent: "偵察\x1b]52;c;Zm9v\x07",
		presentation: resultPresentation("failed", 9, `漢字 e\u0301 🙂 ${longPreview}`),
	};
	const lines = formatCollapsedSubagentResult(hostile, width, "Ctrl+O to expand");
	eq(`width ${width} never exceeds terminal columns`, lines.every((line) => visibleWidth(line) <= width), true);
	eq(`width ${width} never exposes child terminal controls`, lines.join("").includes("\x1b]52"), false);
}

const current = details("completed");
eq("current structured details parse", parseSubagentResultDetails(current)?.presentation.status, "completed");
eq("unknown presentation version uses normal renderer fallback", parseSubagentResultDetails({
	id: "abc12345",
	name: "API review",
	presentation: { ...current.presentation, version: 2 },
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

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;
const markdown = [
	"# Complete report",
	"",
	"Child response with **Markdown** and safe Unicode 界.",
	"",
	"```ts",
	"const complete = true;",
	"```",
	"",
	"Context: 84k/200k tokens (42%) · cost this run $0.31",
	"Session: /sessions/child.jsonl",
	"Resume with subagent_resume({ id: \"abc12345\", message: \"...\" }).",
	"Worktree: kept at /repo/worktree on branch pi/api-review.",
	"TAIL_SENTINEL\x1b]52;c;Zm9v\x07",
].join("\n");
const message = {
	role: "custom" as const,
	customType: "subagent_result",
	content: markdown,
	display: true,
	details: current,
	timestamp: 1,
};
const originalContent = message.content;
const collapsedComponent = renderer?.(message, { expanded: false }, theme);
const expandedComponent = renderer?.(message, { expanded: true }, theme);
eq("current details receive collapsed custom rendering", collapsedComponent !== undefined, true);
eq("current details receive expanded custom rendering", expandedComponent !== undefined, true);
const markedTheme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bold: (text: string) => text,
} as unknown as Theme;
for (const [status, color] of [["completed", "success"], ["failed", "error"], ["stopped", "warning"]] as const) {
	const styledMessage = { ...message, details: details(status) };
	const styledOutput = renderer?.(styledMessage, { expanded: false }, markedTheme)?.render(500).join("") ?? "";
	eq(`${status} uses ${color} status styling`, styledOutput.includes(`<${color}>${STATUS_ICON[status]}</${color}>`), true);
}
const expandedLines = expandedComponent?.render(60) ?? [];
const expandedText = expandedLines.map(plain).join("\n");
eq("expanded rendering includes the full tail", expandedText.includes("TAIL_SENTINEL"), true);
eq("expanded rendering includes context and cost", expandedText.includes("Context: 84k/200k tokens (42%) · cost this run $0.31"), true);
eq("expanded rendering includes session and resume guidance", expandedText.includes("subagent_resume"), true);
eq("expanded rendering includes worktree outcome", expandedText.includes("Worktree: kept"), true);
for (const [status, marker] of [["failed", "FULL_FAILURE_GUIDANCE"], ["stopped", "FULL_STOPPED_GUIDANCE"]] as const) {
	const statusMessage = {
		...message,
		content: `${status} result\n\n${marker}\nSession: /sessions/${status}.jsonl`,
		details: details(status),
	};
	const statusExpanded = renderer?.(statusMessage, { expanded: true }, theme)?.render(60).map(plain).join("\n") ?? "";
	eq(`expanded ${status} result keeps its complete guidance`, statusExpanded.includes(marker), true);
}
eq("expanded rendering strips terminal controls", expandedLines.join("").includes("\x1b]52"), false);
eq("expanded rendering does not mutate model-facing content", message.content, originalContent);
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
eq("watcher emits completed presentation details", watcherSource.includes('resultPresentation("completed"'), true);
eq("watcher emits failed presentation details", watcherSource.includes('resultPresentation("failed"'), true);
eq("watcher emits stopped presentation details", watcherSource.includes('"stopped",\n'), true);
eq("parent extension registers the result renderer", indexSource.includes("registerSubagentResultRenderer(pi)"), true);
eq("help requests do not get a compact renderer", indexSource.includes('registerMessageRenderer("subagent_ping"'), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
