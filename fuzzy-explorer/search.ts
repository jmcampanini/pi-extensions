import { fuzzyMatch } from "@earendil-works/pi-tui";
import { parseQuery } from "./query.ts";
import type {
	Block,
	BlockMatch,
	HighlightSpan,
	ListOrder,
	ParsedQuery,
	SearchResult,
} from "./types.ts";

// Highlight helpers

function substringSpans(text: string, token: string, zone: HighlightSpan["zone"]): HighlightSpan[] {
	const spans: HighlightSpan[] = [];
	if (!token) return spans;

	const haystack = text.toLowerCase();
	const needle = token.toLowerCase();

	for (let start = haystack.indexOf(needle); start !== -1; start = haystack.indexOf(needle, start + 1)) {
		spans.push({ zone, start, end: start + token.length });
	}

	return spans;
}

function swappedAlphaNumericToken(token: string): string | undefined {
	const alphaNumeric = /^(?<letters>[a-z]+)(?<digits>[0-9]+)$/i.exec(token);
	if (alphaNumeric?.groups) return `${alphaNumeric.groups.digits}${alphaNumeric.groups.letters}`;

	const numericAlpha = /^(?<digits>[0-9]+)(?<letters>[a-z]+)$/i.exec(token);
	if (numericAlpha?.groups) return `${numericAlpha.groups.letters}${numericAlpha.groups.digits}`;

	return undefined;
}

function greedySubsequenceSpans(token: string, text: string): HighlightSpan[] {
	const query = token.toLowerCase();
	const haystack = text.toLowerCase();
	const positions: number[] = [];
	let from = 0;

	for (const character of query) {
		const position = haystack.indexOf(character, from);
		if (position === -1) return [];
		positions.push(position);
		from = position + 1;
	}

	const spans: HighlightSpan[] = [];
	for (const position of positions) {
		const previous = spans.at(-1);
		if (previous && previous.end === position) previous.end++;
		else spans.push({ zone: "fields", start: position, end: position + 1 });
	}
	return spans;
}

function fuzzyFieldSpans(token: string, fields: string): HighlightSpan[] {
	const substrings = substringSpans(fields, token, "fields");
	if (substrings.length > 0) return substrings;

	const direct = greedySubsequenceSpans(token, fields);
	if (direct.length > 0) return direct;

	const swapped = swappedAlphaNumericToken(token);
	return swapped ? greedySubsequenceSpans(swapped, fields) : [];
}

function mergeSpans(spans: HighlightSpan[]): HighlightSpan[] {
	const zoneOrder = { fields: 0, body: 1 } as const;
	const sorted = [...spans].sort((left, right) =>
		zoneOrder[left.zone] - zoneOrder[right.zone] || left.start - right.start || left.end - right.end,
	);
	const merged: HighlightSpan[] = [];

	for (const span of sorted) {
		const previous = merged.at(-1);
		if (previous && previous.zone === span.zone && span.start <= previous.end) {
			previous.end = Math.max(previous.end, span.end);
		} else {
			merged.push({ ...span });
		}
	}

	return merged;
}

// Block matching

function operatorsMatch(query: ParsedQuery, block: Block): boolean {
	return query.operators.every((operator) => {
		const value = operator.value.toLowerCase();
		if (operator.key === "is") return block.kind.toLowerCase() === value;
		return block.toolName?.toLowerCase() === value;
	});
}

export function matchBlock(query: ParsedQuery, block: Block): BlockMatch {
	if (!operatorsMatch(query, block)) return { matches: false, score: 0, highlightSpans: [] };

	let score = 0;
	const highlightSpans: HighlightSpan[] = [];
	const bodyHighlightTokens: string[] = [];
	const bodyLower = block.body.toLowerCase();

	for (const token of query.tokens) {
		const fieldMatch = fuzzyMatch(token, block.fields);
		const bodyMatches = bodyLower.includes(token.toLowerCase());
		if (!fieldMatch.matches && !bodyMatches) {
			return { matches: false, score: 0, highlightSpans: [] };
		}

		if (fieldMatch.matches) {
			score += fieldMatch.score;
			highlightSpans.push(...fuzzyFieldSpans(token, block.fields));
		}
		if (bodyMatches) bodyHighlightTokens.push(token);
	}

	return {
		matches: true,
		score,
		highlightSpans: mergeSpans(highlightSpans),
		bodyHighlightTokens,
	};
}

// Result ordering

export function searchBlocks(
	blocks: readonly Block[],
	query: string | ParsedQuery,
	listOrder: ListOrder = "chronological",
): SearchResult[] {
	const parsed = typeof query === "string" ? parseQuery(query) : query;
	const matches = blocks.flatMap((block, chronologicalIndex) => {
		const match = matchBlock(parsed, block);
		return match.matches ? [{ block, match, chronologicalIndex }] : [];
	});

	if (listOrder === "reverse-chronological") matches.reverse();
	if (listOrder === "relevance") {
		matches.sort((left, right) =>
			left.match.score - right.match.score || left.chronologicalIndex - right.chronologicalIndex,
		);
	}

	return matches.map(({ block, match }) => ({ block, match }));
}
