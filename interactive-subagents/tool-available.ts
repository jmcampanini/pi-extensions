/**
 * tool-available.ts — model-facing discovery of configured agent definitions.
 */

import { keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	agentDefsDir,
	collectAgentInventory,
	contextMode,
	descriptionHeadline,
	formatAgentOverviewLines,
	projectDefsDir,
	type AgentInfo,
} from "./agents.ts";
import { updateCatalogue } from "./catalogue.ts";
import { sanitizeDisplayText } from "./display-text.ts";
import { isExternalHarness } from "./harnesses.ts";

export interface AvailablePresentation {
	version: 1;
	inventory: AgentInfo[];
	dirs: { global: string; project: string };
}

export interface AvailableToolDetails {
	presentation: AvailablePresentation;
}

const AVAILABLE_CARD_MAX_ROWS = 5;
const plainText = (text: string): string => text;
const safeInline = (text: string): string => sanitizeDisplayText(text).replace(/\s+/g, " ").trim();

export interface AvailableCardStyle {
	name?: (text: string) => string;
	metadata?: (text: string) => string;
	preview?: (text: string) => string;
	warning?: (text: string) => string;
}

function availableMarkers(agent: AgentInfo): string[] {
	const markers: string[] = [];
	if (agent.name === "worker") markers.push("default");
	if (agent.source === "project") markers.push("project");
	if (contextMode(agent) === "forked") markers.push("forked");
	if (!agent.autoExit) markers.push("interactive");
	if (agent.worktree) markers.push("worktree");
	if (isExternalHarness(agent.harness)) {
		markers.push(`external: ${safeInline(agent.harness)}`);
		markers.push(contextMode(agent));
	}
	return markers;
}

export function formatAvailableModelText(inventory: readonly AgentInfo[]): string {
	if (inventory.length === 0) return "No available subagent definitions.";
	return inventory.map((agent) => {
		const markers = availableMarkers(agent);
		const suffix = markers.length > 0 ? ` (${markers.join(", ")})` : "";
		const problems = agent.problems.length > 0
			? ` [not spawnable: ${safeInline(agent.problems.join("; "))}]`
			: "";
		const description = safeInline(agent.details ?? agent.description ?? "(no description)");
		const model = agent.resolvedModel
			? `model ${agent.resolvedModel}`
			: agent.requestedModels.length > 0
				? `requested models ${agent.requestedModels.join(", ")} (none usable)`
				: "model inherits parent";
		const config = [
			`source ${agent.source}`,
			model,
			`context ${contextMode(agent)}`,
			agent.autoExit ? "autonomous" : "interactive",
			agent.worktree ? "worktree" : "shared checkout",
			isExternalHarness(agent.harness) ? `external: ${agent.harness}` : `harness ${agent.harness}`,
			...(agent.thinking ? [`thinking ${agent.thinking}`] : []),
			...(agent.tools ? [`tools ${agent.tools}`] : []),
			...(agent.harnessPassThrough ? [`pass-through ${agent.harnessPassThrough}`] : []),
		];
		return `• ${safeInline(agent.name)}${suffix}${problems} — ${description}\n  config: ${safeInline(config.join(" · "))}`;
	}).join("\n");
}

export function formatCollapsedAvailableLines(
	inventory: readonly AgentInfo[],
	width: number,
	style: AvailableCardStyle = {},
	expandHint = "",
): string[] {
	const safeWidth = Math.max(0, Math.floor(width));
	if (safeWidth === 0) return [];
	const name = style.name ?? plainText;
	const metadata = style.metadata ?? plainText;
	const preview = style.preview ?? plainText;
	const warning = style.warning ?? metadata;
	if (inventory.length === 0) return new Text(preview("No available subagent definitions."), 0, 0).render(safeWidth);

	const lines: string[] = [];
	for (const agent of inventory.slice(0, AVAILABLE_CARD_MAX_ROWS)) {
		const markers = availableMarkers(agent);
		const markerText = markers.length > 0 ? metadata(` · ${markers.join(" · ")}`) : "";
		const description = agent.description
			? preview(` — ${descriptionHeadline(sanitizeDisplayText(agent.description))}`)
			: preview(" — (no description)");
		const problem = agent.problems.length > 0 ? warning(" · not spawnable") : "";
		lines.push(...new Text(name(sanitizeDisplayText(agent.name)) + markerText + problem + description, 0, 0).render(safeWidth));
	}
	if (expandHint) {
		const hidden = inventory.length - Math.min(inventory.length, AVAILABLE_CARD_MAX_ROWS);
		const label = hidden > 0 ? `… ${hidden} more · ${expandHint}` : `(${expandHint})`;
		lines.push(truncateToWidth(metadata(label), safeWidth, ""));
	}
	return lines.map((line) => truncateToWidth(line, safeWidth, ""));
}

function isAgentInfo(value: unknown): value is AgentInfo {
	if (!value || typeof value !== "object") return false;
	const agent = value as Partial<AgentInfo>;
	return typeof agent.name === "string"
		&& (agent.source === "global" || agent.source === "project")
		&& typeof agent.filePath === "string"
		&& (agent.description === undefined || typeof agent.description === "string")
		&& (agent.details === undefined || typeof agent.details === "string")
		&& (agent.resolvedModel === undefined || typeof agent.resolvedModel === "string")
		&& (agent.thinking === undefined || typeof agent.thinking === "string")
		&& (agent.tools === undefined || typeof agent.tools === "string")
		&& (agent.harnessPassThrough === undefined || typeof agent.harnessPassThrough === "string")
		&& Array.isArray(agent.requestedModels)
		&& agent.requestedModels.every((model) => typeof model === "string")
		&& (agent.context === "new" || agent.context === "forked")
		&& typeof agent.autoExit === "boolean"
		&& typeof agent.worktree === "boolean"
		&& typeof agent.harness === "string"
		&& Array.isArray(agent.problems)
		&& agent.problems.every((problem) => typeof problem === "string");
}

function parseDetails(details: unknown): AvailablePresentation | undefined {
	if (!details || typeof details !== "object") return undefined;
	const presentation = (details as { presentation?: unknown }).presentation;
	if (!presentation || typeof presentation !== "object") return undefined;
	const candidate = presentation as Partial<AvailablePresentation>;
	if (candidate.version !== 1 || !Array.isArray(candidate.inventory) || !candidate.inventory.every(isAgentInfo)) return undefined;
	if (!candidate.dirs || typeof candidate.dirs.global !== "string" || typeof candidate.dirs.project !== "string") return undefined;
	return candidate as AvailablePresentation;
}

export function registerSubagentAvailableTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "subagent_available",
		label: "Available Subagents",
		description:
			"List the available agent definitions (<name>.md files from the project's .pi/subagents/ or the global subagents directory; project definitions shadow global ones). " +
			"Use the returned definition name as the `agent` parameter of subagent_spawn. Reports expanded descriptions, effective defaults, and problems that make a definition unspawnable. " +
			"Use subagent_status instead to inspect launched work.",
		parameters: Type.Object({}),
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("subagent available")), 0, 0);
		},
		renderResult(result, { expanded }, theme, context) {
			const presentation = parseDetails(result.details);
			if (!presentation) {
				const text = result.content.find((part) => part.type === "text");
				const output = sanitizeDisplayText(text?.type === "text" ? text.text : "");
				return new Text(
					context.isError
						? theme.fg("error", output || "Unable to list available subagents.")
						: theme.fg("toolOutput", output),
					0,
					0,
				);
			}
			if (!expanded) {
				const hint = keyHint("app.tools.expand", "to expand");
				return {
					invalidate(): void {},
					render(width: number): string[] {
						return formatCollapsedAvailableLines(presentation.inventory, width, {
							name: (text) => theme.fg("accent", text),
							metadata: (text) => theme.fg("muted", text),
							preview: (text) => theme.fg("dim", text),
							warning: (text) => theme.fg("error", text),
						}, hint);
					},
				};
			}
			return {
				invalidate(): void {},
				render(width: number): string[] {
					return formatAgentOverviewLines(presentation.inventory, width, presentation.dirs, {
						dim: (text) => theme.fg("dim", text),
						muted: (text) => theme.fg("muted", text),
						accent: (text) => theme.fg("accent", text),
						output: (text) => theme.fg("toolOutput", text),
						error: (text) => theme.fg("error", text),
						warning: (text) => theme.fg("warning", text),
						border: (text) => theme.fg("borderMuted", text),
						bold: (text) => theme.bold(text),
						italic: (text) => theme.italic(text),
					}, { header: false, footer: false, fullDescriptionFallback: true });
				},
			};
		},
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const inventory = collectAgentInventory(ctx.modelRegistry, ctx.cwd);
			updateCatalogue(inventory);
			const dirs = { global: agentDefsDir(), project: projectDefsDir(ctx.cwd) };
			return {
				content: [{ type: "text", text: formatAvailableModelText(inventory) }],
				details: {
					presentation: { version: 1, inventory, dirs },
				} satisfies AvailableToolDetails,
			};
		},
	});
}
