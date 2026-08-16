import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const sandbox = join(process.cwd(), ".sandbox");
mkdirSync(sandbox, { recursive: true });
const agentDir = mkdtempSync(join(sandbox, "fuzzy-explorer-index-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { registerFuzzyExplorer } = await import("../index.ts");

after(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

type OpenHandler = (ctx: ExtensionContext) => Promise<void>;

describe("registerFuzzyExplorer", () => {
	let commandName = "";
	let commandDescription = "";
	let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	let shortcutRegistrations = 0;
	const pi = {
		registerCommand(name: string, options: { description: string; handler: typeof commandHandler }): void {
			commandName = name;
			commandDescription = options.description;
			commandHandler = options.handler;
		},
		registerShortcut(_key: string, _options: { description: string; handler: OpenHandler }): void {
			shortcutRegistrations++;
		},
	} as unknown as ExtensionAPI;
	registerFuzzyExplorer(pi);

	it("registers the documented slash command", () => {
		assert.strictEqual(commandName, "fuzzy-explorer");
	});

	it("does not register a shortcut by default", () => {
		assert.strictEqual(shortcutRegistrations, 0);
	});

	it("the command has a discoverable description", () => {
		assert.strictEqual(commandDescription.length > 0, true);
	});

	it("the command fails clearly outside interactive TUI", async () => {
		const notices: Array<[string, string]> = [];
		const nonTui = {
			mode: "print",
			ui: { notify: (message: string, level: string) => notices.push([message, level]) },
		} as unknown as ExtensionContext;
		await commandHandler?.("", nonTui);
		assert.deepStrictEqual(notices, [
			["fuzzy-explorer requires Pi's interactive TUI.", "warning"],
		]);
	});
});
