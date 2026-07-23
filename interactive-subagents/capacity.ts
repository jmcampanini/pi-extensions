/**
 * capacity.ts — the concurrency limit and the launch queue.
 *
 * At most `config.maxConcurrentSubagents` children run at once. A launch
 * that would exceed the limit is QUEUED instead of rejected: the tool call
 * returns "queued" immediately, and the child starts automatically when a
 * running child exits (the watcher calls drainQueue at every slot release).
 *
 * The two invariants everything here protects:
 *
 * 1. A queued entry is PURE DATA. All side effects (worktree, session seed,
 *    pane) happen at launch time, inside the launcher the tool registered.
 *    That is what makes cancel a splice, shutdown a clear, and /reload a
 *    non-event — a queued child that never launches simply never existed.
 *
 * 2. Admission is SYNCHRONOUS. pi executes parallel tool calls concurrently,
 *    and a child only appears in state.ts's `running` map after the launch
 *    pipeline's awaits — so counting `running` alone would let N parallel
 *    spawns all pass the check. admitLaunch() claims a slot (or queues) with
 *    no await in between, and each in-flight launch holds its claim until
 *    the child is registered. Capacity = running + claims.
 *
 * The queue and claims live on globalThis (same pattern as tmux.ts's
 * agents-window slot) so they survive /reload; the launcher registry is
 * module-local on purpose, so an old generation's drain never mixes with a
 * replacement's code.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { assertValidAgentIdentifier } from "./agent-identifier.ts";
import { config } from "./config.ts";
import { sanitizeDisplayText } from "./display-text.ts";
import { moduleGeneration, moduleSignal, running } from "./state.ts";
import type { WorktreeInfo } from "./worktree.ts";

// ── launch specs: everything a deferred launch needs, as plain data ──────
// Values are resolved and validated at CALL time (params beat frontmatter,
// models resolved, cwd checked), so a queued launch behaves like the call
// that created it — except side effects, which wait for the slot. The one
// deliberate exception: a forked child's conversation is copied at LAUNCH
// time, so a fork that waited in the queue forks the parent as of when it
// actually starts.

export interface SpawnSpec {
	kind: "spawn";
	/** The child's 8-char id, minted at call time so the model can refer to
	 * the child ("queued", cancel notices, failure notices) before it runs. */
	id: string;
	name: string;
	task: string;
	agentName: string;
	/** "pi" or an external harness name; the profile is re-derived at launch. */
	harness: string;
	/** The agent definition's body, snapshotted at call time. */
	agentBody: string;
	harnessPassThrough?: string;
	context: "new" | "forked";
	model?: string;
	thinking?: string;
	tools?: string;
	autoExit: boolean;
	useWorktree: boolean;
	/** Resolved absolute cwd; absent when useWorktree (created at launch). */
	cwd?: string;
	/** The parent session's cwd — where the worktree create command runs. */
	parentCwd: string;
	parentSessionFile: string;
	/** artifactBase(ctx), captured at call time. */
	base: string;
	slug: string;
}

export interface ResumeSpec {
	kind: "resume";
	/** Fresh run id for this resume, minted at call time. */
	id: string;
	sessionPath: string;
	name: string;
	agent?: string;
	harness: string;
	autoExit: boolean;
	tools?: string;
	model?: string;
	thinking?: string;
	systemPromptFile?: string;
	message?: string;
	context?: "new" | "forked";
	worktree?: WorktreeInfo;
	harnessPassThrough?: string;
	/** The child's cwd: a string to cd into, null = wherever the shell is. */
	cwd: string | null;
	/** True when the cwd came from a worktree record (changes the error prose
	 * if the directory vanished while queued). */
	cwdFromWorktree: boolean;
	/** Session-picker label to backfill at launch, when the session has none. */
	backfillLabel?: string;
	externalSessionId?: string;
	base: string;
	slug: string;
	expectsRun: boolean;
}

export type LaunchSpec = SpawnSpec | ResumeSpec;

export interface QueuedLaunch {
	spec: LaunchSpec;
	queuedAt: number;
}

/** The display name/agent pair every surface (widget, picker, list) shows. */
function launchAgent(spec: LaunchSpec): string | undefined {
	return spec.kind === "spawn" ? spec.agentName : spec.agent;
}

function validateLaunchSpec(spec: LaunchSpec): void {
	const agent = launchAgent(spec);
	if (agent !== undefined) assertValidAgentIdentifier(agent);
}

export function specDisplay(spec: LaunchSpec): { name: string; agent?: string } {
	validateLaunchSpec(spec);
	return { name: spec.name, agent: launchAgent(spec) };
}

// ── the globalThis store ─────────────────────────────────────────────────

export interface PendingLaunch {
	spec: LaunchSpec;
	claimedAt: number;
}

interface CapacityStore {
	queue: QueuedLaunch[];
	/** In-flight launches (claimed slot, child not yet in `running`), keyed by
	 * spec id. Carrying the spec keeps a mid-launch child visible to the
	 * widget/list and lets resume dedupe see launches in flight. */
	claims: Map<string, PendingLaunch>;
	/** The NEWEST generation's bound drainQueue, armed at session_start. A
	 * dying generation that unwinds a launch after its replacement already
	 * drained calls this so the requeued entry is not stranded — its own
	 * drainQueue would no-op on the aborted module signal. */
	drainHook?: () => void;
	/** The newest generation's widget repaint, armed alongside drainHook: a
	 * background launch that fails or requeues changes what the widget
	 * should show, and this module cannot import the widget (cycle). */
	queueChangedHook?: () => void;
}

const STORE_KEY = Symbol.for("interactive-subagents/launch-capacity");
const slots = globalThis as Record<symbol, unknown>;
const store: CapacityStore = (slots[STORE_KEY] as CapacityStore | undefined) ?? {
	queue: [],
	claims: new Map(),
};
slots[STORE_KEY] = store;

// ── counting ─────────────────────────────────────────────────────────────

function hasCapacity(): boolean {
	return running.size + store.claims.size < config.maxConcurrentSubagents;
}

export function queuedCount(): number {
	return store.queue.length;
}

export function queuedEntries(): readonly QueuedLaunch[] {
	return store.queue;
}

export function findQueued(id: string): QueuedLaunch | undefined {
	return store.queue.find((entry) => entry.spec.id === id);
}

/** In-flight launches: slot claimed, child not yet registered in `running`.
 * The widget and subagent_status show these so a child dequeued for launch
 * never vanishes from every surface during its pipeline. Invalid claims
 * retained across reload stay capacity-counted until their old launcher
 * unwinds, but are quarantined from lifecycle projections. */
export function pendingLaunches(): PendingLaunch[] {
	return [...store.claims.values()].filter((pending) => {
		try {
			validateLaunchSpec(pending.spec);
			return true;
		} catch {
			return false;
		}
	});
}

export function pendingLaunchCount(): number {
	return pendingLaunches().length;
}

/** True when this id is queued or mid-launch (not yet in `running`). */
export function isPendingLaunch(id: string): boolean {
	return store.claims.has(id) || findQueued(id) !== undefined;
}

/** True when a resume of this session is queued or mid-launch — the
 * busy-guard's extension to work that has not reached `running` yet. Paths
 * are compared resolved on both sides: the specs store the caller's raw
 * path, and a non-canonical spelling must not slip past the guard. */
export function pendingResumeFor(resolvedSessionPath: string): boolean {
	for (const claim of store.claims.values()) {
		if (claim.spec.kind === "resume" && resolve(claim.spec.sessionPath) === resolvedSessionPath) return true;
	}
	return store.queue.some(
		(entry) => entry.spec.kind === "resume" && resolve(entry.spec.sessionPath) === resolvedSessionPath,
	);
}

// ── admission (synchronous — see header invariant 2) ─────────────────────

export type Admission = { status: "run" } | { status: "queued"; ahead: number };

/**
 * Claim a slot or join the queue, atomically from the caller's view. A
 * non-empty queue always queues (even when a slot just freed) so parallel
 * calls cannot jump ahead of already-waiting work. On "run" the caller MUST
 * launch and the pipeline MUST releaseClaim() in the same synchronous step
 * that registers the child (or on failure) — a leaked claim is a leaked slot.
 */
export function admitLaunch(spec: LaunchSpec): Admission {
	validateLaunchSpec(spec);
	if (store.queue.length === 0 && hasCapacity()) {
		store.claims.set(spec.id, { spec, claimedAt: Date.now() });
		return { status: "run" };
	}
	const ahead = store.queue.length;
	store.queue.push({ spec, queuedAt: Date.now() });
	return { status: "queued", ahead };
}

export function releaseClaim(id: string): void {
	store.claims.delete(id);
}

/** Remove a queued entry (picker cancel, or tests). Pure data — nothing to
 * roll back. Returns the entry so the caller can notify the model. */
export function cancelQueued(id: string): QueuedLaunch | undefined {
	const index = store.queue.findIndex((entry) => entry.spec.id === id);
	if (index === -1) return undefined;
	return store.queue.splice(index, 1)[0];
}

/** Destructive session boundaries (/new, quit, failed-reload reaper) drop
 * queued work: those children never existed. In-flight claims are left to
 * their own launch pipelines, which observe the boundary via the guards. */
export function clearQueueForShutdown(): void {
	store.queue.length = 0;
}

// ── the mid-launch boundary guards ───────────────────────────────────────
// A drain launch runs OUTSIDE any tool call, so the pane-creation boundary
// verifies that its generation still owns the session. Resume currently has
// no awaits and spawn awaits only worktree creation, but keeping the assertion
// at each boundary catches a future refactor that adds an interleave point.
// After it passes, pane creation and trackChild are synchronous, so the child
// is registered in the same generation or the launch is unwound.

/** Reload in progress: side effects are rolled back and the entry returns to
 * the FRONT of the queue — the replacement generation relaunches it. */
export class RequeueLaunch extends Error {
	constructor() {
		super("launch interrupted by reload — requeued");
	}
}

/** Session boundary (/new, /resume, quit): the queue was discarded, so the
 * child is no longer wanted. Side effects are rolled back, nothing is sent. */
export class AbandonLaunch extends Error {
	constructor() {
		super("launch abandoned at session boundary");
	}
}

export function assertLaunchStillWanted(launchGeneration: number): void {
	// Generation change = resetForShutdown ran in THIS module (/new etc.).
	// Abort without a generation change = prepareForReload (or this module
	// was replaced by a new import) — the queue survives those on purpose.
	if (moduleGeneration() !== launchGeneration) throw new AbandonLaunch();
	if (moduleSignal().aborted) throw new RequeueLaunch();
}

// ── launching queued entries ─────────────────────────────────────────────

/** A tool's launch pipeline: performs every side effect and registers the
 * child. Must releaseClaim(spec.id) when it registers, and roll back its own
 * side effects when it throws (the claim is then released here). */
type Launcher = (pi: ExtensionAPI, spec: LaunchSpec) => Promise<unknown>;

const launchers = new Map<string, Launcher>();

export function registerLauncher(kind: LaunchSpec["kind"], launcher: Launcher): void {
	launchers.set(kind, launcher);
}

/**
 * Start as many queued launches as capacity allows. Called at every slot
 * release (watcher) and after reload adoption (index.ts). Claims are taken
 * synchronously in the loop, so a burst of exits cannot over-launch; the
 * launches themselves run detached, like the watchers they hand off to.
 */
export function drainQueue(pi: ExtensionAPI): void {
	if (moduleSignal().aborted) return;
	while (store.queue.length > 0 && hasCapacity()) {
		const entry = store.queue.shift() as QueuedLaunch;
		try {
			validateLaunchSpec(entry.spec);
		} catch (error) {
			notifyRejectedLaunch(pi, entry.spec, error);
			store.queueChangedHook?.();
			continue;
		}
		store.claims.set(entry.spec.id, { spec: entry.spec, claimedAt: Date.now() });
		void launchDequeued(pi, entry);
	}
}

/** Arm the drain trigger for possibly-stale callers. Called at every
 * session_start, so the hook always belongs to the NEWEST generation: a
 * dying generation that frees a slot (or requeues an interrupted launch)
 * after its replacement already drained can still start queued work — its
 * own drainQueue would no-op on the aborted module signal. */
export function armDrainHook(pi: ExtensionAPI, onQueueChanged?: () => void): void {
	store.drainHook = () => drainQueue(pi);
	store.queueChangedHook = onQueueChanged;
	// The queue survives reload and may predate the current validation rules.
	let removed = false;
	for (let index = store.queue.length - 1; index >= 0; index--) {
		const entry = store.queue[index];
		try {
			validateLaunchSpec(entry.spec);
		} catch (error) {
			store.queue.splice(index, 1);
			removed = true;
			notifyRejectedLaunch(pi, entry.spec, error);
		}
	}
	if (removed) store.queueChangedHook?.();
}

/** Drain via the newest generation when armed; fall back to this module's. */
export function requestDrain(fallbackPi: ExtensionAPI): void {
	if (store.drainHook) store.drainHook();
	else drainQueue(fallbackPi);
}

async function launchDequeued(pi: ExtensionAPI, entry: QueuedLaunch): Promise<void> {
	const launcher = launchers.get(entry.spec.kind);
	try {
		if (!launcher) throw new Error(`internal: no ${entry.spec.kind} launcher registered`);
		await launcher(pi, entry.spec);
	} catch (error) {
		releaseClaim(entry.spec.id);
		try {
			if (error instanceof RequeueLaunch) {
				// A reload interrupted this launch mid-flight. The replacement
				// generation's adoption drain may ALREADY have run (it races
				// the unwind of this pipeline's awaits), so requeueing alone
				// could strand the entry — ask the newest generation to drain.
				store.queue.unshift(entry);
				requestDrain(pi);
				return;
			}
			if (error instanceof AbandonLaunch) {
				// The boundary cleared the queue, but a NEW session may have
				// queued work behind this dying launch's slot already — drain.
				requestDrain(pi);
				return;
			}
			notifyLaunchFailure(pi, entry.spec, error);
			// The failed launch freed its slot — keep the queue moving.
			requestDrain(pi);
		} finally {
			// Whatever happened, the queued/starting rows changed.
			store.queueChangedHook?.();
		}
	}
}

// ── the words the model hears ────────────────────────────────────────────
// A deferred failure can land hours after the call, in a turn with no memory
// of it — the prose must carry everything (see watcher.ts: the prose IS the
// protocol). Builders are pure and exported for tests.

/** One-line preview of the queued task/message, so a failure notice landing
 * hours after the call still tells the model WHAT was lost. */
function pendingWorkPreview(spec: LaunchSpec): string | undefined {
	const source = spec.kind === "spawn" ? spec.task : spec.message;
	if (!source) return undefined;
	const flat = sanitizeDisplayText(source).replace(/\s+/g, " ").trim();
	return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}

export function formatLaunchFailureNotice(spec: LaunchSpec, errorMessage: string): string {
	const { name, agent } = specDisplay(spec);
	const identity = `"${sanitizeDisplayText(name)}" (id ${spec.id}${agent ? `, agent ${sanitizeDisplayText(agent)}` : ""})`;
	const verb = spec.kind === "resume" ? "resume" : "launch";
	const retry =
		spec.kind === "resume"
			? `Retry with subagent_resume if you still need it (session: ${spec.sessionPath}).`
			: "Re-issue subagent_spawn if you still need this work done.";
	const preview = pendingWorkPreview(spec);
	const workLine = preview === undefined ? "" : `\n${spec.kind === "resume" ? "Its follow-up message was" : "Its task was"}: ${preview}`;
	return (
		`Queued sub-agent ${identity} failed to ${verb}: ${errorMessage}\n` +
		`It was removed from the queue and nothing was started; no result will arrive for it. ` +
		`${runningLine()} ${retry}${workLine}`
	);
}

export function formatQueueCancelledNotice(spec: LaunchSpec): string {
	const { name, agent } = specDisplay(spec);
	const identity = `"${sanitizeDisplayText(name)}" (id ${spec.id}${agent ? `, agent ${sanitizeDisplayText(agent)}` : ""})`;
	return (
		`Queued sub-agent ${identity} was cancelled by the user before it started. ` +
		`It never ran and no result will arrive for it; do not treat this as a failure. ` +
		runningLine()
	);
}

function runningLine(): string {
	return `Currently ${running.size} running, ${store.queue.length} queued.`;
}

function notifyRejectedLaunch(pi: ExtensionAPI, spec: LaunchSpec, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	try {
		pi.sendMessage(
			{
				customType: "subagent_launch_failed",
				content:
					`Queued sub-agent id ${spec.id} failed validation before launch: ${message}\n` +
					`It was removed from the queue and nothing was started; no result will arrive for it. ${runningLine()}`,
				display: true,
				details: { id: spec.id, kind: spec.kind, error: message },
			},
			{ triggerTurn: true, deliverAs: "steer" },
		);
	} catch {}
}

function notifyLaunchFailure(pi: ExtensionAPI, spec: LaunchSpec, error: unknown): void {
	try {
		validateLaunchSpec(spec);
	} catch (validationError) {
		notifyRejectedLaunch(pi, spec, validationError);
		return;
	}
	const message = error instanceof Error ? error.message : String(error);
	try {
		pi.sendMessage(
			{
				customType: "subagent_launch_failed",
				content: formatLaunchFailureNotice(spec, message),
				display: true,
				details: { id: spec.id, kind: spec.kind, error: message },
			},
			{ triggerTurn: true, deliverAs: "steer" },
		);
	} catch {
		// A failed notice must not kill the drain; the queue keeps moving and
		// subagent_status still shows the truth.
	}
}

export function notifyQueueCancelled(pi: ExtensionAPI, spec: LaunchSpec): void {
	try {
		pi.sendMessage(
			{
				customType: "subagent_queue_cancelled",
				content: formatQueueCancelledNotice(spec),
				display: true,
				details: { id: spec.id, kind: spec.kind },
			},
			{ triggerTurn: true, deliverAs: "steer" },
		);
	} catch {
		// Same contract as notifyLaunchFailure: never let a notice throw.
	}
}
