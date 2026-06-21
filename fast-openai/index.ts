import fs from "node:fs";
import path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	clampThinkingLevel,
	type Api,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamOpenAICodexResponses } from "@earendil-works/pi-ai/openai-codex-responses";
import { streamOpenAIResponses } from "@earendil-works/pi-ai/openai-responses";

type FastOpenAIConfig = {
	enabled: boolean;
	providers: string[];
};

type SupportedApi = "openai-codex-responses" | "openai-responses";

const DEFAULT_CONFIG: FastOpenAIConfig = {
	enabled: false,
	providers: ["openai-codex"],
};

const CONFIG_FILE = path.join(getAgentDir(), "extensions", "fast-openai.json");
const SUPPORTED_APIS = new Set<Api>(["openai-codex-responses", "openai-responses"]);
const PRIORITY_SERVICE_TIER = "priority" as const;

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

function readConfigObject(): Record<string, unknown> | undefined {
	try {
		if (!fs.existsSync(CONFIG_FILE)) return undefined;
		const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function parseCompleteConfig(value: Record<string, unknown> | undefined): FastOpenAIConfig | undefined {
	if (!value || typeof value.enabled !== "boolean") return undefined;
	const providers = normalizeProviders(value.providers);
	if (!providers) return undefined;
	return { enabled: value.enabled, providers };
}

function loadConfig(): FastOpenAIConfig {
	return parseCompleteConfig(readConfigObject()) ?? defaultConfig();
}

function loadProvidersForSave(): string[] {
	return normalizeProviders(readConfigObject()?.providers) ?? [...DEFAULT_CONFIG.providers];
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
	return streamOpenAIResponses(model as Model<"openai-responses">, context, {
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
	return streamOpenAICodexResponses(model as Model<"openai-codex-responses">, context, {
		...fastOptions,
		reasoningEffort: reasoningEffortFor(model, options),
	});
}

function formatConfig(config: FastOpenAIConfig): string {
	return JSON.stringify(config);
}

function formatCurrentModelStatus(model: Model<Api> | undefined, config: FastOpenAIConfig): string {
	if (!model) {
		return [
			`config: ${formatConfig(config)}`,
			"current model: none",
			"would apply: no",
			`config path: ${CONFIG_FILE}`,
		].join("\n");
	}

	const providerListed = config.providers.includes(model.provider);
	const apiSupported = isSupportedApi(model.api);
	const applies = shouldUseFast(model, config);
	return [
		`config: ${formatConfig(config)}`,
		`current model: ${model.provider}/${model.id}`,
		`current api: ${model.api}`,
		`provider listed: ${providerListed ? "yes" : "no"}`,
		`api supported: ${apiSupported ? "yes" : "no"}`,
		`would apply: ${applies ? "yes (serviceTier: priority)" : "no"}`,
		`config path: ${CONFIG_FILE}`,
	].join("\n");
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
				const nextConfig = {
					enabled: action === "on",
					providers: loadProvidersForSave(),
				};
				try {
					saveConfig(nextConfig);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`fast-openai config write failed: ${message}`, "error");
					return;
				}
				ctx.ui.notify(`fast-openai ${action}: ${formatConfig(nextConfig)}`, "info");
				return;
			}

			if (action === "status") {
				ctx.ui.notify(formatCurrentModelStatus(ctx.model, loadConfig()), "info");
				return;
			}

			showUsage(ctx);
		},
	});
}
