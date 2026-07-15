import { estimateTokens, getMarkdownTheme, keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { sanitizeDisplayText } from "./display-text.ts";
import { formatTokens } from "./widget.ts";

export type SubagentResultStatus = "completed" | "failed" | "stopped";

export interface SubagentResultPresentation {
	version: 1;
	status: SubagentResultStatus;
	elapsedSeconds: number;
	preview: string;
}

export interface SubagentResultDetails {
	id: string;
	name: string;
	agent?: string;
	contextTokens?: number;
	resultTokens?: number;
	presentation: SubagentResultPresentation;
}

interface ResultStyle {
	title: (text: string) => string;
	name: (text: string) => string;
	metadata: (text: string) => string;
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
	completed: { verb: "completed", timing: "in" },
	failed: { verb: "failed", timing: "after" },
	stopped: { verb: "stopped", timing: "after" },
} as const;

const PLAIN_STYLE: ResultStyle = {
	title: (text) => text,
	name: (text) => text,
	metadata: (text) => text,
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
		version: 1,
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

export function parseSubagentResultDetails(value: unknown): SubagentResultDetails | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return undefined;
	if (value.agent !== undefined && typeof value.agent !== "string") return undefined;
	if (!isRecord(value.presentation)) return undefined;
	const presentation = value.presentation;
	if (presentation.version !== 1) return undefined;
	if (presentation.status !== "completed" && presentation.status !== "failed" && presentation.status !== "stopped") {
		return undefined;
	}
	if (
		typeof presentation.elapsedSeconds !== "number" ||
		!Number.isFinite(presentation.elapsedSeconds) ||
		presentation.elapsedSeconds < 0 ||
		typeof presentation.preview !== "string"
	) return undefined;
	return {
		id: value.id,
		name: value.name,
		agent: value.agent,
		contextTokens: optionalTokenCount(value.contextTokens),
		resultTokens: optionalTokenCount(value.resultTokens),
		presentation: {
			version: 1,
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
	const copy = STATUS_COPY[details.presentation.status];
	const name = inline(details.name);
	const agent = inline(details.agent ?? "") || "worker";
	const duration = humanElapsed(details.presentation.elapsedSeconds);
	const titleText = style.title("subagent result");
	const agentLead = style.metadata(" · ");
	const agentValue = style.metadata(agent);
	const agentTrail = style.metadata(" · ");
	const agentText = agentLead + agentValue + agentTrail;
	const prefix = titleText + agentText;
	const statusText = style.metadata(` · ${copy.verb} ${copy.timing} ${duration}`);
	const shortStatusText = style.metadata(` · ${copy.verb}`);
	const sizeParts: string[] = [];
	if (details.contextTokens !== undefined) sizeParts.push(`context ${formatTokens(details.contextTokens)}`);
	if (details.resultTokens !== undefined) sizeParts.push(`result ~${formatTokens(details.resultTokens)}`);
	const sizeText = sizeParts.length > 0 ? style.metadata(` · ${sizeParts.join(" · ")}`) : "";
	const hintText = hint ? style.metadata(" (") + hint + style.metadata(")") : "";
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

	const statusOnly = `${titleText}${style.metadata(` ${copy.verb}`)}`;
	if (metrics.visibleWidth(statusOnly) <= width) return statusOnly;
	return metrics.truncateToWidth(`${style.title("subagent")}${style.metadata(` ${copy.verb}`)}`, width, "");
}

export function formatCollapsedSubagentResult(
	details: SubagentResultDetails,
	width: number,
	hint: string,
	metrics: ResultMetrics = METRICS,
	style: ResultStyle = PLAIN_STYLE,
): string[] {
	const maxWidth = availableWidth(width);
	if (maxWidth === 0) return [];
	const lines = [formatHeader(details, maxWidth, hint, metrics, style)];
	if (maxWidth <= 2) return lines;

	const preview = resultPreview(details.presentation.preview);
	if (!preview) return lines;
	const visualLines = metrics.renderText(preview, maxWidth).map((line) => line.trimEnd());
	const shown = visualLines.slice(0, 2);
	if (visualLines.length > 2 && shown.length === 2) {
		shown[1] = metrics.truncateToWidth(`${shown[1]}…`, maxWidth, "…");
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

export function registerSubagentResultRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("subagent_result", (message, { expanded }, theme) => {
		const details = parseSubagentResultDetails(message.details);
		if (details === undefined) return undefined;
		const background = details.presentation.status === "completed" ? "toolSuccessBg" : "toolErrorBg";
		const shell = (component: Component): Component =>
			nativeMessageShell(component, (text) => theme.bg(background, text));
		if (expanded) {
			return shell(new Markdown(
				messageText(message.content),
				0,
				0,
				getMarkdownTheme(),
				{ color: (text) => theme.fg("toolOutput", text) },
			));
		}

		const hint = keyHint("app.tools.expand", "to expand");
		const style: ResultStyle = {
			title: (text) => theme.fg("toolTitle", theme.bold(text)),
			name: (text) => theme.fg("accent", text),
			metadata: (text) => theme.fg("muted", text),
			preview: (text) => theme.fg("dim", text),
		};
		return shell({
			invalidate(): void {},
			render(width: number): string[] {
				return formatCollapsedSubagentResult(details, width, hint, METRICS, style);
			},
		});
	});
}
