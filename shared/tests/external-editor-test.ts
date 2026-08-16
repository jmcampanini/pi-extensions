import {
	editorNeedsOptionsTerminator,
	editorSupportsPlusLine,
	parseEditorCommand,
	resolveExternalEditor,
} from "../external-editor.ts";

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown): void {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}: got ${g}, want ${w}`); }
}

// Editor parsing keeps quoted commands and arguments as individual argv entries.

eq("quoted editor commands are parsed without a shell",
	parseEditorCommand("'/Applications/Visual Studio Code/bin/code' --wait --reuse-window"),
	["/Applications/Visual Studio Code/bin/code", "--wait", "--reuse-window"]);
eq("quoted editor arguments are parsed", parseEditorCommand(`vim -c "set number"`),
	["vim", "-c", "set number"]);
let unmatchedQuote = "";
try {
	parseEditorCommand("vim 'unfinished");
} catch (error) {
	unmatchedQuote = error instanceof Error ? error.message : String(error);
}
eq("unmatched editor quote fails clearly", unmatchedQuote, "External editor command has an unmatched quote");

// Resolution order: configured setting, VISUAL, EDITOR, platform default.

eq("configured editor wins resolution", resolveExternalEditor({ externalEditor: "code --wait" }, { VISUAL: "nvim", EDITOR: "vim" }, "linux"),
	"code --wait");
eq("blank setting falls through to VISUAL", resolveExternalEditor({ externalEditor: "  " }, { VISUAL: "nvim", EDITOR: "vim" }, "linux"),
	"nvim");
eq("EDITOR follows VISUAL", resolveExternalEditor({}, { EDITOR: "vim" }, "linux"), "vim");
eq("Pi's Unix editor default is retained", resolveExternalEditor({}, {}, "linux"), "nano");
eq("Pi's Windows editor default is retained", resolveExternalEditor({}, {}, "win32"), "notepad");

// Capability tables match editors by executable basename.

eq("+line support is recognized by basename", [
	editorSupportsPlusLine("/usr/local/bin/vim"),
	editorSupportsPlusLine("code"),
], [true, false]);
eq("vi-family editors require an options terminator", [
	editorNeedsOptionsTerminator("nvim"),
	editorNeedsOptionsTerminator("nano"),
], [true, false]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
