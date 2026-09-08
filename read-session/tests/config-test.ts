import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { matchesKey } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { loadConfig } from "../config.ts";

const sandbox = join(process.cwd(), ".sandbox");
mkdirSync(sandbox, { recursive: true });
const directory = mkdtempSync(join(sandbox, "read-session-config-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));

describe("reader configuration", () => {
	it("uses Ctrl+R without conflicts when Pi session rename is unbound", () => {
		const config = loadConfig({ PI_CODING_AGENT_DIR: directory });
		const bindings = new KeybindingsManager({ "app.session.rename": [] }).getEffectiveConfig();
		const keys = Object.values(bindings)
			.flat()
			.filter((key) => key !== undefined);

		assert.equal(config.openShortcut, "ctrl+r");
		assert.ok(matchesKey("\u0012", config.openShortcut!));
		assert.ok(keys.every((key) => key.split("+").sort().join("+") !== "ctrl+r"));
	});

	it("loads the shortcut from the config file and lets the environment override it", () => {
		writeFileSync(join(directory, "read-session.json"), '{"openShortcut":"f6"}');
		const env = { PI_CODING_AGENT_DIR: directory };

		assert.equal(loadConfig(env).openShortcut, "f6");
		assert.equal(loadConfig({ ...env, PI_READ_SESSION_OPEN_SHORTCUT: "ctrl+alt+r" }).openShortcut, "ctrl+alt+r");
	});

	it("disables the shortcut with a null file value or an empty environment override", () => {
		writeFileSync(join(directory, "read-session.json"), '{"openShortcut":null}');
		const env = { PI_CODING_AGENT_DIR: directory };

		assert.equal(loadConfig(env).openShortcut, null);
		assert.equal(loadConfig({ ...env, PI_READ_SESSION_OPEN_SHORTCUT: "f6" }).openShortcut, "f6");
		assert.equal(loadConfig({ ...env, PI_READ_SESSION_OPEN_SHORTCUT: "" }).openShortcut, null);
	});
});
