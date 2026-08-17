import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fuzzyMatch } from "@earendil-works/pi-tui";
import { parseQuery } from "../query.ts";
import { matchBlock, searchBlocks, stripSeparators } from "../search.ts";
import { makeBlock } from "./block-factory.ts";

function ids(results: ReturnType<typeof searchBlocks>): string[] {
	return results.map((result) => result.block.id);
}

const toolBlock = makeBlock({
	id: "tool-block",
	kind: "tool",
	toolName: "read",
	title: "read",
	subtitle: "path=src/config.ts",
	fields: "role:assistant type:tool tool:read toolCallId:call-77 entry:entry-42 timestamp:2026-01-01 00:00:01Z",
	body: "The stored result contains a Hidden Needle.",
});

describe("parseQuery", () => {
	it("whitespace tokenization retains slash paths", () => {
		assert.deepStrictEqual(parseQuery("  src/config.ts\tother/path  "), {
			tokens: ["src/config.ts", "other/path"],
			operators: [],
		});
	});

	it("known operator keys are case-insensitive", () => {
		assert.deepStrictEqual(parseQuery("IS:user ToOl:Read AnY:toolu_01"), {
			tokens: [],
			operators: [
				{ key: "is", value: "user" },
				{ key: "tool", value: "Read" },
				{ key: "any", value: "toolu_01" },
			],
		});
	});

	it("unknown and empty operators remain tokens", () => {
		assert.deepStrictEqual(parseQuery("path:src/config.ts owner:me is: tool: any:"), {
			tokens: ["path:src/config.ts", "owner:me", "is:", "tool:", "any:"],
			operators: [],
		});
	});
});

describe("stripSeparators", () => {
	it("stripping removes the matcher's separator class", () => {
		assert.strictEqual(stripSeparators("a-b_c.d/e:f g"), "abcdef g");
	});
});

describe("matchBlock key and body matching", () => {
	it("free tokens fuzzy-match the curated search key", () => {
		assert.ok(matchBlock(parseQuery("sconf"), toolBlock).matches);
	});

	it("all tokens may match across key and body", () => {
		assert.ok(matchBlock(parseQuery("sconf hidden needle"), toolBlock).matches);
	});

	it("all plain tokens are required", () => {
		assert.ok(!matchBlock(parseQuery("sconf missing"), toolBlock).matches);
	});

	it("body substring matches case-insensitively", () => {
		assert.ok(matchBlock(parseQuery("HIDDEN NEEDLE"), toolBlock).matches);
	});

	it("scattered body characters do not fuzzy-match", () => {
		assert.ok(!matchBlock(parseQuery("needle"), makeBlock({ body: "n e e d l e" })).matches);
	});

	it("separator-scattered body text is reachable through the stripped fallback", () => {
		assert.ok(matchBlock(parseQuery("needle"), makeBlock({ body: "n-e.e_d/l:e" })).matches);
	});

	it("free tokens never search the fields blob", () => {
		assert.ok(
			!matchBlock(parseQuery("entry-42"), toolBlock).matches
			&& !matchBlock(parseQuery("call-77"), toolBlock).matches,
		);
	});

	it("matched token forms are reported for highlight re-derivation", () => {
		const match = matchBlock(parseQuery("sconf needle"), toolBlock);
		assert.deepStrictEqual(
			{ keyTokens: match.keyTokens, bodyTokens: match.bodyTokens },
			{ keyTokens: ["sconf"], bodyTokens: ["needle"] },
		);
	});

	it("key scores accumulate across tokens", () => {
		const cumulative = matchBlock(parseQuery("tool read"), toolBlock);
		assert.strictEqual(
			cumulative.score,
			fuzzyMatch("tool", toolBlock.searchKey).score + fuzzyMatch("read", toolBlock.searchKey).score,
		);
	});
});

describe("matchBlock separator fallback", () => {
	const spawnBlock = makeBlock({
		id: "spawn-block",
		kind: "tool",
		toolName: "subagent_spawn",
		title: "subagent_spawn",
		subtitle: "agent=scout",
	});
	const dashedBody = makeBlock({ id: "dashed-body", body: "started the sub-agent now" });
	const plainBody = makeBlock({ id: "plain-body", body: "started the subagent now" });

	it("raw token matching the key carries no penalty", () => {
		assert.strictEqual(
			matchBlock(parseQuery("subagent"), spawnBlock).score,
			fuzzyMatch("subagent", spawnBlock.searchKey).score,
		);
	});

	it("separator-bearing token falls back to its stripped form against the key", () => {
		const strippedKey = matchBlock(parseQuery("sub-agent"), spawnBlock);
		assert.ok(strippedKey.matches);
		assert.strictEqual(
			strippedKey.score,
			fuzzyMatch("subagent", spawnBlock.searchKey).score + 5,
			"stripped key fallback scores the stripped token plus the penalty",
		);
		assert.deepStrictEqual(strippedKey.keyTokens, ["subagent"],
			"stripped key fallback reports the stripped token form");
	});

	it("token without separators still matches a separator-bearing body", () => {
		const strippedBodyMatch = matchBlock(parseQuery("subagent"), dashedBody);
		assert.ok(strippedBodyMatch.matches);
		assert.strictEqual(strippedBodyMatch.score, 5, "stripped body fallback carries the +5 penalty");
		assert.deepStrictEqual(strippedBodyMatch.bodyTokens, ["subagent"],
			"stripped body fallback reports the stripped form");
	});

	it("token with separators matches a plain body through stripping", () => {
		assert.strictEqual(matchBlock(parseQuery("sub-agent"), plainBody).score, 5);
	});

	it("raw body substring matches contribute score 0", () => {
		assert.strictEqual(matchBlock(parseQuery("subagent"), plainBody).score, 0);
	});

	it("an all-separator token cannot match everything", () => {
		assert.ok(!matchBlock(parseQuery("--"), plainBody).matches);
	});
});

describe("matchBlock any: operator", () => {
	const anyBlock = makeBlock({
		id: "any-block",
		kind: "tool",
		toolName: "write",
		title: "write",
		fields: "role:assistant type:tool tool:write toolCallId:toolu_015abc entry:entry-9",
		body: "short body",
		canonicalText: "write {\n  \"path\": \"src/deep/value.ts\"\n}\n\nshort body",
	});

	it("any: matches fields-blob needles free tokens cannot reach", () => {
		assert.ok(matchBlock(parseQuery("any:toolu_015"), anyBlock).matches);
	});

	it("any: matches canonical argument text", () => {
		assert.ok(matchBlock(parseQuery("any:deep/value"), anyBlock).matches);
	});

	it("any: is substring, never fuzzy", () => {
		assert.ok(!matchBlock(parseQuery("any:tlu015"), anyBlock).matches);
	});

	it("any: applies the separator-stripped fallback", () => {
		assert.ok(matchBlock(parseQuery("any:toolu015"), anyBlock).matches);
		assert.strictEqual(matchBlock(parseQuery("any:toolu015"), anyBlock).score, 5,
			"any: stripped fallback carries the +5 penalty");
	});

	it("any: raw substring contributes score 0", () => {
		assert.strictEqual(matchBlock(parseQuery("any:toolu_015"), anyBlock).score, 0);
	});

	it("any: rejects absent needles", () => {
		assert.ok(!matchBlock(parseQuery("any:missing-needle"), anyBlock).matches);
	});
});

describe("matchBlock is: and tool: operators", () => {
	const summary = makeBlock({ id: "summary-block", kind: "summary", title: "Branch summary" });
	const assistant = makeBlock({ id: "assistant-block", kind: "assistant" });

	it("is: fuzzy-matches the kind", () => {
		assert.ok(matchBlock(parseQuery("is:s"), summary).matches);
	});

	it("is: keeps every kind the pattern matches", () => {
		assert.ok(matchBlock(parseQuery("is:s"), assistant).matches);
	});

	it("is: excludes kinds missing the pattern", () => {
		assert.ok(!matchBlock(parseQuery("is:s"), toolBlock).matches);
	});

	it("is: contributes its fuzzy score", () => {
		assert.strictEqual(matchBlock(parseQuery("is:s"), summary).score, fuzzyMatch("s", "summary").score);
	});

	it("tool: fuzzy-matches partial names", () => {
		assert.ok(matchBlock(parseQuery("tool:rd"), toolBlock).matches);
	});

	it("tool: contributes its fuzzy score", () => {
		assert.strictEqual(matchBlock(parseQuery("tool:rd"), toolBlock).score, fuzzyMatch("rd", "read").score);
	});

	it("tool: rejects blocks without a tool name", () => {
		assert.ok(!matchBlock(parseQuery("tool:read"), assistant).matches);
	});

	it("operator-looking body text cannot satisfy a recognized operator", () => {
		assert.ok(!matchBlock(
			parseQuery("tool:write"),
			makeBlock({ kind: "tool", toolName: "read", title: "read", body: "tool:write" }),
		).matches);
	});

	it("is:s ranks word-boundary kinds above interior hits", () => {
		assert.deepStrictEqual(
			ids(searchBlocks([assistant, summary], "is:s")),
			["summary-block", "assistant-block"],
		);
	});

	it("unknown operator-shaped token is searched normally", () => {
		const pathKeyBlock = makeBlock({ searchKey: "assistant path:src/config.ts" });
		assert.ok(matchBlock(parseQuery("path:src/config.ts"), pathKeyBlock).matches);
		assert.ok(matchBlock(parseQuery("src/config.ts"), pathKeyBlock).matches,
			"a slash path remains one searchable token");
	});
});

describe("matchBlock key versus body tier", () => {
	it("a crisp key hit outranks the body tier when both match", () => {
		const crispBoth = makeBlock({
			id: "crisp-both",
			kind: "tool",
			toolName: "read",
			title: "read",
			body: "read the stored file",
		});
		const crispBothMatch = matchBlock(parseQuery("read"), crispBoth);
		assert.deepStrictEqual(
			[crispBothMatch.score, crispBothMatch.keyTokens, crispBothMatch.bodyTokens],
			[fuzzyMatch("read", crispBoth.searchKey).score, ["read"], ["read"]],
		);
	});

	it("incidental key noise cannot bury an exact body hit", () => {
		const noisyKey = makeBlock({
			id: "noisy-key",
			kind: "tool",
			toolName: "write",
			title: "write",
			subtitle: "command=scripts/exec.sh flags=no-verbose depth=12 label=deploy",
			body: "the needle sits in the stored body",
		});
		const noisyMatch = matchBlock(parseQuery("needle"), noisyKey);
		assert.ok(fuzzyMatch("needle", noisyKey.searchKey).matches,
			"the noisy key incidentally subsequence-matches");
		assert.deepStrictEqual(
			[noisyMatch.score, noisyMatch.keyTokens, noisyMatch.bodyTokens],
			[0, [], ["needle"]],
		);
	});
});

describe("searchBlocks ordering", () => {
	const oldBody = makeBlock({ id: "old-body", body: "needle early" });
	const crispKey = makeBlock({ id: "crisp-key", kind: "tool", toolName: "needle", title: "needle" });
	const newBody = makeBlock({ id: "new-body", body: "needle late" });
	const corpus = [oldBody, crispKey, newBody];

	it("empty query keeps every block in chronological order", () => {
		assert.deepStrictEqual(ids(searchBlocks(corpus, "")), ["old-body", "crisp-key", "new-body"]);
	});

	it("whitespace-only query stays chronological", () => {
		assert.deepStrictEqual(ids(searchBlocks(corpus, "   ")), ["old-body", "crisp-key", "new-body"]);
	});

	it("active query orders by relevance with crisp key hits first", () => {
		assert.deepStrictEqual(ids(searchBlocks(corpus, "needle")), ["crisp-key", "new-body", "old-body"]);
	});

	it("body-only matches score 0 and tie-break newest first", () => {
		assert.deepStrictEqual(
			searchBlocks(corpus, "needle").slice(1).map((result) => result.match.score),
			[0, 0],
		);
	});

	it("operator-only queries are active and order newest first among ties", () => {
		assert.deepStrictEqual(ids(searchBlocks(corpus, "is:assistant")), ["new-body", "old-body"]);
	});

	it("empty query matches report no tokens", () => {
		assert.ok(searchBlocks(corpus, "").every((result) =>
			result.match.keyTokens.length === 0 && result.match.bodyTokens.length === 0 && result.match.score === 0,
		));
	});
});
