import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { EditorTui } from "../../shared/external-editor.ts";
import { editTextExternally } from "../index.ts";

function fakeTui(): { tui: EditorTui; calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		tui: {
			stop: () => calls.push("stop"),
			start: () => calls.push("start"),
			requestRender: (force?: boolean) => calls.push(`render(${force === true})`),
		},
	};
}

// The fake editor is `sh -c '<script>'`; the temp file arrives as $0.
describe("editTextExternally", () => {
	it("successful edit returns the file text and restarts the TUI", async () => {
		const { tui, calls } = fakeTui();
		const outcome = await editTextExternally(tui, "sh -c 'printf \" world\" >> \"$0\"'", "hello");
		assert.deepStrictEqual(outcome, { exitCode: 0, text: "hello world" }, "successful edit returns the file text");
		assert.deepStrictEqual(calls, ["stop", "start", "render(true)"], "successful edit restarts the TUI after stopping it");
	});

	it("non-zero exit returns only the exit code and restarts the TUI", async () => {
		const { tui, calls } = fakeTui();
		const outcome = await editTextExternally(tui, "sh -c 'exit 3'", "hello");
		assert.deepStrictEqual(outcome, { exitCode: 3 }, "non-zero exit returns only the exit code");
		assert.deepStrictEqual(calls, ["stop", "start", "render(true)"], "non-zero exit restarts the TUI");
	});

	it("spawn failure reports an error and restarts the TUI", async () => {
		const { tui, calls } = fakeTui();
		const outcome = await editTextExternally(tui, "pi-comment-test-missing-editor", "hello");
		assert.deepStrictEqual(
			[outcome.exitCode, outcome.error !== undefined],
			[null, true],
			"spawn failure reports an error",
		);
		assert.deepStrictEqual(calls, ["stop", "start", "render(true)"], "spawn failure restarts the TUI");
	});

	it("unparseable editor command reports an error without touching the TUI", async () => {
		const { tui, calls } = fakeTui();
		const outcome = await editTextExternally(tui, "\"unclosed", "hello");
		assert.deepStrictEqual(
			[outcome.exitCode, outcome.error !== undefined],
			[null, true],
			"unparseable editor command reports an error",
		);
		assert.deepStrictEqual(calls, [], "unparseable editor command never touches the TUI");
	});
});
