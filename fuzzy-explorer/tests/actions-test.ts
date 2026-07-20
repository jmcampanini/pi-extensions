import type { Block } from "../types.ts";
import {
	buildEditorInvocation,
	copyBlockCanonicalText,
	describeSmartOpen,
	describeSmartOpenSync,
	formatSmartOpenHint,
	parseEditorCommand,
	resolveExternalEditor,
	resolveSmartOpenTarget,
	smartOpenBlock,
	type ActionTui,
	type EditorProcessRunner,
	type SmartOpenFileSystem,
	type SmartOpenTarget,
} from "../actions.ts";
import { makeBlock } from "./block-factory.ts";

let pass = 0;
let fail = 0;

function eq(label: string, got: unknown, want: unknown): void {
	const actual = JSON.stringify(got);
	const expected = JSON.stringify(want);
	if (actual === expected) {
		pass++;
		console.log(`  ok  ${label}`);
	} else {
		fail++;
		console.log(`  FAIL ${label}: got ${actual}, want ${expected}`);
	}
}

function ok(label: string, condition: boolean): void {
	if (condition) {
		pass++;
		console.log(`  ok  ${label}`);
	} else {
		fail++;
		console.log(`  FAIL ${label}`);
	}
}

function block(overrides: Partial<Block> = {}): Block {
	return makeBlock({
		id: "block-1",
		kind: "assistant",
		entryId: "entry-1",
		entryIds: ["entry-1"],
		timestamp: "2026-04-10T12:00:00.000Z",
		fields: "assistant",
		body: "body",
		title: "Assistant",
		canonicalText: "canonical body",
		...overrides,
	});
}

class FakeFileSystem implements SmartOpenFileSystem {
	existing = new Set<string>();
	created: Array<{ repositoryRoot: string; text: string; path: string }> = [];
	removed: string[] = [];
	events?: string[];

	async pathExists(filePath: string): Promise<boolean> {
		return this.existing.has(filePath);
	}

	async createCanonicalTextFile(repositoryRoot: string, text: string): Promise<string> {
		const path = `${repositoryRoot}/.sandbox/fuzzy-explorer/generated block.md`;
		this.created.push({ repositoryRoot, text, path });
		this.events?.push("create");
		return path;
	}

	async removeFile(filePath: string): Promise<void> {
		this.removed.push(filePath);
		this.events?.push("remove");
	}
}

function fakeTui(events: string[]): ActionTui {
	return {
		stop(): void { events.push("stop"); },
		start(): void { events.push("start"); },
		requestRender(force?: boolean): void { events.push(`render:${String(force)}`); },
	};
}

// Copy strips terminal styling without shortening canonical text.

let copied = "";
const canonical = "\x1b[31mtool read\x1b[0m\nresult line\n\x1b]8;;https://example.com\x07link\x1b]8;;\x07";
const copiedResult = await copyBlockCanonicalText(block({ canonicalText: canonical }), async (text) => {
	copied = text;
});
eq("copy writes all canonical text with ANSI removed", copied, "tool read\nresult line\nlink");
eq("copy returns the same plain canonical text", copiedResult, copied);

// File references beat surviving full output; missing output falls back to text.

const precedenceFs = new FakeFileSystem();
precedenceFs.existing.add("/saved/full output.log");
const precedenceBlock = block({
	fileReference: { path: "/repo/path with spaces/file.ts", line: 17 },
	truncation: { truncated: true, fullOutputPath: "/saved/full output.log" },
});
eq(
	"file reference has first target precedence",
	await resolveSmartOpenTarget(precedenceBlock, "/repo", precedenceFs),
	{ kind: "file-reference", path: "/repo/path with spaces/file.ts", line: 17, temporary: false },
);
eq("precedence does not create a canonical temp", precedenceFs.created.length, 0);
const optionLikeTarget = await resolveSmartOpenTarget(
	block({ fileReference: { path: "+!touch injected" } }),
	"/repo",
	precedenceFs,
);
eq("option-like relative references resolve beneath the repository root", optionLikeTarget,
	{ kind: "file-reference", path: "/repo/+!touch injected", temporary: false });
eq("selection hint names referenced file and line",
	formatSmartOpenHint(describeSmartOpenSync(precedenceBlock, (path) => precedenceFs.existing.has(path))),
	"open /repo/path with spaces/file.ts:17");

const fullOutputBlock = block({
	kind: "bash",
	truncation: { truncated: true, fullOutputPath: "/saved/full output.log" },
});
eq(
	"surviving truncated full output is second precedence",
	await describeSmartOpen(fullOutputBlock, precedenceFs),
	{ kind: "full-output", path: "/saved/full output.log" },
);
eq("selection hint names surviving full output",
	formatSmartOpenHint(describeSmartOpenSync(fullOutputBlock, (path) => precedenceFs.existing.has(path))),
	"open full output /saved/full output.log");

const missingFs = new FakeFileSystem();
const missingBlock = block({
	kind: "bash",
	canonicalText: "command\n\x1b[32mstored output\x1b[0m",
	truncation: { truncated: true, fullOutputPath: "/gone/full.log" },
});
const missingTarget = await resolveSmartOpenTarget(missingBlock, "/work tree", missingFs);
eq("missing full output falls back to canonical temp", missingTarget,
	{ kind: "canonical-text", path: "/work tree/.sandbox/fuzzy-explorer/generated block.md", temporary: true });
eq("fallback temp receives plain whole canonical text", missingFs.created,
	[{ repositoryRoot: "/work tree", text: "command\nstored output", path: "/work tree/.sandbox/fuzzy-explorer/generated block.md" }]);
eq("fallback hint is honest without creating another temp",
	formatSmartOpenHint(describeSmartOpenSync(missingBlock, (path) => missingFs.existing.has(path))),
	"open block text");
eq("hint did not create another canonical temp", missingFs.created.length, 1);

// Editor parsing keeps quoted commands and target paths as individual argv entries.

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

const fileTarget: SmartOpenTarget = {
	kind: "file-reference",
	path: "/repo/path with spaces/file.ts",
	line: 42,
	temporary: false,
};
eq("known editor receives +line and an option terminator before the safe path", buildEditorInvocation("vim -f", fileTarget),
	{ command: "vim", args: ["-f", "+42", "--", "/repo/path with spaces/file.ts"] });
eq("Vim cannot interpret an option-like target as an Ex command", buildEditorInvocation("vim", {
	kind: "file-reference", path: "+!touch injected", temporary: false,
}), { command: "vim", args: ["--", "+!touch injected"] });
eq("unknown editor does not receive unsupported +line", buildEditorInvocation("code --wait", fileTarget),
	{ command: "code", args: ["--wait", "/repo/path with spaces/file.ts"] });
const nonReferenceWithLine = {
	kind: "full-output",
	path: "/saved/full output.log",
	line: 42,
	temporary: false,
} as unknown as SmartOpenTarget;
eq("line argument is limited to file-reference targets", buildEditorInvocation("nvim", nonReferenceWithLine),
	{ command: "nvim", args: ["--", "/saved/full output.log"] });

eq("configured editor wins resolution", resolveExternalEditor({ externalEditor: "code --wait" }, { VISUAL: "nvim", EDITOR: "vim" }, "linux"),
	"code --wait");
eq("blank setting falls through to VISUAL", resolveExternalEditor({ externalEditor: "  " }, { VISUAL: "nvim", EDITOR: "vim" }, "linux"),
	"nvim");
eq("EDITOR follows VISUAL", resolveExternalEditor({}, { EDITOR: "vim" }, "linux"), "vim");
eq("Pi's Unix editor default is retained", resolveExternalEditor({}, {}, "linux"), "nano");
eq("Pi's Windows editor default is retained", resolveExternalEditor({}, {}, "win32"), "notepad");

// Temp cleanup and TUI restoration happen only after the editor settles.

const lifecycleEvents: string[] = [];
const lifecycleFs = new FakeFileSystem();
lifecycleFs.events = lifecycleEvents;
let finishEditor: ((code: number | null) => void) | undefined;
const waitingRunner: EditorProcessRunner = {
	run(command, args): Promise<number | null> {
		lifecycleEvents.push(`run:${command}:${JSON.stringify(args)}`);
		return new Promise((resolve) => { finishEditor = resolve; });
	},
};
const opening = smartOpenBlock(block({ canonicalText: "temporary text" }), {
	tui: fakeTui(lifecycleEvents),
	settings: { externalEditor: "'/Applications/My Editor/editor' --wait" },
	repositoryRoot: "/repo with spaces",
	fileSystem: lifecycleFs,
	processRunner: waitingRunner,
});
await new Promise<void>((resolve) => setImmediate(resolve));
eq("TUI stops while editor owns the terminal", lifecycleEvents,
	["create", "stop", "run:/Applications/My Editor/editor:[\"--wait\",\"/repo with spaces/.sandbox/fuzzy-explorer/generated block.md\"]"]);
eq("temp remains while editor is running", lifecycleFs.removed, []);
finishEditor?.(0);
const opened = await opening;
eq("successful editor result is reported", opened.exitCode, 0);
eq("temp is removed after editor exit", lifecycleFs.removed,
	["/repo with spaces/.sandbox/fuzzy-explorer/generated block.md"]);
eq("success restarts TUI and forces a full render", lifecycleEvents.slice(-3),
	["remove", "start", "render:true"]);

const errorEvents: string[] = [];
const errorFs = new FakeFileSystem();
errorFs.events = errorEvents;
let spawnError = "";
try {
	await smartOpenBlock(block({ fileReference: { path: "/repo/file.ts", line: 9 } }), {
		tui: fakeTui(errorEvents),
		settings: { externalEditor: "vim" },
		fileSystem: errorFs,
		processRunner: {
			async run(): Promise<number | null> {
				errorEvents.push("run-error");
				throw new Error("spawn failed");
			},
		},
	});
} catch (error) {
	spawnError = error instanceof Error ? error.message : String(error);
}
eq("spawn error propagates to controller", spawnError, "spawn failed");
eq("spawn error still restarts TUI with full render", errorEvents,
	["stop", "run-error", "start", "render:true"]);

const temporaryErrorEvents: string[] = [];
const temporaryErrorFs = new FakeFileSystem();
temporaryErrorFs.events = temporaryErrorEvents;
try {
	await smartOpenBlock(block(), {
		tui: fakeTui(temporaryErrorEvents),
		settings: { externalEditor: "vim" },
		fileSystem: temporaryErrorFs,
		processRunner: { async run(): Promise<number | null> { throw new Error("editor crashed"); } },
	});
} catch {
	// Expected.
}
eq("spawn error also cleans generated canonical temp", temporaryErrorEvents,
	["create", "stop", "remove", "start", "render:true"]);

ok("all action tests completed", true);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
