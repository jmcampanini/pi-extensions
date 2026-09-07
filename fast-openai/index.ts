import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	FAST_OPENAI_STATUS_KEY,
	FAST_OPENAI_STATUS_OFF,
	FAST_OPENAI_STATUS_ON,
} from "../shared/status-keys.ts";

type PayloadRecord = Record<string, unknown>;
type PiModel = NonNullable<ExtensionContext["model"]>;

type FastEligibility = {
	eligible: boolean;
	providerSupported: boolean;
	apiSupported: boolean;
	modelSupported: boolean;
	usingOAuth: boolean;
};

const SUPPORTED_PROVIDER = "openai-codex" as const;
const SUPPORTED_API = "openai-codex-responses" as const;
const DEFAULT_FAST_MODELS = new Set([
	"gpt-5.4",
	"gpt-5.5",
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
]);
const SUPPORTED_MODELS = new Set([...DEFAULT_FAST_MODELS, "gpt-6-astra"]);
const PRIORITY_SERVICE_TIER = "priority" as const;

export default function (pi: ExtensionAPI): void {
	let manualOverride: boolean | undefined;

	function publishStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const { eligible } = getFastEligibility(ctx, manualOverride);
		ctx.ui.setStatus(FAST_OPENAI_STATUS_KEY, eligible ? FAST_OPENAI_STATUS_ON : FAST_OPENAI_STATUS_OFF);
	}

	function setFastMode(action: "on" | "off", ctx: ExtensionCommandContext): void {
		if (action === "on" && !getFastEligibility(ctx, true).eligible) {
			ctx.ui.notify("Fast mode is unavailable for this model, provider, or authentication. Use /fast status for details.", "warning");
			return;
		}

		manualOverride = action === "on";
		publishStatus(ctx);
		ctx.ui.notify(`Fast mode ${action} for the current selection; resets when the model changes.`, "info");
	}

	pi.on("session_start", (_event, ctx) => {
		manualOverride = undefined;
		publishStatus(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		manualOverride = undefined;
		publishStatus(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(FAST_OPENAI_STATUS_KEY, undefined);
	});

	pi.on("agent_start", (_event, ctx) => publishStatus(ctx));
	pi.on("before_provider_request", (event, ctx) => injectFastServiceTier(event.payload, ctx, manualOverride));

	pi.registerCommand("fast", {
		description: "Enable, disable, or inspect OpenAI Codex Fast mode for the current model selection",
		handler: async (args, ctx) => {
			const action = args.trim();
			switch (action) {
				case "on":
				case "off":
					setFastMode(action, ctx);
					return;
				case "status":
					ctx.ui.notify(formatCurrentModelStatus(ctx, manualOverride), "info");
					return;
				default:
					ctx.ui.notify("Usage: /fast on | /fast off | /fast status", "info");
			}
		},
	});
}

function getFastEligibility(
	ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
	manualOverride?: boolean,
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
	const usingOAuth = ctx.modelRegistry.isUsingOAuth(model);
	const enabled = manualOverride ?? DEFAULT_FAST_MODELS.has(model.id);
	const eligible = enabled && providerSupported && apiSupported && modelSupported && usingOAuth;

	return { eligible, providerSupported, apiSupported, modelSupported, usingOAuth };
}

function payloadMatchesModel(payload: PayloadRecord, model: PiModel): boolean {
	return payload.model === undefined || payload.model === model.id;
}

function injectFastServiceTier(
	payload: unknown,
	ctx: ExtensionContext,
	manualOverride?: boolean,
): PayloadRecord | undefined {
	const model = ctx.model;
	if (!model || !getFastEligibility(ctx, manualOverride).eligible) return undefined;
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	if ("service_tier" in payload) return undefined;
	if (!payloadMatchesModel(payload as PayloadRecord, model)) return undefined;

	// The request hook avoids Pi's lazy-provider capture race.
	return { ...payload, service_tier: PRIORITY_SERVICE_TIER };
}

function formatCurrentModelStatus(
	ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
	manualOverride?: boolean,
): string {
	const model = ctx.model;
	if (!model) return "current model: none\nwould inject: no";

	const eligibility = getFastEligibility(ctx, manualOverride);
	const defaultEnabled = DEFAULT_FAST_MODELS.has(model.id);
	const override = manualOverride === undefined ? "none" : manualOverride ? "on" : "off";
	const lines = [
		`current model: ${model.provider}/${model.id}`,
		`current api: ${model.api}`,
		`model default: ${defaultEnabled ? "on" : "off"}`,
		`current selection override: ${override}`,
		"model changes and session starts restore the model default",
		`provider supported: ${eligibility.providerSupported ? "yes" : `no (requires ${SUPPORTED_PROVIDER})`}`,
		`api supported: ${eligibility.apiSupported ? "yes" : `no (requires ${SUPPORTED_API})`}`,
		`model supported: ${eligibility.modelSupported ? "yes" : `no (requires ${[...SUPPORTED_MODELS].join(", ")})`}`,
		`using OAuth: ${eligibility.usingOAuth ? "yes" : "no (required)"}`,
		"request payload check: must be an object, match the current model when payload.model is present, and omit service_tier",
		`would inject: ${eligibility.eligible ? "yes (service_tier: priority)" : "no"}`,
	];
	return lines.join("\n");
}
