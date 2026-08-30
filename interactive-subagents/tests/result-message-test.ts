import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
	ExtensionAPI,
	MessageRenderer,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { parseSubagentResultEnvelope } from "../../shared/subagent-envelope.ts";
import {
	buildSubagentResultEnvelope,
	buildSubagentResultMessage,
} from "../result-content.ts";
import { clampStyled, fitText } from "../../shared/text-fit.ts";
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
const stoppedDetails = {
	...details("stopped", "Stopped by the user - no final result. Partial work may remain; expand for resume and worktree details."),
	resultTokens: undefined,
};
const longPreview = Array.from({ length: 40 }, (_, index) => `finding-${index}`).join(" ");
const current = details("completed");

describe("humanElapsed", () => {
	it("human elapsed seconds", () => {
		assert.strictEqual(humanElapsed(42), "42s");
	});

	it("human elapsed minutes retain seconds", () => {
		assert.strictEqual(humanElapsed(134), "2m 14s");
	});

	it("human elapsed clamps negative values", () => {
		assert.strictEqual(humanElapsed(-2), "0s");
	});
});

describe("resultPreview", () => {
	it("preview flattens whitespace", () => {
		assert.strictEqual(resultPreview("  First\n\nsecond\titem  "), "First second item");
	});

	it("preview removes terminal controls", () => {
		assert.strictEqual(resultPreview("safe\x1b]52;c;Zm9v\x07 text\0"), "safe text");
	});
});

describe("estimateResultTokens", () => {
	it("result tokens use pi's conservative estimate", () => {
		assert.strictEqual(estimateResultTokens("12345678"), 2);
	});

	it("result tokens omit empty sanitized text", () => {
		assert.strictEqual(estimateResultTokens(" \x1b]52;c;Zm9v\x07\0 "), undefined);
	});
});

describe("resultPresentation", () => {
	const oversizedPresentation = resultPresentation("completed", 1, "x".repeat(10_000));

	it("persisted preview is bounded without affecting message content", () => {
		assert.strictEqual(Array.from(oversizedPresentation.preview).length, 2001);
	});

	it("bounded persisted preview marks omitted text", () => {
		assert.strictEqual(oversizedPresentation.preview.endsWith("…"), true);
	});
});

describe("formatCollapsedSubagentResult", () => {
	const completed = formatCollapsedSubagentResult(details("completed"), 120, 5, "ctrl+o").map(plain);
	const failed = formatCollapsedSubagentResult(details("failed", "Provider authentication expired."), 120, 5, "Ctrl+O").map(plain);
	const stopped = formatCollapsedSubagentResult(stoppedDetails, 120, 5, "Ctrl+O").map(plain);

	it("completed header keeps identity, outcome, and elapsed time", () => {
		assert.strictEqual(completed[0],
			"subagent result · code-reviewer · API review · done 2m14s");
	});

	it("completed separates its preview from the header", () => {
		assert.strictEqual(completed[1], "");
	});

	it("completed includes its preview without extra indentation", () => {
		assert.strictEqual(completed[2], "Found two authentication bypass risks in the token refresh path.");
	});

	it("completed separates its footer from the preview", () => {
		assert.strictEqual(completed[3], "");
	});

	it("completed footer carries sizes and the expansion hint", () => {
		assert.strictEqual(completed[4],
			"84k ctx · ~1.8k result (ctrl+o to expand)");
	});

	it("failed is explicit without header metrics", () => {
		assert.strictEqual(failed[0],
			"subagent result · code-reviewer · API review · failed 2m14s");
	});

	it("stopped omits unavailable result size from its footer", () => {
		assert.strictEqual(stopped.at(-1),
			"84k ctx (Ctrl+O to expand)");
	});

	it("collapsed footer can show only a result size", () => {
		const resultOnly = formatCollapsedSubagentResult({
			...details("completed"),
			contextTokens: undefined,
		}, 120, 5, "Ctrl+O").map(plain);
		assert.strictEqual(resultOnly.at(-1), "~1.8k result (Ctrl+O to expand)");
	});

	it("collapsed footer remains useful when sizes are unavailable", () => {
		const sizesUnavailable = formatCollapsedSubagentResult({
			...details("completed"),
			contextTokens: undefined,
			resultTokens: undefined,
		}, 120, 0, "Ctrl+O").map(plain);
		assert.strictEqual(sizesUnavailable.at(-1), "(Ctrl+O to expand)");
	});

	it("status headers have no leading symbols", () => {
		assert.strictEqual([completed[0], failed[0], stopped[0]].every((line) => line.startsWith("subagent result ")), true);
	});

	it("collapsed expansion hint supports dim styling", () => {
		const styledHint = formatCollapsedSubagentResult(
			details("completed"),
			500,
			5,
			"ctrl+o",
			{
				visibleWidth,
				fitText,
				clampStyled,
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
		assert.strictEqual(styledHint.includes("<dim>(ctrl+o to expand)</dim>"), true);
	});

	it("collapsed footer accepts a configured expansion binding", () => {
		const customHintFooter = formatCollapsedSubagentResult(details("completed"), 120, 0, "f6").map(plain).at(-1);
		assert.strictEqual(customHintFooter?.endsWith("(f6 to expand)"), true);
	});

	const bounded = formatCollapsedSubagentResult(details("completed", longPreview), 42, 5, "Ctrl+O");

	it("collapsed output has a header, five preview lines, and a footer", () => {
		assert.strictEqual(bounded.length, 9);
	});

	it("truncated preview advertises omitted content", () => {
		assert.strictEqual(plain(bounded[6]).endsWith("…"), true);
	});

	it("collapsed hint remains on the final line", () => {
		assert.strictEqual(plain(bounded.at(-1) ?? "").endsWith("(Ctrl+O to expand)"), true);
	});

	const headerOnly = formatCollapsedSubagentResult(details("completed", longPreview), 120, 0, "Ctrl+O").map(plain);

	it("zero result preview lines still render the footer", () => {
		assert.strictEqual(headerOnly.length, 3);
	});

	it("zero result preview separates header and footer", () => {
		assert.strictEqual(headerOnly[1], "");
	});

	it("zero result preview retains sizes and expansion guidance", () => {
		assert.strictEqual(headerOnly[2],
			"84k ctx · ~1.8k result (Ctrl+O to expand)");
	});

	const twentyLineResult = formatCollapsedSubagentResult(details("completed", longPreview.repeat(4)), 16, 20, "");

	it("maximum result preview line limit is honored", () => {
		assert.strictEqual(twentyLineResult.length, 24);
	});

	it("maximum result preview still marks omitted content", () => {
		assert.strictEqual(plain(twentyLineResult.at(-3) ?? "").endsWith("…"), true);
	});

	const narrowHeader = plain(formatCollapsedSubagentResult(details("completed"), 40, 5, "Ctrl+O")[0] ?? "");

	it("narrow headers preserve clipped identity when it fits before elapsed time", () => {
		assert.strictEqual(narrowHeader.includes("· c"), true);
	});

	it("narrow headers preserve status and elapsed time", () => {
		assert.strictEqual(narrowHeader.endsWith("· done 2m14s"), true);
	});

	it("narrow headers drop optional identity before elapsed time", () => {
		const timedStatusOnlyHeader = plain(formatCollapsedSubagentResult(details("completed"), 30, 5, "Ctrl+O")[0] ?? "");
		assert.strictEqual(timedStatusOnlyHeader, "subagent result · done 2m14s");
	});

	it("very narrow headers prioritize exceptional status", () => {
		const statusOnlyHeader = plain(formatCollapsedSubagentResult(details("failed"), 20, 5, "Ctrl+O")[0] ?? "");
		assert.strictEqual(statusOnlyHeader.includes("failed"), true);
	});

	it("hostile input never overflows or leaks terminal controls at any width", () => {
		for (const width of [0, 1, 2, 8, 20, 40, 80]) {
			const hostile: SubagentResultDetails = {
				id: "wide0001",
				name: "界e\u0301 🙂\x1b[2J review",
				agent: "偵察\x1b]52;c;Zm9v\x07",
				expanded: { version: 1 },
				presentation: resultPresentation("failed", 9, `漢字 e\u0301 🙂 ${longPreview}`),
			};
			const lines = formatCollapsedSubagentResult(hostile, width, 5, "Ctrl+O");
			assert.strictEqual(lines.every((line) => visibleWidth(line) <= width), true,
				`width ${width} never exceeds terminal columns`);
			assert.strictEqual(lines.join("").includes("\x1b]52"), false,
				`width ${width} never exposes child terminal controls`);
			assert.strictEqual(lines.join("").includes("\x1b"), false,
				`width ${width} truncation introduces no escape codes`);
		}
	});
});

describe("parseSubagentResultDetails", () => {
	// The parser normalizes every optional key to an explicit undefined.
	function normalizedCurrent(overrides: Partial<SubagentResultDetails> = {}): SubagentResultDetails {
		return {
			id: current.id,
			name: current.name,
			agent: current.agent,
			harness: undefined,
			model: undefined,
			effort: undefined,
			tools: undefined,
			forked: undefined,
			interactive: undefined,
			worktree: undefined,
			exitCode: undefined,
			reason: undefined,
			sessionFile: undefined,
			worktreeDir: undefined,
			worktreeBranch: undefined,
			worktreeStatus: undefined,
			contextTokens: current.contextTokens,
			contextWindow: undefined,
			resultTokens: current.resultTokens,
			costUsd: undefined,
			expanded: {
				version: 1,
				response: undefined,
				notice: undefined,
				failureReason: undefined,
				worktreeNote: undefined,
			},
			presentation: current.presentation,
			...overrides,
		};
	}

	it("old-shape structured details parse", () => {
		assert.strictEqual(parseSubagentResultDetails(current)?.presentation.status, "completed");
	});

	it("old-shape structured details preserve sizes", () => {
		assert.deepStrictEqual(parseSubagentResultDetails(current), normalizedCurrent());
	});

	it("widened structured details retain display and machine-only fields", () => {
		const widened = {
			...current,
			harness: "claude-code",
			model: "provider/model",
			effort: "high",
			tools: "read,edit,bash",
			forked: true,
			interactive: false,
			worktree: true,
			exitCode: 23,
			reason: "exited",
			sessionFile: "/sessions/child.jsonl",
			worktreeDir: "/repo/worktree",
			worktreeBranch: "pi/check",
			worktreeStatus: "kept",
			contextWindow: 200_000,
		};
		const parsedWidened = parseSubagentResultDetails(widened);
		assert.deepStrictEqual({
			harness: parsedWidened?.harness,
			model: parsedWidened?.model,
			effort: parsedWidened?.effort,
			tools: parsedWidened?.tools,
			forked: parsedWidened?.forked,
			interactive: parsedWidened?.interactive,
			worktree: parsedWidened?.worktree,
			exitCode: parsedWidened?.exitCode,
			reason: parsedWidened?.reason,
			worktreeDir: parsedWidened?.worktreeDir,
			worktreeBranch: parsedWidened?.worktreeBranch,
			worktreeStatus: parsedWidened?.worktreeStatus,
			contextWindow: parsedWidened?.contextWindow,
		}, {
			harness: "claude-code",
			model: "provider/model",
			effort: "high",
			tools: "read,edit,bash",
			forked: true,
			interactive: false,
			worktree: true,
			exitCode: 23,
			reason: "exited",
			worktreeDir: "/repo/worktree",
			worktreeBranch: "pi/check",
			worktreeStatus: "kept",
			contextWindow: 200_000,
		});
	});

	it("malformed optional root fields are omitted individually", () => {
		assert.deepStrictEqual(parseSubagentResultDetails({
			...current,
			model: 42,
			effort: false,
			tools: [],
			forked: "yes",
			contextWindow: 0,
			exitCode: 1.5,
		}), normalizedCurrent());
	});

	const compactedDetails = parseSubagentResultDetails({
		...current,
		contextTokens: null,
		contextWindow: 200_000,
	});

	it("compacted context null sentinel survives parsing", () => {
		assert.strictEqual(compactedDetails?.contextTokens, null);
	});

	it("compacted context null sentinel is omitted from the collapsed display", () => {
		assert.strictEqual(
			compactedDetails && formatCollapsedSubagentResult(compactedDetails, 120, 0, "Ctrl+O").map(plain).at(-1),
			"~1.8k result (Ctrl+O to expand)");
	});

	it("persisted result rejects an invalid agent identifier", () => {
		assert.strictEqual(parseSubagentResultDetails({
			...current,
			agent: "code reviewer",
		}), undefined);
	});

	it("invalid optional sizes are omitted", () => {
		assert.deepStrictEqual(parseSubagentResultDetails({
			...current,
			contextTokens: -1,
			resultTokens: Number.NaN,
		}), normalizedCurrent({ contextTokens: undefined, resultTokens: undefined }));
	});

	it("unknown presentation version uses normal renderer fallback", () => {
		assert.strictEqual(parseSubagentResultDetails({
			...current,
			presentation: { ...current.presentation, version: 3 },
		}), undefined);
	});

	it("missing expanded details use normal renderer fallback", () => {
		assert.strictEqual(parseSubagentResultDetails({
			...current,
			expanded: undefined,
		}), undefined);
	});

	it("malformed details use normal renderer fallback", () => {
		assert.strictEqual(parseSubagentResultDetails(null), undefined);
	});
});

describe("registerSubagentResultRenderer", () => {
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

	it("one message renderer is registered", () => {
		assert.strictEqual(registrations, 1);
	});

	it("only delivered results get the renderer", () => {
		assert.strictEqual(registeredType, "subagent_result");
	});

	const backgroundColors: string[] = [];
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (color: string, text: string) => {
			backgroundColors.push(color);
			return text;
		},
		bold: (text: string) => text,
	} as unknown as Theme;
	const renderMessage = (
		message: Parameters<MessageRenderer>[0],
		expanded: boolean,
		theme: Theme,
		outputPad = 1,
	) => renderer?.(message, { expanded, outputPad }, theme);
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
		contextTokens: current.contextTokens ?? undefined,
		resultTokens: current.resultTokens,
		model: "provider/model",
		effort: "high",
		forked: true,
		interactive: true,
		worktree: true,
		tools: "read,edit,bash",
		costUsd: 0.31,
		response: responseMarkdown,
		action: "Resume",
		actionMessage: "...",
		sessionFile: "/sessions/child.jsonl",
		worktreeNote,
	});
	const messageDetails: SubagentResultDetails = {
		...current,
		model: "provider/model",
		effort: "high",
		tools: "read,edit,bash",
		forked: true,
		interactive: true,
		worktree: true,
		exitCode: 0,
		reason: "done",
		contextWindow: 200_000,
		costUsd: 0.31,
		sessionFile: "/sessions/child.jsonl",
		worktreeDir: "/repo/worktree",
		worktreeBranch: "pi/api-review",
		worktreeStatus: "kept",
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
	const collapsedComponent = renderMessage(message, false, theme);
	const expandedComponent = renderMessage(message, true, theme);
	const collapsedShellLines = collapsedComponent?.render(120).map(plain) ?? [];
	const unpaddedShellLines = renderMessage(message, false, theme, 0)?.render(120).map(plain) ?? [];
	const completedShellBackgrounds = [...backgroundColors];

	it("current details receive collapsed custom rendering", () => {
		assert.strictEqual(collapsedComponent !== undefined, true);
	});

	it("current details receive expanded custom rendering", () => {
		assert.strictEqual(expandedComponent !== undefined, true);
	});

	it("collapsed renderer uses native vertical padding", () => {
		assert.deepStrictEqual([collapsedShellLines[0], collapsedShellLines.at(-1)], ["", ""]);
	});

	it("collapsed header receives native horizontal padding", () => {
		assert.strictEqual(collapsedShellLines[1]?.startsWith(" subagent result"), true);
	});

	it("zero configured output padding removes horizontal padding", () => {
		assert.strictEqual(unpaddedShellLines[1]?.startsWith("subagent result"), true);
	});

	it("collapsed body keeps a native spacer", () => {
		assert.strictEqual(collapsedShellLines[2], "");
	});

	it("collapsed preview relies only on boxed horizontal padding", () => {
		assert.strictEqual(collapsedShellLines[3]?.startsWith(" Found two"), true);
	});

	it("collapsed footer keeps a native spacer", () => {
		assert.strictEqual(collapsedShellLines[4], "");
	});

	it("collapsed footer is the final content line", () => {
		assert.strictEqual(collapsedShellLines.at(-2)?.trimStart().startsWith("84k ctx · ~1.8k result"), true);
	});

	it("completed shell uses the tool-success background", () => {
		assert.strictEqual(completedShellBackgrounds.includes("toolSuccessBg"), true);
	});

	it("completed shell does not use the custom-message background", () => {
		assert.strictEqual(completedShellBackgrounds.includes("customMessageBg"), false);
	});

	it("each status selects its semantic background", () => {
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
			renderMessage(statusMessage, false, statusTheme)?.render(120);
			const expectedBackground =
				status === "completed" ? "toolSuccessBg" : status === "stopped" ? "customMessageBg" : "toolErrorBg";
			assert.strictEqual(usedBackgrounds.includes(expectedBackground), true,
				`${status} uses ${expectedBackground}`);
		}
	});

	it("each status follows native tool typography in its collapsed header", () => {
		const markedTheme = {
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as unknown as Theme;
		for (const status of ["completed", "failed", "stopped"] as const) {
			const styledMessage = { ...message, details: details(status) };
			const styledOutput = renderMessage(styledMessage, false, markedTheme)?.render(500).join("") ?? "";
			assert.strictEqual(styledOutput.includes("<toolTitle>subagent result</toolTitle>"), true,
				`${status} uses tool-title styling`);
			assert.strictEqual(styledOutput.includes("<accent>API review</accent>"), true,
				`${status} uses accent styling for the task name`);
			assert.strictEqual(styledOutput.includes("<muted> · </muted><muted>code-reviewer</muted><muted> · </muted>"), true,
				`${status} uses muted separator and agent metadata`);
			assert.strictEqual(styledOutput.includes(`<muted> · ${status === "completed" ? "done" : status} 2m14s</muted>`), true,
				`${status} uses muted status metadata`);
			assert.strictEqual(styledOutput.includes("2m14s</muted><muted> · 84k"), false,
				`${status} omits size metadata from the header`);
			assert.strictEqual(styledOutput.includes("<muted>84k ctx · ~1.8k result</muted>"), true,
				`${status} uses muted size metadata in the footer`);
			assert.strictEqual(/[✓✗■]/u.test(styledOutput), false,
				`${status} has no legacy status icon`);
		}
	});

	const markedTheme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;
	const expandedLines = expandedComponent?.render(60) ?? [];
	const expandedPlainLines = expandedLines.map(plain);
	const expandedText = expandedPlainLines.join("\n");
	const expandedWideLines = expandedComponent?.render(120).map(plain) ?? [];
	const expandedWideText = expandedWideLines.join("\n");
	const responseLineIndex = expandedWideLines.findIndex((line) => line.includes("TAIL_SENTINEL"));
	const dividerLineIndex = expandedWideLines.findIndex((line) => line.trimStart().startsWith("─ result details ─"));
	const statusLineIndex = expandedWideLines.findIndex((line) => line.trimStart().startsWith("status   completed"));
	const nameLineIndex = expandedWideLines.findIndex((line) => line.trimStart().startsWith("name     API review"));
	const modelLineIndex = expandedWideLines.findIndex((line) => line.trimStart().startsWith("model    provider/model"));
	const effortLineIndex = expandedWideLines.findIndex((line) => line.trimStart().startsWith("effort   high"));
	const contextLineIndex = expandedWideLines.findIndex((line) => line.trimStart().startsWith("context  84k / 200k tokens"));
	const costLineIndex = expandedWideLines.findIndex((line) => line.trimStart().startsWith("cost     $0.31"));
	const worktreeLineIndex = expandedWideLines.findIndex((line) => line.includes("Worktree: kept"));
	const sessionLineIndex = expandedWideLines.findIndex((line) => line.trimStart().startsWith("session "));
	const resumeLineIndex = expandedWideLines.findIndex((line) => line.trimStart().startsWith("resume "));

	it("expanded renderer uses native vertical padding", () => {
		assert.deepStrictEqual([expandedPlainLines[0], expandedPlainLines.at(-1)], ["", ""]);
	});

	it("expanded content receives native horizontal padding", () => {
		assert.strictEqual(expandedPlainLines.filter(Boolean).every((line) => line.startsWith(" ")), true);
	});

	it("expanded result uses the outcome-only native header", () => {
		assert.strictEqual(
			expandedWideText.includes("subagent result · code-reviewer · API review · done 2m14s"), true);
	});

	it("expanded result omits size metrics from its header", () => {
		assert.strictEqual(expandedWideText.includes("done 2m14s · 84k ctx"), false);
	});

	it("expanded result renders the complete child response", () => {
		assert.strictEqual(expandedText.includes("TAIL_SENTINEL"), true);
	});

	it("expanded result does not render envelope labels", () => {
		assert.strictEqual(expandedText.includes("Status: completed"), false);
	});

	it("expanded result does not render response delimiters", () => {
		assert.strictEqual(expandedText.includes("<result>"), false);
	});

	it("expanded layout separates the response and canonical metadata table with a labeled rule", () => {
		assert.strictEqual(
			responseLineIndex > 0 && responseLineIndex < dividerLineIndex && dividerLineIndex < statusLineIndex &&
			statusLineIndex < nameLineIndex &&
			nameLineIndex < modelLineIndex && modelLineIndex < effortLineIndex && effortLineIndex < contextLineIndex &&
			contextLineIndex < costLineIndex, true);
	});

	it("expanded layout puts the action tail after the metadata table", () => {
		assert.strictEqual(
			costLineIndex < worktreeLineIndex && sessionLineIndex === worktreeLineIndex + 1 &&
			resumeLineIndex === sessionLineIndex + 1, true);
	});

	it("expanded context row includes the known context window", () => {
		assert.strictEqual(expandedWideLines[contextLineIndex]?.trimStart(), "context  84k / 200k tokens");
	});

	it("expanded result shows the session path", () => {
		assert.strictEqual(expandedWideLines[sessionLineIndex]?.trimStart(),
			"session /sessions/child.jsonl");
	});

	it("expanded result shows resume guidance", () => {
		assert.strictEqual(expandedWideLines[resumeLineIndex]?.trimStart(),
			'resume subagent_resume({ id: "abc12345", message: "..." })');
	});

	it("expanded result has no expansion hint", () => {
		assert.strictEqual(expandedText.includes("to expand"), false);
	});

	it("expanded result strips terminal controls", () => {
		assert.strictEqual(expandedLines.join("").includes("\x1b]52"), false);
	});

	it("expanded rendering does not mutate model-facing content", () => {
		assert.strictEqual(message.content, originalContent);
	});

	const structuredMarked = renderMessage(message, true, markedTheme)?.render(500).join("") ?? "";

	it("expanded result styles its title as a tool title", () => {
		assert.strictEqual(structuredMarked.includes("<toolTitle>subagent result</toolTitle>"), true);
	});

	it("expanded result styles session paths as accents", () => {
		assert.strictEqual(structuredMarked.includes("<accent>/sessions/child.jsonl</accent>"), true);
	});

	it("expanded result styles its details divider and table keys as metadata", () => {
		assert.strictEqual(
			structuredMarked.includes("<muted>─ result details ─") &&
			structuredMarked.includes("<muted>context  </muted><toolOutput>84k / 200k tokens</toolOutput>") &&
			structuredMarked.includes("<muted>model    </muted><toolOutput>provider/model</toolOutput>") &&
			structuredMarked.includes("<muted>effort   </muted><toolOutput>high</toolOutput>"), true);
	});

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
	const failedStructuredText = renderMessage(failedStructuredMessage, true, theme)?.render(100).map(plain).join("\n") ?? "";

	it("expanded failed result shows its failure reason", () => {
		assert.strictEqual(failedStructuredText.includes("failure · exit code 1"), true);
	});

	it("expanded failed result labels partial output", () => {
		assert.strictEqual(failedStructuredText.includes("last output"), true);
	});

	it("expanded failed result shows retry guidance", () => {
		assert.strictEqual(failedStructuredText.includes("retry subagent_resume"), true);
	});

	it("expanded failed result renders the partial response", () => {
		assert.strictEqual(failedStructuredText.includes(failedResponse), true);
	});

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
	const stoppedStructuredText = renderMessage(stoppedStructuredMessage, true, theme)?.render(100).map(plain).join("\n") ?? "";

	it("expanded stopped result shows its notice", () => {
		assert.strictEqual(stoppedStructuredText.includes(stoppedNotice), true);
	});

	it("expanded stopped table includes only available run metrics", () => {
		assert.strictEqual(
			stoppedStructuredText.includes("context  84k tokens") && stoppedStructuredText.includes("cost     $0.02") &&
			!stoppedStructuredText.includes("result   ~"), true);
	});

	it("expanded stopped result shows resume guidance", () => {
		assert.strictEqual(stoppedStructuredText.includes("resume subagent_resume"), true);
	});

	it("expanded rendering stays within terminal columns at every width", () => {
		for (const width of [1, 2, 8, 20, 60]) {
			const lines = expandedComponent?.render(width) ?? [];
			assert.strictEqual(lines.every((line) => visibleWidth(line) <= width), true,
				`expanded width ${width} stays within terminal columns`);
		}
	});

	const collapsedAgain = renderMessage(message, false, theme)?.render(80).map(plain);

	it("collapse is stable after expansion", () => {
		assert.deepStrictEqual(collapsedAgain, collapsedComponent?.render(80).map(plain));
	});

	it("persisted current message restores identically", () => {
		const restored = JSON.parse(JSON.stringify(message)) as typeof message;
		assert.deepStrictEqual(renderMessage(restored, false, theme)?.render(80).map(plain), collapsedAgain);
	});

	it("non-current details defer to Pi's renderer", () => {
		assert.strictEqual(renderMessage({ ...message, details: null }, false, theme), undefined);
	});

	const pipeline = buildSubagentResultMessage({
		status: "completed",
		name: "pipeline proof",
		agent: "worker",
		id: "pipe1234",
		model: "provider/pipeline-model",
		effort: "high",
		forked: true,
		interactive: false,
		worktree: false,
		tools: "read,bash",
		elapsedSeconds: 183,
		contextTokens: 78_000,
		contextWindow: 200_000,
		resultTokens: 12,
		costUsd: 0.08,
		exitCode: 0,
		reason: "done",
		sessionFile: "/sessions/pipeline.jsonl",
		response: "PIPELINE RESPONSE",
	});

	it("unified pipeline envelope exposes model and effort in canonical order", () => {
		const pipelineEnvelope = parseSubagentResultEnvelope(pipeline.content);
		assert.deepStrictEqual(
			pipelineEnvelope?.fields.map((field) => field.key).slice(0, 9),
			["status", "name", "agent", "id", "model", "effort", "mode", "tools", "elapsed"]);
	});

	it("unified pipeline renders response before its complete TUI table", () => {
		const pipelineMessage = {
			role: "custom" as const,
			customType: "subagent_result",
			content: pipeline.content,
			display: true,
			details: pipeline.details,
			timestamp: 1,
		};
		const pipelineLines = renderMessage(pipelineMessage, true, theme)?.render(120).map(plain) ?? [];
		const pipelineResponseIndex = pipelineLines.findIndex((line) => line.includes("PIPELINE RESPONSE"));
		const pipelineStatusIndex = pipelineLines.findIndex((line) => line.trimStart().startsWith("status   completed"));
		assert.strictEqual(
			pipelineResponseIndex > 0 && pipelineResponseIndex < pipelineStatusIndex &&
			pipelineLines.some((line) => line.trimStart().startsWith("model    provider/pipeline-model")) &&
			pipelineLines.some((line) => line.trimStart().startsWith("effort   high")), true);
	});

	const directory = fileURLToPath(new URL("..", import.meta.url));
	const indexSource = readFileSync(`${directory}/index.ts`, "utf8");
	const resultMessageSource = readFileSync(`${directory}/result-message.ts`, "utf8");

	it("result renderer resolves the configured expansion binding", () => {
		assert.strictEqual(resultMessageSource.includes('keyText("app.tools.expand")'), true);
	});

	it("parent extension registers the result renderer", () => {
		assert.strictEqual(indexSource.includes("registerSubagentResultRenderer(pi)"), true);
	});

	it("help requests do not get a compact renderer", () => {
		assert.strictEqual(indexSource.includes('registerMessageRenderer("subagent_ping"'), false);
	});
});
