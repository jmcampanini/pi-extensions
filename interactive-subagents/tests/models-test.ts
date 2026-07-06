import { resolveUsableModel } from "../models.ts";

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

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown) {
	if (got === want) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
function throws(label: string, fn: () => void, contains: string[]) {
	try { fn(); fail++; console.log(`  FAIL ${label}: expected throw`); }
	catch (e) {
		const msg = String(e);
		const missing = contains.filter((c) => !msg.includes(c));
		if (missing.length === 0) { pass++; console.log(`  ok  ${label}`); }
		else { fail++; console.log(`  FAIL ${label}: message missing ${JSON.stringify(missing)}\n    ${msg}`); }
	}
}

// qualified entry wins, canonical casing
eq("qualified win", resolveUsableModel(["OpenAI-Codex/GPT-X"], registry), "openai-codex/gpt-x");
// bare id, unique among AUTHED providers (openrouter has no auth) -> wins
eq("bare unique win", resolveUsableModel(["gpt-x"], registry), "openai-codex/gpt-x");
// list order: bad entry falls through to bare winner
eq("fallback order", resolveUsableModel(["nope/nothing", "gpt-x"], registry), "openai-codex/gpt-x");
// bare ambiguous (two authed providers) -> that entry fails, next wins
eq("ambiguous falls through", resolveUsableModel(["dual-model", "anthropic/claude-y"], registry), "anthropic/claude-y");
// bare ambiguous alone -> error names both providers
throws("ambiguous alone", () => resolveUsableModel(["dual-model"], registry), ["ambiguous", "openai-codex", "anthropic"]);
// bare known but credential-less provider
throws("bare no-auth", () => resolveUsableModel(["orphan-model"], registry), ["known (groq)", "credentials"]);
// qualified known but no auth
throws("qualified no-auth", () => resolveUsableModel(["groq/orphan-model"], registry), ['provider "groq" has no credentials']);
// unknown everywhere
throws("unknown", () => resolveUsableModel(["nope"], registry), ["unknown model"]);
// malformed
throws("malformed", () => resolveUsableModel(["/gpt-x"], registry), ["malformed"]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
