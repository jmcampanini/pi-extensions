import { SUBAGENT_ENVELOPE_TITLE } from "../shared/subagent-envelope.ts";
import { assertValidAgentIdentifier } from "./agent-identifier.ts";
import { sanitizeDisplayText } from "./display-text.ts";
import { formatCost, formatTokens } from "./widget.ts";

export type SubagentResultStatus = "completed" | "failed" | "stopped";
export type SubagentEnvelopeStatus = SubagentResultStatus;

export interface SubagentResultPresentation {
	version: 2;
	status: SubagentResultStatus;
	elapsedSeconds: number;
	preview: string;
}

export interface SubagentResultContentRange {
	start: number;
	end: number;
}

export interface SubagentExpandedResultPresentation {
	version: 1;
	response?: SubagentResultContentRange;
	notice?: string;
	failureReason?: string;
	worktreeNote?: string;
}

export interface SubagentResultDetails {
	id: string;
	name: string;
	agent?: string;
	harness?: string;
	model?: string;
	effort?: string;
	tools?: string;
	forked?: boolean;
	interactive?: boolean;
	worktree?: boolean;
	exitCode?: number;
	reason?: string;
	sessionFile?: string;
	worktreeDir?: string;
	worktreeBranch?: string;
	worktreeStatus?: string;
	contextTokens?: number | null;
	contextWindow?: number;
	resultTokens?: number;
	costUsd?: number;
	expanded: SubagentExpandedResultPresentation;
	presentation: SubagentResultPresentation;
}

export interface SubagentResultEnvelope {
	status: SubagentEnvelopeStatus;
	name: string;
	agent: string;
	/** The external tool that ran the child ("claude-code"); absent = pi.
	 * Also switches the session line to resume-reference wording - an
	 * external child's anchor path is not a readable session file. */
	harness?: string;
	id: string;
	model?: string;
	effort?: string;
	forked?: boolean;
	interactive?: boolean;
	worktree?: boolean;
	tools?: string;
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
	response?: SubagentResultContentRange;
}

interface SubagentResultMessageBase {
	name: string;
	agent?: string;
	harness?: string;
	id: string;
	model?: string;
	effort?: string;
	forked: boolean;
	interactive: boolean;
	worktree: boolean;
	tools?: string;
	elapsedSeconds: number;
	contextTokens?: number | null;
	contextWindow?: number;
	resultTokens?: number;
	costUsd?: number;
	exitCode: number;
	reason: string;
	sessionFile: string;
	worktreeDir?: string;
	worktreeBranch?: string;
	worktreeStatus?: string;
	worktreeNote?: string;
}

export type SubagentResultMessageInput = SubagentResultMessageBase & (
	| { status: "completed"; response: string }
	| { status: "failed"; response?: string; failureReason: string }
	| { status: "stopped"; notice: string; stopRequester: "user" | "model" }
);

export interface SubagentResultMessage {
	content: string;
	details: SubagentResultDetails;
}

const MAX_STORED_PREVIEW_CODE_POINTS = 2000;

function inline(text: string): string {
	return sanitizeDisplayText(text).replace(/\s+/g, " ").trim();
}

function optionalInlineLine(label: string, value: string | undefined): string[] {
	if (value === undefined) return [];
	const safe = inline(value);
	return safe === "" ? [] : [`${label}: ${safe}`];
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
		version: 2,
		status,
		elapsedSeconds: Math.max(0, Math.floor(elapsedSeconds)),
		preview: codePoints.length > MAX_STORED_PREVIEW_CODE_POINTS
			? `${codePoints.slice(0, MAX_STORED_PREVIEW_CODE_POINTS).join("")}…`
			: normalizedPreview,
	};
}

export function buildSubagentResultEnvelope(input: SubagentResultEnvelope): SubagentResultEnvelopeContent {
	assertValidAgentIdentifier(input.agent, "Result agent identifier");
	const modes = [
		...(input.forked ? ["forked"] : []),
		...(input.interactive ? ["interactive"] : []),
		...(input.worktree ? ["worktree"] : []),
	];
	const lines = [
		SUBAGENT_ENVELOPE_TITLE,
		`Status: ${input.status}`,
		...(input.failureReason ? [`Failure: ${inline(input.failureReason)}`] : []),
		...(input.notice ? [`Notice: ${inline(input.notice)}`] : []),
		`Name: ${inline(input.name)}`,
		`Agent: ${inline(input.agent)}`,
		...optionalInlineLine("Harness", input.harness),
		`ID: ${inline(input.id)}`,
		...optionalInlineLine("Model", input.model),
		...optionalInlineLine("Effort", input.effort),
		...(modes.length > 0 ? [`Mode: ${modes.join(" · ")}`] : []),
		...optionalInlineLine("Tools", input.tools),
		`Elapsed: ${inline(input.elapsed)}`,
	];
	if (input.contextTokens !== undefined) lines.push(`Context: ${formatTokens(input.contextTokens)} tokens`);
	if (input.resultTokens !== undefined) lines.push(`Result: ~${formatTokens(input.resultTokens)} tokens`);
	if (input.costUsd !== undefined) lines.push(`Cost: ${formatCost(input.costUsd)}`);

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

export function buildSubagentResultMessage(input: SubagentResultMessageInput): SubagentResultMessage {
	const failed = input.status === "failed";
	const response = input.status === "stopped" ? undefined : input.response;
	const failureReason = failed ? input.failureReason : undefined;
	const notice = input.status === "stopped" ? input.notice : undefined;
	const envelope = buildSubagentResultEnvelope({
		status: input.status,
		name: input.name,
		agent: input.agent ?? "worker",
		harness: input.harness,
		id: input.id,
		model: input.model,
		effort: input.effort,
		forked: input.forked,
		interactive: input.interactive,
		worktree: input.worktree,
		tools: input.tools,
		elapsed: humanElapsed(input.elapsedSeconds),
		// null is the post-compaction telemetry sentinel; prose omits an unknown count.
		contextTokens: input.contextTokens ?? undefined,
		resultTokens: input.resultTokens,
		costUsd: input.costUsd,
		response,
		failureReason,
		notice,
		action: failed ? "Retry" : "Resume",
		actionMessage: failed ? "<guidance>" : "...",
		sessionFile: input.sessionFile,
		worktreeNote: input.worktreeNote,
	});
	let preview: string;
	if (input.status === "completed") {
		preview = input.response;
	} else if (input.status === "failed") {
		preview = input.response ?? input.failureReason;
	} else {
		preview = (input.stopRequester === "user" ? "Stopped by the user" : "Stopped by the parent agent") +
			" — no final result. Partial work may remain; expand for resume and worktree details.";
	}

	return {
		content: envelope.content,
		details: {
			id: input.id,
			name: input.name,
			agent: input.agent,
			harness: input.harness,
			model: input.model,
			effort: input.effort,
			tools: input.tools,
			forked: input.forked,
			interactive: input.interactive,
			worktree: input.worktree,
			exitCode: input.exitCode,
			reason: input.reason,
			sessionFile: input.sessionFile,
			worktreeDir: input.worktreeDir,
			worktreeBranch: input.worktreeBranch,
			worktreeStatus: input.worktreeStatus,
			contextTokens: input.contextTokens,
			contextWindow: input.contextWindow,
			resultTokens: input.resultTokens,
			costUsd: input.costUsd,
			expanded: {
				version: 1,
				response: envelope.response,
				failureReason,
				notice,
				worktreeNote: input.worktreeNote,
			},
			presentation: resultPresentation(input.status, input.elapsedSeconds, preview),
		},
	};
}
