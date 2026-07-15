import { sanitizeDisplayText } from "./display-text.ts";

interface SubagentCallArgs {
	name?: string;
	task?: string;
	agent?: string;
}

interface SubagentCallStyle {
	title?: (text: string) => string;
	name?: (text: string) => string;
	agent?: (text: string) => string;
	hint?: (text: string) => string;
	preview?: (text: string) => string;
	body?: (text: string) => string;
}

interface SubagentCallTextMetrics {
	visibleWidth: (text: string) => number;
	truncateToWidth: (text: string, width: number, ellipsis: string) => string;
	renderText: (text: string, width: number) => string[];
}

const plainText = (text: string): string => text;

function normalizedInline(value: string | undefined): string {
	return sanitizeDisplayText(value ?? "").replace(/\s+/g, " ").trim();
}

function agentName(value: string | undefined): string {
	return normalizedInline(value) || "worker";
}

function formatHeading(args: SubagentCallArgs, style: SubagentCallStyle): string {
	const title = style.title ?? plainText;
	const nameStyle = style.name ?? plainText;
	const agentStyle = style.agent ?? plainText;
	const name = normalizedInline(args.name);
	let heading = title("subagent");
	if (name) heading += ` ${nameStyle(name)}`;
	heading += agentStyle(` · ${agentName(args.agent)}`);
	return heading;
}

function formatCollapsedHeading(
	args: SubagentCallArgs,
	style: SubagentCallStyle,
	width: number,
	metrics: SubagentCallTextMetrics,
	hint: string,
): string {
	const title = style.title ?? plainText;
	const nameStyle = style.name ?? plainText;
	const agentStyle = style.agent ?? plainText;
	const hintStyle = style.hint ?? plainText;
	const name = normalizedInline(args.name);
	const prefix = `${title("subagent")} `;
	const agent = agentStyle(` · ${agentName(args.agent)}`);
	const hintText = hint ? hintStyle(" (") + hint + hintStyle(")") : "";
	const minimumNameWidth = Math.min(4, metrics.visibleWidth(name));

	for (const suffix of hintText ? [agent + hintText, agent] : [agent]) {
		const nameWidth = width - metrics.visibleWidth(prefix) - metrics.visibleWidth(suffix);
		if (nameWidth < minimumNameWidth) continue;
		return metrics.truncateToWidth(
			`${prefix}${metrics.truncateToWidth(nameStyle(name), nameWidth, "…")}${suffix}`,
			width,
			"",
		);
	}

	const agentWidth = Math.max(0, width - metrics.visibleWidth(prefix) - minimumNameWidth);
	const clippedAgent = metrics.truncateToWidth(agent, agentWidth, "…");
	const nameWidth = Math.max(0, width - metrics.visibleWidth(prefix) - metrics.visibleWidth(clippedAgent));
	const heading = `${prefix}${metrics.truncateToWidth(nameStyle(name), nameWidth, "…")}${clippedAgent}`;
	return metrics.truncateToWidth(heading, width, "");
}

function availableWidth(width: number): number {
	if (Number.isNaN(width) || width <= 0) return 0;
	return Math.floor(width);
}

function normalizedTask(value: string | undefined): string {
	return sanitizeDisplayText(value ?? "").replace(/\r\n?/g, "\n");
}

function taskHasHiddenDetail(args: SubagentCallArgs, width: number, metrics: SubagentCallTextMetrics): boolean {
	const task = normalizedTask(args.task);
	const preview = normalizedInline(args.task);
	const fullLines = metrics.renderText(task, width).map((line) => line.trimEnd());
	const previewLines = metrics.renderText(preview, width).map((line) => line.trimEnd());
	return fullLines.length !== 1 || previewLines.length !== 1 || fullLines[0] !== previewLines[0];
}

function expandedContent(args: SubagentCallArgs, style: SubagentCallStyle): string {
	const body = style.body ?? plainText;
	return `${formatHeading(args, style)}\n\n${body(normalizedTask(args.task))}`;
}

export function formatCollapsedSubagentCall(
	args: SubagentCallArgs,
	width: number,
	metrics: SubagentCallTextMetrics,
	style: SubagentCallStyle = {},
	expandHint = "",
): string[] {
	const maxWidth = availableWidth(width);
	if (maxWidth === 0) return [];
	const hint = taskHasHiddenDetail(args, maxWidth, metrics) ? expandHint : "";
	const heading = formatCollapsedHeading(args, style, maxWidth, metrics, hint);
	const preview = (style.preview ?? plainText)(normalizedInline(args.task));
	const firstLine = (text: string): string =>
		metrics.truncateToWidth(metrics.renderText(text, maxWidth)[0] ?? "", maxWidth, "");
	return [firstLine(heading), "", firstLine(preview)];
}

export function formatExpandedSubagentCall(
	args: SubagentCallArgs,
	width: number,
	metrics: SubagentCallTextMetrics,
	style: Pick<SubagentCallStyle, "title" | "name" | "agent" | "body"> = {},
): string[] {
	const maxWidth = availableWidth(width);
	if (maxWidth === 0) return [];
	return metrics
		.renderText(expandedContent(args, style), maxWidth)
		.map((line) => metrics.truncateToWidth(line, maxWidth, ""));
}
