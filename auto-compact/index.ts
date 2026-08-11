import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { config, type AutoCompactConfig } from "./config.ts";
import { formatTokens, isNativeFirst, nativeCompactionTokens, resolveThresholdTokens } from "./threshold.ts";

interface ActiveModel {
	id: string;
	provider: string;
	contextWindow: number;
}

export function registerAutoCompact(pi: ExtensionAPI, resolvedConfig: AutoCompactConfig): void {
	let inFlight = false;
	let failed = false;
	let lastRunAborted = false;
	let active = true;
	const warnedModels = new Set<string>();

	function warnWhenNativeFirst(model: ActiveModel | undefined, notify: (message: string) => void): void {
		if (!resolvedConfig.enabled || !model) return;
		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0 || !isNativeFirst(resolvedConfig, contextWindow)) return;

		const key = `${model.provider}/${model.id}`;
		if (warnedModels.has(key)) return;
		warnedModels.add(key);
		notify(
			`Auto-compact: threshold ${formatTokens(resolveThresholdTokens(resolvedConfig, contextWindow))} for ${model.id} is at or past Pi's native compaction point (${formatTokens(nativeCompactionTokens(contextWindow))}) — native compaction will fire first.`,
		);
	}

	pi.on("session_start", (_event, ctx) => {
		warnWhenNativeFirst(ctx.model, (message) => ctx.ui.notify(message, "warning"));
	});

	pi.on("agent_end", (event) => {
		const lastAssistant = [...event.messages].reverse().find((message) => message.role === "assistant");
		lastRunAborted = lastAssistant?.stopReason === "aborted";
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!resolvedConfig.enabled || failed || inFlight) return;

		const usage = ctx.getContextUsage();
		if (usage == null || usage.tokens == null || usage.contextWindow <= 0) return;

		const thresholdTokens = resolveThresholdTokens(resolvedConfig, usage.contextWindow);
		if (thresholdTokens >= nativeCompactionTokens(usage.contextWindow)) {
			warnWhenNativeFirst(ctx.model, (message) => ctx.ui.notify(message, "warning"));
			return;
		}
		if (usage.tokens < thresholdTokens) return;

		const percent = Math.round((usage.tokens / usage.contextWindow) * 100);
		const status = `${formatTokens(usage.tokens)}/${formatTokens(usage.contextWindow)} (${percent}%)`;
		if (lastRunAborted) {
			ctx.ui.notify(
				`Context at ${status} — auto-compaction deferred after the aborted run; it will run after the next completed run.`,
				"info",
			);
			return;
		}

		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

		inFlight = true;
		ctx.ui.notify(`Context at ${status} — auto-compacting.`, "info");
		return new Promise<void>((resolve) => {
			const finishCompaction = () => {
				inFlight = false;
				resolve();
			};
			ctx.compact({
				onComplete: finishCompaction,
				onError: (error) => {
					failed = true;
					finishCompaction();
					if (active) {
						ctx.ui.notify(
							`Auto-compaction failed: ${error.message}. Auto-compaction is disabled until the next successful compaction or model switch.`,
							"error",
						);
					}
				},
			});
		});
	});

	pi.on("session_compact", () => {
		failed = false;
	});

	pi.on("model_select", (event, ctx) => {
		failed = false;
		warnWhenNativeFirst(event.model, (message) => ctx.ui.notify(message, "warning"));
	});

	pi.on("session_shutdown", () => {
		active = false;
	});
}

export default function autoCompact(pi: ExtensionAPI): void {
	registerAutoCompact(pi, config);
}
