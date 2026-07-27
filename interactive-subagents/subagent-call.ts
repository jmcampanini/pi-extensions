import { sanitizeDisplayText } from "./display-text.ts";

interface SubagentCallArgs {
	name?: string;
	task?: string;
	agent?: string;
	model?: string;
	effectiveModel?: string | null;
	modelPending?: boolean;
	modelUnknown?: boolean;
	context?: "new" | "forked";
	autoExit?: boolean;
	useWorktree?: boolean;
	harness?: string;
}

interface SubagentResumeCallArgs {
	name?: string;
	message?: string;
	agent?: string;
}

interface SubagentActionArgs {
	action: "spawn" | "resume";
	name?: string;
	agent?: string;
	body?: string;
	emptyBody?: string;
	metadata?: string;
}

interface SubagentCallStyle {
	title?: (text: string) => string;
	name?: (text: string) => string;
	agent?: (text: string) => string;
	hint?: (text: string) => string;
	preview?: (text: string) => string;
	metadata?: (text: string) => string;
	body?: (text: string) => string;
}

interface SubagentCallTextMetrics {
	visibleWidth: (text: string) => number;
	fitText: (text: string, maxWidth: number, ellipsis?: string) => string;
	clampStyled: (line: string, maxWidth: number) => string;
	renderText: (text: string, width: number) => string[];
}

const EMPTY_RESUME_MESSAGE = "No follow-up message.";
const plainText = (text: string): string => text;

function spawnActionArgs(args: SubagentCallArgs): SubagentActionArgs {
	const modes: string[] = [];
	const model = args.effectiveModel === undefined ? args.model : args.effectiveModel;
	if (args.modelPending) modes.push("model resolving");
	else if (args.modelUnknown) modes.push("model unknown");
	else if (model) modes.push(`model ${normalizedInline(model)}`);
	else if (args.harness && args.harness !== "pi") modes.push("model harness default");
	else modes.push("inherits model");
	if (args.context) modes.push(`context ${args.context}`);
	if (args.autoExit === false) modes.push("interactive");
	if (args.useWorktree) modes.push("worktree");
	if (args.harness && args.harness !== "pi") modes.push(`harness ${normalizedInline(args.harness)}`);
	return {
		action: "spawn",
		name: args.name,
		agent: args.agent,
		body: args.task,
		metadata: modes.length > 0 ? modes.join(" · ") : undefined,
	};
}

function resumeActionArgs(args: SubagentResumeCallArgs): SubagentActionArgs {
	return {
		action: "resume",
		name: args.name,
		agent: args.agent,
		body: args.message,
		emptyBody: EMPTY_RESUME_MESSAGE,
	};
}

function normalizedInline(value: string | undefined): string {
	return sanitizeDisplayText(value ?? "").replace(/\s+/g, " ").trim();
}

function agentName(value: string | undefined): string {
	return value === undefined ? "worker" : normalizedInline(value);
}

function formatHeading(args: SubagentActionArgs, style: SubagentCallStyle): string {
	const title = style.title ?? plainText;
	const nameStyle = style.name ?? plainText;
	const agentStyle = style.agent ?? plainText;
	const name = normalizedInline(args.name);
	let heading = title(`subagent ${args.action}`) + agentStyle(` · ${agentName(args.agent)}`);
	if (name) heading += agentStyle(" · ") + nameStyle(name);
	return heading;
}

function formatCollapsedHeading(
	args: SubagentActionArgs,
	style: SubagentCallStyle,
	width: number,
	metrics: SubagentCallTextMetrics,
): string {
	const title = style.title ?? plainText;
	const nameStyle = style.name ?? plainText;
	const agentStyle = style.agent ?? plainText;
	const name = normalizedInline(args.name);
	const agent = agentName(args.agent);
	const titleText = title(`subagent ${args.action}`);
	const titleWidth = metrics.visibleWidth(titleText);
	const separatorsWidth = metrics.visibleWidth(" · ") * 2;
	const minimumNameWidth = Math.min(4, metrics.visibleWidth(name));

	const nameWidth = width - titleWidth - separatorsWidth - metrics.visibleWidth(agent);
	if (nameWidth >= minimumNameWidth) {
		return titleText + agentStyle(" · ") + agentStyle(agent) + agentStyle(" · ")
			+ nameStyle(metrics.fitText(name, nameWidth));
	}

	const agentWidth = width - titleWidth - separatorsWidth - minimumNameWidth;
	if (agentWidth > 0) {
		return titleText + agentStyle(" · ") + agentStyle(metrics.fitText(agent, agentWidth))
			+ agentStyle(" · ") + nameStyle(metrics.fitText(name, minimumNameWidth));
	}

	const fallbackNameWidth = width - titleWidth - metrics.visibleWidth(" · ");
	const nameFallback = name && fallbackNameWidth > 0
		? agentStyle(" · ") + nameStyle(metrics.fitText(name, fallbackNameWidth))
		: "";
	return metrics.clampStyled(`${titleText}${nameFallback}`, width);
}

function availableWidth(width: number): number {
	if (Number.isNaN(width) || width <= 0) return 0;
	return Math.floor(width);
}

function normalizedBody(value: string | undefined): string {
	return sanitizeDisplayText(value ?? "").replace(/\r\n?/g, "\n");
}

function displayedBody(args: SubagentActionArgs): string {
	const body = normalizedBody(args.body);
	return normalizedInline(body) ? body : (args.emptyBody ?? body);
}

function bodyHasHiddenDetail(
	args: SubagentActionArgs,
	width: number,
	previewLineLimit: number,
	metrics: SubagentCallTextMetrics,
): boolean {
	const body = normalizedBody(args.body);
	const preview = normalizedInline(args.body);
	if (!preview) return false;
	const fullLines = metrics.renderText(body, width).map((line) => line.trimEnd());
	const previewLines = metrics
		.renderText(preview, width)
		.slice(0, previewLineLimit)
		.map((line) => line.trimEnd());
	return fullLines.length !== previewLines.length || fullLines.some((line, index) => line !== previewLines[index]);
}

function expandedContent(args: SubagentActionArgs, style: SubagentCallStyle): string {
	const body = style.body ?? plainText;
	const metadata = args.metadata ? `\n${(style.metadata ?? plainText)(args.metadata)}` : "";
	return `${formatHeading(args, style)}${metadata}\n\n${body(displayedBody(args))}`;
}

function formatCollapsedSubagentAction(
	args: SubagentActionArgs,
	width: number,
	previewLineLimit: number,
	metrics: SubagentCallTextMetrics,
	style: SubagentCallStyle,
	expandHint: string,
): string[] {
	const maxWidth = availableWidth(width);
	if (maxWidth === 0) return [];
	const heading = metrics.clampStyled(
		metrics.renderText(formatCollapsedHeading(args, style, maxWidth, metrics), maxWidth)[0] ?? "",
		maxWidth,
	);
	const metadataLines = args.metadata
		? metrics.renderText((style.metadata ?? plainText)(args.metadata), maxWidth)
			.map((line) => metrics.clampStyled(line, maxWidth))
		: [];
	const lines = [heading, ...metadataLines];
	if (previewLineLimit > 0) {
		const preview = normalizedInline(args.body) || args.emptyBody || "";
		if (preview !== "") {
			const visualLines = metrics.renderText(preview, maxWidth).map((line) => line.trimEnd());
			const shown = visualLines.slice(0, previewLineLimit);
			if (visualLines.length > previewLineLimit && shown.length > 0) {
				const last = shown.length - 1;
				shown[last] = metrics.fitText(`${shown[last]}…`, maxWidth);
			}
			lines.push("", ...shown.map((line) => metrics.clampStyled((style.preview ?? plainText)(line), maxWidth)));
		}
	}
	if (expandHint && bodyHasHiddenDetail(args, maxWidth, previewLineLimit, metrics)) {
		lines.push("", metrics.clampStyled((style.hint ?? plainText)(`(${expandHint} to expand)`), maxWidth));
	}
	return lines;
}

function formatExpandedSubagentAction(
	args: SubagentActionArgs,
	width: number,
	metrics: SubagentCallTextMetrics,
	style: Pick<SubagentCallStyle, "title" | "name" | "agent" | "metadata" | "body">,
): string[] {
	const maxWidth = availableWidth(width);
	if (maxWidth === 0) return [];
	return metrics
		.renderText(expandedContent(args, style), maxWidth)
		.map((line) => metrics.clampStyled(line, maxWidth));
}

export function formatCollapsedSubagentCall(
	args: SubagentCallArgs,
	width: number,
	previewLineLimit: number,
	metrics: SubagentCallTextMetrics,
	style: SubagentCallStyle = {},
	expandHint = "",
): string[] {
	return formatCollapsedSubagentAction(spawnActionArgs(args), width, previewLineLimit, metrics, style, expandHint);
}

export function formatExpandedSubagentCall(
	args: SubagentCallArgs,
	width: number,
	metrics: SubagentCallTextMetrics,
	style: Pick<SubagentCallStyle, "title" | "name" | "agent" | "metadata" | "body"> = {},
): string[] {
	return formatExpandedSubagentAction(spawnActionArgs(args), width, metrics, style);
}

export function formatCollapsedSubagentResumeCall(
	args: SubagentResumeCallArgs,
	width: number,
	previewLineLimit: number,
	metrics: SubagentCallTextMetrics,
	style: SubagentCallStyle = {},
	expandHint = "",
): string[] {
	return formatCollapsedSubagentAction(resumeActionArgs(args), width, previewLineLimit, metrics, style, expandHint);
}

export function formatExpandedSubagentResumeCall(
	args: SubagentResumeCallArgs,
	width: number,
	metrics: SubagentCallTextMetrics,
	style: Pick<SubagentCallStyle, "title" | "name" | "agent" | "metadata" | "body"> = {},
): string[] {
	return formatExpandedSubagentAction(resumeActionArgs(args), width, metrics, style);
}
