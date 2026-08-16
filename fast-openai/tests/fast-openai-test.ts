import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const sandbox = join(process.cwd(), ".sandbox");
mkdirSync(sandbox, { recursive: true });
const testRoot = mkdtempSync(join(sandbox, "fast-openai-"));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = testRoot;
const { FAST_OPENAI_STATUS_KEY } = await import("../../shared/status-keys.ts");
const { default: fastOpenAI } = await import("../index.ts");

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

interface FakeContext {
	hasUI: boolean;
	ui: {
		setStatus(key: string, text: string | undefined): void;
		notify(message: string, level: string): void;
	};
	model: undefined;
	modelRegistry: {
		isUsingOAuth(): boolean;
	};
}

type EventHandler = (event: unknown, context: FakeContext) => unknown;
type CommandHandler = (args: string, context: FakeContext) => unknown;

const handlers = new Map<string, EventHandler>();
const commands = new Map<string, CommandHandler>();
const fakePi = {
	on(event: string, handler: unknown): void {
		handlers.set(event, handler as EventHandler);
	},
	registerCommand(name: string, options: unknown): void {
		commands.set(name, (options as { handler: CommandHandler }).handler);
	},
} as unknown as ExtensionAPI;

const statuses: Array<[string, string | undefined]> = [];
const notifications: Array<[string, string]> = [];
const context: FakeContext = {
	hasUI: true,
	ui: {
		setStatus: (key, text) => statuses.push([key, text]),
		notify: (message, level) => notifications.push([message, level]),
	},
	model: undefined,
	modelRegistry: {
		isUsingOAuth: () => false,
	},
};

fastOpenAI(fakePi);
const fastCommand = commands.get("fast");
if (!fastCommand) throw new Error("fast command was not registered");

await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
eq("missing config clears fast status", statuses.at(-1), [FAST_OPENAI_STATUS_KEY, undefined]);

await fastCommand("on", context);
eq("fast on publishes the enabled status", statuses.at(-1), [FAST_OPENAI_STATUS_KEY, "fast"]);
eq("fast on persists enabled config", JSON.parse(readFileSync(
	join(testRoot, "extensions", "fast-openai.json"),
	"utf8",
)), {
	enabled: true,
	providers: ["openai-codex"],
});

await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "reload" }, context);
eq("shutdown clears fast status", statuses.at(-1), [FAST_OPENAI_STATUS_KEY, undefined]);

await handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, context);
eq("session start restores enabled fast status", statuses.at(-1), [FAST_OPENAI_STATUS_KEY, "fast"]);

await fastCommand("off", context);
eq("fast off clears the status", statuses.at(-1), [FAST_OPENAI_STATUS_KEY, undefined]);

const disabledReloadStart = statuses.length;
await handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, context);
eq("session start restores persisted disabled status", statuses.slice(disabledReloadStart), [
	[FAST_OPENAI_STATUS_KEY, undefined],
]);

writeFileSync(
	join(testRoot, "extensions", "fast-openai.json"),
	'{"enabled":true,"providers":["openai-codex"]}',
	"utf8",
);
await handlers.get("agent_start")?.({ type: "agent_start" }, context);
eq("agent start resyncs an out-of-band config change", statuses.at(-1), [FAST_OPENAI_STATUS_KEY, "fast"]);

writeFileSync(join(testRoot, "extensions", "fast-openai.json"), "{invalid", "utf8");
await handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, context);
eq("invalid config uses the disabled status fallback", statuses.at(-1), [FAST_OPENAI_STATUS_KEY, undefined]);

const statusCount = statuses.length;
await handlers.get("session_start")?.(
	{ type: "session_start", reason: "reload" },
	{ ...context, hasUI: false },
);
eq("headless session does not publish status", statuses.length, statusCount);
eq("successful toggles retain their notifications", notifications.length, 2);

if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
rmSync(testRoot, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
