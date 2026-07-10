interface SubagentCallArgs {
	name?: string;
	task?: string;
	agent?: string;
}

interface SubagentCallStyle {
	title?: (text: string) => string;
	agent?: (text: string) => string;
	name?: (text: string) => string;
	preview?: (text: string) => string;
}

interface SubagentCallTextMetrics {
	truncateToWidth: (text: string, width: number, ellipsis: string) => string;
	renderText: (text: string, width: number) => string[];
}

const plainText = (text: string): string => text;

function normalizedInline(value: string | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

function formatHeading(args: SubagentCallArgs, style: SubagentCallStyle): string {
	const title = style.title ?? plainText;
	const agentStyle = style.agent ?? plainText;
	const nameStyle = style.name ?? plainText;
	const agent = args.agent === undefined ? "worker" : normalizedInline(args.agent);
	const name = normalizedInline(args.name);
	return title("Subagent") + " " + agentStyle(`[${agent}]`) + " " + nameStyle(name);
}

function availableWidth(width: number): number {
	if (Number.isNaN(width) || width <= 0) return 0;
	return Math.floor(width);
}

function expandedContent(args: SubagentCallArgs, style: SubagentCallStyle): string {
	const task = (args.task ?? "").replace(/\r\n?/g, "\n");
	return `${formatHeading(args, style)}\n\n${task}`;
}

export function formatCollapsedSubagentCall(
	args: SubagentCallArgs,
	width: number,
	metrics: SubagentCallTextMetrics,
	style: SubagentCallStyle = {},
): string[] {
	const maxWidth = availableWidth(width);
	if (maxWidth === 0) return [];
	const heading = formatHeading(args, style);
	const preview = (style.preview ?? plainText)(normalizedInline(args.task));
	const firstLine = (text: string): string =>
		metrics.truncateToWidth(metrics.renderText(text, maxWidth)[0] ?? "", maxWidth, "");
	return [firstLine(heading), "", firstLine(preview)];
}

export function formatExpandedSubagentCall(
	args: SubagentCallArgs,
	width: number,
	metrics: SubagentCallTextMetrics,
	style: Pick<SubagentCallStyle, "title" | "agent" | "name"> = {},
): string[] {
	const maxWidth = availableWidth(width);
	if (maxWidth === 0) return [];
	return metrics
		.renderText(expandedContent(args, style), maxWidth)
		.map((line) => metrics.truncateToWidth(line, maxWidth, ""));
}
