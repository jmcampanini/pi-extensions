import { visibleWidth } from "@earendil-works/pi-tui";

export const AGENT_IDENTIFIER_MAX_COLUMNS = 20;

export function agentIdentifierProblem(value: unknown): string | undefined {
	if (typeof value !== "string" || value === "") return "must be a non-empty string";
	if (/\s/u.test(value)) return "must not contain whitespace";
	const columns = visibleWidth(value);
	if (columns > AGENT_IDENTIFIER_MAX_COLUMNS) {
		return `must be at most ${AGENT_IDENTIFIER_MAX_COLUMNS} display columns (got ${columns})`;
	}
	return undefined;
}

export function isValidAgentIdentifier(value: unknown): value is string {
	return agentIdentifierProblem(value) === undefined;
}

export function assertValidAgentIdentifier(value: unknown, source = "Agent identifier"): asserts value is string {
	const problem = agentIdentifierProblem(value);
	if (problem) throw new Error(`${source} ${problem}.`);
}
