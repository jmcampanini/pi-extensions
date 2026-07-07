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
const worktreeDefaults = {
	worktreeCreateCommand: DEFAULT_WORKTREE_CREATE_COMMAND,
	worktreeCleanupCommand: DEFAULT_WORKTREE_CLEANUP_COMMAND,
	worktreeCleanupMode: "auto",
};

// defaults when no file and no env
eq("defaults", loadConfig({ PI_CODING_AGENT_DIR: dirWith(null) }),
	{ layout: "window", mainWidth: "60%", shellReadyDelayMs: 500, ...worktreeDefaults });

// full file applies
eq("file applies", loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"layout":"window","mainWidth":"120","shellReadyDelayMs":250}') }),
	{ layout: "window", mainWidth: "120", shellReadyDelayMs: 250, ...worktreeDefaults });

// partial file merges with defaults
eq("partial file", loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"layout":"off"}') }),
	{ layout: "off", mainWidth: "60%", shellReadyDelayMs: 500, ...worktreeDefaults });

// env beats file
eq("env beats file", loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"layout":"window"}'), PI_SUBAGENT_LAYOUT: "main" }).layout, "main");
eq("env delay parses", loadConfig({ PI_CODING_AGENT_DIR: dirWith(null), PI_SUBAGENT_SHELL_READY_DELAY_MS: "2500" }).shellReadyDelayMs, 2500);

// failures — each names the offender
throws("unknown key", () => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"layot":"main"}') }), "unknown key(s) layot");
throws("bad json", () => loadConfig({ PI_CODING_AGENT_DIR: dirWith("{nope") }), "not valid JSON");
throws("array root", () => loadConfig({ PI_CODING_AGENT_DIR: dirWith("[1]") }), "must be a JSON object");
throws("bad layout in file", () => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"layout":"grid"}') }), "valid values: main, window, off");
throws("bad layout in env", () => loadConfig({ PI_CODING_AGENT_DIR: dirWith(null), PI_SUBAGENT_LAYOUT: "windw" }), "PI_SUBAGENT_LAYOUT");
throws("bad width", () => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"mainWidth":"12px"}') }), "mainWidth");
throws("negative delay", () => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"shellReadyDelayMs":-5}') }), "non-negative");
// exactly one accepted shape per layer: the file takes a NUMBER (a numeric
// string is rejected), and a non-numeric env value reports the original text
throws("string delay in file", () => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"shellReadyDelayMs":"500"}') }), '"500"');
throws("junk delay in env", () => loadConfig({ PI_CODING_AGENT_DIR: dirWith(null), PI_SUBAGENT_SHELL_READY_DELAY_MS: "fast" }), '"fast"');
throws("uppercase layout in env is rejected", () => loadConfig({ PI_CODING_AGENT_DIR: dirWith(null), PI_SUBAGENT_LAYOUT: "MAIN" }), "PI_SUBAGENT_LAYOUT");

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
