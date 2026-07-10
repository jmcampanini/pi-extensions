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

function normalizedInline(value: string | undefined, fallback: string): string {
	return value?.replace(/\s+/g, " ").trim() || fallback;
}

function identity(args: SubagentCallArgs): { agent: string; name: string } {
	return {
		agent: args.agent === undefined ? "worker" : args.agent.replace(/\s+/g, " ").trim(),
		name: normalizedInline(args.name, ""),
	};
}

function availableWidth(width: number): number {
	if (Number.isNaN(width) || width <= 0) return 0;
	return Math.floor(width);
}

function expandedContent(args: SubagentCallArgs, style: SubagentCallStyle): string {
	const title = style.title ?? ((text: string) => text);
	const agentStyle = style.agent ?? ((text: string) => text);
	const nameStyle = style.name ?? ((text: string) => text);
	const callIdentity = identity(args);
	const heading =
		title("Subagent") + " " + agentStyle(`[${callIdentity.agent}]`) + " " + nameStyle(callIdentity.name);
	const task = (args.task ?? "").replace(/\r\n?|\n/g, "\n");
	return `${heading}\n\n${task}`;
}

export function formatCollapsedSubagentCall(
	args: SubagentCallArgs,
	width: number,
	metrics: SubagentCallTextMetrics,
	style: SubagentCallStyle = {},
): string[] {
	const maxWidth = availableWidth(width);
	if (maxWidth === 0) return [];
	const title = style.title ?? ((text: string) => text);
	const agentStyle = style.agent ?? ((text: string) => text);
	const nameStyle = style.name ?? ((text: string) => text);
	const previewStyle = style.preview ?? ((text: string) => text);
	const callIdentity = identity(args);
	const heading = title("Subagent") + " " + agentStyle(`[${callIdentity.agent}]`) + " " + nameStyle(callIdentity.name);
	const preview = previewStyle(normalizedInline(args.task, ""));
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
