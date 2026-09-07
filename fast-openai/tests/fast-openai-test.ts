import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTestEventHarness } from "../../shared/test-event-harness.ts";
import {
	FAST_OPENAI_STATUS_KEY,
	FAST_OPENAI_STATUS_ON,
	FAST_OPENAI_STATUS_OFF,
} from "../../shared/status-keys.ts";
import fastOpenAI from "../index.ts";

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

const sol: FakeModel = {
	provider: "openai-codex",
	api: "openai-codex-responses",
	id: "gpt-5.6-sol",
};
const astra: FakeModel = { ...sol, id: "gpt-6-astra" };

function createHarness(model: FakeModel = sol, usingOAuth = true) {
	const events = createTestEventHarness<unknown, FakeContext, unknown>();
	const commands = new Map<string, CommandHandler>();
	const statuses: Array<[string, string | undefined]> = [];
	const notifications: Array<[string, string]> = [];
	const context: FakeContext = {
		hasUI: true,
		ui: {
			setStatus: (key, text) => statuses.push([key, text]),
			notify: (message, level) => notifications.push([message, level]),
		},
		model,
		modelRegistry: { isUsingOAuth: () => usingOAuth },
	};
	const pi = {
		on(event: string, handler: unknown): void {
			events.on(event, handler as EventHandler);
		},
		registerCommand(name: string, options: unknown): void {
			commands.set(name, (options as { handler: CommandHandler }).handler);
		},
	} as unknown as ExtensionAPI;
	fastOpenAI(pi);
	const fast = commands.get("fast");
	assert.ok(fast);

	return {
		context, events, statuses, notifications,
		fast: (args: string) => fast(args, context),
		request(payload: unknown = { model: context.model?.id }) {
			return events.emitResults("before_provider_request", { type: "before_provider_request", payload }, context)[0];
		},
		selectModel(nextModel: FakeModel) {
			const previousModel = context.model;
			context.model = nextModel;
			events.emit("model_select", { type: "model_select", model: nextModel, previousModel, source: "cycle" }, context);
		},
	};
}

describe("fast-openai", () => {
	it("supported non-Astra models request Fast by default", () => {
		for (const id of ["gpt-5.4", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]) {
			const harness = createHarness({ ...sol, id });
			harness.events.emit("session_start", { type: "session_start", reason: "startup" }, harness.context);

			assert.deepStrictEqual(harness.request(), { model: id, service_tier: "priority" }, id);
			assert.deepStrictEqual(harness.statuses.at(-1), [FAST_OPENAI_STATUS_KEY, FAST_OPENAI_STATUS_ON], id);
		}
	});

	it("Astra requires opt-in and keeps that override across turns", async () => {
		const harness = createHarness(astra);
		harness.events.emit("session_start", { type: "session_start", reason: "startup" }, harness.context);
		assert.strictEqual(harness.request(), undefined);
		assert.deepStrictEqual(harness.statuses.at(-1), [FAST_OPENAI_STATUS_KEY, FAST_OPENAI_STATUS_OFF]);

		await harness.fast("on");
		harness.events.emit("agent_start", { type: "agent_start" }, harness.context);

		assert.deepStrictEqual(harness.request(), { model: astra.id, service_tier: "priority" });
		assert.deepStrictEqual(harness.statuses.at(-1), [FAST_OPENAI_STATUS_KEY, FAST_OPENAI_STATUS_ON]);
	});

	it("switching models discards overrides and immediately publishes each destination default", async () => {
		const harness = createHarness();
		await harness.fast("off");
		assert.strictEqual(harness.request(), undefined);

		harness.selectModel(astra);
		assert.strictEqual(harness.request(), undefined);
		assert.deepStrictEqual(harness.statuses.at(-1), [FAST_OPENAI_STATUS_KEY, FAST_OPENAI_STATUS_OFF]);

		await harness.fast("on");
		assert.deepStrictEqual(harness.request(), { model: astra.id, service_tier: "priority" });

		harness.selectModel(sol);
		assert.deepStrictEqual(harness.request(), { model: sol.id, service_tier: "priority" });
		assert.deepStrictEqual(harness.statuses.at(-1), [FAST_OPENAI_STATUS_KEY, FAST_OPENAI_STATUS_ON]);

		harness.selectModel(astra);
		assert.strictEqual(harness.request(), undefined);
		assert.deepStrictEqual(harness.statuses.at(-1), [FAST_OPENAI_STATUS_KEY, FAST_OPENAI_STATUS_OFF]);
	});

	it("new and resumed sessions restore defaults and shutdown removes the status", async () => {
		for (const [model, action, expectedStatus] of [
			[sol, "off", FAST_OPENAI_STATUS_ON],
			[astra, "on", FAST_OPENAI_STATUS_OFF],
		] as const) {
			for (const reason of ["new", "resume", "reload"]) {
				const harness = createHarness(model);
				await harness.fast(action);
				harness.events.emit("session_shutdown", { type: "session_shutdown", reason }, harness.context);
				assert.deepStrictEqual(harness.statuses.at(-1), [FAST_OPENAI_STATUS_KEY, undefined], model.id + " shutdown");

				harness.events.emit("session_start", { type: "session_start", reason }, harness.context);

				assert.deepStrictEqual(harness.statuses.at(-1), [FAST_OPENAI_STATUS_KEY, expectedStatus], model.id + " " + reason);
				assert.deepStrictEqual(
					harness.request(),
					model === sol ? { model: sol.id, service_tier: "priority" } : undefined,
					model.id + " " + reason,
				);
			}
		}
	});

	it("manual overrides do not affect another Pi instance", async () => {
		const first = createHarness(astra);
		const second = createHarness(astra);

		await first.fast("on");

		assert.deepStrictEqual(first.request(), { model: astra.id, service_tier: "priority" });
		assert.strictEqual(second.request(), undefined);
	});

	it("headless requests use model defaults without publishing UI status", () => {
		const harness = createHarness();
		harness.context.hasUI = false;
		Object.defineProperty(harness.context, "ui", { get: () => assert.fail("headless model changes must not read ui") });
		harness.events.emit("session_start", { type: "session_start", reason: "startup" }, harness.context);
		harness.events.emit("agent_start", { type: "agent_start" }, harness.context);

		assert.deepStrictEqual(harness.request(), { model: sol.id, service_tier: "priority" });
		harness.selectModel(astra);
		assert.strictEqual(harness.request(), undefined);
		harness.events.emit("session_shutdown", { type: "session_shutdown" }, harness.context);
		assert.deepStrictEqual(harness.statuses, []);
		assert.deepStrictEqual(harness.notifications, []);
	});

	it("status explains the default and override without changing request behavior", async () => {
		const withoutOAuth = createHarness(sol, false);
		await withoutOAuth.fast("status");
		assert.match(withoutOAuth.notifications.at(-1)?.[0] ?? "", /model default: on[\s\S]*would inject: no/);

		const harness = createHarness(astra);
		await harness.fast("status");
		assert.match(harness.notifications.at(-1)?.[0] ?? "", /model default: off/);
		assert.match(harness.notifications.at(-1)?.[0] ?? "", /current selection override: none/);
		assert.strictEqual(harness.request(), undefined);

		await harness.fast("on");
		await harness.fast("status");

		const [report, level] = harness.notifications.at(-1)!;
		assert.match(report, /model default: off/);
		assert.match(report, /current selection override: on/);
		assert.match(report, /would inject: yes/);
		assert.match(report, /actual billed cost can be higher/);
		assert.strictEqual(level, "warning");
		assert.deepStrictEqual(harness.request(), { model: astra.id, service_tier: "priority" });
	});

	it("explicit request tiers are preserved and a mismatched payload is not upgraded", () => {
		const harness = createHarness();

		assert.strictEqual(harness.request({ model: sol.id, service_tier: "default" }), undefined);
		assert.strictEqual(harness.request({ model: astra.id }), undefined);
		assert.strictEqual(harness.request("prompt"), undefined);
		assert.deepStrictEqual(harness.request({ input: "hi" }), { input: "hi", service_tier: "priority" });
	});

	it("an opt-in cannot bypass model, provider, API, or OAuth eligibility", async () => {
		for (const [model, usingOAuth] of [
			[{ ...sol, id: "gpt-4.1" }, true],
			[{ ...sol, provider: "openai" }, true],
			[{ ...sol, api: "openai-responses" }, true],
			[sol, false],
		] as const) {
			const harness = createHarness(model, usingOAuth);
			harness.events.emit("session_start", { type: "session_start", reason: "startup" }, harness.context);
			assert.strictEqual(harness.request(), undefined, model.id + " default");

			await harness.fast("on");

			assert.strictEqual(harness.request(), undefined, model.id + " override");
			assert.deepStrictEqual(harness.statuses.at(-1), [FAST_OPENAI_STATUS_KEY, FAST_OPENAI_STATUS_OFF], model.id);
			assert.strictEqual(harness.notifications.at(-1)?.[1], "warning", model.id);
		}
	});

	it("a session without a current model stays off", async () => {
		const harness = createHarness();
		harness.context.model = undefined;
		harness.events.emit("session_start", { type: "session_start", reason: "startup" }, harness.context);
		await harness.fast("status");

		assert.strictEqual(harness.request(), undefined);
		assert.deepStrictEqual(harness.statuses.at(-1), [FAST_OPENAI_STATUS_KEY, FAST_OPENAI_STATUS_OFF]);
		assert.match(harness.notifications.at(-1)?.[0] ?? "", /current model: none/);
	});
});
