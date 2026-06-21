import fs from "node:fs";
import path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	clampThinkingLevel,
	createAssistantMessageEventStream,
	getApiProvider,
	registerApiProvider,
	streamOpenAICodexResponses,
	streamOpenAIResponses,
	type Api,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

type FastOpenAIConfig = {
	enabled: boolean;
	providers: string[];
};

type ConfigDiagnostic = {
	path: string;
	message: string;
};

type ConfigFileReadResult =
	| { status: "missing" }
	| { status: "ok"; object: Record<string, unknown> }
	| { status: "invalid"; diagnostic: ConfigDiagnostic };

type ConfigLoadResult = {
	config: FastOpenAIConfig;
	diagnostic?: ConfigDiagnostic;
};

type SupportedApi = "openai-codex-responses" | "openai-responses";

type NativeOpenAIStreamOptions = SimpleStreamOptions & {
	reasoningEffort?: string;
	serviceTier?: "priority";
};

type NativeOpenAIStream = (
	model: Model<Api>,
	context: Context,
	options?: NativeOpenAIStreamOptions,
) => AssistantMessageEventStream;

const DEFAULT_CONFIG: FastOpenAIConfig = {
	enabled: false,
	providers: ["openai-codex"],
};

const CONFIG_FILE = path.join(getAgentDir(), "extensions", "fast-openai.json");
const SUPPORTED_APIS = new Set<Api>(["openai-codex-responses", "openai-responses"]);
const PRIORITY_SERVICE_TIER = "priority" as const;
const nativeOpenAIStreams: Partial<Record<SupportedApi, NativeOpenAIStream>> = {};

function registerApiWrappers(): void {
	registerApiProvider(
		{
			api: "openai-responses",
			stream: (model, context, options) => streamFastOpenAIResponses(model, context, options as SimpleStreamOptions),
			streamSimple: streamFastOpenAIResponses,
		},
		"fast-openai:openai-responses",
	);
	registerApiProvider(
		{
			api: "openai-codex-responses",
			stream: (model, context, options) => streamFastOpenAICodexResponses(model, context, options as SimpleStreamOptions),
			streamSimple: streamFastOpenAICodexResponses,
		},
		"fast-openai:openai-codex-responses",
	);
}

function captureNativeOpenAIStream(api: SupportedApi): void {
	const provider = getApiProvider(api);
	if (!provider) return;
	nativeOpenAIStreams[api] = provider.stream as NativeOpenAIStream;
	registerApiWrappers();
}

function streamNativeOpenAI(
	api: SupportedApi,
	lazyNativeStream: NativeOpenAIStream,
	model: Model<Api>,
	context: Context,
	options: NativeOpenAIStreamOptions,
): AssistantMessageEventStream {
	const nativeStream = nativeOpenAIStreams[api];
	if (nativeStream) return nativeStream(model, context, options);

	const stream = createAssistantMessageEventStream();
	(async () => {
		let captured = false;
		// TODO(fast-openai): Pi-AI's lazy OpenAI providers re-register the native
		// provider globally before this extension re-wraps it. A concurrent cold-start
		// request can briefly resolve the native provider directly and skip serviceTier.
		// Replace this registry-capture path with concrete provider delegation when a
		// stable extension-loader-compatible import path is available.
		const inner = lazyNativeStream(model, context, options);
		for await (const event of inner) {
			if (!captured) {
				captureNativeOpenAIStream(api);
				captured = true;
			}
			stream.push(event);
		}
		if (!captured) captureNativeOpenAIStream(api);
		stream.end();
	})();
	return stream;
}

function defaultConfig(): FastOpenAIConfig {
	return {
		enabled: DEFAULT_CONFIG.enabled,
		providers: [...DEFAULT_CONFIG.providers],
	};
}

function normalizeProviders(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;

	const providers: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string") return undefined;
		const provider = item.trim();
		if (!provider) return undefined;
		if (seen.has(provider)) continue;
		seen.add(provider);
		providers.push(provider);
	}

	return providers.length > 0 ? providers : undefined;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is Error & { code?: unknown } {
	return error instanceof Error && "code" in error;
}

function configDiagnostic(message: string): ConfigDiagnostic {
	return { path: CONFIG_FILE, message };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readConfigFile(): ConfigFileReadResult {
	let contents: string;
	try {
		contents = fs.readFileSync(CONFIG_FILE, "utf-8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { status: "missing" };
		return { status: "invalid", diagnostic: configDiagnostic(`could not read config: ${formatError(error)}`) };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(contents) as unknown;
	} catch (error) {
		return { status: "invalid", diagnostic: configDiagnostic(`could not parse JSON: ${formatError(error)}`) };
	}

	if (!isJsonObject(parsed)) {
		return { status: "invalid", diagnostic: configDiagnostic("config must be a JSON object") };
	}

	return { status: "ok", object: parsed };
}

function parseConfigObject(value: Record<string, unknown>): ConfigLoadResult {
	if (typeof value.enabled !== "boolean") {
		return {
			config: defaultConfig(),
			diagnostic: configDiagnostic('field "enabled" must be a boolean'),
		};
	}

	const providers = normalizeProviders(value.providers);
	if (!providers) {
		return {
			config: defaultConfig(),
			diagnostic: configDiagnostic('field "providers" must be a non-empty array of non-empty strings'),
		};
	}

	return { config: { enabled: value.enabled, providers } };
}

function loadConfigResult(readResult = readConfigFile()): ConfigLoadResult {
	if (readResult.status === "missing") return { config: defaultConfig() };
	if (readResult.status === "invalid") return { config: defaultConfig(), diagnostic: readResult.diagnostic };
	return parseConfigObject(readResult.object);
}

function loadConfig(): FastOpenAIConfig {
	return loadConfigResult().config;
}

function providersForSave(readResult: ConfigFileReadResult): string[] {
	return readResult.status === "ok"
		? (normalizeProviders(readResult.object.providers) ?? [...DEFAULT_CONFIG.providers])
		: [...DEFAULT_CONFIG.providers];
}

function saveConfig(config: FastOpenAIConfig): void {
	fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
	fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function isSupportedApi(api: Api): api is SupportedApi {
	return SUPPORTED_APIS.has(api);
}

function shouldUseFast(model: Model<Api>, config: FastOpenAIConfig): boolean {
	return config.enabled && isSupportedApi(model.api) && config.providers.includes(model.provider);
}

function withoutServiceTier<TOptions extends SimpleStreamOptions>(options: TOptions | undefined): TOptions | undefined {
	if (!options) return undefined;
	const rest = { ...options } as TOptions & { serviceTier?: unknown };
	delete rest.serviceTier;
	return rest as TOptions;
}

function withFastOptions<TOptions extends SimpleStreamOptions>(
	model: Model<Api>,
	options: TOptions | undefined,
	config: FastOpenAIConfig,
): TOptions | (TOptions & { serviceTier: typeof PRIORITY_SERVICE_TIER }) | undefined {
	const baseOptions = withoutServiceTier(options);
	if (!shouldUseFast(model, config)) return baseOptions;
	return { ...baseOptions, serviceTier: PRIORITY_SERVICE_TIER } as TOptions & {
		serviceTier: typeof PRIORITY_SERVICE_TIER;
	};
}

function reasoningEffortFor(model: Model<Api>, options?: SimpleStreamOptions) {
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	return clampedReasoning === "off" ? undefined : clampedReasoning;
}

function streamFastOpenAIResponses(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const config = loadConfig();
	const fastOptions = withFastOptions(model, options, config);
	return streamNativeOpenAI("openai-responses", streamOpenAIResponses as NativeOpenAIStream, model, context, {
		...fastOptions,
		reasoningEffort: reasoningEffortFor(model, options),
	});
}

function streamFastOpenAICodexResponses(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const config = loadConfig();
	const fastOptions = withFastOptions(model, options, config);
	return streamNativeOpenAI("openai-codex-responses", streamOpenAICodexResponses as NativeOpenAIStream, model, context, {
		...fastOptions,
		reasoningEffort: reasoningEffortFor(model, options),
	});
}

function formatConfig(config: FastOpenAIConfig): string {
	return JSON.stringify(config);
}

function formatConfigWarning(diagnostic: ConfigDiagnostic): string {
	return `warning: ignored config at ${diagnostic.path}: ${diagnostic.message}; using disabled fallback and omitting serviceTier`;
}

function hasConfigDiagnostic(loadResult: ConfigLoadResult): loadResult is ConfigLoadResult & { diagnostic: ConfigDiagnostic } {
	return Boolean(loadResult.diagnostic);
}

function formatCurrentModelStatus(model: Model<Api> | undefined, loadResult: ConfigLoadResult): string {
	const { config, diagnostic } = loadResult;
	const lines = [
		...(diagnostic ? [formatConfigWarning(diagnostic)] : []),
		`effective config: ${formatConfig(config)}`,
	];

	if (!model) {
		lines.push("current model: none", "would apply: no", `config path: ${CONFIG_FILE}`);
		return lines.join("\n");
	}

	const providerListed = config.providers.includes(model.provider);
	const apiSupported = isSupportedApi(model.api);
	const applies = shouldUseFast(model, config);
	lines.push(
		`current model: ${model.provider}/${model.id}`,
		`current api: ${model.api}`,
		`provider listed: ${providerListed ? "yes" : "no"}`,
		`api supported: ${apiSupported ? "yes" : "no"}`,
		`would apply: ${applies ? "yes (serviceTier: priority)" : "no"}`,
		`config path: ${CONFIG_FILE}`,
	);
	return lines.join("\n");
}

function showUsage(ctx: ExtensionCommandContext): void {
	ctx.ui.notify("Usage: /fast on | /fast off | /fast status", "info");
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider("fast-openai-openai-responses", {
		api: "openai-responses",
		streamSimple: streamFastOpenAIResponses,
	});

	pi.registerProvider("fast-openai-openai-codex-responses", {
		api: "openai-codex-responses",
		streamSimple: streamFastOpenAICodexResponses,
	});
	registerApiWrappers();

	pi.on("agent_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const model = ctx.model;
		if (!model || !isSupportedApi(model.api)) return;
		const loadResult = loadConfigResult();
		if (!hasConfigDiagnostic(loadResult)) return;
		ctx.ui.notify(`${formatConfigWarning(loadResult.diagnostic)} for ${model.provider}/${model.id}`, "warning");
	});

	pi.registerCommand("fast", {
		description: "Enable, disable, or inspect OpenAI priority service tier",
		handler: async (args, ctx) => {
			const parts = args.trim() ? args.trim().split(/\s+/) : [];
			if (parts.length !== 1) {
				showUsage(ctx);
				return;
			}

			const action = parts[0];
			if (action === "on" || action === "off") {
				const readResult = readConfigFile();
				const previous = loadConfigResult(readResult);
				const nextConfig = {
					enabled: action === "on",
					providers: providersForSave(readResult),
				};
				try {
					saveConfig(nextConfig);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`fast-openai config write failed: ${message}`, "error");
					return;
				}

				const messages = previous.diagnostic
					? [
							`warning: previous config at ${previous.diagnostic.path} was invalid/unreadable and has been overwritten: ${previous.diagnostic.message}`,
							`fast-openai ${action}: ${formatConfig(nextConfig)}`,
						]
					: [`fast-openai ${action}: ${formatConfig(nextConfig)}`];
				ctx.ui.notify(messages.join("\n"), previous.diagnostic ? "warning" : "info");
				return;
			}

			if (action === "status") {
				const loadResult = loadConfigResult();
				ctx.ui.notify(formatCurrentModelStatus(ctx.model, loadResult), loadResult.diagnostic ? "warning" : "info");
				return;
			}

			showUsage(ctx);
		},
	});
}
