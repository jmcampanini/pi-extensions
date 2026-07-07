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
import type { WorktreeInfo } from "./worktree.ts";

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
	/** Set when this child runs in a git worktree — drives end-of-run cleanup. */
	worktree?: WorktreeInfo;
	/** Cancels this child's watcher (used by the picker's x = stop). */
	abort: AbortController;
	/** True when a human stopped it via the picker — the model gets told. */
	stoppedByUser?: boolean;
}

/** All children currently running, keyed by their 8-char run id. */
export const running = new Map<string, RunningSubagent>();

/**
 * Every child this session has ever tracked (running or finished), so
 * subagent_resume can accept a short id instead of a long session path.
 * The path fallback still exists because this ledger is in-memory only —
 * it dies with the parent process, but the session file doesn't.
 */
export const ledger = new Map<string, { sessionFile: string; name: string }>();

// ── the module-wide abort signal (survives /reload) ──────────────────────
// One AbortController for "this import of the extension is done": aborted on
// session shutdown AND on re-import (so the previous import's watchers stop).
// The two accessors below are the ONLY places that touch the globalThis slot.

const ABORT_KEY = Symbol.for("interactive-subagents/abort-controller");
const slots = globalThis as Record<symbol, unknown>;

function moduleAbort(): AbortController {
	return slots[ABORT_KEY] as AbortController;
}

// On import: abort whatever a previous import left behind, then start fresh.
{
	const previous = slots[ABORT_KEY] as AbortController | undefined;
	if (previous) previous.abort();
	slots[ABORT_KEY] = new AbortController();
}

/** Signal that fires when the session shuts down or the module is reloaded. */
export function moduleSignal(): AbortSignal {
	return moduleAbort().signal;
}

/**
 * Session teardown (/new, /resume, quit): stop every watcher by aborting the
 * module signal, arm a fresh controller for the next session, and forget the
 * running children. The ledger is deliberately kept — its session FILES still
 * exist on disk, so their ids remain resumable.
 */
export function resetForShutdown(): void {
	moduleAbort().abort();
	slots[ABORT_KEY] = new AbortController();
	running.clear();
}

// ── the latest ExtensionContext ──────────────────────────────────────────
// Captured at session_start. Widget updates happen from timers and watchers
// where pi hands us no ctx, so they reach the UI through this.

let latestCtx: ExtensionContext | null = null;

export function setLatestCtx(ctx: ExtensionContext): void {
	latestCtx = ctx;
}

export function getLatestCtx(): ExtensionContext | null {
	return latestCtx;
}
