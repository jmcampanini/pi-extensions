import fs from "node:fs";
import path from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

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

type PayloadRecord = Record<string, unknown>;
type PiModel = NonNullable<ExtensionContext["model"]>;

type FastEligibility = {
	eligible: boolean;
	providerListed: boolean;
	providerSupported: boolean;
	apiSupported: boolean;
	modelSupported: boolean;
	usingOAuth: boolean;
};

const DEFAULT_CONFIG: FastOpenAIConfig = {
	enabled: false,
	providers: ["openai-codex"],
};

const CONFIG_FILE = path.join(getAgentDir(), "extensions", "fast-openai.json");
const SUPPORTED_PROVIDER = "openai-codex" as const;
const SUPPORTED_API = "openai-codex-responses" as const;
const SUPPORTED_MODELS = new Set(["gpt-5.4", "gpt-5.5"]);
const PRIORITY_SERVICE_TIER = "priority" as const;
const COST_ACCOUNTING_WARNING =
	"warning: raw service_tier injection may not apply Pi's native priority cost multiplier; actual billed cost can be higher than Pi displays";

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
	// Invalid fast-mode config should not fail the model request. Fast mode is an
	// optional latency/cost preference, so fall back to disabled rather than
	// blocking normal model usage. Request-time payload injection intentionally
	// uses only the returned config, so non-UI runs may just omit service_tier;
	// interactive paths surface the diagnostic via /fast status and agent_start.
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

function isSupportedApi(api: unknown): boolean {
	return api === SUPPORTED_API;
}

function isSupportedModelId(id: unknown): boolean {
	return typeof id === "string" && SUPPORTED_MODELS.has(id);
}

function isPayloadRecord(payload: unknown): payload is PayloadRecord {
	return typeof payload === "object" && payload !== null && !Array.isArray(payload);
}

function isUsingOAuth(ctx: Pick<ExtensionContext, "modelRegistry">, model: PiModel): boolean {
	try {
		return ctx.modelRegistry.isUsingOAuth(model);
	} catch {
		return false;
	}
}

function getFastEligibility(ctx: Pick<ExtensionContext, "model" | "modelRegistry">, config: FastOpenAIConfig): FastEligibility {
	const model = ctx.model;
	if (!model) {
		return {
			eligible: false,
			providerListed: false,
			providerSupported: false,
			apiSupported: false,
			modelSupported: false,
			usingOAuth: false,
		};
	}

	const providerListed = config.providers.includes(model.provider);
	const providerSupported = model.provider === SUPPORTED_PROVIDER;
	const apiSupported = isSupportedApi(model.api);
	const modelSupported = isSupportedModelId(model.id);
	const usingOAuth = isUsingOAuth(ctx, model);

	return {
		eligible: config.enabled && providerListed && providerSupported && apiSupported && modelSupported && usingOAuth,
		providerListed,
		providerSupported,
		apiSupported,
		modelSupported,
		usingOAuth,
	};
}

function payloadMatchesModel(payload: PayloadRecord, model: PiModel): boolean {
	return payload.model === undefined || payload.model === model.id;
}

function injectFastServiceTier(payload: unknown, ctx: ExtensionContext): PayloadRecord | undefined {
	const model = ctx.model;
	if (!model) return undefined;

	const config = loadConfig();
	const eligibility = getFastEligibility(ctx, config);
	if (!eligibility.eligible) return undefined;
	if (!isPayloadRecord(payload)) return undefined;
	if ("service_tier" in payload) return undefined;
	if (!payloadMatchesModel(payload, model)) return undefined;

	// We intentionally use the simpler before_provider_request hook instead of
	// native serviceTier provider wrapping. Raw service_tier injection avoids the
	// lazy-provider capture race, but Pi-AI's priority cost multiplier is tied to
	// native serviceTier options, so /fast status warns about possible displayed
	// cost undercounting.
	return { ...payload, service_tier: PRIORITY_SERVICE_TIER };
}

function formatConfig(config: FastOpenAIConfig): string {
	return JSON.stringify(config);
}

function formatConfigWarning(diagnostic: ConfigDiagnostic): string {
	return `warning: ignored config at ${diagnostic.path}: ${diagnostic.message}; using disabled fallback and omitting service_tier`;
}

function hasConfigDiagnostic(loadResult: ConfigLoadResult): loadResult is ConfigLoadResult & { diagnostic: ConfigDiagnostic } {
	return Boolean(loadResult.diagnostic);
}

function formatCurrentModelStatus(ctx: Pick<ExtensionContext, "model" | "modelRegistry">, loadResult: ConfigLoadResult): string {
	const { config, diagnostic } = loadResult;
	const model = ctx.model;
	const lines = [
		...(diagnostic ? [formatConfigWarning(diagnostic)] : []),
		`effective config: ${formatConfig(config)}`,
	];

	if (!model) {
		lines.push("current model: none", "would inject: no", `config path: ${CONFIG_FILE}`);
		if (config.enabled) lines.push(COST_ACCOUNTING_WARNING);
		return lines.join("\n");
	}

	const eligibility = getFastEligibility(ctx, config);
	lines.push(
		`current model: ${model.provider}/${model.id}`,
		`current api: ${model.api}`,
		`provider listed: ${eligibility.providerListed ? "yes" : "no"}`,
		`provider supported: ${eligibility.providerSupported ? "yes" : `no (requires ${SUPPORTED_PROVIDER})`}`,
		`api supported: ${eligibility.apiSupported ? "yes" : `no (requires ${SUPPORTED_API})`}`,
		`model supported: ${eligibility.modelSupported ? "yes" : "no (requires gpt-5.4 or gpt-5.5)"}`,
		`using OAuth: ${eligibility.usingOAuth ? "yes" : "no (required)"}`,
		"request payload check: must be an object, match the current model when payload.model is present, and omit service_tier",
		`would inject: ${eligibility.eligible ? "yes (service_tier: priority)" : "no"}`,
		`config path: ${CONFIG_FILE}`,
	);
	if (config.enabled) lines.push(COST_ACCOUNTING_WARNING);
	return lines.join("\n");
}

function showUsage(ctx: ExtensionCommandContext): void {
	ctx.ui.notify("Usage: /fast on | /fast off | /fast status", "info");
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const model = ctx.model;
		if (!model || !isSupportedApi(model.api)) return;
		const loadResult = loadConfigResult();
		if (!hasConfigDiagnostic(loadResult)) return;
		ctx.ui.notify(`${formatConfigWarning(loadResult.diagnostic)} for ${model.provider}/${model.id}`, "warning");
	});

	pi.on("before_provider_request", (event, ctx) => injectFastServiceTier(event.payload, ctx));

	pi.registerCommand("fast", {
		description: "Enable, disable, or inspect OpenAI Codex Fast mode",
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
				ctx.ui.notify(
					formatCurrentModelStatus(ctx, loadResult),
					loadResult.diagnostic || loadResult.config.enabled ? "warning" : "info",
				);
				return;
			}

			showUsage(ctx);
		},
	});
}
