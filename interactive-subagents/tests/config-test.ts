import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_WORKTREE_CLEANUP_COMMAND, DEFAULT_WORKTREE_CREATE_COMMAND, loadConfig } from "../config.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function dirWith(content: string | null): string {
	const dir = mkdtempSync(join(tmpdir(), "subagents-config-"));
	if (content !== null) writeFileSync(join(dir, "subagents.json"), content);
	return dir;
}

// the worktree defaults repeat in several whole-object assertions below
const previewDefaults = {
	maxConcurrentSubagents: 9,
	callPreviewLines: 3,
	resultPreviewLines: 3,
	widgetMaxRows: 5,
};
const worktreeDefaults = {
	worktreeCreateCommand: DEFAULT_WORKTREE_CREATE_COMMAND,
	worktreeCleanupCommand: DEFAULT_WORKTREE_CLEANUP_COMMAND,
	worktreeCleanupMode: "auto",
};

describe("loadConfig", () => {
	it("defaults", () => {
		assert.deepStrictEqual(loadConfig({ PI_CODING_AGENT_DIR: dirWith(null) }),
			{ layout: "window", mainWidth: "60%", ...previewDefaults, ...worktreeDefaults });
	});

	it("file applies", () => {
		assert.deepStrictEqual(loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"layout":"window","mainWidth":"120","maxConcurrentSubagents":4,"callPreviewLines":4,"resultPreviewLines":8,"widgetMaxRows":7}') }),
			{ layout: "window", mainWidth: "120", maxConcurrentSubagents: 4, callPreviewLines: 4, resultPreviewLines: 8, widgetMaxRows: 7, ...worktreeDefaults });
	});

	it("partial file merges with defaults", () => {
		assert.deepStrictEqual(loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"layout":"off"}') }),
			{ layout: "off", mainWidth: "60%", ...previewDefaults, ...worktreeDefaults });
	});

	it("env beats file", () => {
		assert.strictEqual(loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"layout":"window"}'), PI_SUBAGENT_LAYOUT: "main" }).layout, "main");
	});

	it("file accepts header-only call previews", () => {
		assert.strictEqual(loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"callPreviewLines":0}') }).callPreviewLines, 0);
	});

	it("file accepts footer-only result cards", () => {
		assert.strictEqual(loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"resultPreviewLines":0}') }).resultPreviewLines, 0);
	});

	it("file accepts the maximum result preview", () => {
		assert.strictEqual(loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"resultPreviewLines":20}') }).resultPreviewLines, 20);
	});

	it("call preview env beats file", () => {
		assert.strictEqual(loadConfig({
			PI_CODING_AGENT_DIR: dirWith('{"callPreviewLines":2}'),
			PI_SUBAGENT_CALL_PREVIEW_LINES: "7",
		}).callPreviewLines, 7);
	});

	it("result preview env beats file", () => {
		assert.strictEqual(loadConfig({
			PI_CODING_AGENT_DIR: dirWith('{"resultPreviewLines":2}'),
			PI_SUBAGENT_RESULT_PREVIEW_LINES: "9",
		}).resultPreviewLines, 9);
	});

	it("widget rows env beats file", () => {
		assert.strictEqual(loadConfig({
			PI_CODING_AGENT_DIR: dirWith('{"widgetMaxRows":3}'),
			PI_SUBAGENT_WIDGET_MAX_ROWS: "8",
		}).widgetMaxRows, 8);
	});

	it("widget rows accept one", () => {
		assert.strictEqual(loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"widgetMaxRows":1}') }).widgetMaxRows, 1);
	});

	it("negative widget rows are rejected", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"widgetMaxRows":-1}') }),
			/positive integer/,
		);
	});

	it("fractional widget rows are rejected", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"widgetMaxRows":2.5}') }),
			/positive integer/,
		);
	});

	it("invalid widget rows env names the variable", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith(null), PI_SUBAGENT_WIDGET_MAX_ROWS: "0" }),
			/PI_SUBAGENT_WIDGET_MAX_ROWS/,
		);
	});

	it("max concurrent accepts the minimum", () => {
		assert.strictEqual(loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"maxConcurrentSubagents":1}') }).maxConcurrentSubagents, 1);
	});

	it("max concurrent env beats file", () => {
		assert.strictEqual(loadConfig({
			PI_CODING_AGENT_DIR: dirWith('{"maxConcurrentSubagents":3}'),
			PI_SUBAGENT_MAX_CONCURRENT_SUBAGENTS: "5",
		}).maxConcurrentSubagents, 5);
	});

	it("zero max concurrent is rejected", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"maxConcurrentSubagents":0}') }),
			/integer from 1 through 9/,
		);
	});

	it("max concurrent above 9 is rejected", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"maxConcurrentSubagents":10}') }),
			/integer from 1 through 9/,
		);
	});

	it("fractional max concurrent is rejected", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"maxConcurrentSubagents":2.5}') }),
			/integer from 1 through 9/,
		);
	});

	it("string max concurrent in file is rejected", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"maxConcurrentSubagents":"9"}') }),
			/"9"/,
		);
	});

	it("invalid max concurrent env names the variable", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith(null), PI_SUBAGENT_MAX_CONCURRENT_SUBAGENTS: "lots" }),
			/PI_SUBAGENT_MAX_CONCURRENT_SUBAGENTS/,
		);
	});

	it("unknown key", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"layot":"main"}') }),
			/unknown key\(s\) layot/,
		);
	});

	it("bad json", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith("{nope") }),
			/not valid JSON/,
		);
	});

	it("array root", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith("[1]") }),
			/must be a JSON object/,
		);
	});

	it("bad layout in file", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"layout":"grid"}') }),
			/valid values: main, window, off/,
		);
	});

	it("bad layout in env", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith(null), PI_SUBAGENT_LAYOUT: "windw" }),
			/PI_SUBAGENT_LAYOUT/,
		);
	});

	it("bad width", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"mainWidth":"12px"}') }),
			/mainWidth/,
		);
	});

	it("uppercase layout in env is rejected", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith(null), PI_SUBAGENT_LAYOUT: "MAIN" }),
			/PI_SUBAGENT_LAYOUT/,
		);
	});

	it("negative call preview lines are rejected", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"callPreviewLines":-1}') }),
			/integer from 0 through 20/,
		);
	});

	it("result preview lines above the maximum are rejected", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"resultPreviewLines":21}') }),
			/integer from 0 through 20/,
		);
	});

	it("fractional preview lines are rejected", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"callPreviewLines":1.5}') }),
			/integer from 0 through 20/,
		);
	});

	it("string preview lines in file are rejected", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"resultPreviewLines":"5"}') }),
			/"5"/,
		);
	});

	it("invalid call preview env names the variable", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith(null), PI_SUBAGENT_CALL_PREVIEW_LINES: "many" }),
			/PI_SUBAGENT_CALL_PREVIEW_LINES/,
		);
	});

	it("invalid result preview env names the variable", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith(null), PI_SUBAGENT_RESULT_PREVIEW_LINES: "21" }),
			/PI_SUBAGENT_RESULT_PREVIEW_LINES/,
		);
	});

	it("worktree create command from file", () => {
		assert.strictEqual(
			loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"worktreeCreateCommand":"grove create \\"$PI_SUBAGENT_WORKTREE_NAME\\""}') }).worktreeCreateCommand,
			'grove create "$PI_SUBAGENT_WORKTREE_NAME"');
	});

	it("worktree cleanup command from file", () => {
		assert.strictEqual(
			loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"worktreeCleanupCommand":"grove remove \\"$PI_SUBAGENT_WORKTREE_DIR\\""}') }).worktreeCleanupCommand,
			'grove remove "$PI_SUBAGENT_WORKTREE_DIR"');
	});

	it("worktree cleanup mode from file", () => {
		assert.strictEqual(
			loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"worktreeCleanupMode":"never"}') }).worktreeCleanupMode,
			"never");
	});

	it("worktree create env beats file", () => {
		assert.strictEqual(loadConfig({
			PI_CODING_AGENT_DIR: dirWith('{"worktreeCreateCommand":"from-file"}'),
			PI_SUBAGENT_WORKTREE_CREATE_COMMAND: "from-env",
		}).worktreeCreateCommand, "from-env");
	});

	it("worktree cleanup env beats file", () => {
		assert.strictEqual(loadConfig({
			PI_CODING_AGENT_DIR: dirWith('{"worktreeCleanupCommand":"from-file"}'),
			PI_SUBAGENT_WORKTREE_CLEANUP_COMMAND: "from-env",
		}).worktreeCleanupCommand, "from-env");
	});

	it("worktree mode env beats file", () => {
		assert.strictEqual(loadConfig({
			PI_CODING_AGENT_DIR: dirWith('{"worktreeCleanupMode":"never"}'),
			PI_SUBAGENT_WORKTREE_CLEANUP_MODE: "auto",
		}).worktreeCleanupMode, "auto");
	});

	it("bad worktree mode in file", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"worktreeCleanupMode":"always"}') }),
			/valid values: auto, never/,
		);
	});

	it("bad worktree mode in env", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith(null), PI_SUBAGENT_WORKTREE_CLEANUP_MODE: "always" }),
			/PI_SUBAGENT_WORKTREE_CLEANUP_MODE/,
		);
	});

	it("empty create command in file", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"worktreeCreateCommand":""}') }),
			/worktreeCreateCommand/,
		);
	});

	it("blank cleanup command in file", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"worktreeCleanupCommand":"   "}') }),
			/worktreeCleanupCommand/,
		);
	});

	it("non-string create command in file", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"worktreeCreateCommand":42}') }),
			/non-empty shell command/,
		);
	});

	it("blank create command in env", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith(null), PI_SUBAGENT_WORKTREE_CREATE_COMMAND: "   " }),
			/PI_SUBAGENT_WORKTREE_CREATE_COMMAND/,
		);
	});
});
