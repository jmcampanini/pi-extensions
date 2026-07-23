import { DEFAULT_WORKTREE_CLEANUP_COMMAND, DEFAULT_WORKTREE_CREATE_COMMAND, loadConfig } from "../config.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown) {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}: got ${g}, want ${w}`); }
}
function throws(label: string, fn: () => void, contains: string) {
	try { fn(); fail++; console.log(`  FAIL ${label}: expected throw`); }
	catch (e) {
		if (String(e).includes(contains)) { pass++; console.log(`  ok  ${label}`); }
		else { fail++; console.log(`  FAIL ${label}: message missing "${contains}": ${e}`); }
	}
}
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

// defaults when no file and no env
eq("defaults", loadConfig({ PI_CODING_AGENT_DIR: dirWith(null) }),
	{ layout: "window", mainWidth: "60%", ...previewDefaults, ...worktreeDefaults });

// full file applies
eq("file applies", loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"layout":"window","mainWidth":"120","maxConcurrentSubagents":4,"callPreviewLines":4,"resultPreviewLines":8,"widgetMaxRows":7}') }),
	{ layout: "window", mainWidth: "120", maxConcurrentSubagents: 4, callPreviewLines: 4, resultPreviewLines: 8, widgetMaxRows: 7, ...worktreeDefaults });

// partial file merges with defaults
eq("partial file", loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"layout":"off"}') }),
	{ layout: "off", mainWidth: "60%", ...previewDefaults, ...worktreeDefaults });

// env beats file
eq("env beats file", loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"layout":"window"}'), PI_SUBAGENT_LAYOUT: "main" }).layout, "main");
eq("file accepts header-only call previews",
	loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"callPreviewLines":0}') }).callPreviewLines, 0);
eq("file accepts footer-only result cards",
	loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"resultPreviewLines":0}') }).resultPreviewLines, 0);
eq("file accepts the maximum result preview",
	loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"resultPreviewLines":20}') }).resultPreviewLines, 20);
eq("call preview env beats file",
	loadConfig({
		PI_CODING_AGENT_DIR: dirWith('{"callPreviewLines":2}'),
		PI_SUBAGENT_CALL_PREVIEW_LINES: "7",
	}).callPreviewLines, 7);
eq("result preview env beats file",
	loadConfig({
		PI_CODING_AGENT_DIR: dirWith('{"resultPreviewLines":2}'),
		PI_SUBAGENT_RESULT_PREVIEW_LINES: "9",
	}).resultPreviewLines, 9);
eq("widget rows env beats file",
	loadConfig({
		PI_CODING_AGENT_DIR: dirWith('{"widgetMaxRows":3}'),
		PI_SUBAGENT_WIDGET_MAX_ROWS: "8",
	}).widgetMaxRows, 8);
eq("widget rows accept one",
	loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"widgetMaxRows":1}') }).widgetMaxRows, 1);
throws("negative widget rows are rejected",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"widgetMaxRows":-1}') }),
	"positive integer");
throws("fractional widget rows are rejected",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"widgetMaxRows":2.5}') }),
	"positive integer");
throws("invalid widget rows env names the variable",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith(null), PI_SUBAGENT_WIDGET_MAX_ROWS: "0" }),
	"PI_SUBAGENT_WIDGET_MAX_ROWS");

// ── maxConcurrentSubagents ────────────────────────────────────────────────

eq("max concurrent accepts the minimum",
	loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"maxConcurrentSubagents":1}') }).maxConcurrentSubagents, 1);
eq("max concurrent env beats file",
	loadConfig({
		PI_CODING_AGENT_DIR: dirWith('{"maxConcurrentSubagents":3}'),
		PI_SUBAGENT_MAX_CONCURRENT_SUBAGENTS: "5",
	}).maxConcurrentSubagents, 5);
throws("zero max concurrent is rejected",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"maxConcurrentSubagents":0}') }),
	"integer from 1 through 9");
throws("max concurrent above 9 is rejected",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"maxConcurrentSubagents":10}') }),
	"integer from 1 through 9");
throws("fractional max concurrent is rejected",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"maxConcurrentSubagents":2.5}') }),
	"integer from 1 through 9");
throws("string max concurrent in file is rejected",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"maxConcurrentSubagents":"9"}') }),
	'"9"');
throws("invalid max concurrent env names the variable",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith(null), PI_SUBAGENT_MAX_CONCURRENT_SUBAGENTS: "lots" }),
	"PI_SUBAGENT_MAX_CONCURRENT_SUBAGENTS");

// failures — each names the offender
throws("unknown key", () => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"layot":"main"}') }), "unknown key(s) layot");
throws("bad json", () => loadConfig({ PI_CODING_AGENT_DIR: dirWith("{nope") }), "not valid JSON");
throws("array root", () => loadConfig({ PI_CODING_AGENT_DIR: dirWith("[1]") }), "must be a JSON object");
throws("bad layout in file", () => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"layout":"grid"}') }), "valid values: main, window, off");
throws("bad layout in env", () => loadConfig({ PI_CODING_AGENT_DIR: dirWith(null), PI_SUBAGENT_LAYOUT: "windw" }), "PI_SUBAGENT_LAYOUT");
throws("bad width", () => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"mainWidth":"12px"}') }), "mainWidth");
throws("uppercase layout in env is rejected", () => loadConfig({ PI_CODING_AGENT_DIR: dirWith(null), PI_SUBAGENT_LAYOUT: "MAIN" }), "PI_SUBAGENT_LAYOUT");
throws("negative call preview lines are rejected",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"callPreviewLines":-1}') }),
	"integer from 0 through 20");
throws("result preview lines above the maximum are rejected",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"resultPreviewLines":21}') }),
	"integer from 0 through 20");
throws("fractional preview lines are rejected",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"callPreviewLines":1.5}') }),
	"integer from 0 through 20");
throws("string preview lines in file are rejected",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"resultPreviewLines":"5"}') }),
	'"5"');
throws("invalid call preview env names the variable",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith(null), PI_SUBAGENT_CALL_PREVIEW_LINES: "many" }),
	"PI_SUBAGENT_CALL_PREVIEW_LINES");
throws("invalid result preview env names the variable",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith(null), PI_SUBAGENT_RESULT_PREVIEW_LINES: "21" }),
	"PI_SUBAGENT_RESULT_PREVIEW_LINES");

// ── worktree keys ──────────────────────────────────────────────────────────

// file overrides work for each key
eq("worktree create command from file",
	loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"worktreeCreateCommand":"grove create \\"$PI_SUBAGENT_WORKTREE_NAME\\""}') }).worktreeCreateCommand,
	'grove create "$PI_SUBAGENT_WORKTREE_NAME"');
eq("worktree cleanup command from file",
	loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"worktreeCleanupCommand":"grove remove \\"$PI_SUBAGENT_WORKTREE_DIR\\""}') }).worktreeCleanupCommand,
	'grove remove "$PI_SUBAGENT_WORKTREE_DIR"');
eq("worktree cleanup mode from file",
	loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"worktreeCleanupMode":"never"}') }).worktreeCleanupMode,
	"never");

// env overrides beat the file, per key
eq("worktree create env beats file",
	loadConfig({
		PI_CODING_AGENT_DIR: dirWith('{"worktreeCreateCommand":"from-file"}'),
		PI_SUBAGENT_WORKTREE_CREATE_COMMAND: "from-env",
	}).worktreeCreateCommand, "from-env");
eq("worktree cleanup env beats file",
	loadConfig({
		PI_CODING_AGENT_DIR: dirWith('{"worktreeCleanupCommand":"from-file"}'),
		PI_SUBAGENT_WORKTREE_CLEANUP_COMMAND: "from-env",
	}).worktreeCleanupCommand, "from-env");
eq("worktree mode env beats file",
	loadConfig({
		PI_CODING_AGENT_DIR: dirWith('{"worktreeCleanupMode":"never"}'),
		PI_SUBAGENT_WORKTREE_CLEANUP_MODE: "auto",
	}).worktreeCleanupMode, "auto");

// invalid mode value is rejected from BOTH layers, naming the offender
throws("bad worktree mode in file",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"worktreeCleanupMode":"always"}') }),
	"valid values: auto, never");
throws("bad worktree mode in env",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith(null), PI_SUBAGENT_WORKTREE_CLEANUP_MODE: "always" }),
	"PI_SUBAGENT_WORKTREE_CLEANUP_MODE");

// commands must be non-empty strings (blank would silently do nothing)
throws("empty create command in file",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"worktreeCreateCommand":""}') }),
	"worktreeCreateCommand");
throws("blank cleanup command in file",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"worktreeCleanupCommand":"   "}') }),
	"worktreeCleanupCommand");
throws("non-string create command in file",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"worktreeCreateCommand":42}') }),
	"non-empty shell command");
throws("blank create command in env",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith(null), PI_SUBAGENT_WORKTREE_CREATE_COMMAND: "   " }),
	"PI_SUBAGENT_WORKTREE_CREATE_COMMAND");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
