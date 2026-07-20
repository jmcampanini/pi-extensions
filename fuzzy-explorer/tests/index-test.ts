import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const sandbox = join(process.cwd(), ".sandbox");
mkdirSync(sandbox, { recursive: true });
const agentDir = mkdtempSync(join(sandbox, "fuzzy-explorer-index-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { registerFuzzyExplorer } = await import("../index.ts");

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown): void {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}: got ${g}, want ${w}`); }
}

type OpenHandler = (ctx: ExtensionContext) => Promise<void>;
let commandName = "";
let commandDescription = "";
let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
let shortcut = "";
let shortcutDescription = "";
let shortcutHandler: OpenHandler | undefined;
const pi = {
	registerCommand(name: string, options: { description: string; handler: typeof commandHandler }): void {
		commandName = name;
		commandDescription = options.description;
		commandHandler = options.handler;
	},
	registerShortcut(key: string, options: { description: string; handler: OpenHandler }): void {
		shortcut = key;
		shortcutDescription = options.description;
		shortcutHandler = options.handler;
	},
} as unknown as ExtensionAPI;
registerFuzzyExplorer(pi);

eq("registers the documented slash command", commandName, "fuzzy-explorer");
eq("registers the default shortcut", shortcut, "ctrl+r");
eq("both registrations have discoverable descriptions",
	[commandDescription.length > 0, shortcutDescription.length > 0], [true, true]);

const notices: Array<[string, string]> = [];
const nonTui = {
	mode: "print",
	ui: { notify: (message: string, level: string) => notices.push([message, level]) },
} as unknown as ExtensionContext;
await commandHandler?.("", nonTui);
await shortcutHandler?.(nonTui);
eq("both entry points fail clearly outside interactive TUI", notices, [
	["fuzzy-explorer requires Pi's interactive TUI.", "warning"],
	["fuzzy-explorer requires Pi's interactive TUI.", "warning"],
]);

rmSync(agentDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
