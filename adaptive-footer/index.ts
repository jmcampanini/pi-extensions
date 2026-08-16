import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { hyperlink } from "@earendil-works/pi-tui";
import { config as autoCompactConfig, type AutoCompactConfig } from "../shared/auto-compact-config.ts";
import { formatTokens, resolveThresholdTokens } from "../shared/auto-compact-threshold.ts";
import { AUTO_COMPACT_STATUS_KEY, ELAPSED_TIME_STATUS_KEY, FAST_OPENAI_STATUS_KEY } from "../shared/status-keys.ts";
import { clampStyled, fitText } from "../shared/text-fit.ts";
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
	contextWindow: number | undefined,
	contextTokens?: number,
	paused = false,
): ComponentVariants | undefined {
	if (!autoCompactConfig.enabled || contextWindow === undefined || contextWindow <= 0) return undefined;
	if (paused) return { full: "compact ⏸", compact: "C⏸" };
	const thresholdTokens = resolveThresholdTokens(autoCompactConfig, contextWindow);
	const target = formatTokens(thresholdTokens);
	if (contextTokens === undefined) {
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
	percent: number | undefined,
	autoCompactConfig: AutoCompactConfig,
	contextWindow: number | undefined,
	paused = false,
): ContextColorBand | undefined {
	if (percent === undefined) return undefined;

	if (!autoCompactConfig.enabled || contextWindow === undefined || contextWindow <= 0 || paused) {
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
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
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
	percent: number | undefined,
	tokens: number | undefined,
	window: number | undefined,
): ComponentVariants {
	const percentDisplay = percent === undefined ? "?" : `${Math.round(percent)}%`;
	const tokensDisplay = tokens === undefined ? "?" : formatTokens(tokens);
	const windowDisplay = window === undefined || window <= 0 ? "?" : formatTokens(window);
	const ratio = `${tokensDisplay}/${windowDisplay}`;
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

export interface SessionUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	latestCacheHitRate: number | undefined;
}

// Matches pi's native footer accounting: tool-result usage and
// compaction/branch-summary summarization usage count toward session totals,
// even though they sit outside the main LLM context.
export function aggregateSessionUsage(entries: readonly SessionEntry[]): SessionUsageTotals {
	const totals: SessionUsageTotals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		latestCacheHitRate: undefined,
	};
	const add = (usage: Usage): void => {
		totals.input += usage.input;
		totals.output += usage.output;
		totals.cacheRead += usage.cacheRead;
		totals.cacheWrite += usage.cacheWrite;
		totals.cost += usage.cost.total;
	};
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const usage = entry.message.usage;
			add(usage);
			const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
			totals.latestCacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			add(entry.message.usage);
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			add(entry.usage);
		}
	}
	return totals;
}

export interface AdaptiveFooterDependencies {
	issuePatterns?: readonly string[];
	discover?: RepositoryContextDiscovery;
	now?: () => number;
}

const SETTLE_REFRESH_MIN_INTERVAL_MS = 30_000;

export function registerAdaptiveFooter(
	pi: ExtensionAPI,
	dependencies: AdaptiveFooterDependencies = {},
): void {
	let activeSession: { refresh(): Promise<void>; refreshOnSettle(): Promise<void>; dispose(): void } | undefined;

	pi.on("agent_settled", () => {
		void activeSession?.refreshOnSettle();
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
				dependencies.now,
			);
			const unsubscribeBranch = footerData.onBranchChange(() => {
				refresher.clear();
				void refresher.refresh();
			});
			let disposed = false;
			const session = {
				refresh: () => refresher.refresh(),
				refreshOnSettle: () => refresher.refreshIfStale(SETTLE_REFRESH_MIN_INTERVAL_MS),
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
					const usage = aggregateSessionUsage(ctx.sessionManager.getEntries());

					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow;
					const contextPercent = contextUsage?.percent ?? undefined;
					const contextTokens = contextUsage?.tokens ?? undefined;
					const footerStatuses = partitionFooterStatuses(footerData.getExtensionStatuses());
					const contextColorBand = selectContextColorBand(
						contextPercent,
						autoCompactConfig,
						contextWindow,
						footerStatuses.autoCompactPaused,
					);
					const components: FooterComponent[] = [];

					const tokenFlow = tokenFlowVariants(usage.input, usage.output);
					if (tokenFlow) components.push({ id: "token-flow", alignment: "left", ...tokenFlow });

					const cache = cacheVariants(usage.cacheRead, usage.cacheWrite, usage.latestCacheHitRate);
					if (cache) components.push({ id: "cache", alignment: "left", ...cache });

					const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
					const cost = costVariants(usage.cost, usingSubscription);
					if (cost) components.push({ id: "cost", alignment: "left", ...cost });

					const context = contextVariants(contextPercent, contextTokens, contextWindow);
					components.push({ id: "context", alignment: "left", ...context });

					const compactTarget = compactTargetVariants(
						autoCompactConfig,
						contextWindow,
						contextTokens,
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
