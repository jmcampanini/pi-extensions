import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const sandbox = join(process.cwd(), ".sandbox");
mkdirSync(sandbox, { recursive: true });
const importAgentDir = mkdtempSync(join(sandbox, "fuzzy-explorer-config-import-"));
process.env.PI_CODING_AGENT_DIR = importAgentDir;
const { agentConfigDir, configFilePath, loadConfig } = await import("../config.ts");

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

function throws(label: string, fn: () => void, contains: string): void {
	try {
		fn();
		fail++;
		console.log(`  FAIL ${label}: expected throw`);
	} catch (error) {
		if (String(error).includes(contains)) {
			pass++;
			console.log(`  ok  ${label}`);
		} else {
			fail++;
			console.log(`  FAIL ${label}: message missing ${JSON.stringify(contains)}: ${String(error)}`);
		}
	}
}

const testRoot = mkdtempSync(join(sandbox, "fuzzy-explorer-config-"));
let nextDirectory = 0;

function dirWith(content: string | null): string {
	const directory = join(testRoot, String(nextDirectory++));
	mkdirSync(directory);
	if (content !== null) writeFileSync(join(directory, "fuzzy-explorer.json"), content);
	return directory;
}

const defaults = {
	openMode: "list",
};

// Paths and the built-in defaults follow Pi's config-root convention.
eq("default agent config directory", agentConfigDir({}), join(homedir(), ".pi", "agent"));
eq("custom agent config directory", agentConfigDir({ PI_CODING_AGENT_DIR: "/configured/pi" }), "/configured/pi");
eq(
	"config file path",
	configFilePath({ PI_CODING_AGENT_DIR: "/configured/pi" }),
	join("/configured/pi", "fuzzy-explorer.json"),
);
eq("missing file uses defaults", loadConfig({ PI_CODING_AGENT_DIR: dirWith(null) }), defaults);

// File values merge over defaults, and environment values win last.
eq(
	"full file applies",
	loadConfig({
		PI_CODING_AGENT_DIR: dirWith('{"openShortcut":"alt+x","openMode":"filter"}'),
	}),
	{ openMode: "filter", openShortcut: "alt+x" },
);
eq(
	"partial file keeps defaults",
	loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"openShortcut":"alt+x"}') }),
	{ openMode: "list", openShortcut: "alt+x" },
);
eq(
	"environment beats file",
	loadConfig({
		PI_CODING_AGENT_DIR: dirWith('{"openShortcut":"alt+x","openMode":"list"}'),
		PI_FUZZY_EXPLORER_OPEN_SHORTCUT: "ctrl+shift+f12",
		PI_FUZZY_EXPLORER_OPEN_MODE: "filter",
	}),
	{ openMode: "filter", openShortcut: "ctrl+shift+f12" },
);
eq(
	"only the documented environment names apply",
	loadConfig({
		PI_CODING_AGENT_DIR: dirWith(null),
		PI_FUZZY_EXPLORER_SHORTCUT: "alt+x",
		PI_FUZZY_EXPLORER_MODE: "filter",
		PI_FUZZY_EXPLORER_LIST_ORDER: "relevance",
	}),
	defaults,
);

// Open shortcuts accept modified Pi keys and bare function keys, but never ordinary editor input.
const validShortcuts = [
	"f12",
	"ctrl++",
	"ctrl+r",
	"ctrl+x",
	"ctrl+n",
	"shift+f1",
	"ctrl+shift+g",
	"alt+ctrl+x",
	"ctrl+shift+alt+x",
	"ctrl+super+k",
];
for (const shortcut of validShortcuts) {
	eq(
		`valid KeyId ${JSON.stringify(shortcut)}`,
		loadConfig({ PI_CODING_AGENT_DIR: dirWith(null), PI_FUZZY_EXPLORER_OPEN_SHORTCUT: shortcut })
			.openShortcut,
		shortcut,
	);
}

const invalidShortcuts = ["", "R", "pageup", "f13", "meta+x", "ctrl+ctrl+x", "ctrl+", "ctrl +r", "ctrl+a+b"];
for (const shortcut of invalidShortcuts) {
	throws(
		`invalid KeyId ${JSON.stringify(shortcut)}`,
		() =>
			loadConfig({
				PI_CODING_AGENT_DIR: dirWith(null),
				PI_FUZZY_EXPLORER_OPEN_SHORTCUT: shortcut,
			}),
		"PI_FUZZY_EXPLORER_OPEN_SHORTCUT",
	);
}

for (const shortcut of [
	"a", "9", "pageUp", "?", "+", "escape", "enter", "ctrl+c", "ctrl+g", "ctrl+p", "shift+ctrl+p",
	"shift+tab", "shift+enter", "ctrl+a", "ctrl+b", "ctrl+e", "ctrl+f", "ctrl+u", "ctrl+w", "ctrl+y",
	"ctrl+j", "ctrl+m", "ctrl+i", "ctrl+h", "ctrl+[", "ctrl+]", "ctrl+alt+]",
	"shift+g", "shift+9", "shift+?", "shift+space", "alt+b", "alt+f", "alt+d",
]) {
	throws(
		`reserved shortcut ${JSON.stringify(shortcut)}`,
		() => loadConfig({ PI_CODING_AGENT_DIR: dirWith(null), PI_FUZZY_EXPLORER_OPEN_SHORTCUT: shortcut }),
		"is reserved by Pi's main editor",
	);
}

const badFileShortcutDir = dirWith('{"openShortcut":42}');
throws(
	"non-string file shortcut names its key",
	() => loadConfig({ PI_CODING_AGENT_DIR: badFileShortcutDir }),
	`${join(badFileShortcutDir, "fuzzy-explorer.json")}: openShortcut`,
);
throws(
	"invalid file shortcut explains KeyId",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"openShortcut":"control+r"}') }),
	"use a Pi KeyId",
);

// Every enum key rejects bad values from both file and environment layers.
throws(
	"invalid file open mode",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"openMode":"search"}') }),
	"valid values: list, filter",
);
throws(
	"invalid environment open mode",
	() =>
		loadConfig({
			PI_CODING_AGENT_DIR: dirWith(null),
			PI_FUZZY_EXPLORER_OPEN_MODE: "LIST",
		}),
	"PI_FUZZY_EXPLORER_OPEN_MODE",
);
throws(
	"empty environment open mode is rejected",
	() =>
		loadConfig({
			PI_CODING_AGENT_DIR: dirWith(null),
			PI_FUZZY_EXPLORER_OPEN_MODE: "",
		}),
	'openMode ""',
);
throws(
	"the removed listOrder key is unknown",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"listOrder":"chronological"}') }),
	"unknown key(s) listOrder",
);

// Structural and syntax errors fail before environment overrides are considered.
throws(
	"unknown key",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"openMod":"filter"}') }),
	"unknown key(s) openMod",
);
throws(
	"inherited object name is still unknown",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"toString":"filter"}') }),
	"unknown key(s) toString",
);
throws(
	"malformed JSON",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith("{broken") }),
	"not valid JSON",
);
throws(
	"array root",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith("[]") }),
	"must be a JSON object",
);
throws(
	"null root",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith("null") }),
	"must be a JSON object",
);
throws(
	"invalid file is not rescued by environment",
	() =>
		loadConfig({
			PI_CODING_AGENT_DIR: dirWith('{"openMode":"search"}'),
			PI_FUZZY_EXPLORER_OPEN_MODE: "list",
		}),
	"openMode \"search\"",
);

rmSync(testRoot, { recursive: true, force: true });
rmSync(importAgentDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
