import type { AutoCompactConfig } from "./auto-compact-config.ts";

export function resolveThresholdTokens(config: AutoCompactConfig, contextWindow: number): number {
	const spec = config.classes.find((windowClass) => contextWindow <= windowClass.windowMax) ?? config.default;
	if (spec.thresholdTokens !== undefined) return spec.thresholdTokens;
	return Math.round((contextWindow * spec.thresholdPercent) / 100);
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}
