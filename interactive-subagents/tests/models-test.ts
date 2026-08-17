import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertValidThinkingLevel, resolveUsableModel, THINKING_LEVELS } from "../models.ts";

// Fake registry: gpt-x offered by two providers (only one with auth),
// dual-model offered by two providers BOTH with auth (ambiguous),
// orphan-model only by a credential-less provider.
const models = [
	{ provider: "openai-codex", id: "gpt-x" },
	{ provider: "openrouter", id: "gpt-x" },
	{ provider: "openai-codex", id: "dual-model" },
	{ provider: "anthropic", id: "dual-model" },
	{ provider: "groq", id: "orphan-model" },
	{ provider: "anthropic", id: "claude-y" },
];
const authed = new Set(["openai-codex", "anthropic"]);
const registry = {
	getAll: () => models,
	hasConfiguredAuth: (m: { provider: string }) => authed.has(m.provider),
} as any;

function includesAll(contains: string[]): (error: unknown) => boolean {
	return (error) => contains.every((needle) => String(error).includes(needle));
}

describe("thinking levels", () => {
	it("thinking levels mirror Pi", () => {
		assert.strictEqual(THINKING_LEVELS.join(", "), "off, minimal, low, medium, high, xhigh, max");
	});

	it("max thinking accepted", () => {
		assert.strictEqual(assertValidThinkingLevel("max"), undefined);
	});

	it("invalid thinking rejected", () => {
		assert.throws(() => assertValidThinkingLevel("ultra"), includesAll(["valid levels", "max"]));
	});
});

describe("resolveUsableModel", () => {
	it("qualified win", () => {
		// qualified entry wins, canonical casing
		assert.strictEqual(resolveUsableModel(["OpenAI-Codex/GPT-X"], registry), "openai-codex/gpt-x");
	});

	it("bare unique win", () => {
		// bare id, unique among AUTHED providers (openrouter has no auth) -> wins
		assert.strictEqual(resolveUsableModel(["gpt-x"], registry), "openai-codex/gpt-x");
	});

	it("fallback order", () => {
		// list order: bad entry falls through to bare winner
		assert.strictEqual(resolveUsableModel(["nope/nothing", "gpt-x"], registry), "openai-codex/gpt-x");
	});

	it("ambiguous falls through", () => {
		// bare ambiguous (two authed providers) -> that entry fails, next wins
		assert.strictEqual(resolveUsableModel(["dual-model", "anthropic/claude-y"], registry), "anthropic/claude-y");
	});

	it("ambiguous alone", () => {
		// bare ambiguous alone -> error names both providers
		assert.throws(
			() => resolveUsableModel(["dual-model"], registry),
			includesAll(["ambiguous", "openai-codex", "anthropic"]),
		);
	});

	it("bare no-auth", () => {
		// bare known but credential-less provider
		assert.throws(
			() => resolveUsableModel(["orphan-model"], registry),
			includesAll(["known (groq)", "credentials"]),
		);
	});

	it("qualified no-auth", () => {
		// qualified known but no auth
		assert.throws(
			() => resolveUsableModel(["groq/orphan-model"], registry),
			includesAll(['provider "groq" has no credentials']),
		);
	});

	it("unknown", () => {
		// unknown everywhere
		assert.throws(() => resolveUsableModel(["nope"], registry), includesAll(["unknown model"]));
	});

	it("malformed", () => {
		assert.throws(() => resolveUsableModel(["/gpt-x"], registry), includesAll(["malformed"]));
	});
});
