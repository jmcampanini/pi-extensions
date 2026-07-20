import { fuzzyMatch } from "@earendil-works/pi-tui";
import { parseQuery } from "../query.ts";
import { matchBlock, searchBlocks, stripSeparators } from "../search.ts";
import { makeBlock } from "./block-factory.ts";

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

function ids(results: ReturnType<typeof searchBlocks>): string[] {
	return results.map((result) => result.block.id);
}

// Query parsing

eq("whitespace tokenization retains slash paths", parseQuery("  src/config.ts\tother/path  "), {
	tokens: ["src/config.ts", "other/path"],
	operators: [],
});
eq("known operator keys are case-insensitive", parseQuery("IS:user ToOl:Read AnY:toolu_01"), {
	tokens: [],
	operators: [
		{ key: "is", value: "user" },
		{ key: "tool", value: "Read" },
		{ key: "any", value: "toolu_01" },
	],
});
eq("unknown and empty operators remain tokens", parseQuery("path:src/config.ts owner:me is: tool: any:"), {
	tokens: ["path:src/config.ts", "owner:me", "is:", "tool:", "any:"],
	operators: [],
});

// Separator stripping

eq("stripping removes the matcher's separator class", stripSeparators("a-b_c.d/e:f g"), "abcdef g");

// Key fuzzy matching versus body substring matching

const toolBlock = makeBlock({
	id: "tool-block",
	kind: "tool",
	toolName: "read",
	title: "read",
	subtitle: "path=src/config.ts",
	fields: "role:assistant type:tool tool:read toolCallId:call-77 entry:entry-42 timestamp:2026-01-01 00:00:01Z",
	body: "The stored result contains a Hidden Needle.",
});
ok("free tokens fuzzy-match the curated search key", matchBlock(parseQuery("sconf"), toolBlock).matches);
ok("all tokens may match across key and body", matchBlock(parseQuery("sconf hidden needle"), toolBlock).matches);
ok("all plain tokens are required", !matchBlock(parseQuery("sconf missing"), toolBlock).matches);
ok("body substring matches case-insensitively", matchBlock(parseQuery("HIDDEN NEEDLE"), toolBlock).matches);
ok(
	"scattered body characters do not fuzzy-match",
	!matchBlock(parseQuery("needle"), makeBlock({ body: "n e e d l e" })).matches,
);
ok(
	"separator-scattered body text is reachable through the stripped fallback",
	matchBlock(parseQuery("needle"), makeBlock({ body: "n-e.e_d/l:e" })).matches,
);
ok(
	"free tokens never search the fields blob",
	!matchBlock(parseQuery("entry-42"), toolBlock).matches
	&& !matchBlock(parseQuery("call-77"), toolBlock).matches,
);
eq(
	"matched token forms are reported for highlight re-derivation",
	(() => {
		const match = matchBlock(parseQuery("sconf needle"), toolBlock);
		return { keyTokens: match.keyTokens, bodyTokens: match.bodyTokens };
	})(),
	{ keyTokens: ["sconf"], bodyTokens: ["needle"] },
);

const cumulative = matchBlock(parseQuery("tool read"), toolBlock);
eq(
	"key scores accumulate across tokens",
	cumulative.score,
	fuzzyMatch("tool", toolBlock.searchKey).score + fuzzyMatch("read", toolBlock.searchKey).score,
);

// Separator fallback: raw first, stripped retry at a +5 penalty

const spawnBlock = makeBlock({
	id: "spawn-block",
	kind: "tool",
	toolName: "subagent_spawn",
	title: "subagent_spawn",
	subtitle: "agent=scout",
});
const rawKey = matchBlock(parseQuery("subagent"), spawnBlock);
eq("raw token matching the key carries no penalty", rawKey.score, fuzzyMatch("subagent", spawnBlock.searchKey).score);
const strippedKey = matchBlock(parseQuery("sub-agent"), spawnBlock);
ok("separator-bearing token falls back to its stripped form against the key", strippedKey.matches);
eq(
	"stripped key fallback scores the stripped token plus the penalty",
	strippedKey.score,
	fuzzyMatch("subagent", spawnBlock.searchKey).score + 5,
);
eq("stripped key fallback reports the stripped token form", strippedKey.keyTokens, ["subagent"]);

const dashedBody = makeBlock({ id: "dashed-body", body: "started the sub-agent now" });
const strippedBodyMatch = matchBlock(parseQuery("subagent"), dashedBody);
ok("token without separators still matches a separator-bearing body", strippedBodyMatch.matches);
eq("stripped body fallback carries the +5 penalty", strippedBodyMatch.score, 5);
eq("stripped body fallback reports the stripped form", strippedBodyMatch.bodyTokens, ["subagent"]);
const plainBody = makeBlock({ id: "plain-body", body: "started the subagent now" });
eq("token with separators matches a plain body through stripping", matchBlock(parseQuery("sub-agent"), plainBody).score, 5);
eq("raw body substring matches contribute score 0", matchBlock(parseQuery("subagent"), plainBody).score, 0);
ok("an all-separator token cannot match everything", !matchBlock(parseQuery("--"), plainBody).matches);

// `any:` widens to the full haystack as substring, never fuzzy

const anyBlock = makeBlock({
	id: "any-block",
	kind: "tool",
	toolName: "write",
	title: "write",
	fields: "role:assistant type:tool tool:write toolCallId:toolu_015abc entry:entry-9",
	body: "short body",
	canonicalText: "write {\n  \"path\": \"src/deep/value.ts\"\n}\n\nshort body",
});
ok("any: matches fields-blob needles free tokens cannot reach", matchBlock(parseQuery("any:toolu_015"), anyBlock).matches);
ok("any: matches canonical argument text", matchBlock(parseQuery("any:deep/value"), anyBlock).matches);
ok("any: is substring, never fuzzy", !matchBlock(parseQuery("any:tlu015"), anyBlock).matches);
ok("any: applies the separator-stripped fallback", matchBlock(parseQuery("any:toolu015"), anyBlock).matches);
eq("any: stripped fallback carries the +5 penalty", matchBlock(parseQuery("any:toolu015"), anyBlock).score, 5);
eq("any: raw substring contributes score 0", matchBlock(parseQuery("any:toolu_015"), anyBlock).score, 0);
ok("any: rejects absent needles", !matchBlock(parseQuery("any:missing-needle"), anyBlock).matches);

// `is:` and `tool:` are fuzzy patterns whose scores join the block score

const summary = makeBlock({ id: "summary-block", kind: "summary", title: "Branch summary" });
const assistant = makeBlock({ id: "assistant-block", kind: "assistant" });
const userBlock = makeBlock({ id: "user-block", kind: "user" });
ok("is: fuzzy-matches the kind", matchBlock(parseQuery("is:s"), summary).matches);
ok("is: keeps every kind the pattern matches", matchBlock(parseQuery("is:s"), assistant).matches);
ok("is: excludes kinds missing the pattern", !matchBlock(parseQuery("is:s"), toolBlock).matches);
eq("is: contributes its fuzzy score", matchBlock(parseQuery("is:s"), summary).score, fuzzyMatch("s", "summary").score);
ok("tool: fuzzy-matches partial names", matchBlock(parseQuery("tool:rd"), toolBlock).matches);
eq("tool: contributes its fuzzy score", matchBlock(parseQuery("tool:rd"), toolBlock).score, fuzzyMatch("rd", "read").score);
ok("tool: rejects blocks without a tool name", !matchBlock(parseQuery("tool:read"), assistant).matches);
ok(
	"operator-looking body text cannot satisfy a recognized operator",
	!matchBlock(parseQuery("tool:write"), makeBlock({ kind: "tool", toolName: "read", title: "read", body: "tool:write" })).matches,
);
eq(
	"is:s ranks word-boundary kinds above interior hits",
	ids(searchBlocks([assistant, summary], "is:s")),
	["summary-block", "assistant-block"],
);

const pathKeyBlock = makeBlock({ searchKey: "assistant path:src/config.ts" });
ok("unknown operator-shaped token is searched normally", matchBlock(parseQuery("path:src/config.ts"), pathKeyBlock).matches);
ok("a slash path remains one searchable token", matchBlock(parseQuery("src/config.ts"), pathKeyBlock).matches);

// When a token hits both the key and the body, the better contribution wins.

const crispBoth = makeBlock({
	id: "crisp-both",
	kind: "tool",
	toolName: "read",
	title: "read",
	body: "read the stored file",
});
const crispBothMatch = matchBlock(parseQuery("read"), crispBoth);
eq("a crisp key hit outranks the body tier when both match",
	[crispBothMatch.score, crispBothMatch.keyTokens, crispBothMatch.bodyTokens],
	[fuzzyMatch("read", crispBoth.searchKey).score, ["read"], ["read"]]);
const noisyKey = makeBlock({
	id: "noisy-key",
	kind: "tool",
	toolName: "write",
	title: "write",
	subtitle: "command=scripts/exec.sh flags=no-verbose depth=12 label=deploy",
	body: "the needle sits in the stored body",
});
const noisyMatch = matchBlock(parseQuery("needle"), noisyKey);
ok("the noisy key incidentally subsequence-matches", fuzzyMatch("needle", noisyKey.searchKey).matches);
eq("incidental key noise cannot bury an exact body hit",
	[noisyMatch.score, noisyMatch.keyTokens, noisyMatch.bodyTokens],
	[0, [], ["needle"]]);

// Ordering, tiering, and tie-breaks

const oldBody = makeBlock({ id: "old-body", body: "needle early" });
const crispKey = makeBlock({ id: "crisp-key", kind: "tool", toolName: "needle", title: "needle" });
const newBody = makeBlock({ id: "new-body", body: "needle late" });
const corpus = [oldBody, crispKey, newBody];

eq("empty query keeps every block in chronological order", ids(searchBlocks(corpus, "")), [
	"old-body", "crisp-key", "new-body",
]);
eq("whitespace-only query stays chronological", ids(searchBlocks(corpus, "   ")), [
	"old-body", "crisp-key", "new-body",
]);
eq("active query orders by relevance with crisp key hits first", ids(searchBlocks(corpus, "needle")), [
	"crisp-key", "new-body", "old-body",
]);
eq(
	"body-only matches score 0 and tie-break newest first",
	searchBlocks(corpus, "needle").slice(1).map((result) => result.match.score),
	[0, 0],
);
eq("operator-only queries are active and order newest first among ties", ids(searchBlocks(corpus, "is:assistant")), [
	"new-body", "old-body",
]);
ok(
	"empty query matches report no tokens",
	searchBlocks(corpus, "").every((result) =>
		result.match.keyTokens.length === 0 && result.match.bodyTokens.length === 0 && result.match.score === 0,
	),
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
