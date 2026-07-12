/**
 * state.ts — the shared mutable state of the running extension.
 *
 * Everything here is written by one feature and read by another (the spawn
 * tools register children, the watcher removes them, the widget and the
 * picker render them), so it lives in one small file instead of being
 * threaded through call parameters.
 *
 * A note on /reload: pi's /reload re-imports the extension modules, but
 * timers and watcher loops from the PREVIOUS import keep running in their
 * old closures. State that must survive (or be torn down) across a reload
 * is parked on `globalThis` under stable `Symbol.for` keys — plain
 * module-level variables would just be recreated fresh, leaving the old
 * ones running unreachable in the background.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ActivityObservation } from "./activity.ts";
import type { SubagentStatus } from "./status.ts";
import type { ExitResult } from "./tmux.ts";
import type { WorktreeInfo, WorktreeOutcome } from "./worktree.ts";

// ── the per-child record ─────────────────────────────────────────────────

export interface RunningSubagent {
	id: string;
	name: string;
	agent?: string;
	paneId: string;
	sessionFile: string;
	startTime: number;
	/** Entry count before a resume, so the summary only covers new turns. */
	skipEntries: number;
	/** Restrictions applied at launch — echoed in results so a resume can reapply them. */
	tools?: string;
	model?: string;
	autoExit: boolean;
	/** How the conversation started: "forked" copies the parent's, "fresh" starts
	 * empty. Missing when a resume found no `.meta` context (an older session). */
	context?: "fresh" | "forked";
	/** Set when this child runs in a git worktree — drives end-of-run cleanup. */
	worktree?: WorktreeInfo;
	/** Cancels this child's watcher (used by the picker's x = stop). */
	abort: AbortController;
	/** True when a human stopped it via the picker — the model gets told. */
	stoppedByUser?: boolean;
	/** Did this launch include an initial prompt/message? Drives
	 * starting-vs-waiting in status.ts. REQUIRED so tsc forces both trackChild
	 * call sites (spawn always delivers a task; resume only sometimes). */
	expectsRun: boolean;
	/** Liveness observation state; created by trackChild, mutated only by the
	 * watcher's onTick, read by the widget and subagents_list. */
	activity?: ActivityObservation;
	/** Watcher-PRIVATE edge-trigger memory. Status is never cached for
	 * display: the widget and subagents_list recompute it from `activity`. */
	lastStatus?: SubagentStatus;
	/** Stall episodes seen (lifetime, this record). Steers stop after 3. */
	stallEpisodes?: number;
	/** True while the current stall episode's steer was actually sent. */
	stallSteerSent?: boolean;
	/** Reload generation currently supervising this child. */
	watcherGeneration?: number;
	/** Exit already observed by an old generation during reload handoff. */
	pendingExit?: ExitResult;
	/** Shared cleanup work, so two generations cannot clean a worktree twice. */
	worktreeCleanup?: Promise<WorktreeOutcome>;
	resultDelivered?: boolean;
}

interface ModuleLifetime {
	controller: AbortController;
	generation: number;
}

interface ReloadState {
	running: Map<string, RunningSubagent>;
	ledger: Map<string, { sessionFile: string; name: string }>;
	latestCtx: ExtensionContext | null;
	lifetime?: ModuleLifetime;
	nextGeneration: number;
	handoffTimer?: ReturnType<typeof setTimeout>;
}

const STATE_KEY = Symbol.for("interactive-subagents/reload-state");
const slots = globalThis as Record<symbol, unknown>;
const reloadState = (slots[STATE_KEY] as ReloadState | undefined) ?? {
	running: new Map<string, RunningSubagent>(),
	ledger: new Map<string, { sessionFile: string; name: string }>(),
	latestCtx: null,
	nextGeneration: 0,
};
slots[STATE_KEY] = reloadState;

reloadState.lifetime?.controller.abort();

function newLifetime(): ModuleLifetime {
	return {
		controller: new AbortController(),
		generation: ++reloadState.nextGeneration,
	};
}

let lifetime = newLifetime();
reloadState.lifetime = lifetime;

/** All children currently running, keyed by their 8-char run id. */
export const running = reloadState.running;

/** Every child known to this parent process, used for short-id resume. */
export const ledger = reloadState.ledger;

/** Signal that fires when this imported runtime must stop supervising. */
export function moduleSignal(): AbortSignal {
	return lifetime.controller.signal;
}

export function moduleGeneration(): number {
	return lifetime.generation;
}

export const RELOAD_HANDOFF_TIMEOUT_MS = 30_000;

function clearTrackedState(): RunningSubagent[] {
	const children = [...running.values()];
	running.clear();
	reloadState.latestCtx = null;
	return children;
}

/** Stop old-generation work without destroying live child records or panes. */
export function prepareForReload(
	onExpired: (children: RunningSubagent[]) => void,
	timeoutMs = RELOAD_HANDOFF_TIMEOUT_MS,
): void {
	lifetime.controller.abort();
	reloadState.latestCtx = null;
	if (reloadState.handoffTimer) clearTimeout(reloadState.handoffTimer);
	if (running.size === 0) return;
	const timer = setTimeout(() => {
		if (reloadState.handoffTimer !== timer) return;
		reloadState.handoffTimer = undefined;
		reloadState.lifetime?.controller.abort();
		onExpired(clearTrackedState());
	}, timeoutMs);
	reloadState.handoffTimer = timer;
}

/** Confirm that the replacement runtime adopted every preserved child. */
export function completeReloadHandoff(): void {
	if (reloadState.handoffTimer) clearTimeout(reloadState.handoffTimer);
	reloadState.handoffTimer = undefined;
	if (lifetime.controller.signal.aborted) {
		lifetime = newLifetime();
		reloadState.lifetime = lifetime;
	}
}

/** Stop live supervision at every boundary other than reload. */
export function resetForShutdown(): RunningSubagent[] {
	completeReloadHandoff();
	lifetime.controller.abort();
	const children = clearTrackedState();
	// Pi can reuse this imported factory for a same-cwd session replacement.
	// Re-arm it now while old watchers remain fenced by their generation.
	lifetime = newLifetime();
	reloadState.lifetime = lifetime;
	return children;
}

export function setLatestCtx(ctx: ExtensionContext): void {
	reloadState.latestCtx = ctx;
}

export function getLatestCtx(): ExtensionContext | null {
	return reloadState.latestCtx;
}
