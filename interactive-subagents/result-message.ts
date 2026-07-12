import { getMarkdownTheme, keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { sanitizeDisplayText } from "./display-text.ts";

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
	presentation: SubagentResultPresentation;
}

interface ResultStyle {
	status: (status: SubagentResultStatus, text: string) => string;
	text: (text: string) => string;
	name: (text: string) => string;
	agent: (text: string) => string;
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
	completed: { icon: "✓", verb: "completed", timing: "in", color: "success" },
	failed: { icon: "✗", verb: "failed", timing: "after", color: "error" },
	stopped: { icon: "■", verb: "was stopped", timing: "after", color: "warning" },
} as const;

const PLAIN_STYLE: ResultStyle = {
	status: (_status, text) => text,
	text: (text) => text,
	name: (text) => text,
	agent: (text) => text,
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
	const status = details.presentation.status;
	const copy = STATUS_COPY[status];
	const name = inline(details.name);
	const agent = details.agent === undefined ? undefined : inline(details.agent);
	const duration = humanElapsed(details.presentation.elapsedSeconds);
	const icon = style.status(status, copy.icon);
	const verb = style.status(status, copy.verb);
	const variants = [
		{ agent: true, duration: true, hint: true },
		{ agent: true, duration: true, hint: false },
		{ agent: false, duration: true, hint: false },
		{ agent: false, duration: false, hint: false },
	];

	for (const variant of variants) {
		const agentText = variant.agent && agent !== undefined ? ` ${style.agent(`[${agent}]`)}` : "";
		const durationText = variant.duration ? style.text(` ${copy.timing} ${duration}`) : "";
		const hintText = variant.hint && hint ? style.text(" · ") + hint : "";
		const prefix = `${icon}${style.text(' Sub-agent "')}`;
		const suffix = `${style.text('"')}${agentText}${style.text(" ")}${verb}${durationText}${hintText}`;
		const nameWidth = width - metrics.visibleWidth(prefix) - metrics.visibleWidth(suffix);
		const minimumNameWidth = Math.min(4, metrics.visibleWidth(name));
		if (nameWidth < minimumNameWidth) continue;
		const clippedName = metrics.truncateToWidth(style.name(name), nameWidth, "…");
		return metrics.truncateToWidth(`${prefix}${clippedName}${suffix}`, width, "");
	}

	return metrics.truncateToWidth(`${icon}${style.text(" ")}${verb}`, width, "");
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
	const previewWidth = maxWidth - 2;
	const visualLines = metrics.renderText(preview, previewWidth).map((line) => line.trimEnd());
	const shown = visualLines.slice(0, 2);
	if (visualLines.length > 2 && shown.length === 2) {
		shown[1] = metrics.truncateToWidth(`${shown[1]}…`, previewWidth, "…");
	}
	for (const line of shown) {
		lines.push(metrics.truncateToWidth(style.preview(`  ${line}`), maxWidth, ""));
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

export function registerSubagentResultRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("subagent_result", (message, { expanded }, theme) => {
		const details = parseSubagentResultDetails(message.details);
		if (details === undefined) return undefined;
		if (expanded) {
			return widthSafe(new Markdown(
				messageText(message.content),
				0,
				0,
				getMarkdownTheme(),
				{ color: (text) => theme.fg("customMessageText", text) },
			));
		}

		const hint = keyHint("app.tools.expand", "to expand");
		const style: ResultStyle = {
			status: (status, text) => theme.fg(STATUS_COPY[status].color, text),
			text: (text) => theme.fg("customMessageText", text),
			name: (text) => theme.fg("customMessageText", theme.bold(text)),
			agent: (text) => theme.fg("accent", text),
			preview: (text) => theme.fg("dim", text),
		};
		return {
			invalidate(): void {},
			render(width: number): string[] {
				return formatCollapsedSubagentResult(details, width, hint, METRICS, style);
			},
		};
	});
}
