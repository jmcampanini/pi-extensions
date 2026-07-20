import { assertValidAgentIdentifier } from "./agent-identifier.ts";
import { sanitizeDisplayText } from "./display-text.ts";
import { formatCost, formatTokens } from "./widget.ts";

export type SubagentEnvelopeStatus = "completed" | "failed" | "stopped";

// Public format contract for consumers that present subagent traffic (e.g. the
// fuzzy-explorer extension): the customType results arrive under, which tool
// arguments are prose rather than metadata, and a parser that inverts
// buildSubagentResultEnvelope so the envelope format cannot drift from it.

export const SUBAGENT_RESULT_CUSTOM_TYPE = "subagent_result";
export const SUBAGENT_TOOL_NAME_PREFIX = "subagent_";
export const SUBAGENT_PROSE_ARGUMENT_KEYS: ReadonlySet<string> = new Set(["task", "prompt", "message"]);

export interface SubagentResultEnvelope {
	status: SubagentEnvelopeStatus;
	name: string;
	agent: string;
	/** The external tool that ran the child ("claude-code"); absent = pi.
	 * Also switches the session line to resume-reference wording - an
	 * external child's anchor path is not a readable session file. */
	harness?: string;
	id: string;
	elapsed: string;
	contextTokens?: number;
	resultTokens?: number;
	costUsd?: number;
	response?: string;
	failureReason?: string;
	notice?: string;
	action: "Resume" | "Retry";
	actionMessage: "..." | "<guidance>";
	sessionFile: string;
	worktreeNote?: string;
}

export interface SubagentResultEnvelopeContent {
	content: string;
	response?: { start: number; end: number };
}

function inline(text: string): string {
	return sanitizeDisplayText(text).replace(/\s+/g, " ").trim();
}

export function buildSubagentResultEnvelope(input: SubagentResultEnvelope): SubagentResultEnvelopeContent {
	assertValidAgentIdentifier(input.agent, "Result agent identifier");
	const lines = [
		"Subagent result",
		`Status: ${input.status}`,
		`Name: ${inline(input.name)}`,
		`Agent: ${inline(input.agent)}`,
		...(input.harness ? [`Harness: ${inline(input.harness)}`] : []),
		`ID: ${inline(input.id)}`,
		`Elapsed: ${inline(input.elapsed)}`,
	];
	if (input.contextTokens !== undefined) lines.push(`Context: ${formatTokens(input.contextTokens)} tokens`);
	if (input.resultTokens !== undefined) lines.push(`Result: ~${formatTokens(input.resultTokens)} tokens`);
	if (input.costUsd !== undefined) lines.push(`Cost: ${formatCost(input.costUsd)}`);
	if (input.failureReason) lines.push(`Failure: ${inline(input.failureReason)}`);
	if (input.notice) lines.push(`Notice: ${inline(input.notice)}`);

	let content = lines.join("\n");
	let response: SubagentResultEnvelopeContent["response"];
	if (input.response !== undefined) {
		const safeResponse = sanitizeDisplayText(input.response);
		content += "\n\n<result>\n";
		response = { start: content.length, end: content.length + safeResponse.length };
		content += `${safeResponse}\n</result>`;
	}

	// The session line: pi children name a readable .jsonl transcript; an
	// external child's anchor is only a resume reference (its sidecars hold
	// the state, the tool's own storage holds the transcript).
	content +=
		`\n\n${input.action}: subagent_resume({ id: "${inline(input.id)}", message: "${input.actionMessage}" })` +
		(input.harness
			? `\nSession ref: ${sanitizeDisplayText(input.sessionFile)} (pass as sessionPath to subagent_resume if the id is no longer known; not a readable file)`
			: `\nSession: ${sanitizeDisplayText(input.sessionFile)}`);
	if (input.worktreeNote) content += `\n${inline(input.worktreeNote)}`;
	return { content, response };
}

export interface SubagentEnvelopeField {
	key: string;
	value: string;
}

export interface ParsedSubagentResultEnvelope {
	/** Metadata lines (head and tail) as lowercase key/value pairs, in envelope order. */
	fields: SubagentEnvelopeField[];
	/** The delivered response text, unwrapped from its <result> markers. */
	response: string;
}

const ENVELOPE_TITLE = "Subagent result";
const ENVELOPE_FIELD_LINE = /^([A-Za-z][A-Za-z ]{0,24}): (.*)$/;

/** Invert buildSubagentResultEnvelope; undefined when content is not an envelope. */
export function parseSubagentResultEnvelope(content: string): ParsedSubagentResultEnvelope | undefined {
	const lines = content.split("\n");
	const fields: SubagentEnvelopeField[] = [];
	let index = lines[0]?.trim() === ENVELOPE_TITLE ? 1 : 0;
	for (; index < lines.length; index++) {
		const line = lines[index]!;
		if (line.trim() === "") break;
		const match = ENVELOPE_FIELD_LINE.exec(line);
		if (match === null) break;
		fields.push({ key: match[1]!.toLowerCase(), value: match[2]! });
	}
	if (fields.length === 0) return undefined;

	const rest = lines.slice(index).join("\n").trim();
	const open = rest.indexOf("<result>");
	const close = rest.lastIndexOf("</result>");
	let response = "";
	let tail = rest;
	if (open !== -1 && close > open) {
		response = rest.slice(open + "<result>".length, close).trim();
		tail = `${rest.slice(0, open)}\n${rest.slice(close + "</result>".length)}`;
	}

	// The action/session tail lines are metadata too; anything unshaped joins the response.
	const leftover: string[] = [];
	for (const line of tail.split("\n")) {
		if (line.trim() === "") continue;
		const match = ENVELOPE_FIELD_LINE.exec(line);
		if (match !== null) fields.push({ key: match[1]!.toLowerCase(), value: match[2]! });
		else leftover.push(line);
	}
	if (leftover.length > 0) {
		response = [response, leftover.join("\n")].filter((text) => text !== "").join("\n\n");
	}
	return { fields, response };
}
