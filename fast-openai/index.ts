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
};

type FastAction = "on" | "off";

export const FAST_OPENAI_STATUS_KEY = "fast-openai";
// The status is always published while the extension is running, so consumers
// can tell "fast is off" apart from "fast-openai is not loaded" (key absent).
export const FAST_OPENAI_STATUS_ON = "on";
export const FAST_OPENAI_STATUS_OFF = "off";

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

type FastStatusReport = {
	text: string;
	hasWarning: boolean;
};

type PayloadRecord = Record<string, unknown>;
type PiModel = NonNullable<ExtensionContext["model"]>;

type FastEligibility = {
	eligible: boolean;
	providerSupported: boolean;
	apiSupported: boolean;
	modelSupported: boolean;
	usingOAuth: boolean;
};

const CONFIG_FILE = path.join(getAgentDir(), "extensions", "fast-openai.json");
const SUPPORTED_PROVIDER = "openai-codex" as const;
const SUPPORTED_API = "openai-codex-responses" as const;
const SUPPORTED_MODELS = new Set([
	"gpt-5.4",
	"gpt-5.5",
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
]);
const PRIORITY_SERVICE_TIER = "priority" as const;
const COST_ACCOUNTING_WARNING =
	"warning: raw service_tier injection may not apply Pi's native priority cost multiplier; actual billed cost can be higher than Pi displays";

function publishFastStatus(
	ctx: Pick<ExtensionContext, "hasUI" | "ui">,
	enabled: boolean,
): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(FAST_OPENAI_STATUS_KEY, enabled ? FAST_OPENAI_STATUS_ON : FAST_OPENAI_STATUS_OFF);
}

function clearFastStatus(ctx: Pick<ExtensionContext, "hasUI" | "ui">): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(FAST_OPENAI_STATUS_KEY, undefined);
}

function defaultConfig(): FastOpenAIConfig {
	return { enabled: false };
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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readConfigFile(): ConfigFileReadResult {
	let contents: string;
	try {
		contents = fs.readFileSync(CONFIG_FILE, "utf-8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { status: "missing" };
		return {
			status: "invalid",
			diagnostic: configDiagnostic(`could not read config: ${formatError(error)}`),
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(contents) as unknown;
	} catch (error) {
		return {
			status: "invalid",
			diagnostic: configDiagnostic(`could not parse JSON: ${formatError(error)}`),
		};
	}

	if (!isObjectRecord(parsed)) {
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

	return { config: { enabled: value.enabled } };
}

function loadConfigResult(): ConfigLoadResult {
	const readResult = readConfigFile();
	if (readResult.status === "missing") return { config: defaultConfig() };
	// Invalid fast-mode config should not fail the model request. Fast mode is an
	// optional latency/cost preference, so fall back to disabled rather than
	// blocking normal model usage. Request-time payload injection intentionally
	// uses only the returned config, so non-UI runs may just omit service_tier;
	// interactive paths surface the diagnostic via /fast status and agent_start.
	if (readResult.status === "invalid") {
		return { config: defaultConfig(), diagnostic: readResult.diagnostic };
	}
	return parseConfigObject(readResult.object);
}

function saveConfig(config: FastOpenAIConfig): void {
	fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
	fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function getFastEligibility(
	ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
	config: FastOpenAIConfig,
): FastEligibility {
	const model = ctx.model;
	if (!model) {
		return {
			eligible: false,
			providerSupported: false,
			apiSupported: false,
			modelSupported: false,
			usingOAuth: false,
		};
	}

	const providerSupported = model.provider === SUPPORTED_PROVIDER;
	const apiSupported = model.api === SUPPORTED_API;
	const modelSupported = SUPPORTED_MODELS.has(model.id);
	// Eligibility is intentionally narrow because this extension targets fast
	// mode specifically: it should activate only in very specific circumstances,
	// which today means ChatGPT-OAuth Codex sessions. Those circumstances may
	// change over time; revisit these gates when they do.
	const usingOAuth = ctx.modelRegistry.isUsingOAuth(model);

	const eligible =
		config.enabled && providerSupported && apiSupported && modelSupported && usingOAuth;

	return {
		eligible,
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

	const config = loadConfigResult().config;
	const eligibility = getFastEligibility(ctx, config);
	if (!eligibility.eligible) return undefined;
	// These guards are restated in prose by the "request payload check" line in
	// formatCurrentModelStatus; keep the two in sync.
	if (!isObjectRecord(payload)) return undefined;
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

function formatCurrentModelStatus(
	ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
	loadResult: ConfigLoadResult,
): FastStatusReport {
	const { config, diagnostic } = loadResult;
	const model = ctx.model;
	const lines: string[] = [];

	if (diagnostic) lines.push(formatConfigWarning(diagnostic));
	lines.push(`effective config: ${formatConfig(config)}`);

	if (!model) {
		lines.push("current model: none", "would inject: no", `config path: ${CONFIG_FILE}`);
		return { text: lines.join("\n"), hasWarning: Boolean(diagnostic) };
	}

	const eligibility = getFastEligibility(ctx, config);
	lines.push(
		`current model: ${model.provider}/${model.id}`,
		`current api: ${model.api}`,
		`provider supported: ${eligibility.providerSupported ? "yes" : `no (requires ${SUPPORTED_PROVIDER})`}`,
		`api supported: ${eligibility.apiSupported ? "yes" : `no (requires ${SUPPORTED_API})`}`,
		`model supported: ${eligibility.modelSupported ? "yes" : `no (requires ${[...SUPPORTED_MODELS].join(", ")})`}`,
		`using OAuth: ${eligibility.usingOAuth ? "yes" : "no (required)"}`,
		"request payload check: must be an object, match the current model when payload.model is present, and omit service_tier",
		`would inject: ${eligibility.eligible ? "yes (service_tier: priority)" : "no"}`,
		`config path: ${CONFIG_FILE}`,
	);
	if (eligibility.eligible) lines.push(COST_ACCOUNTING_WARNING);
	return { text: lines.join("\n"), hasWarning: Boolean(diagnostic) || eligibility.eligible };
}

function showUsage(ctx: ExtensionCommandContext): void {
	ctx.ui.notify("Usage: /fast on | /fast off | /fast status", "info");
}

function setFastMode(action: FastAction, ctx: ExtensionCommandContext): void {
	const previousDiagnostic = loadConfigResult().diagnostic;
	const nextConfig: FastOpenAIConfig = { enabled: action === "on" };

	try {
		saveConfig(nextConfig);
	} catch (error) {
		ctx.ui.notify(`fast-openai config write failed: ${formatError(error)}`, "error");
		return;
	}

	publishFastStatus(ctx, nextConfig.enabled);
	if (previousDiagnostic) {
		ctx.ui.notify(
			[
				`warning: previous config at ${previousDiagnostic.path} was invalid/unreadable and has been overwritten: ${previousDiagnostic.message}`,
				`fast-openai ${action}: ${formatConfig(nextConfig)}`,
			].join("\n"),
			"warning",
		);
		return;
	}

	ctx.ui.notify(`fast-openai ${action}: ${formatConfig(nextConfig)}`, "info");
}

function showFastStatus(ctx: ExtensionCommandContext): void {
	const report = formatCurrentModelStatus(ctx, loadConfigResult());
	ctx.ui.notify(report.text, report.hasWarning ? "warning" : "info");
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		publishFastStatus(ctx, loadConfigResult().config.enabled);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearFastStatus(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const loadResult = loadConfigResult();
		publishFastStatus(ctx, loadResult.config.enabled);

		const model = ctx.model;
		if (!model || model.api !== SUPPORTED_API || !loadResult.diagnostic) return;
		ctx.ui.notify(`${formatConfigWarning(loadResult.diagnostic)} for ${model.provider}/${model.id}`, "warning");
	});

	pi.on("before_provider_request", (event, ctx) => injectFastServiceTier(event.payload, ctx));

	pi.registerCommand("fast", {
		description: "Enable, disable, or inspect OpenAI Codex Fast mode",
		handler: async (args, ctx) => {
			const trimmedArgs = args.trim();
			const parts = trimmedArgs ? trimmedArgs.split(/\s+/) : [];
			if (parts.length !== 1) {
				showUsage(ctx);
				return;
			}

			const action = parts[0];
			switch (action) {
				case "on":
				case "off":
					setFastMode(action, ctx);
					return;
				case "status":
					showFastStatus(ctx);
					return;
				default:
					showUsage(ctx);
			}
		},
	});
}
