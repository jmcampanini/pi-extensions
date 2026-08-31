import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	assertValidThinkingLevel,
	listUsableModels,
	resolveUsableModel,
	summarizeUsableModels,
	THINKING_LEVELS,
	USABLE_MODELS_MAX_LISTED,
} from "../models.ts";

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
		assert.strictEqual(resolveUsableModel(["OpenAI-Codex/GPT-X"], registry, []), "openai-codex/gpt-x");
	});

	it("bare unique win", () => {
		// bare id, unique among AUTHED providers (openrouter has no auth) -> wins
		assert.strictEqual(resolveUsableModel(["gpt-x"], registry, []), "openai-codex/gpt-x");
	});

	it("fallback order", () => {
		// list order: bad entry falls through to bare winner
		assert.strictEqual(resolveUsableModel(["nope/nothing", "gpt-x"], registry, []), "openai-codex/gpt-x");
	});

	it("ambiguous falls through", () => {
		// bare ambiguous (two authed providers) -> that entry fails, next wins
		assert.strictEqual(resolveUsableModel(["dual-model", "anthropic/claude-y"], registry, []), "anthropic/claude-y");
	});

	it("ambiguous alone", () => {
		// bare ambiguous alone -> error names both providers
		assert.throws(
			() => resolveUsableModel(["dual-model"], registry, []),
			includesAll(["ambiguous", "openai-codex", "anthropic"]),
		);
	});

	it("bare no-auth", () => {
		// bare known but credential-less provider
		assert.throws(
			() => resolveUsableModel(["orphan-model"], registry, []),
			includesAll(["known (groq)", "credentials"]),
		);
	});

	it("qualified no-auth", () => {
		// qualified known but no auth
		assert.throws(
			() => resolveUsableModel(["groq/orphan-model"], registry, []),
			includesAll(['provider "groq" has no credentials']),
		);
	});

	it("unknown", () => {
		// unknown everywhere
		assert.throws(() => resolveUsableModel(["nope"], registry, []), includesAll(["unknown model"]));
	});

	it("malformed", () => {
		assert.throws(() => resolveUsableModel(["/gpt-x"], registry, []), includesAll(["malformed"]));
	});
});

describe("resolution failures name the usable ids", () => {
	const usable = ["openai-codex/gpt-x", "anthropic/claude-y"];

	it("a nickname miss lists the exact ids to use instead", () => {
		assert.throws(
			() => resolveUsableModel(["terra"], registry, usable),
			includesAll(["terra - unknown model", "Usable models", "openai-codex/gpt-x, anthropic/claude-y"]),
		);
	});

	it("an empty usable list adds no trailer", () => {
		assert.throws(() => resolveUsableModel(["terra"], registry, []), (error: unknown) => !String(error).includes("Usable models"));
	});
});

describe("listUsableModels", () => {
	const available = [
		{ provider: "openai-codex", id: "gpt-x" },
		{ provider: "lm-studio", id: "local/small" },
		{ provider: "anthropic", id: "claude-y" },
	];
	const scoped = [{ model: { provider: "openai-codex", id: "gpt-x" } }, { model: { provider: "anthropic", id: "claude-y" } }];

	it("scoped models win over the available catalogue", () => {
		const models = listUsableModels({ scopedModels: scoped, modelRegistry: { getAvailable: () => available }, model: undefined });

		assert.deepStrictEqual(models.ids, ["openai-codex/gpt-x", "anthropic/claude-y"]);
	});

	it("an unscoped session lists every available model", () => {
		const models = listUsableModels({ scopedModels: [], modelRegistry: { getAvailable: () => available }, model: undefined });

		assert.deepStrictEqual(models.ids, ["openai-codex/gpt-x", "lm-studio/local/small", "anthropic/claude-y"]);
	});

	it("the current model is reported in canonical form", () => {
		const models = listUsableModels({ scopedModels: scoped, modelRegistry: { getAvailable: () => available }, model: { provider: "anthropic", id: "claude-y" } });

		assert.strictEqual(models.current, "anthropic/claude-y");
	});

	it("no selected model means no current entry", () => {
		const models = listUsableModels({ scopedModels: scoped, modelRegistry: { getAvailable: () => available }, model: undefined });

		assert.strictEqual("current" in models, false);
	});
});

describe("summarizeUsableModels", () => {
	it("short lists are joined whole", () => {
		assert.strictEqual(summarizeUsableModels(["a/b", "c/d"]), "a/b, c/d");
	});

	it("long lists are bounded with a count and a pointer", () => {
		const ids = Array.from({ length: USABLE_MODELS_MAX_LISTED + 3 }, (_, i) => `p/m${i}`);

		const summary = summarizeUsableModels(ids);

		assert.ok(summary.endsWith(", +3 more (call subagent_available for the full list)"));
		assert.ok(!summary.includes(`p/m${USABLE_MODELS_MAX_LISTED}`));
	});
});
