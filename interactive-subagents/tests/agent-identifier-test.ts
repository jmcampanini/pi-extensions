import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	AGENT_IDENTIFIER_MAX_COLUMNS,
	agentIdentifierProblem,
	assertValidAgentIdentifier,
	isValidAgentIdentifier,
} from "../agent-identifier.ts";

const family = "👨‍👩‍👧‍👦";

describe("agent-identifier", () => {
	it("identifier maximum is 20 display columns", () => {
		assert.strictEqual(AGENT_IDENTIFIER_MAX_COLUMNS, 20);
	});

	it("20 ASCII columns are valid", () => {
		assert.strictEqual(isValidAgentIdentifier("abcdefghijklmnopqrst"), true);
	});

	it("21 ASCII columns are invalid", () => {
		assert.strictEqual(isValidAgentIdentifier("abcdefghijklmnopqrstu"), false);
	});

	it("five CJK pairs occupy the valid boundary", () => {
		assert.strictEqual(isValidAgentIdentifier("検索".repeat(5)), true);
	});

	it("one more wide glyph exceeds the boundary", () => {
		assert.strictEqual(isValidAgentIdentifier("検索".repeat(5) + "検"), false);
	});

	it("ten family emoji graphemes occupy the valid boundary", () => {
		assert.strictEqual(isValidAgentIdentifier(family.repeat(10)), true);
	});

	it("eleven family emoji graphemes exceed the boundary", () => {
		assert.strictEqual(isValidAgentIdentifier(family.repeat(11)), false);
	});

	it("combining marks use terminal display width", () => {
		assert.strictEqual(isValidAgentIdentifier("e\u0301".repeat(20)), true);
	});

	it("empty identifiers are rejected", () => {
		assert.throws(
			() => assertValidAgentIdentifier(""),
			(error) => String(error).includes("non-empty"),
		);
	});

	it("spaces are rejected", () => {
		assert.throws(
			() => assertValidAgentIdentifier("code reviewer"),
			(error) => String(error).includes("whitespace"),
		);
	});

	it("tabs are rejected", () => {
		assert.throws(
			() => assertValidAgentIdentifier("code\treviewer"),
			(error) => String(error).includes("whitespace"),
		);
	});

	it("newlines are rejected", () => {
		assert.throws(
			() => assertValidAgentIdentifier("code\nreviewer"),
			(error) => String(error).includes("whitespace"),
		);
	});

	it("non-strings are rejected", () => {
		assert.throws(
			() => assertValidAgentIdentifier(20),
			(error) => String(error).includes("non-empty string"),
		);
	});

	it("problem reports measured overage", () => {
		assert.strictEqual(agentIdentifierProblem("検索".repeat(6))?.includes("got 24"), true);
	});
});
