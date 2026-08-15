import {
	parseSubagentResultEnvelope,
	SUBAGENT_PROSE_ARGUMENT_KEYS,
	SUBAGENT_RESULT_CUSTOM_TYPE,
	SUBAGENT_TOOL_NAME_PREFIX,
} from "../interactive-subagents/result-content.ts";
import type { Block } from "./types.ts";

/**
 * Structured presentation for interactive-subagents traffic. The envelope and
 * argument contracts live in that extension (next to the code that writes
 * them); this module only maps them onto fuzzy-explorer blocks: metadata
 * becomes key=value fields (name/agent/status first) and the task prompt or
 * delivered result becomes markdown-renderable content.
 */

export interface SubagentField {
	key: string;
	value: string;
}

export interface SubagentView {
	fields: SubagentField[];
	content: string;
	rowFields?: SubagentField[];
	result?: true;
}

const PRIORITY_KEYS = ["name", "agent", "status"];

function prioritized(fields: SubagentField[]): SubagentField[] {
	return [
		...PRIORITY_KEYS.flatMap((key) => fields.filter((field) => field.key === key)),
		...fields.filter((field) => !PRIORITY_KEYS.includes(field.key)),
	];
}

function compactValue(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

/** Tool calls: primitive arguments are metadata; prose arguments and the ack are content. */
function toolView(block: Block): SubagentView | undefined {
	const toolName = block.toolName;
	if (toolName === undefined) return undefined;
	const argumentsEnd = block.body !== "" && block.canonicalBodyOffset !== undefined
		? block.canonicalBodyOffset - 2
		: block.canonicalText.length;
	const argumentsText = block.canonicalText.slice(toolName.length + 1, argumentsEnd);

	let parsed: unknown;
	try {
		parsed = JSON.parse(argumentsText);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

	const fields: SubagentField[] = [];
	const contents: string[] = [];
	for (const [key, value] of Object.entries(parsed)) {
		if (SUBAGENT_PROSE_ARGUMENT_KEYS.has(key) && typeof value === "string") {
			contents.push(value.trim());
		} else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			fields.push({ key, value: compactValue(String(value)) });
		}
	}
	if (block.body !== "") contents.push(block.body.trim());
	return { fields: prioritized(fields), content: contents.filter((text) => text !== "").join("\n\n") };
}

function resultView(block: Block): SubagentView | undefined {
	const envelope = parseSubagentResultEnvelope(block.body);
	if (envelope === undefined) return undefined;
	return {
		fields: envelope.fields,
		content: envelope.response,
		rowFields: prioritized(envelope.fields),
		result: true,
	};
}

export function subagentView(block: Block): SubagentView | undefined {
	if (block.kind === "custom" && block.title === SUBAGENT_RESULT_CUSTOM_TYPE) return resultView(block);
	if (block.kind === "tool" && (block.toolName?.startsWith(SUBAGENT_TOOL_NAME_PREFIX) ?? false)) {
		return toolView(block);
	}
	return undefined;
}
