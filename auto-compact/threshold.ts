import type { AutoCompactConfig, ThresholdSpec } from "./config.ts";

// Mirrors Pi's DEFAULT_COMPACTION_SETTINGS.reserveTokens: native compaction fires at contextWindow - reserve.
export const NATIVE_RESERVE_TOKENS = 16_384;

export function nativeCompactionTokens(contextWindow: number): number {
	return contextWindow - NATIVE_RESERVE_TOKENS;
}

function specTokens(spec: ThresholdSpec, contextWindow: number): number {
	if (spec.thresholdTokens !== undefined) return spec.thresholdTokens;
	return Math.round((contextWindow * (spec.thresholdPercent ?? 0)) / 100);
}

export function resolveThresholdTokens(config: AutoCompactConfig, contextWindow: number): number {
	const spec = config.classes.find((windowClass) => contextWindow <= windowClass.windowMax) ?? config.default;
	return specTokens(spec, contextWindow);
}

export function effectiveCompactionTokens(config: AutoCompactConfig, contextWindow: number): number {
	return Math.min(resolveThresholdTokens(config, contextWindow), nativeCompactionTokens(contextWindow));
}

export function isNativeFirst(config: AutoCompactConfig, contextWindow: number): boolean {
	return resolveThresholdTokens(config, contextWindow) >= nativeCompactionTokens(contextWindow);
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}
