import { assertValidAgentIdentifier } from "./agent-identifier.ts";
import { sanitizeDisplayText } from "./display-text.ts";
import { formatCost, formatTokens } from "./widget.ts";

export type SubagentEnvelopeStatus = "completed" | "failed" | "stopped";

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
