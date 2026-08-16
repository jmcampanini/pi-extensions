import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { EditorProcessRunner, EditorTui } from "../../shared/external-editor.ts";
import type { Block } from "../types.ts";
import {
	buildEditorInvocation,
	copyBlockCanonicalText,
	describeSmartOpen,
	describeSmartOpenSync,
	formatSmartOpenHint,
	resolveSmartOpenTarget,
	smartOpenBlock,
	type SmartOpenFileSystem,
	type SmartOpenTarget,
} from "../actions.ts";
import { makeBlock } from "./block-factory.ts";

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

function fakeTui(events: string[]): EditorTui {
	return {
		stop(): void { events.push("stop"); },
		start(): void { events.push("start"); },
		requestRender(force?: boolean): void { events.push(`render:${String(force)}`); },
	};
}

describe("copyBlockCanonicalText", () => {
	it("copy strips terminal styling without shortening canonical text", async () => {
		let copied = "";
		const canonical = "\x1b[31mtool read\x1b[0m\nresult line\n\x1b]8;;https://example.com\x07link\x1b]8;;\x07";
		const copiedResult = await copyBlockCanonicalText(block({ canonicalText: canonical }), async (text) => {
			copied = text;
		});
		assert.strictEqual(copied, "tool read\nresult line\nlink",
			"copy writes all canonical text with ANSI removed");
		assert.strictEqual(copiedResult, copied, "copy returns the same plain canonical text");
	});
});

describe("smart-open target resolution", () => {
	it("file reference has first target precedence", async () => {
		const precedenceFs = new FakeFileSystem();
		precedenceFs.existing.add("/saved/full output.log");
		const precedenceBlock = block({
			fileReference: { path: "/repo/path with spaces/file.ts", line: 17 },
			truncation: { truncated: true, fullOutputPath: "/saved/full output.log" },
		});
		assert.deepStrictEqual(
			await resolveSmartOpenTarget(precedenceBlock, "/repo", precedenceFs),
			{ kind: "file-reference", path: "/repo/path with spaces/file.ts", line: 17, temporary: false },
			"file reference has first target precedence",
		);
		assert.strictEqual(precedenceFs.created.length, 0, "precedence does not create a canonical temp");
		assert.strictEqual(
			formatSmartOpenHint(describeSmartOpenSync(precedenceBlock, (path) => precedenceFs.existing.has(path))),
			"open /repo/path with spaces/file.ts:17",
			"selection hint names referenced file and line",
		);
	});

	it("option-like relative references resolve beneath the repository root", async () => {
		const optionLikeTarget = await resolveSmartOpenTarget(
			block({ fileReference: { path: "+!touch injected" } }),
			"/repo",
			new FakeFileSystem(),
		);
		assert.deepStrictEqual(optionLikeTarget,
			{ kind: "file-reference", path: "/repo/+!touch injected", temporary: false });
	});

	it("surviving truncated full output is second precedence", async () => {
		const survivingFs = new FakeFileSystem();
		survivingFs.existing.add("/saved/full output.log");
		const fullOutputBlock = block({
			kind: "bash",
			truncation: { truncated: true, fullOutputPath: "/saved/full output.log" },
		});
		assert.deepStrictEqual(
			await describeSmartOpen(fullOutputBlock, survivingFs),
			{ kind: "full-output", path: "/saved/full output.log" },
			"surviving truncated full output is second precedence",
		);
		assert.strictEqual(
			formatSmartOpenHint(describeSmartOpenSync(fullOutputBlock, (path) => survivingFs.existing.has(path))),
			"open full output /saved/full output.log",
			"selection hint names surviving full output",
		);
	});

	it("missing full output falls back to canonical temp", async () => {
		const missingFs = new FakeFileSystem();
		const missingBlock = block({
			kind: "bash",
			canonicalText: "command\n\x1b[32mstored output\x1b[0m",
			truncation: { truncated: true, fullOutputPath: "/gone/full.log" },
		});
		const missingTarget = await resolveSmartOpenTarget(missingBlock, "/work tree", missingFs);
		assert.deepStrictEqual(missingTarget,
			{ kind: "canonical-text", path: "/work tree/.sandbox/fuzzy-explorer/generated block.md", temporary: true },
			"missing full output falls back to canonical temp");
		assert.deepStrictEqual(missingFs.created,
			[{ repositoryRoot: "/work tree", text: "command\nstored output", path: "/work tree/.sandbox/fuzzy-explorer/generated block.md" }],
			"fallback temp receives plain whole canonical text");
		assert.strictEqual(
			formatSmartOpenHint(describeSmartOpenSync(missingBlock, (path) => missingFs.existing.has(path))),
			"open block text",
			"fallback hint is honest without creating another temp",
		);
		assert.strictEqual(missingFs.created.length, 1, "hint did not create another canonical temp");
	});
});

describe("buildEditorInvocation", () => {
	const fileTarget: SmartOpenTarget = {
		kind: "file-reference",
		path: "/repo/path with spaces/file.ts",
		line: 42,
		temporary: false,
	};

	it("known editor receives +line and an option terminator before the safe path", () => {
		assert.deepStrictEqual(buildEditorInvocation("vim -f", fileTarget),
			{ command: "vim", args: ["-f", "+42", "--", "/repo/path with spaces/file.ts"] });
	});

	it("Vim cannot interpret an option-like target as an Ex command", () => {
		assert.deepStrictEqual(buildEditorInvocation("vim", {
			kind: "file-reference", path: "+!touch injected", temporary: false,
		}), { command: "vim", args: ["--", "+!touch injected"] });
	});

	it("unknown editor does not receive unsupported +line", () => {
		assert.deepStrictEqual(buildEditorInvocation("code --wait", fileTarget),
			{ command: "code", args: ["--wait", "/repo/path with spaces/file.ts"] });
	});

	it("line argument is limited to file-reference targets", () => {
		const nonReferenceWithLine = {
			kind: "full-output",
			path: "/saved/full output.log",
			line: 42,
			temporary: false,
		} as unknown as SmartOpenTarget;
		assert.deepStrictEqual(buildEditorInvocation("nvim", nonReferenceWithLine),
			{ command: "nvim", args: ["--", "/saved/full output.log"] });
	});
});

describe("smartOpenBlock", () => {
	it("temp cleanup and TUI restoration happen only after the editor settles", async () => {
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
		assert.deepStrictEqual(lifecycleEvents,
			["create", "stop", "run:/Applications/My Editor/editor:[\"--wait\",\"/repo with spaces/.sandbox/fuzzy-explorer/generated block.md\"]"],
			"TUI stops while editor owns the terminal");
		assert.deepStrictEqual(lifecycleFs.removed, [], "temp remains while editor is running");
		finishEditor?.(0);
		const opened = await opening;
		assert.strictEqual(opened.exitCode, 0, "successful editor result is reported");
		assert.deepStrictEqual(lifecycleFs.removed,
			["/repo with spaces/.sandbox/fuzzy-explorer/generated block.md"],
			"temp is removed after editor exit");
		assert.deepStrictEqual(lifecycleEvents.slice(-3),
			["remove", "start", "render:true"],
			"success restarts TUI and forces a full render");
	});

	it("spawn error propagates and still restores the TUI", async () => {
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
		assert.strictEqual(spawnError, "spawn failed", "spawn error propagates to controller");
		assert.deepStrictEqual(errorEvents,
			["stop", "run-error", "start", "render:true"],
			"spawn error still restarts TUI with full render");
	});

	it("spawn error also cleans generated canonical temp", async () => {
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
		assert.deepStrictEqual(temporaryErrorEvents,
			["create", "stop", "remove", "start", "render:true"]);
	});
});
