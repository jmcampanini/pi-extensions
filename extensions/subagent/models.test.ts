import { describe, expect, it } from "vitest";
import { matchModel } from "./models.ts";

const m = (provider: string, id: string, name = id) => ({ provider, id, name });
const available = [
	m("anthropic", "claude-opus-4-7", "Claude Opus 4.7"),
	m("anthropic", "claude-sonnet-4-6", "Claude Sonnet 4.6"),
	m("anthropic", "claude-sonnet-5", "Claude Sonnet 5"),
	m("openai-codex", "gpt-6-luna", "GPT-6 Luna"),
	m("openai-codex", "gpt-5.6-luna", "GPT-5.6 Luna"),
	m("openrouter", "gpt-6-luna", "GPT-6 Luna via OpenRouter"),
];
const scoped = [m("openai-codex", "gpt-6-luna", "GPT-6 Luna")];

describe("matchModel", () => {
	it("resolves provider/id exactly even when the bare id is offered by several providers", () => {
		const match = matchModel("openrouter/gpt-6-luna", scoped, available);
		expect(match).toEqual({ status: "resolved", model: available[5] });
	});

	it("prefers the session's scoped models for a short name", () => {
		const match = matchModel("luna", scoped, available);
		expect(match).toEqual({ status: "resolved", model: scoped[0] });
	});

	it("falls back to every available model when nothing scoped matches", () => {
		const match = matchModel("opus", scoped, available);
		expect(match).toEqual({ status: "resolved", model: available[0] });
	});

	it("reports every candidate when a substring is ambiguous", () => {
		const match = matchModel("sonnet", [], available);
		expect(match.status).toBe("ambiguous");
		expect(match.status === "ambiguous" && match.candidates.map((c) => c.id)).toEqual(["claude-sonnet-4-6", "claude-sonnet-5"]);
	});

	it("matches case-insensitively against display names", () => {
		expect(matchModel("OPUS 4.7", [], available)).toEqual({ status: "resolved", model: available[0] });
	});

	it("reports not-found with the available list", () => {
		const match = matchModel("gemini", scoped, available);
		expect(match.status).toBe("not-found");
		expect(match.status === "not-found" && match.available).toHaveLength(available.length);
	});
});
