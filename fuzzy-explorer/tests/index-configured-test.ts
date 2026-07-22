import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const sandbox = join(process.cwd(), ".sandbox");
mkdirSync(sandbox, { recursive: true });
const agentDir = mkdtempSync(join(sandbox, "fuzzy-explorer-index-configured-"));
writeFileSync(join(agentDir, "fuzzy-explorer.json"), '{"openShortcut":"ctrl+r"}');
process.env.PI_CODING_AGENT_DIR = agentDir;
const { registerFuzzyExplorer } = await import("../index.ts");

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown): void {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}: got ${g}, want ${w}`); }
}

type OpenHandler = (ctx: ExtensionContext) => Promise<void>;
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

eq("registers the configured shortcut", shortcut, "ctrl+r");
eq("the shortcut has a discoverable description", shortcutDescription.length > 0, true);

const notices: Array<[string, string]> = [];
const nonTui = {
	mode: "print",
	ui: { notify: (message: string, level: string) => notices.push([message, level]) },
} as unknown as ExtensionContext;
await shortcutHandler?.(nonTui);
eq("the shortcut fails clearly outside interactive TUI", notices, [
	["fuzzy-explorer requires Pi's interactive TUI.", "warning"],
]);

rmSync(agentDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
