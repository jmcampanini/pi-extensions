import { fuzzyMatch } from "@earendil-works/pi-tui";
import { isEmptyQuery, parseQuery } from "./query.ts";
import type { Block, BlockMatch, ParsedQuery, QueryOperator, SearchResult } from "./types.ts";

// Separator normalization
//
// The separator class mirrors the fuzzy matcher's word-boundary class. Every
// match site tries the raw token first and retries with separators stripped at
// a small penalty, so `sub-agent` finds `subagent` and vice versa.

export const SEPARATOR_CLASS = /[-_./:]/;
const STRIPPED_TOKEN_PENALTY = 5;

export function stripSeparators(text: string): string {
	return text.replace(/[-_./:]/gu, "");
}

interface TokenHit {
	score: number;
	/** The token form that actually matched; renderers re-derive highlights from it. */
	matchedToken: string;
}

function keyTokenHit(token: string, searchKey: string): TokenHit | undefined {
	const raw = fuzzyMatch(token, searchKey);
	if (raw.matches) return { score: raw.score, matchedToken: token };

	// Fuzzy subsequences already skip separators in the key, so the fallback
	// only needs to strip the token itself.
	const stripped = stripSeparators(token);
	if (stripped === token || stripped === "") return undefined;
	const fallback = fuzzyMatch(stripped, searchKey);
	return fallback.matches
		? { score: fallback.score + STRIPPED_TOKEN_PENALTY, matchedToken: stripped }
		: undefined;
}

function substringTokenHit(
	token: string,
	haystackLower: string,
	strippedHaystackLower: string,
): TokenHit | undefined {
	if (haystackLower.includes(token.toLowerCase())) return { score: 0, matchedToken: token };

	const stripped = stripSeparators(token);
	if (stripped === "") return undefined;
	return strippedHaystackLower.includes(stripped.toLowerCase())
		? { score: STRIPPED_TOKEN_PENALTY, matchedToken: stripped }
		: undefined;
}

// Block matching

function operatorScore(operator: QueryOperator, block: Block): number | undefined {
	if (operator.key === "is") {
		const kind = fuzzyMatch(operator.value, block.kind);
		return kind.matches ? kind.score : undefined;
	}
	if (operator.key === "tool") {
		if (block.toolName === undefined) return undefined;
		const tool = fuzzyMatch(operator.value, block.toolName);
		return tool.matches ? tool.score : undefined;
	}
	// `any:` hunts concrete needles across the full haystack: substring, never fuzzy.
	return substringTokenHit(
		operator.value,
		block.anyText.toLowerCase(),
		block.strippedAnyText.toLowerCase(),
	)?.score;
}

export function matchBlock(query: ParsedQuery, block: Block): BlockMatch {
	const noMatch: BlockMatch = { matches: false, score: 0, keyTokens: [], bodyTokens: [] };
	let score = 0;

	for (const operator of query.operators) {
		const contribution = operatorScore(operator, block);
		if (contribution === undefined) return noMatch;
		score += contribution;
	}

	const keyTokens: string[] = [];
	const bodyTokens: string[] = [];
	const bodyLower = block.body.toLowerCase();
	const strippedBodyLower = block.strippedBody.toLowerCase();

	for (const token of query.tokens) {
		const keyHit = keyTokenHit(token, block.searchKey);
		const bodyHit = substringTokenHit(token, bodyLower, strippedBodyLower);
		if (!keyHit && !bodyHit) return noMatch;

		// The better (lower) contribution wins: crisp key hits outrank the body
		// tier, but incidental subsequence noise in a long key must not bury an
		// exact body hit (body matches contribute 0, stripped fallbacks +5).
		const keyWins = keyHit !== undefined && (bodyHit === undefined || keyHit.score <= bodyHit.score);
		if (keyWins) {
			score += keyHit.score;
			keyTokens.push(keyHit.matchedToken);
		} else {
			score += bodyHit!.score;
		}
		if (bodyHit) bodyTokens.push(bodyHit.matchedToken);
	}

	return { matches: true, score, keyTokens, bodyTokens };
}

// Result ordering: relevance while a query is active, chronological otherwise.

export function searchBlocks(blocks: readonly Block[], query: string | ParsedQuery): SearchResult[] {
	const parsed = typeof query === "string" ? parseQuery(query) : query;
	const matches = blocks.flatMap((block, chronologicalIndex) => {
		const match = matchBlock(parsed, block);
		return match.matches ? [{ block, match, chronologicalIndex }] : [];
	});

	if (!isEmptyQuery(parsed)) {
		matches.sort((left, right) =>
			left.match.score - right.match.score
			|| right.chronologicalIndex - left.chronologicalIndex,
		);
	}

	return matches.map(({ block, match }) => ({ block, match }));
}
