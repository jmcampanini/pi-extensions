import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const sandbox = join(process.cwd(), ".sandbox");
mkdirSync(sandbox, { recursive: true });
const testRoot = mkdtempSync(join(sandbox, "fast-openai-"));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = testRoot;
const {
	FAST_OPENAI_STATUS_KEY,
	FAST_OPENAI_STATUS_ON,
	FAST_OPENAI_STATUS_OFF,
} = await import("../../shared/status-keys.ts");
const { default: fastOpenAI } = await import("../index.ts");

after(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	rmSync(testRoot, { recursive: true, force: true });
});

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
assert.ok(fastCommand, "fast command was not registered");
const beforeProviderRequest = handlers.get("before_provider_request");
assert.ok(beforeProviderRequest, "before_provider_request handler was not registered");

const extensionsPath = join(testRoot, "extensions");
const configPath = join(extensionsPath, "fast-openai.json");

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

const injectWith = (enabled: boolean, payload: unknown, ctx: FakeContext): unknown => {
	writeFileSync(configPath, JSON.stringify({ enabled }), "utf8");
	return beforeProviderRequest({ type: "before_provider_request", payload }, ctx);
};

describe("fast status lifecycle", () => {
	it("session lifecycle persists toggles and republishes the fast status", async () => {
		rmSync(extensionsPath, { recursive: true, force: true });
		await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
		assert.deepStrictEqual(
			statuses.at(-1),
			[FAST_OPENAI_STATUS_KEY, FAST_OPENAI_STATUS_OFF],
			"missing config publishes the off status",
		);

		assert.strictEqual(existsSync(extensionsPath), false, "missing config leaves the parent directory absent");
		await fastCommand("on", context);
		assert.deepStrictEqual(
			statuses.at(-1),
			[FAST_OPENAI_STATUS_KEY, FAST_OPENAI_STATUS_ON],
			"fast on publishes the on status",
		);
		assert.deepStrictEqual(
			JSON.parse(readFileSync(configPath, "utf8")),
			{ enabled: true },
			"fast on persists enabled config",
		);

		await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "reload" }, context);
		assert.deepStrictEqual(
			statuses.at(-1),
			[FAST_OPENAI_STATUS_KEY, undefined],
			"shutdown clears the status entirely",
		);

		await handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, context);
		assert.deepStrictEqual(
			statuses.at(-1),
			[FAST_OPENAI_STATUS_KEY, FAST_OPENAI_STATUS_ON],
			"session start restores the on status",
		);

		await fastCommand("off", context);
		assert.deepStrictEqual(
			statuses.at(-1),
			[FAST_OPENAI_STATUS_KEY, FAST_OPENAI_STATUS_OFF],
			"fast off publishes the off status",
		);

		const disabledReloadStart = statuses.length;
		await handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, context);
		assert.deepStrictEqual(statuses.slice(disabledReloadStart), [
			[FAST_OPENAI_STATUS_KEY, FAST_OPENAI_STATUS_OFF],
		], "session start republishes the persisted off status");

		writeFileSync(configPath, '{"enabled":true}', "utf8");
		await handlers.get("agent_start")?.({ type: "agent_start" }, context);
		assert.deepStrictEqual(
			statuses.at(-1),
			[FAST_OPENAI_STATUS_KEY, FAST_OPENAI_STATUS_ON],
			"agent start resyncs an out-of-band config change",
		);

		writeFileSync(configPath, "{invalid", "utf8");
		await handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, context);
		assert.deepStrictEqual(
			statuses.at(-1),
			[FAST_OPENAI_STATUS_KEY, FAST_OPENAI_STATUS_OFF],
			"invalid config publishes the off fallback",
		);

		const statusCount = statuses.length;
		await handlers.get("session_start")?.(
			{ type: "session_start", reason: "reload" },
			{ ...context, hasUI: false },
		);
		assert.strictEqual(statuses.length, statusCount, "headless session does not publish status");
		assert.deepStrictEqual(notifications, [
			['fast-openai on: {"enabled":true}', "info"],
			['fast-openai off: {"enabled":false}', "info"],
		], "successful toggles notify with the saved config");
	});
});

describe("before_provider_request", () => {
	beforeEach(() => {
		rmSync(extensionsPath, { recursive: true, force: true });
		mkdirSync(extensionsPath);
	});

	it("eligible request gains the priority tier", () => {
		assert.deepStrictEqual(
			injectWith(true, { model: "gpt-5.5", input: "hi" }, requestContext(eligibleModel)),
			{ model: "gpt-5.5", input: "hi", service_tier: "priority" },
		);
	});

	it("payload without a model field still gains the tier", () => {
		assert.deepStrictEqual(
			injectWith(true, { input: "hi" }, requestContext(eligibleModel)),
			{ input: "hi", service_tier: "priority" },
		);
	});

	it("payload for a different model is left alone", () => {
		assert.strictEqual(injectWith(true, { model: "gpt-5.4" }, requestContext(eligibleModel)), undefined);
	});

	it("existing service_tier is preserved", () => {
		assert.strictEqual(
			injectWith(true, { model: "gpt-5.5", service_tier: "default" }, requestContext(eligibleModel)),
			undefined,
		);
	});

	it("non-object payload is left alone", () => {
		assert.strictEqual(injectWith(true, "prompt", requestContext(eligibleModel)), undefined);
	});

	it("no current model never injects", () => {
		assert.strictEqual(injectWith(true, {}, requestContext(undefined)), undefined);
	});

	it("unsupported model never injects", () => {
		assert.strictEqual(injectWith(true, {}, requestContext({ ...eligibleModel, id: "gpt-4.1" })), undefined);
	});

	it("unsupported provider never injects", () => {
		assert.strictEqual(injectWith(true, {}, requestContext({ ...eligibleModel, provider: "openai" })), undefined);
	});

	it("unsupported api never injects", () => {
		assert.strictEqual(injectWith(true, {}, requestContext({ ...eligibleModel, api: "openai-responses" })), undefined);
	});

	it("api-key auth never injects", () => {
		assert.strictEqual(injectWith(true, {}, requestContext(eligibleModel, false)), undefined);
	});

	it("disabled config never injects", () => {
		assert.strictEqual(injectWith(false, {}, requestContext(eligibleModel)), undefined);
	});
});
