import { estimateTokens, getMarkdownTheme, keyText, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { isValidAgentIdentifier } from "./agent-identifier.ts";
import { config } from "./config.ts";
import { sanitizeDisplayText } from "./display-text.ts";
import { formatCost, formatTokens } from "./widget.ts";

export type SubagentResultStatus = "completed" | "failed" | "stopped";

export interface SubagentResultPresentation {
	version: 2;
	status: SubagentResultStatus;
	elapsedSeconds: number;
	preview: string;
}

export interface SubagentResultContentRange {
	start: number;
	end: number;
}

export interface SubagentExpandedResultPresentation {
	version: 1;
	response?: SubagentResultContentRange;
	notice?: string;
	failureReason?: string;
	worktreeNote?: string;
}

export interface SubagentResultDetails {
	id: string;
	name: string;
	agent?: string;
	contextTokens?: number;
	resultTokens?: number;
	costUsd?: number;
	sessionFile?: string;
	expanded: SubagentExpandedResultPresentation;
	presentation: SubagentResultPresentation;
}

interface ResultStyle {
	title: (text: string) => string;
	name: (text: string) => string;
	metadata: (text: string) => string;
	hint: (text: string) => string;
	preview: (text: string) => string;
}

interface ResultMetrics {
	visibleWidth: (text: string) => number;
	truncateToWidth: (text: string, width: number, ellipsis?: string) => string;
	renderText: (text: string, width: number) => string[];
}

const METRICS: ResultMetrics = {
	visibleWidth,
	truncateToWidth,
	renderText: (text, width) => new Text(text, 0, 0).render(width),
};

const MAX_STORED_PREVIEW_CODE_POINTS = 2000;

const STATUS_COPY = {
	completed: "done",
	failed: "failed",
	stopped: "stopped",
} as const;

const PLAIN_STYLE: ResultStyle = {
	title: (text) => text,
	name: (text) => text,
	metadata: (text) => text,
	hint: (text) => text,
	preview: (text) => text,
};

function inline(text: string): string {
	return sanitizeDisplayText(text).replace(/\s+/g, " ").trim();
}

export function humanElapsed(totalSeconds: number): string {
	const seconds = Math.max(0, Math.floor(totalSeconds));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function resultPreview(text: string): string {
	return inline(text);
}

export function estimateResultTokens(text: string): number | undefined {
	const safeText = sanitizeDisplayText(text);
	if (safeText.trim() === "") return undefined;
	return estimateTokens({
		role: "custom",
		customType: "subagent_result_size",
		content: safeText,
		display: false,
		timestamp: 0,
	});
}

export function resultPresentation(
	status: SubagentResultStatus,
	elapsedSeconds: number,
	preview: string,
): SubagentResultPresentation {
	const normalizedPreview = resultPreview(preview);
	const codePoints = Array.from(normalizedPreview);
	return {
		version: 2,
		status,
		elapsedSeconds: Math.max(0, Math.floor(elapsedSeconds)),
		preview: codePoints.length > MAX_STORED_PREVIEW_CODE_POINTS
			? `${codePoints.slice(0, MAX_STORED_PREVIEW_CODE_POINTS).join("")}…`
			: normalizedPreview,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function optionalTokenCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
		? value
		: undefined;
}

function parseExpandedPresentation(value: unknown): SubagentExpandedResultPresentation | undefined {
	if (!isRecord(value) || value.version !== 1) return undefined;
	let response: SubagentResultContentRange | undefined;
	if (value.response !== undefined) {
		if (!isRecord(value.response)) return undefined;
		const start = value.response.start;
		const end = value.response.end;
		if (
			typeof start !== "number" ||
			typeof end !== "number" ||
			!Number.isInteger(start) ||
			!Number.isInteger(end) ||
			start < 0 ||
			end < start
		) return undefined;
		response = { start, end };
	}
	if (value.notice !== undefined && typeof value.notice !== "string") return undefined;
	if (value.failureReason !== undefined && typeof value.failureReason !== "string") return undefined;
	if (value.worktreeNote !== undefined && typeof value.worktreeNote !== "string") return undefined;
	return {
		version: 1,
		response,
		notice: value.notice,
		failureReason: value.failureReason,
		worktreeNote: value.worktreeNote,
	};
}

export function parseSubagentResultDetails(value: unknown): SubagentResultDetails | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return undefined;
	if (value.agent !== undefined && !isValidAgentIdentifier(value.agent)) return undefined;
	if (!isRecord(value.presentation)) return undefined;
	const presentation = value.presentation;
	if (presentation.version !== 2) return undefined;
	if (presentation.status !== "completed" && presentation.status !== "failed" && presentation.status !== "stopped") {
		return undefined;
	}
	if (
		typeof presentation.elapsedSeconds !== "number" ||
		!Number.isFinite(presentation.elapsedSeconds) ||
		presentation.elapsedSeconds < 0 ||
		typeof presentation.preview !== "string"
	) return undefined;
	const expanded = parseExpandedPresentation(value.expanded);
	if (expanded === undefined) return undefined;
	return {
		id: value.id,
		name: value.name,
		agent: value.agent,
		contextTokens: optionalTokenCount(value.contextTokens),
		resultTokens: optionalTokenCount(value.resultTokens),
		costUsd: typeof value.costUsd === "number" && Number.isFinite(value.costUsd) && value.costUsd >= 0
			? value.costUsd
			: undefined,
		sessionFile: typeof value.sessionFile === "string" ? value.sessionFile : undefined,
		expanded,
		presentation: {
			version: 2,
			status: presentation.status,
			elapsedSeconds: presentation.elapsedSeconds,
			preview: presentation.preview,
		},
	};
}

function availableWidth(width: number): number {
	if (!Number.isFinite(width) || width <= 0) return 0;
	return Math.floor(width);
}

function formatHeader(
	details: SubagentResultDetails,
	width: number,
	hint: string,
	metrics: ResultMetrics,
	style: ResultStyle,
): string {
	const status = STATUS_COPY[details.presentation.status];
	const name = inline(details.name);
	const agent = inline(details.agent ?? "") || "worker";
	const duration = humanElapsed(details.presentation.elapsedSeconds).replace(/\s+/g, "");
	const titleText = style.title("subagent result");
	const agentLead = style.metadata(" · ");
	const agentValue = style.metadata(agent);
	const agentTrail = style.metadata(" · ");
	const agentText = agentLead + agentValue + agentTrail;
	const prefix = titleText + agentText;
	const statusText = style.metadata(` · ${status} ${duration}`);
	const shortStatusText = style.metadata(` · ${status}`);
	const sizeParts: string[] = [];
	if (details.contextTokens !== undefined) sizeParts.push(`${formatTokens(details.contextTokens)} ctx`);
	if (details.resultTokens !== undefined) sizeParts.push(`~${formatTokens(details.resultTokens)} result`);
	const sizeText = sizeParts.length > 0 ? style.metadata(` · ${sizeParts.join(" · ")}`) : "";
	const hintText = hint ? style.metadata(" (") + style.hint(hint) + style.metadata(")") : "";
	const minimumNameWidth = Math.min(4, metrics.visibleWidth(name));

	function withFullAgent(suffixes: string[]): string | undefined {
		for (const suffix of suffixes) {
			const nameWidth = width - metrics.visibleWidth(prefix) - metrics.visibleWidth(suffix);
			if (nameWidth < minimumNameWidth) continue;
			const clippedName = metrics.truncateToWidth(style.name(name), nameWidth, "…");
			return metrics.truncateToWidth(`${prefix}${clippedName}${suffix}`, width, "");
		}
		return undefined;
	}

	function withClippedAgent(suffix: string): string | undefined {
		const fixedAgentWidth = metrics.visibleWidth(agentLead) + metrics.visibleWidth(agentTrail);
		const agentWidth = width - metrics.visibleWidth(titleText) - minimumNameWidth - metrics.visibleWidth(suffix);
		if (agentWidth <= fixedAgentWidth) return undefined;
		const clippedAgentValue = metrics.truncateToWidth(agentValue, agentWidth - fixedAgentWidth, "…");
		const clippedAgent = agentLead + clippedAgentValue + agentTrail;
		const nameWidth = Math.max(
			0,
			width - metrics.visibleWidth(titleText) - metrics.visibleWidth(clippedAgent) - metrics.visibleWidth(suffix),
		);
		return metrics.truncateToWidth(
			`${titleText}${clippedAgent}${metrics.truncateToWidth(style.name(name), nameWidth, "…")}${suffix}`,
			width,
			"",
		);
	}

	if (sizeText) {
		const sized = withFullAgent(hintText
			? [statusText + sizeText + hintText, statusText + sizeText, shortStatusText + sizeText]
			: [statusText + sizeText, shortStatusText + sizeText]);
		if (sized !== undefined) return sized;
		const clippedSized = withClippedAgent(shortStatusText + sizeText);
		if (clippedSized !== undefined) return clippedSized;
	}

	const unsized = withFullAgent(sizeText
		? [statusText, shortStatusText]
		: hintText
			? [statusText + hintText, statusText, shortStatusText]
			: [statusText, shortStatusText]);
	if (unsized !== undefined) return unsized;
	const clipped = withClippedAgent(shortStatusText);
	if (clipped !== undefined) return clipped;

	const statusOnly = `${titleText}${style.metadata(` ${status}`)}`;
	if (metrics.visibleWidth(statusOnly) <= width) return statusOnly;
	return metrics.truncateToWidth(`${style.title("subagent")}${style.metadata(` ${status}`)}`, width, "");
}

export function formatCollapsedSubagentResult(
	details: SubagentResultDetails,
	width: number,
	previewLineLimit: number,
	hint: string,
	metrics: ResultMetrics = METRICS,
	style: ResultStyle = PLAIN_STYLE,
): string[] {
	const maxWidth = availableWidth(width);
	if (maxWidth === 0) return [];
	const lines = [formatHeader(details, maxWidth, hint, metrics, style)];
	if (maxWidth <= 2 || previewLineLimit === 0) return lines;

	const preview = resultPreview(details.presentation.preview);
	if (!preview) return lines;
	const visualLines = metrics.renderText(preview, maxWidth).map((line) => line.trimEnd());
	const shown = visualLines.slice(0, previewLineLimit);
	if (visualLines.length > previewLineLimit && shown.length > 0) {
		const last = shown.length - 1;
		shown[last] = metrics.truncateToWidth(`${shown[last]}…`, maxWidth, "…");
	}
	lines.push("");
	for (const line of shown) {
		lines.push(metrics.truncateToWidth(style.preview(line), maxWidth, ""));
	}
	return lines;
}

function safeMarkdown(text: string): string {
	return sanitizeDisplayText(text).replace(/\r\n?/g, "\n");
}

function messageText(content: unknown): string {
	if (typeof content === "string") return safeMarkdown(content);
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text: string } =>
			isRecord(part) && part.type === "text" && typeof part.text === "string")
		.map((part) => safeMarkdown(part.text))
		.join("\n");
}

function widthSafe(component: Component): Component {
	return {
		invalidate(): void {
			component.invalidate();
		},
		render(width: number): string[] {
			const maxWidth = availableWidth(width);
			if (maxWidth === 0) return [];
			return component.render(maxWidth).map((line) => truncateToWidth(line, maxWidth, ""));
		},
	};
}

function nativeMessageShell(component: Component, background: (text: string) => string): Component {
	const box = new Box(1, 1, background);
	box.addChild(component);
	return widthSafe(box);
}

function structuredExpandedResult(
	details: SubagentResultDetails,
	content: string,
	style: ResultStyle,
	output: (text: string) => string,
	accent: (text: string) => string,
): Component | undefined {
	const expanded = details.expanded;
	if (expanded === undefined) return undefined;
	let response: string | undefined;
	if (expanded.response !== undefined) {
		if (expanded.response.end > content.length) return undefined;
		response = safeMarkdown(content.slice(expanded.response.start, expanded.response.end));
	}
	const markdown = response
		? new Markdown(response, 0, 0, getMarkdownTheme(), { color: output })
		: undefined;

	return {
		invalidate(): void {
			markdown?.invalidate();
		},
		render(width: number): string[] {
			const maxWidth = availableWidth(width);
			if (maxWidth === 0) return [];
			const lines = [formatHeader(details, maxWidth, "", METRICS, style)];
			const appendText = (text: string): void => {
				if (lines.at(-1) !== "") lines.push("");
				lines.push(...new Text(text, 0, 0).render(maxWidth));
			};

			if (expanded.notice) appendText(output(safeMarkdown(expanded.notice)));
			if (expanded.failureReason) {
				appendText(style.metadata("failure · ") + output(safeMarkdown(expanded.failureReason)));
			}
			if (markdown) {
				if (lines.at(-1) !== "") lines.push("");
				if (details.presentation.status === "failed") lines.push(style.metadata("last output"));
				lines.push(...markdown.render(maxWidth));
			}

			const footer: string[] = [];
			if (details.costUsd !== undefined) footer.push(style.metadata(`cost this run ${formatCost(details.costUsd)}`));
			if (details.sessionFile) {
				footer.push(style.metadata("session ") + accent(sanitizeDisplayText(details.sessionFile)));
			}
			const action = details.presentation.status === "failed" ? "retry" : "resume";
			const message = details.presentation.status === "failed" ? "<guidance>" : "...";
			footer.push(
				style.metadata(`${action} `) +
				accent(`subagent_resume({ id: "${sanitizeDisplayText(details.id)}", message: "${message}" })`),
			);
			if (expanded.worktreeNote) footer.push(style.metadata(safeMarkdown(expanded.worktreeNote)));
			if (footer.length > 0) appendText(footer.join("\n"));
			return lines.map((line) => truncateToWidth(line, maxWidth, ""));
		},
	};
}

export function registerSubagentResultRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("subagent_result", (message, { expanded }, theme) => {
		const details = parseSubagentResultDetails(message.details);
		if (details === undefined) return undefined;
		const background = details.presentation.status === "completed" ? "toolSuccessBg" : "toolErrorBg";
		const shell = (component: Component): Component =>
			nativeMessageShell(component, (text) => theme.bg(background, text));
		const style: ResultStyle = {
			title: (text) => theme.fg("toolTitle", theme.bold(text)),
			name: (text) => theme.fg("accent", text),
			metadata: (text) => theme.fg("muted", text),
			hint: (text) => theme.fg("dim", text),
			preview: (text) => theme.fg("dim", text),
		};
		if (expanded) {
			if (typeof message.content === "string") {
				const structured = structuredExpandedResult(
					details,
					message.content,
					style,
					(text) => theme.fg("toolOutput", text),
					(text) => theme.fg("accent", text),
				);
				if (structured !== undefined) return shell(structured);
			}
			return shell(new Markdown(
				messageText(message.content),
				0,
				0,
				getMarkdownTheme(),
				{ color: (text) => theme.fg("toolOutput", text) },
			));
		}

		const hint = keyText("app.tools.expand");
		return shell({
			invalidate(): void {},
			render(width: number): string[] {
				return formatCollapsedSubagentResult(
					details,
					width,
					config.resultPreviewLines,
					hint,
					METRICS,
					style,
				);
			},
		});
	});
}
