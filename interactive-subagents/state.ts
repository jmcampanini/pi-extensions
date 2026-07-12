/**
 * state.ts - process-stable mutable state and reload coordination.
 *
 * /reload re-imports modules while old async closures can still run. The
 * registries and generation coordinator therefore live on globalThis. A
 * generation owns each watcher/finalizer, and replacement imports abort and
 * fence the previous generation before adopting its records.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ActivityObservation } from "./activity.ts";
import type { SubagentStatus } from "./status.ts";
import type { ExitResult } from "./tmux.ts";
import type { WorktreeInfo, WorktreeOutcome } from "./worktree.ts";

export interface RunningSubagent {
	id: string;
	name: string;
	agent?: string;
	paneId: string;
	sessionFile: string;
	startTime: number;
	skipEntries: number;
	tools?: string;
	model?: string;
	autoExit: boolean;
	context?: "fresh" | "forked";
	worktree?: WorktreeInfo;
	abort: AbortController;
	stoppedByUser?: boolean;
	expectsRun: boolean;
	activity?: ActivityObservation;
	lastStatus?: SubagentStatus;
	stallEpisodes?: number;
	stallSteerSent?: boolean;
	watcherGeneration?: number;
	/** Exit consumed from a one-shot sidecar during a reload handoff. */
	pendingExit?: ExitResult;
}

/** Public, frozen widget/list projection of a result awaiting delivery. */
export interface DeliveringSubagent {
	id: string;
	name: string;
	agent?: string;
	elapsedSeconds: number;
	forked: boolean;
	worktree: boolean;
}

/** Private ownership retained so finalization can move between generations. */
export interface DeliveryRecord extends DeliveringSubagent {
	readonly child: RunningSubagent;
	readonly exit: ExitResult;
	finalizerGeneration?: number;
	worktreeCleanup?: Promise<WorktreeOutcome>;
	/** True only after sendMessage returned successfully; queued sends survive reload. */
	sendAccepted?: boolean;
}

interface ModuleLifetime {
	controller: AbortController;
	generation: number;
}

interface ReloadState {
	running: Map<string, RunningSubagent>;
	delivering: Map<string, DeliveryRecord>;
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
	delivering: new Map<string, DeliveryRecord>(),
	ledger: new Map<string, { sessionFile: string; name: string }>(),
	latestCtx: null,
	nextGeneration: 0,
};
// Upgrade a coordinator created by the pre-delivery feature during hot reload.
reloadState.delivering ??= new Map<string, DeliveryRecord>();
slots[STATE_KEY] = reloadState;

reloadState.lifetime?.controller.abort();

function newLifetime(): ModuleLifetime {
	return { controller: new AbortController(), generation: ++reloadState.nextGeneration };
}

let lifetime = newLifetime();
reloadState.lifetime = lifetime;

export const running = reloadState.running;
/** Full records remain private by convention; consumers see only the projection. */
export const delivering: Map<string, DeliveringSubagent> = reloadState.delivering;
export const ledger = reloadState.ledger;

export function deliveryRecord(id: string): DeliveryRecord | undefined {
	return reloadState.delivering.get(id);
}

export function setDeliveryRecord(record: DeliveryRecord): void {
	reloadState.delivering.set(record.id, record);
}

export function deliveryRecords(): IterableIterator<DeliveryRecord> {
	return reloadState.delivering.values();
}

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
	reloadState.delivering.clear();
	reloadState.latestCtx = null;
	return children;
}

/** Stop old work while preserving live and finalizing records for adoption. */
export function prepareForReload(
	onExpired: (children: RunningSubagent[]) => void,
	timeoutMs = RELOAD_HANDOFF_TIMEOUT_MS,
): void {
	lifetime.controller.abort();
	reloadState.latestCtx = null;
	if (reloadState.handoffTimer) clearTimeout(reloadState.handoffTimer);
	if (running.size === 0 && reloadState.delivering.size === 0) return;
	const timer = setTimeout(() => {
		if (reloadState.handoffTimer !== timer) return;
		reloadState.handoffTimer = undefined;
		reloadState.lifetime?.controller.abort();
		onExpired(clearTrackedState());
	}, timeoutMs);
	reloadState.handoffTimer = timer;
}

/** Confirm replacement adoption, including a late start after the reaper. */
export function completeReloadHandoff(): void {
	if (reloadState.handoffTimer) clearTimeout(reloadState.handoffTimer);
	reloadState.handoffTimer = undefined;
	if (lifetime.controller.signal.aborted) {
		lifetime = newLifetime();
		reloadState.lifetime = lifetime;
	}
}

/** Destructive session boundaries discard both running and queued delivery. */
export function resetForShutdown(): RunningSubagent[] {
	completeReloadHandoff();
	lifetime.controller.abort();
	const children = clearTrackedState();
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
