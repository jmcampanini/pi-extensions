import { fuzzyMatch } from "@earendil-works/pi-tui";
import { parseQuery } from "../query.ts";
import { matchBlock, searchBlocks } from "../search.ts";
import type { Block, HighlightSpan } from "../types.ts";

let pass = 0;
let fail = 0;

function eq(label: string, got: unknown, want: unknown) {
	const actual = JSON.stringify(got);
	const expected = JSON.stringify(want);
	if (actual === expected) {
		pass++;
		console.log(`  ok  ${label}`);
	} else {
		fail++;
		console.log(`  FAIL ${label}: got ${actual}, want ${expected}`);
	}
}

function ok(label: string, condition: boolean) {
	if (condition) {
		pass++;
		console.log(`  ok  ${label}`);
	} else {
		fail++;
		console.log(`  FAIL ${label}`);
	}
}

let blockNumber = 0;
function makeBlock(overrides: Partial<Block> = {}): Block {
	blockNumber++;
	return {
		id: `block-${blockNumber}`,
		kind: "assistant",
		entryId: `entry-${blockNumber}`,
		entryIds: [`entry-${blockNumber}`],
		timestamp: new Date(blockNumber * 1_000).toISOString(),
		fields: "assistant",
		body: "",
		title: "Assistant",
		canonicalText: "",
		...overrides,
	};
}

function ids(results: ReturnType<typeof searchBlocks>): string[] {
	return results.map((result) => result.block.id);
}

function highlightedCharacters(text: string, spans: HighlightSpan[], zone: HighlightSpan["zone"]): string {
	return spans
		.filter((span) => span.zone === zone)
		.map((span) => text.slice(span.start, span.end))
		.join("");
}

// Query parsing

eq("whitespace tokenization retains slash paths", parseQuery("  src/config.ts\tother/path  "), {
	tokens: ["src/config.ts", "other/path"],
	operators: [],
});
eq("known operator keys are case-insensitive", parseQuery("IS:user ToOl:Read"), {
	tokens: [],
	operators: [{ key: "is", value: "user" }, { key: "tool", value: "Read" }],
});
eq("unknown and empty operators remain tokens", parseQuery("path:src/config.ts owner:me is: tool:"), {
	tokens: ["path:src/config.ts", "owner:me", "is:", "tool:"],
	operators: [],
});

// Hybrid AND matching

const hybrid = makeBlock({
	id: "hybrid",
	kind: "tool",
	toolName: "read",
	fields: "tool read src/config.ts",
	body: "The stored result contains a Hidden Needle.",
});
ok("all tokens may match across fields and body", matchBlock(parseQuery("sconf hidden needle"), hybrid).matches);
ok("all plain tokens are required", !matchBlock(parseQuery("sconf missing"), hybrid).matches);
ok("body-only substring matches case-insensitively", matchBlock(parseQuery("HIDDEN NEEDLE"), hybrid).matches);
ok(
	"scattered body characters do not fuzzy-match",
	!matchBlock(parseQuery("needle"), makeBlock({ fields: "assistant", body: "n---e---e---d---l---e" })).matches,
);

const cumulative = matchBlock(parseQuery("tool read"), hybrid);
eq(
	"field scores accumulate across tokens",
	cumulative.score,
	fuzzyMatch("tool", hybrid.fields).score + fuzzyMatch("read", hybrid.fields).score,
);

// Fuzzy paths and operators

const fuzzyPathMatch = matchBlock(parseQuery("sconf"), hybrid);
ok("compact path query fuzzy-matches fields", fuzzyPathMatch.matches);
eq("fuzzy field highlights follow the greedy subsequence", fuzzyPathMatch.highlightSpans, [
	{ zone: "fields", start: 10, end: 11 },
	{ zone: "fields", start: 12, end: 13 },
	{ zone: "fields", start: 15, end: 18 },
]);
eq(
	"fuzzy highlight characters spell the query",
	highlightedCharacters(hybrid.fields, fuzzyPathMatch.highlightSpans, "fields"),
	"sconf",
);

ok("is and tool operators scope by exact value", matchBlock(parseQuery("IS:TOOL TOOL:READ"), hybrid).matches);
ok("is operator rejects a different exact kind", !matchBlock(parseQuery("is:assistant"), hybrid).matches);
ok("tool operator rejects a partial name", !matchBlock(parseQuery("tool:rea"), hybrid).matches);
ok(
	"operator-looking body text cannot satisfy a recognized operator",
	!matchBlock(parseQuery("tool:write"), makeBlock({ kind: "tool", toolName: "read", body: "tool:write" })).matches,
);

const pathField = makeBlock({ fields: "path:src/config.ts" });
ok("unknown operator-shaped token is searched normally", matchBlock(parseQuery("path:src/config.ts"), pathField).matches);
ok("a slash path remains one searchable token", matchBlock(parseQuery("src/config.ts"), pathField).matches);

// Highlight coverage

const repeated = makeBlock({ fields: "read READ", body: "Needle and needle; needleness" });
const repeatedMatch = matchBlock(parseQuery("read needle"), repeated);
eq("field substring highlights cover every occurrence", repeatedMatch.highlightSpans.filter((span) => span.zone === "fields"), [
	{ zone: "fields", start: 0, end: 4 },
	{ zone: "fields", start: 5, end: 9 },
]);
eq("body substring highlighting is deferred by token", repeatedMatch.bodyHighlightTokens, ["needle"]);
eq("search does not materialize body occurrence spans", repeatedMatch.highlightSpans.filter((span) => span.zone === "body"), []);
const repeatedLargeBody = "a ".repeat(5_000);
const largeBodyResults = searchBlocks(
	Array.from({ length: 20 }, (_, index) => makeBlock({ id: `large-${index}`, fields: "zz", body: repeatedLargeBody })),
	"a",
);
eq("common-token search stores one lazy body token per result",
	largeBodyResults.map((result) => [result.match.highlightSpans.length, result.match.bodyHighlightTokens]),
	Array.from({ length: 20 }, () => [0, ["a"]]));

// Ordering

const weakOne = makeBlock({ id: "weak-one", fields: "a---l---p" });
const exact = makeBlock({ id: "exact", fields: "alp" });
const weakTwo = makeBlock({ id: "weak-two", fields: "a---l---p" });
const ordered = [weakOne, exact, weakTwo];

eq("chronological order preserves source order", ids(searchBlocks(ordered, "alp", "chronological")), [
	"weak-one", "exact", "weak-two",
]);
eq("reverse chronology reverses source order", ids(searchBlocks(ordered, parseQuery("alp"), "reverse-chronological")), [
	"weak-two", "exact", "weak-one",
]);
eq("relevance uses lower scores and keeps chronological ties stable", ids(searchBlocks(ordered, "alp", "relevance")), [
	"exact", "weak-one", "weak-two",
]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
