import { loadConfig } from "../config.ts";
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

// defaults when no file and no env
eq("defaults", loadConfig({ PI_CODING_AGENT_DIR: dirWith(null) }),
	{ layout: "window", mainWidth: "60%", shellReadyDelayMs: 500 });

// full file applies
eq("file applies", loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"layout":"window","mainWidth":"120","shellReadyDelayMs":250}') }),
	{ layout: "window", mainWidth: "120", shellReadyDelayMs: 250 });

// partial file merges with defaults
eq("partial file", loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"layout":"off"}') }),
	{ layout: "off", mainWidth: "60%", shellReadyDelayMs: 500 });

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
