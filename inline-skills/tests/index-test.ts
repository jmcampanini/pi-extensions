import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
	AutocompleteProviderFactory,
	ExtensionAPI,
	ExtensionContext,
	InputEventResult,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { createTestEventHarness } from "../../shared/test-event-harness.ts";
import { registerInlineSkills } from "../index.ts";

type FakeEvent = { text?: string; source?: string };

function setup() {
	const harness = createTestEventHarness<FakeEvent, ExtensionContext, InputEventResult | void>();
	const pi = {
		on: harness.on,
		getCommands: () => [
			{ name: "skill:write-pr-body", description: "Write PR bodies", source: "skill", sourceInfo: {} },
			{ name: "skill:codex-web-search", source: "skill", sourceInfo: {} },
			{ name: "make-pr", source: "prompt", sourceInfo: {} },
			{ name: "comment", source: "extension", sourceInfo: {} },
		],
	} as unknown as ExtensionAPI;
	registerInlineSkills(pi);
	return harness;
}

function tuiContext(hasUI = true) {
	const notices: string[] = [];
	const factories: AutocompleteProviderFactory[] = [];
	let restoredText: string | undefined;
	const ctx = {
		hasUI,
		ui: {
			notify: (message: string) => {
				notices.push(message);
			},
			setEditorText: (text: string) => {
				restoredText = text;
			},
			addAutocompleteProvider: (factory: AutocompleteProviderFactory) => {
				factories.push(factory);
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, notices, factories, restoredText: () => restoredText };
}

describe("registerInlineSkills", () => {
	it("transforms a single mention into a native skill invocation", () => {
		const harness = setup();
		const { ctx } = tuiContext();
		const results = harness.emitResults("input", { text: "please $write-pr-body now" }, ctx);
		assert.deepEqual(results, [
			{ action: "transform", text: "/skill:write-pr-body please $write-pr-body now" },
		]);
	});

	it("only skill commands count — prompts and extension commands do not", () => {
		const harness = setup();
		const { ctx } = tuiContext();
		const results = harness.emitResults("input", { text: "run $make-pr and $comment" }, ctx);
		assert.deepEqual(results, [{ action: "continue" }]);
	});

	it("blocks a multi-mention message and restores the editor text", () => {
		const harness = setup();
		const context = tuiContext();
		const text = "$write-pr-body and $codex-web-search";
		const results = harness.emitResults("input", { text }, context.ctx);
		assert.deepEqual(results, [{ action: "handled" }]);
		assert.equal(context.restoredText(), text);
		assert.equal(context.notices.length, 1);
		assert.match(context.notices[0], /\$write-pr-body/);
		assert.match(context.notices[0], /\$codex-web-search/);
	});

	it("passes a multi-mention message through untouched without a UI", () => {
		const harness = setup();
		const { ctx } = tuiContext(false);
		const results = harness.emitResults(
			"input",
			{ text: "$write-pr-body and $codex-web-search" },
			ctx,
		);
		assert.deepEqual(results, [{ action: "continue" }]);
	});

	it("registers the autocomplete provider once per process", () => {
		const harness = setup();
		const context = tuiContext();
		harness.emit("session_start", {}, context.ctx);
		harness.emit("session_start", {}, context.ctx);
		assert.equal(context.factories.length, 1);
	});

	it("skips provider registration without a UI", () => {
		const harness = setup();
		const context = tuiContext(false);
		harness.emit("session_start", {}, context.ctx);
		assert.equal(context.factories.length, 0);
	});

	it("wires the provider to the live skill registry", async () => {
		const harness = setup();
		const context = tuiContext();
		harness.emit("session_start", {}, context.ctx);
		const inner = {
			async getSuggestions() {
				return null;
			},
			applyCompletion(lines: string[], cursorLine: number, cursorCol: number) {
				return { lines, cursorLine, cursorCol };
			},
		} as unknown as AutocompleteProvider;
		const provider = context.factories[0](inner);
		const result = await provider.getSuggestions(["$"], 0, 1, {
			signal: new AbortController().signal,
		});
		assert.deepEqual(result?.items.map((item) => item.value), [
			"$write-pr-body",
			"$codex-web-search",
		]);
	});
});
