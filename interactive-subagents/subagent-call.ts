import { sanitizeDisplayText } from "./display-text.ts";

interface SubagentCallArgs {
	name?: string;
	task?: string;
	agent?: string;
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

const EMPTY_RESUME_MESSAGE = "No follow-up message.";
const plainText = (text: string): string => text;

function spawnActionArgs(args: SubagentCallArgs): SubagentActionArgs {
	return { action: "spawn", name: args.name, agent: args.agent, body: args.task };
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
	return normalizedInline(value) || "worker";
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
	hint: string,
): string {
	const title = style.title ?? plainText;
	const nameStyle = style.name ?? plainText;
	const agentStyle = style.agent ?? plainText;
	const hintStyle = style.hint ?? plainText;
	const name = normalizedInline(args.name);
	const titleText = title(`subagent ${args.action}`);
	const agentLead = agentStyle(" · ");
	const agentValue = agentStyle(agentName(args.agent));
	const agentTrail = agentStyle(" · ");
	const agentText = agentLead + agentValue + agentTrail;
	const prefix = titleText + agentText;
	const hintText = hint ? hintStyle(" (") + hint + hintStyle(")") : "";
	const minimumNameWidth = Math.min(4, metrics.visibleWidth(name));

	for (const suffix of hintText ? [hintText, ""] : [""]) {
		const nameWidth = width - metrics.visibleWidth(prefix) - metrics.visibleWidth(suffix);
		if (nameWidth < minimumNameWidth) continue;
		return metrics.truncateToWidth(
			`${prefix}${metrics.truncateToWidth(nameStyle(name), nameWidth, "…")}${suffix}`,
			width,
			"",
		);
	}

	const fixedAgentWidth = metrics.visibleWidth(agentLead) + metrics.visibleWidth(agentTrail);
	const agentWidth = Math.max(0, width - metrics.visibleWidth(titleText) - minimumNameWidth);
	if (agentWidth > fixedAgentWidth) {
		const clippedAgentValue = metrics.truncateToWidth(agentValue, agentWidth - fixedAgentWidth, "…");
		const clippedAgent = agentLead + clippedAgentValue + agentTrail;
		const nameWidth = Math.max(0, width - metrics.visibleWidth(titleText) - metrics.visibleWidth(clippedAgent));
		const heading = `${titleText}${clippedAgent}${metrics.truncateToWidth(nameStyle(name), nameWidth, "…")}`;
		return metrics.truncateToWidth(heading, width, "");
	}

	const nameFallback = name ? agentStyle(" · ") + nameStyle(name) : "";
	return metrics.truncateToWidth(`${titleText}${nameFallback}`, width, "");
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
	return `${formatHeading(args, style)}\n\n${body(displayedBody(args))}`;
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
	const hint = bodyHasHiddenDetail(args, maxWidth, previewLineLimit, metrics) ? expandHint : "";
	const heading = metrics.truncateToWidth(
		metrics.renderText(formatCollapsedHeading(args, style, maxWidth, metrics, hint), maxWidth)[0] ?? "",
		maxWidth,
		"",
	);
	if (previewLineLimit === 0) return [heading];
	const preview = (style.preview ?? plainText)(normalizedInline(args.body) || args.emptyBody || "");
	const previewLines = metrics
		.renderText(preview, maxWidth)
		.slice(0, previewLineLimit)
		.map((line) => metrics.truncateToWidth(line, maxWidth, ""));
	return previewLines.length > 0 ? [heading, "", ...previewLines] : [heading];
}

function formatExpandedSubagentAction(
	args: SubagentActionArgs,
	width: number,
	metrics: SubagentCallTextMetrics,
	style: Pick<SubagentCallStyle, "title" | "name" | "agent" | "body">,
): string[] {
	const maxWidth = availableWidth(width);
	if (maxWidth === 0) return [];
	return metrics
		.renderText(expandedContent(args, style), maxWidth)
		.map((line) => metrics.truncateToWidth(line, maxWidth, ""));
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
	style: Pick<SubagentCallStyle, "title" | "name" | "agent" | "body"> = {},
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
	style: Pick<SubagentCallStyle, "title" | "name" | "agent" | "body"> = {},
): string[] {
	return formatExpandedSubagentAction(resumeActionArgs(args), width, metrics, style);
}
