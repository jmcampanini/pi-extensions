import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import modelAllowlist from "./index.ts";

async function setup(initial: unknown = ["allowlist-test/one"], modelsPath: string | null = null) {
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath,
		refreshOnCreate: false,
	});
	const registry = new ModelRegistry(runtime);
	registry.registerProvider("allowlist-test", {
		baseUrl: "http://example.invalid/v1",
		api: "openai-responses",
		apiKey: "fixture-key",
		models: ["one", "two", "three"].map((id) => ({
			id, name: id, headers: { "X-Model": id }, reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000, maxTokens: 100,
		})),
	});
	await registry.refresh({ allowNetwork: false });

	let settings = initial === undefined ? {} : { enabledModels: initial };
	let start: ((event: { type: "session_start" }, ctx: ExtensionContext) => unknown) | undefined;
	const api = {
		on: (event: string, handler: typeof start) => {
			if (event === "session_start") start = handler;
		},
		getSettings: () => settings,
		registerProvider: registry.registerProvider.bind(registry),
		unregisterProvider: registry.unregisterProvider.bind(registry),
	} as ExtensionAPI;
	modelAllowlist(api);
	return {
		registry,
		start: async () => {
			if (!start) throw new Error("session_start handler missing");
			await start({ type: "session_start" }, { modelRegistry: registry } as ExtensionContext);
		},
		set: (value: unknown) => { settings = value === undefined ? {} : { enabledModels: value }; },
	};
}

describe("model allowlist", () => {
	it("filters the real registry and keeps provider authentication across refresh", async () => {
		const test = await setup();
		const model = test.registry.find("allowlist-test", "one")!;
		expect(await test.registry.getApiKeyAndHeaders(model)).toMatchObject({ headers: { "X-Model": "one" } });
		await test.start();

		expect(await test.registry.getApiKeyAndHeaders(model)).toMatchObject({ headers: { "X-Model": "one" } });
		expect(test.registry.getAll().map((model) => `${model.provider}/${model.id}`)).toEqual(["allowlist-test/one"]);
		expect(test.registry.getAvailable().map((model) => model.id)).toEqual(["one"]);
		expect(await test.registry.getApiKeyForProvider("allowlist-test")).toBe("fixture-key");
		expect(test.registry.find("allowlist-test", "two")).toBeUndefined();
		await test.registry.refresh({ allowNetwork: false });
		expect(test.registry.getAll().map((model) => model.id)).toEqual(["one"]);
	});

	it("can widen, narrow, and remove the allowlist on later session starts", async () => {
		const test = await setup();
		await test.start();

		test.set(["allowlist-test/two", "allowlist-test/three"]);
		await test.start();
		expect(test.registry.getAll().map((model) => model.id)).toEqual(["two", "three"]);

		test.set(["allowlist-test/three"]);
		await test.start();
		expect(test.registry.getAll().map((model) => model.id)).toEqual(["three"]);

		test.set(undefined);
		await test.start();
		expect(test.registry.getAll().filter((model) => model.provider === "allowlist-test").map((model) => model.id))
			.toEqual(["one", "two", "three"]);
		expect(await test.registry.getApiKeyAndHeaders(test.registry.find("allowlist-test", "one")!))
			.toMatchObject({ headers: { "X-Model": "one" } });
	});

	it("keeps endpoint-only builtin providers filtered during re-registration and refresh", async () => {
		mkdirSync(".sandbox", { recursive: true });
		const directory = mkdtempSync(join(".sandbox", "model-allowlist-test-"));
		try {
			const path = join(directory, "models.json");
			writeFileSync(path, JSON.stringify({ providers: { openai: {
				baseUrl: "http://example.invalid/v1", apiKey: "fixture-key",
			} } }));
			const test = await setup(["openai/gpt-4.1"], path);
			await test.start();
			expect(test.registry.getAvailable().map((model) => `${model.provider}/${model.id}`)).toEqual(["openai/gpt-4.1"]);
			expect(test.registry.find("openai", "gpt-4.1")?.baseUrl).toBe("http://example.invalid/v1");
			expect(await test.registry.getApiKeyForProvider("openai")).toBe("fixture-key");
			const native = test.registry.getRegisteredNativeProvider("openai")!;
			test.registry.registerProvider(native);
			expect(test.registry.getAvailable().map((model) => `${model.provider}/${model.id}`)).toEqual(["openai/gpt-4.1"]);
			await test.registry.refresh({ allowNetwork: false });
			expect(test.registry.getAvailable().map((model) => `${model.provider}/${model.id}`)).toEqual(["openai/gpt-4.1"]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each([{ value: undefined }, { value: [] }])("leaves the catalog unrestricted for $value", async ({ value }) => {
		const test = await setup();
		test.set(value);
		const before = test.registry.getAll();
		await test.start();
		expect(test.registry.getAll()).toEqual(before);
	});

	it.each([{ value: "allowlist-test/one" }, { value: [null] }, { value: ["one"] }, { value: ["allowlist-test/*"] }, { value: [42] }])(
		"rejects invalid configuration before filtering: $value", async ({ value }) => {
			const test = await setup();
			test.set(value);
			const before = test.registry.getAll();
			await expect(test.start()).rejects.toThrow("enabledModels must contain exact provider/model IDs");
			expect(test.registry.getAll()).toEqual(before);
		},
	);
});
