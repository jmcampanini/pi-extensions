import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { createInlineSkillsProvider } from "../provider.ts";
import type { InstalledSkill } from "../skills.ts";

const skills: InstalledSkill[] = [
	{ name: "write-pr-body", description: "Write pull request titles and bodies" },
	{ name: "codex-web-search" },
];

const innerSuggestions: AutocompleteSuggestions = {
	items: [{ value: "inner", label: "inner" }],
	prefix: "inner",
};

function fakeCurrent() {
	const calls: string[] = [];
	const current: AutocompleteProvider = {
		async getSuggestions() {
			calls.push("getSuggestions");
			return innerSuggestions;
		},
		applyCompletion(lines, cursorLine, cursorCol) {
			calls.push("applyCompletion");
			return { lines, cursorLine, cursorCol };
		},
		shouldTriggerFileCompletion() {
			calls.push("shouldTriggerFileCompletion");
			return false;
		},
	};
	return { current, calls };
}

const options = { signal: new AbortController().signal };

describe("createInlineSkillsProvider", () => {
	it("declares only the $ trigger character", () => {
		const provider = createInlineSkillsProvider(fakeCurrent().current, () => skills);
		assert.deepEqual(provider.triggerCharacters, ["$"]);
	});

	it("lists every installed skill on a bare $", async () => {
		const provider = createInlineSkillsProvider(fakeCurrent().current, () => skills);
		const result = await provider.getSuggestions(["please $"], 0, 8, options);
		assert.deepEqual(result, {
			prefix: "$",
			items: [
				{ value: "$write-pr-body", label: "$write-pr-body", description: "Write pull request titles and bodies" },
				{ value: "$codex-web-search", label: "$codex-web-search", description: undefined },
			],
		});
	});

	it("narrows with fuzzy matching as the token grows", async () => {
		const provider = createInlineSkillsProvider(fakeCurrent().current, () => skills);
		const result = await provider.getSuggestions(["$wri"], 0, 4, options);
		assert.equal(result?.prefix, "$wri");
		assert.deepEqual(result?.items.map((item) => item.value), ["$write-pr-body"]);
	});

	it("returns nothing for a $token matching no skill, without delegating", async () => {
		const { current, calls } = fakeCurrent();
		const provider = createInlineSkillsProvider(current, () => skills);
		const result = await provider.getSuggestions(["$zzz"], 0, 4, options);
		assert.equal(result, null);
		assert.deepEqual(calls, []);
	});

	it("delegates non-$ contexts to the wrapped provider", async () => {
		const { current, calls } = fakeCurrent();
		const provider = createInlineSkillsProvider(current, () => skills);
		const result = await provider.getSuggestions(["plain text"], 0, 10, options);
		assert.equal(result, innerSuggestions);
		assert.deepEqual(calls, ["getSuggestions"]);
	});

	it("completes a $ prefix by replacing the token and closing it with a space", () => {
		const provider = createInlineSkillsProvider(fakeCurrent().current, () => skills);
		const result = provider.applyCompletion(
			["please $wri"],
			0,
			11,
			{ value: "$write-pr-body", label: "$write-pr-body" },
			"$wri",
		);
		assert.deepEqual(result, { lines: ["please $write-pr-body "], cursorLine: 0, cursorCol: 22 });
	});

	it("keeps text after the cursor when completing mid-line", () => {
		const provider = createInlineSkillsProvider(fakeCurrent().current, () => skills);
		const result = provider.applyCompletion(
			["see $cod for details"],
			0,
			8,
			{ value: "$codex-web-search", label: "$codex-web-search" },
			"$cod",
		);
		assert.equal(result.lines[0], "see $codex-web-search  for details");
		assert.equal(result.cursorCol, 22);
	});

	it("delegates completion of non-$ prefixes to the wrapped provider", () => {
		const { current, calls } = fakeCurrent();
		const provider = createInlineSkillsProvider(current, () => skills);
		provider.applyCompletion(["@src"], 0, 4, { value: "@src/index.ts", label: "index.ts" }, "@src");
		assert.deepEqual(calls, ["applyCompletion"]);
	});

	it("delegates shouldTriggerFileCompletion and defaults to true when absent", () => {
		const { current } = fakeCurrent();
		const provider = createInlineSkillsProvider(current, () => skills);
		assert.equal(provider.shouldTriggerFileCompletion?.(["x"], 0, 1), false);

		const bare = createInlineSkillsProvider(
			{ ...fakeCurrent().current, shouldTriggerFileCompletion: undefined },
			() => skills,
		);
		assert.equal(bare.shouldTriggerFileCompletion?.(["x"], 0, 1), true);
	});
});
