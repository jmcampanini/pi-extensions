import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const sandbox = join(process.cwd(), ".sandbox");
mkdirSync(sandbox, { recursive: true });
const importAgentDir = mkdtempSync(join(sandbox, "fuzzy-explorer-config-import-"));
process.env.PI_CODING_AGENT_DIR = importAgentDir;
const { agentConfigDir, configFilePath, loadConfig } = await import("../config.ts");

const testRoot = mkdtempSync(join(sandbox, "fuzzy-explorer-config-"));

after(() => {
	rmSync(testRoot, { recursive: true, force: true });
	rmSync(importAgentDir, { recursive: true, force: true });
});

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

describe("config", () => {
	it("default agent config directory", () => {
		assert.strictEqual(agentConfigDir({}), join(homedir(), ".pi", "agent"));
	});

	it("custom agent config directory", () => {
		assert.strictEqual(agentConfigDir({ PI_CODING_AGENT_DIR: "/configured/pi" }), "/configured/pi");
	});

	it("config file path", () => {
		assert.strictEqual(
			configFilePath({ PI_CODING_AGENT_DIR: "/configured/pi" }),
			join("/configured/pi", "fuzzy-explorer.json"),
		);
	});

	it("missing file uses defaults", () => {
		assert.deepStrictEqual(loadConfig({ PI_CODING_AGENT_DIR: dirWith(null) }), defaults);
	});

	it("full file applies", () => {
		assert.deepStrictEqual(
			loadConfig({
				PI_CODING_AGENT_DIR: dirWith('{"openShortcut":"alt+x","openMode":"filter"}'),
			}),
			{ openMode: "filter", openShortcut: "alt+x" },
		);
	});

	it("partial file keeps defaults", () => {
		assert.deepStrictEqual(
			loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"openShortcut":"alt+x"}') }),
			{ openMode: "list", openShortcut: "alt+x" },
		);
	});

	it("environment beats file", () => {
		assert.deepStrictEqual(
			loadConfig({
				PI_CODING_AGENT_DIR: dirWith('{"openShortcut":"alt+x","openMode":"list"}'),
				PI_FUZZY_EXPLORER_OPEN_SHORTCUT: "ctrl+shift+f12",
				PI_FUZZY_EXPLORER_OPEN_MODE: "filter",
			}),
			{ openMode: "filter", openShortcut: "ctrl+shift+f12" },
		);
	});

	it("only the documented environment names apply", () => {
		assert.deepStrictEqual(
			loadConfig({
				PI_CODING_AGENT_DIR: dirWith(null),
				PI_FUZZY_EXPLORER_SHORTCUT: "alt+x",
				PI_FUZZY_EXPLORER_MODE: "filter",
				PI_FUZZY_EXPLORER_LIST_ORDER: "relevance",
			}),
			defaults,
		);
	});

	it("open shortcuts accept modified Pi keys and bare function keys", () => {
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
			assert.strictEqual(
				loadConfig({ PI_CODING_AGENT_DIR: dirWith(null), PI_FUZZY_EXPLORER_OPEN_SHORTCUT: shortcut })
					.openShortcut,
				shortcut,
				`valid KeyId ${JSON.stringify(shortcut)}`,
			);
		}
	});

	it("malformed shortcuts are rejected with the environment name", () => {
		const invalidShortcuts = ["", "R", "pageup", "f13", "meta+x", "ctrl+ctrl+x", "ctrl+", "ctrl +r", "ctrl+a+b"];
		for (const shortcut of invalidShortcuts) {
			assert.throws(
				() =>
					loadConfig({
						PI_CODING_AGENT_DIR: dirWith(null),
						PI_FUZZY_EXPLORER_OPEN_SHORTCUT: shortcut,
					}),
				(error) => String(error).includes("PI_FUZZY_EXPLORER_OPEN_SHORTCUT"),
				`invalid KeyId ${JSON.stringify(shortcut)}`,
			);
		}
	});

	it("shortcuts reserved by Pi's main editor are rejected", () => {
		for (const shortcut of [
			"a", "9", "pageUp", "?", "+", "escape", "enter", "ctrl+c", "ctrl+g", "ctrl+p", "shift+ctrl+p",
			"shift+tab", "shift+enter", "ctrl+a", "ctrl+b", "ctrl+e", "ctrl+f", "ctrl+u", "ctrl+w", "ctrl+y",
			"ctrl+j", "ctrl+m", "ctrl+i", "ctrl+h", "ctrl+[", "ctrl+]", "ctrl+alt+]",
			"shift+g", "shift+9", "shift+?", "shift+space", "alt+b", "alt+f", "alt+d",
		]) {
			assert.throws(
				() => loadConfig({ PI_CODING_AGENT_DIR: dirWith(null), PI_FUZZY_EXPLORER_OPEN_SHORTCUT: shortcut }),
				(error) => String(error).includes("is reserved by Pi's main editor"),
				`reserved shortcut ${JSON.stringify(shortcut)}`,
			);
		}
	});

	it("non-string file shortcut names its key", () => {
		const badFileShortcutDir = dirWith('{"openShortcut":42}');
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: badFileShortcutDir }),
			(error) => String(error).includes(`${join(badFileShortcutDir, "fuzzy-explorer.json")}: openShortcut`),
		);
	});

	it("invalid file shortcut explains KeyId", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"openShortcut":"control+r"}') }),
			(error) => String(error).includes("use a Pi KeyId"),
		);
	});

	it("invalid file open mode", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"openMode":"search"}') }),
			(error) => String(error).includes("valid values: list, filter"),
		);
	});

	it("invalid environment open mode", () => {
		assert.throws(
			() =>
				loadConfig({
					PI_CODING_AGENT_DIR: dirWith(null),
					PI_FUZZY_EXPLORER_OPEN_MODE: "LIST",
				}),
			(error) => String(error).includes("PI_FUZZY_EXPLORER_OPEN_MODE"),
		);
	});

	it("empty environment open mode is rejected", () => {
		assert.throws(
			() =>
				loadConfig({
					PI_CODING_AGENT_DIR: dirWith(null),
					PI_FUZZY_EXPLORER_OPEN_MODE: "",
				}),
			(error) => String(error).includes('openMode ""'),
		);
	});

	it("the removed listOrder key is unknown", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"listOrder":"chronological"}') }),
			(error) => String(error).includes("unknown key(s) listOrder"),
		);
	});

	it("unknown key", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"openMod":"filter"}') }),
			(error) => String(error).includes("unknown key(s) openMod"),
		);
	});

	it("inherited object name is still unknown", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"toString":"filter"}') }),
			(error) => String(error).includes("unknown key(s) toString"),
		);
	});

	it("malformed JSON", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith("{broken") }),
			(error) => String(error).includes("not valid JSON"),
		);
	});

	it("array root", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith("[]") }),
			(error) => String(error).includes("must be a JSON object"),
		);
	});

	it("null root", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith("null") }),
			(error) => String(error).includes("must be a JSON object"),
		);
	});

	it("invalid file is not rescued by environment", () => {
		assert.throws(
			() =>
				loadConfig({
					PI_CODING_AGENT_DIR: dirWith('{"openMode":"search"}'),
					PI_FUZZY_EXPLORER_OPEN_MODE: "list",
				}),
			(error) => String(error).includes('openMode "search"'),
		);
	});
});
