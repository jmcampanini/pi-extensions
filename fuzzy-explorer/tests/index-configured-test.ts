import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const sandbox = join(process.cwd(), ".sandbox");
mkdirSync(sandbox, { recursive: true });
const agentDir = mkdtempSync(join(sandbox, "fuzzy-explorer-index-configured-"));
writeFileSync(join(agentDir, "fuzzy-explorer.json"), '{"openShortcut":"ctrl+r"}');
process.env.PI_CODING_AGENT_DIR = agentDir;
const { registerFuzzyExplorer } = await import("../index.ts");

after(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

type OpenHandler = (ctx: ExtensionContext) => Promise<void>;

describe("registerFuzzyExplorer", () => {
	it("registers the configured shortcut and fails clearly outside interactive TUI", async () => {
		let shortcut = "";
		let shortcutDescription = "";
		let shortcutHandler: OpenHandler | undefined;
		const pi = {
			registerCommand(): void {},
			registerShortcut(key: string, options: { description: string; handler: OpenHandler }): void {
				shortcut = key;
				shortcutDescription = options.description;
				shortcutHandler = options.handler;
			},
		} as unknown as ExtensionAPI;
		registerFuzzyExplorer(pi);

		assert.strictEqual(shortcut, "ctrl+r", "registers the configured shortcut");
		assert.strictEqual(shortcutDescription.length > 0, true, "the shortcut has a discoverable description");

		const notices: Array<[string, string]> = [];
		const nonTui = {
			mode: "print",
			ui: { notify: (message: string, level: string) => notices.push([message, level]) },
		} as unknown as ExtensionContext;
		await shortcutHandler?.(nonTui);
		assert.deepStrictEqual(notices, [
			["fuzzy-explorer requires Pi's interactive TUI.", "warning"],
		], "the shortcut fails clearly outside interactive TUI");
	});
});
