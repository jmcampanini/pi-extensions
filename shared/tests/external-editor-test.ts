import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	editorNeedsOptionsTerminator,
	editorSupportsPlusLine,
	parseEditorCommand,
	resolveExternalEditor,
} from "../external-editor.ts";

describe("parseEditorCommand", () => {
	it("quoted editor commands are parsed without a shell", () => {
		assert.deepStrictEqual(
			parseEditorCommand("'/Applications/Visual Studio Code/bin/code' --wait --reuse-window"),
			["/Applications/Visual Studio Code/bin/code", "--wait", "--reuse-window"],
		);
	});

	it("quoted editor arguments are parsed", () => {
		assert.deepStrictEqual(parseEditorCommand(`vim -c "set number"`), ["vim", "-c", "set number"]);
	});

	it("unmatched editor quote fails clearly", () => {
		assert.throws(
			() => parseEditorCommand("vim 'unfinished"),
			(error) => error instanceof Error && error.message === "External editor command has an unmatched quote",
		);
	});
});

describe("resolveExternalEditor", () => {
	it("configured editor wins resolution", () => {
		assert.strictEqual(
			resolveExternalEditor({ externalEditor: "code --wait" }, { VISUAL: "nvim", EDITOR: "vim" }, "linux"),
			"code --wait",
		);
	});

	it("blank setting falls through to VISUAL", () => {
		assert.strictEqual(
			resolveExternalEditor({ externalEditor: "  " }, { VISUAL: "nvim", EDITOR: "vim" }, "linux"),
			"nvim",
		);
	});

	it("EDITOR follows VISUAL", () => {
		assert.strictEqual(resolveExternalEditor({}, { EDITOR: "vim" }, "linux"), "vim");
	});

	it("Pi's Unix editor default is retained", () => {
		assert.strictEqual(resolveExternalEditor({}, {}, "linux"), "nano");
	});

	it("Pi's Windows editor default is retained", () => {
		assert.strictEqual(resolveExternalEditor({}, {}, "win32"), "notepad");
	});
});

describe("editor capability tables", () => {
	it("+line support is recognized by basename", () => {
		assert.deepStrictEqual(
			[editorSupportsPlusLine("/usr/local/bin/vim"), editorSupportsPlusLine("code")],
			[true, false],
		);
	});

	it("vi-family editors require an options terminator", () => {
		assert.deepStrictEqual(
			[editorNeedsOptionsTerminator("nvim"), editorNeedsOptionsTerminator("nano")],
			[true, false],
		);
	});
});
