import type { ParsedQuery, QueryOperator } from "./types.ts";

// Query parsing

export function parseQuery(query: string): ParsedQuery {
	const tokens: string[] = [];
	const operators: QueryOperator[] = [];

	for (const part of query.trim().split(/\s+/)) {
		if (!part) continue;

		const operator = /^(is|tool):(.+)$/i.exec(part);
		if (operator) {
			operators.push({
				key: operator[1]!.toLowerCase() as QueryOperator["key"],
				value: operator[2]!,
			});
		} else {
			tokens.push(part);
		}
	}

	return { tokens, operators };
}
