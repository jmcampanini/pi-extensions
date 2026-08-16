import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const sandbox = join(process.cwd(), ".sandbox");
mkdirSync(sandbox, { recursive: true });
const testRoot = mkdtempSync(join(sandbox, "fast-openai-"));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = testRoot;
const {
	default: fastOpenAI,
	FAST_OPENAI_STATUS_KEY,
	FAST_OPENAI_STATUS_ON,
	FAST_OPENAI_STATUS_OFF,
} = await import("../index.ts");

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

interface FakeModel {
	provider: string;
	api: string;
	id: string;
}

interface FakeContext {
	hasUI: boolean;
	ui: {
		setStatus(key: string, text: string | undefined): void;
		notify(message: string, level: string): void;
	};
	model: FakeModel | undefined;
	modelRegistry: {
		isUsingOAuth(model: FakeModel): boolean;
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

const configPath = join(testRoot, "extensions", "fast-openai.json");

await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
eq("missing config publishes the off status", statuses.at(-1), [FAST_OPENAI_STATUS_KEY, FAST_OPENAI_STATUS_OFF]);

await fastCommand("on", context);
eq("fast on publishes the on status", statuses.at(-1), [FAST_OPENAI_STATUS_KEY, FAST_OPENAI_STATUS_ON]);
eq("fast on persists enabled config", JSON.parse(readFileSync(configPath, "utf8")), {
	enabled: true,
});

await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "reload" }, context);
eq("shutdown clears the status entirely", statuses.at(-1), [FAST_OPENAI_STATUS_KEY, undefined]);

await handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, context);
eq("session start restores the on status", statuses.at(-1), [FAST_OPENAI_STATUS_KEY, FAST_OPENAI_STATUS_ON]);

await fastCommand("off", context);
eq("fast off publishes the off status", statuses.at(-1), [FAST_OPENAI_STATUS_KEY, FAST_OPENAI_STATUS_OFF]);

const disabledReloadStart = statuses.length;
await handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, context);
eq("session start republishes the persisted off status", statuses.slice(disabledReloadStart), [
	[FAST_OPENAI_STATUS_KEY, FAST_OPENAI_STATUS_OFF],
]);

writeFileSync(configPath, '{"enabled":true}', "utf8");
await handlers.get("agent_start")?.({ type: "agent_start" }, context);
eq("agent start resyncs an out-of-band config change", statuses.at(-1), [FAST_OPENAI_STATUS_KEY, FAST_OPENAI_STATUS_ON]);

writeFileSync(configPath, "{invalid", "utf8");
await handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, context);
eq("invalid config publishes the off fallback", statuses.at(-1), [FAST_OPENAI_STATUS_KEY, FAST_OPENAI_STATUS_OFF]);

const statusCount = statuses.length;
await handlers.get("session_start")?.(
	{ type: "session_start", reason: "reload" },
	{ ...context, hasUI: false },
);
eq("headless session does not publish status", statuses.length, statusCount);
eq("successful toggles notify with the saved config", notifications, [
	['fast-openai on: {"enabled":true}', "info"],
	['fast-openai off: {"enabled":false}', "info"],
]);

const beforeProviderRequest = handlers.get("before_provider_request");
if (!beforeProviderRequest) throw new Error("before_provider_request handler was not registered");

const eligibleModel: FakeModel = {
	provider: "openai-codex",
	api: "openai-codex-responses",
	id: "gpt-5.5",
};

const requestContext = (model: FakeModel | undefined, usingOAuth = true): FakeContext => ({
	...context,
	model,
	modelRegistry: { isUsingOAuth: () => usingOAuth },
});

const inject = (payload: unknown, ctx: FakeContext): unknown =>
	beforeProviderRequest({ type: "before_provider_request", payload }, ctx);

writeFileSync(configPath, '{"enabled":true}', "utf8");
eq("eligible request gains the priority tier",
	inject({ model: "gpt-5.5", input: "hi" }, requestContext(eligibleModel)),
	{ model: "gpt-5.5", input: "hi", service_tier: "priority" });
eq("payload without a model field still gains the tier",
	inject({ input: "hi" }, requestContext(eligibleModel)),
	{ input: "hi", service_tier: "priority" });
eq("payload for a different model is left alone",
	inject({ model: "gpt-5.4" }, requestContext(eligibleModel)), undefined);
eq("existing service_tier is preserved",
	inject({ model: "gpt-5.5", service_tier: "default" }, requestContext(eligibleModel)), undefined);
eq("non-object payload is left alone",
	inject("prompt", requestContext(eligibleModel)), undefined);
eq("no current model never injects",
	inject({}, requestContext(undefined)), undefined);
eq("unsupported model never injects",
	inject({}, requestContext({ ...eligibleModel, id: "gpt-4.1" })), undefined);
eq("unsupported provider never injects",
	inject({}, requestContext({ ...eligibleModel, provider: "openai" })), undefined);
eq("unsupported api never injects",
	inject({}, requestContext({ ...eligibleModel, api: "openai-responses" })), undefined);
eq("api-key auth never injects",
	inject({}, requestContext(eligibleModel, false)), undefined);

writeFileSync(configPath, '{"enabled":false}', "utf8");
eq("disabled config never injects",
	inject({}, requestContext(eligibleModel)), undefined);

if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
rmSync(testRoot, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
