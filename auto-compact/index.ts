import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { config, type AutoCompactConfig } from "./config.ts";

function displayPercent(percent: number): string {
	return `${Math.round(percent)}%`;
}

export function registerAutoCompact(pi: ExtensionAPI, resolvedConfig: AutoCompactConfig): void {
	let inFlight = false;
	let failed = false;
	let lastRunAborted = false;
	let active = true;

	pi.on("agent_end", (event) => {
		const lastAssistant = [...event.messages].reverse().find((message) => message.role === "assistant");
		lastRunAborted = lastAssistant?.stopReason === "aborted";
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!resolvedConfig.enabled || failed || inFlight) return;

		const usage = ctx.getContextUsage();
		if (usage?.percent == null || usage.percent < resolvedConfig.thresholdPercent) return;

		const percent = displayPercent(usage.percent);
		if (lastRunAborted) {
			ctx.ui.notify(
				`Context at ${percent} — auto-compaction deferred after the aborted run; it will run after the next completed run.`,
				"info",
			);
			return;
		}

		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

		let resolveCompaction: (() => void) | undefined;
		const waitForCompaction =
			ctx.mode === "print" || ctx.mode === "json"
				? new Promise<void>((resolve) => {
						resolveCompaction = resolve;
					})
				: undefined;
		const finishCompaction = () => {
			inFlight = false;
			resolveCompaction?.();
		};

		inFlight = true;
		ctx.ui.notify(`Context at ${percent} — auto-compacting.`, "info");
		ctx.compact({
			onComplete: finishCompaction,
			onError: (error) => {
				failed = true;
				finishCompaction();
				if (active) {
					ctx.ui.notify(
						`Auto-compaction failed: ${error.message}. Percentage auto-compaction is disabled until the next successful compaction or model switch.`,
						"error",
					);
				}
			},
		});
		return waitForCompaction;
	});

	pi.on("session_compact", () => {
		failed = false;
	});

	pi.on("model_select", () => {
		failed = false;
	});

	pi.on("session_shutdown", () => {
		active = false;
	});
}

export default function autoCompact(pi: ExtensionAPI): void {
	registerAutoCompact(pi, config);
}
