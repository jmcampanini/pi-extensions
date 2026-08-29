import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planSubmit } from "../plan.ts";

const known = new Set(["write-pr-body", "codex-web-search"]);

describe("planSubmit", () => {
	it("hoists a mid-sentence mention onto pi's native skill command", () => {
		const plan = planSubmit("tests pass, please $write-pr-body for this branch", known);
		assert.deepEqual(plan, {
			kind: "hoist",
			name: "write-pr-body",
			text: "/skill:write-pr-body tests pass, please $write-pr-body for this branch",
		});
	});

	it("hoists a mention at the start of the message", () => {
		const plan = planSubmit("$codex-web-search pi editor internals", known);
		assert.deepEqual(plan, {
			kind: "hoist",
			name: "codex-web-search",
			text: "/skill:codex-web-search $codex-web-search pi editor internals",
		});
	});

	it("matches a mention that ends a clause with punctuation", () => {
		const plan = planSubmit("use $write-pr-body, then push", known);
		assert.equal(plan.kind, "hoist");
	});

	it("finds a mention on any line of a multiline message", () => {
		const text = "line one\nplease $codex-web-search this";
		assert.deepEqual(planSubmit(text, known), {
			kind: "hoist",
			name: "codex-web-search",
			text: `/skill:codex-web-search ${text}`,
		});
	});

	it("passes through when no token names an installed skill", () => {
		assert.deepEqual(planSubmit("costs $5 and $writepr is a typo", known), { kind: "pass" });
	});

	it("never matches uppercase environment-variable style tokens", () => {
		assert.deepEqual(planSubmit("echo $PATH please", new Set(["path"])), { kind: "pass" });
	});

	it("ignores sigils glued to preceding text or doubled", () => {
		assert.deepEqual(planSubmit("foo$write-pr-body", known), { kind: "pass" });
		assert.deepEqual(planSubmit("$$write-pr-body", known), { kind: "pass" });
	});

	it("does not let a longer unknown name shadow-match a known prefix", () => {
		assert.deepEqual(planSubmit("run $write-pr-body-draft now", known), { kind: "pass" });
	});

	it("fails closed on two known mentions", () => {
		const plan = planSubmit("$write-pr-body and $codex-web-search", known);
		assert.deepEqual(plan, { kind: "conflict", names: ["write-pr-body", "codex-web-search"] });
	});

	it("fails closed on the same skill mentioned twice", () => {
		const plan = planSubmit("do $write-pr-body then $write-pr-body again", known);
		assert.equal(plan.kind, "conflict");
	});

	it("leaves messages that already start with a slash alone", () => {
		assert.deepEqual(planSubmit("/skill:write-pr-body do it", known), { kind: "pass" });
		assert.deepEqual(planSubmit("/model check $write-pr-body", known), { kind: "pass" });
	});
});
