import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { config, type AutoCompactConfig } from "../shared/auto-compact-config.ts";
import { formatTokens, resolveThresholdTokens } from "../shared/auto-compact-threshold.ts";
import { AUTO_COMPACT_STATUS_KEY } from "../shared/status-keys.ts";


export function registerAutoCompact(pi: ExtensionAPI, resolvedConfig: AutoCompactConfig): void {
	let inFlight = false;
	let failed = false;
	let lastRunAborted = false;
	let active = true;
	const warnedModels = new Set<string>();

	const releaseLatch = (ctx: ExtensionContext) => {
		if (!failed) return;
		failed = false;
		if (ctx.hasUI) ctx.ui.setStatus(AUTO_COMPACT_STATUS_KEY, undefined);
	};

	pi.on("agent_end", (event) => {
		const lastAssistant = [...event.messages].reverse().find((message) => message.role === "assistant");
		lastRunAborted = lastAssistant?.stopReason === "aborted";
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!resolvedConfig.enabled || failed || inFlight) return;

		const usage = ctx.getContextUsage();
		if (usage == null || usage.tokens == null || usage.contextWindow <= 0) return;

		const thresholdTokens = resolveThresholdTokens(resolvedConfig, usage.contextWindow);
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
					if (!active) return;
					if (ctx.hasUI) ctx.ui.setStatus(AUTO_COMPACT_STATUS_KEY, "auto-compact paused");
					if (/cancelled/i.test(error.message)) {
						ctx.ui.notify(
							"Compaction cancelled — auto-compaction paused until the next successful compaction or model switch.",
							"info",
						);
					} else {
						ctx.ui.notify(
							`Auto-compaction failed: ${error.message}. Auto-compaction is disabled until the next successful compaction or model switch.`,
							"error",
						);
					}
				},
			});
		});
	});

	pi.on("session_compact", (event, ctx) => {
		if (failed) {
			releaseLatch(ctx);
			return;
		}
		if (!resolvedConfig.enabled || event.reason !== "threshold") return;

		const model = ctx.model;
		const contextWindow = ctx.getContextUsage()?.contextWindow ?? 0;
		if (!model || contextWindow <= 0) return;

		const key = `${model.provider}/${model.id}`;
		if (warnedModels.has(key)) return;
		warnedModels.add(key);
		const threshold = formatTokens(resolveThresholdTokens(resolvedConfig, contextWindow));
		ctx.ui.notify(
			`Auto-compact: Pi's native compaction ran before Auto Compact could evaluate the ${threshold} threshold for ${model.id}. If this happens repeatedly, the threshold may be at or past Pi's native compaction point.`,
			"warning",
		);
	});

	pi.on("model_select", (_event, ctx) => {
		releaseLatch(ctx);
	});

	pi.on("session_shutdown", () => {
		active = false;
	});
}

export default function autoCompact(pi: ExtensionAPI): void {
	registerAutoCompact(pi, config);
}
