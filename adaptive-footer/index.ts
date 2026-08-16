import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hyperlink } from "@earendil-works/pi-tui";
import { config as autoCompactConfig, type AutoCompactConfig } from "../auto-compact/config.ts";
import { AUTO_COMPACT_STATUS_KEY } from "../auto-compact/index.ts";
import { formatTokens, resolveThresholdTokens } from "../auto-compact/threshold.ts";
import { ELAPSED_TIME_STATUS_KEY } from "../elapsed-time/index.ts";
import { FAST_OPENAI_STATUS_KEY } from "../fast-openai/index.ts";
import { clampStyled, fitText } from "../interactive-subagents/text-fit.ts";
import { config as adaptiveFooterConfig } from "./config.ts";
import {
	cwdVariants,
	fitFooterLayout,
	fitRepositoryLayout,
	styleFooterSpans,
	styleRepositorySpans,
	type FooterComponent,
} from "./layout.ts";
import {
	createRepositoryContextRefresher,
	discoverRepositoryContext,
	type RepositoryContextDiscovery,
} from "./repository-context.ts";

type ContextColorBand = "error" | "warning";

export interface ComponentVariants {
	full: string;
	compact: string;
}

export function compactTargetVariants(
	autoCompactConfig: AutoCompactConfig,
	contextWindow: number,
	contextTokens?: number | null,
	paused = false,
): ComponentVariants | undefined {
	if (!autoCompactConfig.enabled || contextWindow <= 0) return undefined;
	if (paused) return { full: "compact ⏸", compact: "C⏸" };
	const thresholdTokens = resolveThresholdTokens(autoCompactConfig, contextWindow);
	const target = formatTokens(thresholdTokens);
	if (contextTokens == null) {
		return {
			full: `compact @${target}`,
			compact: `C@${target}`,
		};
	}
	const percent = Math.round((contextTokens / thresholdTokens) * 100);
	return {
		full: `compact @${target} ${percent}%`,
		compact: `C${percent}%`,
	};
}

export function selectContextColorBand(
	percent: number | null | undefined,
	autoCompactConfig: AutoCompactConfig,
	contextWindow: number,
	paused = false,
): ContextColorBand | undefined {
	if (percent == null) return undefined;

	if (!autoCompactConfig.enabled || contextWindow <= 0 || paused) {
		if (percent > 90) return "error";
		if (percent > 70) return "warning";
		return undefined;
	}

	const targetPercent = (resolveThresholdTokens(autoCompactConfig, contextWindow) / contextWindow) * 100;
	if (percent >= targetPercent) return "error";
	if (percent >= targetPercent - 10) return "warning";
	return undefined;
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

export function partitionFooterStatuses(statuses: ReadonlyMap<string, string>): {
	elapsedTime: string | undefined;
	fastMode: boolean;
	autoCompactPaused: boolean;
	statusLine: string | undefined;
} {
	const elapsedTime = statuses.get(ELAPSED_TIME_STATUS_KEY);
	const ownedKeys = [ELAPSED_TIME_STATUS_KEY, FAST_OPENAI_STATUS_KEY, AUTO_COMPACT_STATUS_KEY];
	const statusLine = Array.from(statuses.entries())
		.filter(([key]) => !ownedKeys.includes(key))
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizeStatusText(text))
		.join(" ");
	return {
		elapsedTime: elapsedTime === undefined ? undefined : sanitizeStatusText(elapsedTime),
		fastMode: statuses.has(FAST_OPENAI_STATUS_KEY),
		autoCompactPaused: statuses.has(AUTO_COMPACT_STATUS_KEY),
		statusLine: statusLine || undefined,
	};
}

export function tokenFlowVariants(input: number, output: number): ComponentVariants | undefined {
	const parts: string[] = [];
	if (input) parts.push(`↑${formatTokens(input)}`);
	if (output) parts.push(`↓${formatTokens(output)}`);
	if (parts.length === 0) return undefined;
	const text = parts.join(" ");
	return { full: text, compact: text };
}

export function cacheVariants(
	read: number,
	write: number,
	latestHitRate: number | undefined,
): ComponentVariants | undefined {
	const totals: string[] = [];
	if (read) totals.push(`R${formatTokens(read)}`);
	if (write) totals.push(`W${formatTokens(write)}`);
	if (totals.length === 0) return undefined;
	const compact = totals.join(" ");
	const full = latestHitRate === undefined ? compact : `${compact} CH${Math.round(latestHitRate)}%`;
	return { full, compact };
}

export function costVariants(total: number, usingSubscription: boolean): ComponentVariants | undefined {
	if (!total && !usingSubscription) return undefined;
	return usingSubscription
		? { full: `$${total.toFixed(3)} (sub)`, compact: "(sub)" }
		: { full: `$${total.toFixed(3)}`, compact: `$${total.toFixed(2)}` };
}

export function contextVariants(
	percent: number | null | undefined,
	tokens: number | null | undefined,
	window: number,
): ComponentVariants {
	const percentDisplay = percent == null ? "?" : `${Math.round(percent)}%`;
	const tokensDisplay = tokens === null ? "?" : formatTokens(tokens ?? 0);
	const ratio = `${tokensDisplay}/${formatTokens(window)}`;
	return { full: `${percentDisplay} ${ratio}`, compact: ratio };
}

export function runtimeIdentityVariants(
	modelName: string,
	thinking: string | undefined,
	provider: string | undefined,
	fastMode = false,
): ComponentVariants {
	const full = [modelName, fastMode ? "fast" : undefined, thinking].filter(Boolean).join(" • ");
	const compact = [modelName, fastMode ? "f" : undefined, thinking].filter(Boolean).join(" • ");
	return {
		full: provider ? `(${provider}) ${full}` : full,
		compact,
	};
}

export interface AdaptiveFooterDependencies {
	issuePatterns?: readonly string[];
	discover?: RepositoryContextDiscovery;
}

export function registerAdaptiveFooter(
	pi: ExtensionAPI,
	dependencies: AdaptiveFooterDependencies = {},
): void {
	let activeSession: { refresh(): Promise<void>; dispose(): void } | undefined;

	pi.on("agent_settled", () => {
		void activeSession?.refresh();
	});

	pi.on("session_shutdown", () => {
		activeSession?.dispose();
		activeSession = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		activeSession?.dispose();
		activeSession = undefined;
		if (!ctx.hasUI) return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const discover = dependencies.discover ?? ((input, signal) => discoverRepositoryContext(
				(command, args, options) => pi.exec(command, args, options),
				input,
				signal,
			));
			const refresher = createRepositoryContextRefresher(
				() => ({
					cwd: ctx.sessionManager.getCwd(),
					branch: footerData.getGitBranch(),
					issuePatterns: dependencies.issuePatterns ?? adaptiveFooterConfig.issuePatterns,
				}),
				discover,
				() => tui.requestRender(),
			);
			const unsubscribeBranch = footerData.onBranchChange(() => {
				refresher.clear();
				void refresher.refresh();
			});
			let disposed = false;
			const session = {
				refresh: () => refresher.refresh(),
				dispose(): void {
					if (disposed) return;
					disposed = true;
					unsubscribeBranch();
					refresher.dispose();
					if (activeSession === session) activeSession = undefined;
				},
			};
			activeSession?.dispose();
			activeSession = session;
			void session.refresh();

			return {
				dispose: session.dispose,
				invalidate() {},
				render(width: number): string[] {
					let totalInput = 0;
					let totalOutput = 0;
					let totalCacheRead = 0;
					let totalCacheWrite = 0;
					let totalCost = 0;
					let latestCacheHitRate: number | undefined;

					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type !== "message" || entry.message.role !== "assistant") continue;

						const message = entry.message as AssistantMessage;
						totalInput += message.usage.input;
						totalOutput += message.usage.output;
						totalCacheRead += message.usage.cacheRead;
						totalCacheWrite += message.usage.cacheWrite;
						totalCost += message.usage.cost.total;

						const latestPromptTokens =
							message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
						latestCacheHitRate =
							latestPromptTokens > 0 ? (message.usage.cacheRead / latestPromptTokens) * 100 : undefined;
					}

					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const contextPercent = contextUsage?.percent;
					const footerStatuses = partitionFooterStatuses(footerData.getExtensionStatuses());
					const contextColorBand = selectContextColorBand(
						contextPercent,
						autoCompactConfig,
						contextWindow,
						footerStatuses.autoCompactPaused,
					);
					const components: FooterComponent[] = [];

					const tokenFlow = tokenFlowVariants(totalInput, totalOutput);
					if (tokenFlow) components.push({ id: "token-flow", alignment: "left", ...tokenFlow });

					const cache = cacheVariants(totalCacheRead, totalCacheWrite, latestCacheHitRate);
					if (cache) components.push({ id: "cache", alignment: "left", ...cache });

					const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
					const cost = costVariants(totalCost, usingSubscription);
					if (cost) components.push({ id: "cost", alignment: "left", ...cost });

					const context = contextVariants(contextPercent, contextUsage?.tokens, contextWindow);
					components.push({ id: "context", alignment: "left", ...context });

					const compactTarget = compactTargetVariants(
						autoCompactConfig,
						contextWindow,
						contextUsage?.tokens,
						footerStatuses.autoCompactPaused,
					);
					if (compactTarget) {
						components.push({ id: "compact-target", alignment: "left", ...compactTarget });
					}

					if (footerStatuses.elapsedTime) {
						components.push({
							id: "elapsed",
							alignment: "right",
							full: footerStatuses.elapsedTime,
							compact: footerStatuses.elapsedTime,
						});
					}

					const modelName = ctx.model?.id || "no-model";
					let thinking: string | undefined;
					if (ctx.model?.reasoning) {
						const thinkingLevel = pi.getThinkingLevel() || "off";
						thinking = thinkingLevel === "off" ? "thinking off" : thinkingLevel;
					}
					const provider =
						footerData.getAvailableProviderCount() > 1 && ctx.model ? ctx.model.provider : undefined;
					components.push({
						id: "runtime-identity",
						alignment: "right",
						...runtimeIdentityVariants(modelName, thinking, provider, footerStatuses.fastMode),
					});

					const home = process.env.HOME || process.env.USERPROFILE;
					const repositoryLayout = fitRepositoryLayout({
						cwd: cwdVariants(ctx.sessionManager.getCwd(), home),
						session: ctx.sessionManager.getSessionName(),
						branch: footerData.getGitBranch(),
						context: refresher.get(),
					}, width);
					const repositoryLine = styleRepositorySpans(
						repositoryLayout.spans,
						(text) => theme.fg("dim", text),
						(text, url) => hyperlink(theme.fg("accent", theme.underline(text)), url),
					);
					const fitted = fitFooterLayout(components, width);
					const statsLine = styleFooterSpans(
						fitted.spans,
						(text) => theme.fg("dim", text),
						(id, text) =>
							contextColorBand && (id === "context" || id === "compact-target")
								? theme.fg(contextColorBand, text)
								: theme.fg("dim", text),
					);
					const lines = [clampStyled(repositoryLine, width), clampStyled(statsLine, width)];

					if (footerStatuses.statusLine) {
						lines.push(fitText(footerStatuses.statusLine, width, "..."));
					}

					return lines;
				},
			};
		});
	});
}

export default function adaptiveFooter(pi: ExtensionAPI): void {
	registerAdaptiveFooter(pi);
}
