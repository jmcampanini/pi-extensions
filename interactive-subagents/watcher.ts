/**
 * watcher.ts — per-child supervision, and the words the parent model hears.
 *
 * The spawn tools return immediately, so the detached promise started by
 * trackChild() is a child's ONLY supervisor: it polls for the exit, cleans
 * up the pane, and steers the outcome back into the parent conversation.
 * It must never reject silently — every path ends in either a steered
 * message or a deliberate no-op. Exit paths that send a message first park
 * the child in state.ts's delivering map, so its widget row survives until
 * delivery.ts sees the message land; the silent no-op path never parks one.
 *
 * pi API in play: `pi.sendMessage(message, options)` is the one way to wake
 * the parent model asynchronously. `customType` tags the entry in the
 * session file (our E2E tests grep for it), `content` is the prose the
 * model reads, `display: true` also shows it in the TUI, and `details` is
 * machine-readable metadata persisted with the entry — the MODEL NEVER SEES
 * `details`, which is why the content prose must carry everything the model
 * needs (ids, paths, next steps): the prose IS the protocol.
 * `{ triggerTurn: true, deliverAs: "steer" }` makes the message start/steer
 * a turn instead of waiting for the human to type something. Those exact
 * options are also LOAD-BEARING for the delivering row: delivery.ts only
 * observes messages that travel the agent event stream, so a weakened send
 * would strand its row forever.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import {
	activityFilePath,
	newActivityObservation,
	noteTick,
	observeActivity,
	readActivityFile,
	type ActivityObservation,
} from "./activity.ts";
import { assertValidAgentIdentifier } from "./agent-identifier.ts";
import { drainQueue } from "./capacity.ts";
import { config } from "./config.ts";
import { sanitizeDisplayText } from "./display-text.ts";
import { readExternalResult } from "./harnesses.ts";
import { buildSubagentResultEnvelope } from "./result-content.ts";
import { computeStatus, STALL_AFTER_MS, type SubagentStatus } from "./status.ts";
import { closePane, pollForExit, refreshLayout, type ExitResult } from "./tmux.ts";
import { extractSummary } from "./session.ts";
import {
	deliveryRecord,
	deliveryRecords,
	ledger,
	moduleGeneration,
	moduleSignal,
	running,
	setDeliveryRecord,
	type DeliveryRecord,
	type RunningSubagent,
} from "./state.ts";
import { ensureWidgetTimer, updateRunningWidget } from "./running-widget.ts";
import {
	estimateResultTokens,
	humanElapsed,
	resultPresentation,
	type SubagentExpandedResultPresentation,
	type SubagentResultPresentation,
} from "./result-message.ts";
import { finishWorktree, type WorktreeInfo, type WorktreeOutcome } from "./worktree.ts";

/**
 * The worktree field included in a result envelope. The model never sees
 * `details`, so this text must carry everything it needs to act: the path,
 * the branch, what happened to them, and the next step (merge, inspect, or
 * clean up by hand). Branch phrasing is omitted when the worktree was on a
 * detached HEAD (`branch` is the literal "HEAD" — there is no branch to name).
 */
function worktreeNote(info: WorktreeInfo, outcome: WorktreeOutcome): string {
	const branch = info.branch === "HEAD" ? undefined : info.branch;
	if (outcome.status === "removed") {
		// The cleanup contract only promises the worktree goes away — branch
		// deletion is a property of the DEFAULT command, so name the branch
		// without asserting its fate (a grove-style override may keep it).
		return branch
			? `Worktree: no changes were made, so the cleanup command removed it (its branch was ${branch}).`
			: "Worktree: no changes were made, so the cleanup command removed it.";
	}
	if (outcome.status === "kept") {
		// The wording branches on WHY it was kept: "kept at <dir>" would be a
		// lie for a vanished directory, and `git merge` only helps once work
		// is committed — uncommitted changes live only in the worktree itself.
		if (outcome.code === "vanished") {
			return `Worktree: its directory ${info.dir} no longer exists — nothing was cleaned up.`;
		}
		const where = `Worktree: kept at ${info.dir}` + (branch ? ` on branch ${branch}` : "") + ` — ${outcome.reason}.`;
		if (outcome.code === "dirty") {
			return (
				`${where} Inspect the changes there` +
				(branch ? `; committed work can be merged from the main checkout with \`git merge ${branch}\`` : "") +
				`. Remove the worktree when you are done with it.`
			);
		}
		return `${where} Inspect or remove the worktree when you are done with it.`;
	}
	// cleanup-failed: say only what is observable — the command may have
	// removed the directory before failing, or done nothing at all.
	return existsSync(info.dir)
		? `Worktree: the cleanup command failed (${outcome.error}) — it is still at ${info.dir}` +
				(branch ? ` on branch ${branch}` : "") +
				"; remove it manually."
		: `Worktree: the cleanup command failed (${outcome.error}) after removing the directory` +
				(branch ? ` — check for a leftover branch ${branch}.` : ".");
}

// ── the liveness steers ──────────────────────────────────────────────────
// Edge-triggered: one stalled steer when a child ENTERS stalled (capped at 3
// episodes per child), one recovered steer when it leaves — never a message
// per tick. Interactive (non-auto-exit) children get neither: a human is
// expected to be looking at the pane, and the widget still shows their state.

/**
 * Re-checked immediately before EVERY send, mirroring the abort-suppression
 * discipline of the result path below: an abort can fire during the poll
 * sleep, and a steer into a dying or already-resolved session must never go
 * out.
 */
function canSteer(child: RunningSubagent, signal: AbortSignal): boolean {
	return child.autoExit && !signal.aborted && !child.stoppedByUser && running.has(child.id);
}

/**
 * Why the watchdog fired, as prose. When the reads themselves were healthy
 * (no 60s-old problem window) the stall is rule 6 — the child's program is
 * up but the prompted run never began; otherwise the last problem kind
 * decides. `tool` names that program ("pi", "claude-code") so the prose fits
 * every harness. The missing/foreign phrasing branches on whether a snapshot
 * was EVER accepted: "never appeared" would be a lie for a child whose
 * reports demonstrably had been arriving before the file went missing
 * mid-run, and would steer the model toward a bogus launch-failure diagnosis
 * of nearly finished work.
 */
function stalledReason(obs: ActivityObservation, nowMs: number, launchElapsed: string, tool: string): string {
	if (obs.problemSinceMs === undefined || nowMs - obs.problemSinceMs < STALL_AFTER_MS) {
		return `${tool} started in its pane but has not begun the task after ${launchElapsed}`;
	}
	if (obs.lastProblemKind === "invalid") {
		return "its liveness report has been unreadable for over 60s";
	}
	if (obs.lastProblemKind === "stale") {
		return "its liveness reports are time-stamped before the last accepted one for over 60s (child clock stepped backwards)";
	}
	if (obs.snapshot !== undefined) {
		return "its liveness reports stopped over 60s ago (report file missing)";
	}
	return `no liveness report has appeared in ${launchElapsed} (${tool} may never have started in its pane, e.g. a provider/auth error or a first-run setup dialog at startup)`;
}

/** The "may be stalled" warning. Explicitly NOT a failure: the child is
 * still supervised, and a result or failure message still arrives when it
 * exits — the prose says so, because the prose is the protocol. */
function sendStalledSteer(pi: ExtensionAPI, child: RunningSubagent, obs: ActivityObservation, nowMs: number): void {
	const elapsedSeconds = Math.round((nowMs - child.startTime) / 1000);
	const reason = stalledReason(obs, nowMs, humanElapsed(elapsedSeconds), child.harness ?? "pi");
	const childName = sanitizeDisplayText(child.name);
	pi.sendMessage(
		{
			customType: "subagent_stalled",
			content:
				`Sub-agent "${childName}" (id ${child.id}) may be stalled: ${reason}.\n\n` +
				`Options, in order: wait (it may still come up); check its pane via /subagent-running; or stop it there and retry with subagent_resume({ id: "${child.id}", message: "<guidance>" }).\n` +
				`This is a warning, not a failure: you will still get a result or failure message when it exits.\n` +
				`Session: ${child.sessionFile}`,
			display: true,
			details: {
				id: child.id,
				name: child.name,
				status: "stalled",
				reason,
				sessionFile: child.sessionFile,
				elapsedSeconds,
			},
		},
		{ triggerTurn: true, deliverAs: "steer" },
	);
}

/** The all-clear. Also triggerTurn: the model that just heard "maybe
 * stalled" may be mid-decision to stop the child and must be interrupted. */
function sendRecoveredSteer(pi: ExtensionAPI, child: RunningSubagent, status: SubagentStatus): void {
	const childName = sanitizeDisplayText(child.name);
	pi.sendMessage(
		{
			customType: "subagent_recovered",
			content: `Sub-agent "${childName}" (id ${child.id}) recovered: it is now reporting activity (${status}). No action needed, its result will arrive as usual.`,
			display: true,
			details: { id: child.id, name: child.name, status, sessionFile: child.sessionFile },
		},
		{ triggerTurn: true, deliverAs: "steer" },
	);
}

function startWatcher(pi: ExtensionAPI, child: RunningSubagent): void {
	const generation = moduleGeneration();
	if (child.watcherGeneration === generation) return;
	child.watcherGeneration = generation;
	void watchSubagent(pi, child, generation);
}

/** Register a child and start its supervision machinery. */
export function trackChild(pi: ExtensionAPI, child: RunningSubagent): void {
	if (child.agent !== undefined) assertValidAgentIdentifier(child.agent);
	child.activity = newActivityObservation(Date.now());
	running.set(child.id, child);
	ledger.set(child.id, { sessionFile: child.sessionFile, name: child.name });
	ensureWidgetTimer();
	updateRunningWidget();
	startWatcher(pi, child);
}

/** Rebind every live or finalizing child to the replacement runtime. */
export function adoptRunningChildren(pi: ExtensionAPI): void {
	const records = [...deliveryRecords()];
	if (running.size === 0 && records.length === 0) return;
	for (const child of running.values()) {
		if (child.agent !== undefined) assertValidAgentIdentifier(child.agent);
	}
	for (const record of records) {
		if (record.agent !== undefined) assertValidAgentIdentifier(record.agent);
		if (record.child.agent !== undefined) assertValidAgentIdentifier(record.child.agent);
	}
	ensureWidgetTimer();
	updateRunningWidget();
	for (const child of running.values()) startWatcher(pi, child);
	for (const record of records) startFinalizer(pi, record);
}

function ownsActiveWatcher(child: RunningSubagent, generation: number): boolean {
	return !moduleSignal().aborted
		&& generation === moduleGeneration()
		&& child.watcherGeneration === generation
		&& running.get(child.id) === child;
}

function ownsFinalizer(record: DeliveryRecord, generation: number): boolean {
	return !moduleSignal().aborted
		&& generation === moduleGeneration()
		&& record.finalizerGeneration === generation
		&& deliveryRecord(record.id) === record;
}

function startFinalizer(pi: ExtensionAPI, record: DeliveryRecord): void {
	const generation = moduleGeneration();
	if (record.finalizerGeneration === generation) return;
	record.finalizerGeneration = generation;
	void finalizeDelivery(pi, record, generation);
}

function sendDelivery(record: DeliveryRecord, generation: number, send: () => void): void {
	if (!ownsFinalizer(record, generation) || record.sendAccepted) return;
	try {
		send();
		record.sendAccepted = true;
	} catch {
		// Keep the sole record for replacement-generation retry. A successful
		// queued send survives reload and is never sent a second time.
	}
}

async function watchSubagent(pi: ExtensionAPI, child: RunningSubagent, generation: number): Promise<void> {
	const signal = AbortSignal.any([moduleSignal(), child.abort.signal]);

	// trackChild created the observation just before starting us; the ??= only
	// guards a caller that skipped trackChild.
	child.activity ??= newActivityObservation(Date.now());
	const obs = child.activity;
	const activityFile = activityFilePath(child.sessionFile);

	let result: ExitResult;
	try {
		result = child.pendingExit ?? await pollForExit({
			paneId: child.paneId,
			sessionFile: child.sessionFile,
			signal,
			// The liveness tick: one synchronous ~400-byte read per poll second,
			// the same cost class as the sidecar check the tick already does.
			onTick: () => {
				const now = Date.now();
				noteTick(obs, now); // clock-jump guard first — suspend/wake must not fake a stall
				observeActivity(obs, readActivityFile(activityFile, child.id), now);
				const status = computeStatus({
					nowMs: now,
					watchdogStartMs: obs.watchdogStartMs,
					expectsRun: child.expectsRun,
					everSawRun: obs.everSawRun ?? false,
					snapshot: obs.snapshot,
					problemSinceMs: obs.problemSinceMs,
				});

				// Edge detection. lastStatus is watcher-PRIVATE memory — the
				// widget and subagent_list recompute status from the same
				// observation fields, so they can never disagree with us.
				const previous = child.lastStatus ?? "starting";
				child.lastStatus = status;
				if (status === previous) return;

				if (status === "stalled") {
					// Entering stalled: one steer per episode, capped so a child
					// flapping at the 60s boundary cannot spam the parent. The
					// counter advances even when the steer is suppressed
					// (interactive children), so flipping a child to autonomous
					// later cannot replay stale episodes.
					child.stallEpisodes = (child.stallEpisodes ?? 0) + 1;
					if (canSteer(child, signal) && child.stallEpisodes <= 3) {
						sendStalledSteer(pi, child, obs, now);
						child.stallSteerSent = true;
					}
				} else if (previous === "stalled") {
					// Leaving stalled: the all-clear goes out only when the
					// warning did, and the latch clears even when the send is
					// suppressed — no phantom notification queues up.
					if (child.stallSteerSent && canSteer(child, signal)) sendRecoveredSteer(pi, child, status);
					child.stallSteerSent = false;
				}
			},
		});
	} catch (error) {
		result = {
			reason: "error",
			exitCode: 1,
			errorMessage: `Watcher failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	// A reload can land after the poll consumed a one-shot sidecar. Preserve
	// that exit on the stable child record so the replacement watcher can
	// finish it instead of waiting forever or losing a ping payload.
	if (result.reason !== "aborted") child.pendingExit ??= result;

	if (!ownsActiveWatcher(child, generation)) return;
	if (result.reason === "aborted" && !child.stoppedByUser) {
		running.delete(child.id);
		child.pendingExit = undefined;
		closePane(child.paneId);
		updateRunningWidget();
		if (running.size > 0) refreshLayout();
		return;
	}

	observeActivity(obs, readActivityFile(activityFile, child.id), Date.now());
	const record: DeliveryRecord = {
		id: child.id,
		name: child.name,
		agent: child.agent,
		harness: child.harness,
		startedAt: child.startTime,
		elapsedSeconds: Math.round((Date.now() - child.startTime) / 1000),
		forked: child.context === "forked",
		interactive: !child.autoExit,
		worktree: child.worktree !== undefined,
		child,
		exit: result,
		// Captured NOW, not at delivery time: a resume issued while this
		// record waits (allowed - the process has exited) clears the file.
		externalSummary: child.harness ? readExternalResult(child.sessionFile) : undefined,
	};
	// Publish before any async cleanup or send. The listener may delete this
	// record in the same microtask as sendMessage, so it is never reinserted.
	running.delete(child.id);
	child.pendingExit = undefined;
	setDeliveryRecord(record);
	closePane(child.paneId);
	updateRunningWidget();
	if (running.size > 0) refreshLayout();
	startFinalizer(pi, record);
	// The exit above released a concurrency slot — start queued launches.
	// (The silent-abort path earlier never drains: it only runs when this
	// module generation is dying, and drainQueue no-ops on an aborted
	// generation anyway; the replacement drains after adoption instead.)
	drainQueue(pi);
}

async function finalizeDelivery(pi: ExtensionAPI, record: DeliveryRecord, generation: number): Promise<void> {
	const child = record.child;
	const result = record.exit;
	const obs = child.activity ?? newActivityObservation(Date.now());
	const exitElapsedSeconds = record.elapsedSeconds;

	const elapsed = humanElapsed(exitElapsedSeconds);
	// External snapshots carry no cost telemetry (their costUsd is a schema
	// filler, not a measurement) - report nothing rather than a misleading $0.
	// Cost reporting for external tools is intentionally deferred.
	const costUsd = child.harness ? undefined : obs.snapshot?.costUsd;

	if (result.reason === "aborted") {
		// Two ways to get aborted: the session is shutting down (stay
		// silent — nobody is left to tell) or a human pressed x in the
		// picker. The model must hear about the latter, because it was
		// promised a result for this child and would otherwise wait for
		// one that can never arrive.
		if (child.stoppedByUser) {
			const notice = "Stopped by the user. Do not treat this as a subagent failure.";
			const stoppedWorktreeNote = child.worktree
				? `Worktree: kept at ${child.worktree.dir} because the work may be incomplete.`
				: undefined;
			const envelope = buildSubagentResultEnvelope({
				status: "stopped",
				name: child.name,
				agent: child.agent ?? "worker",
				harness: child.harness,
				id: child.id,
				elapsed,
				contextTokens: obs.snapshot?.context?.tokens ?? undefined,
				costUsd,
				notice,
				action: "Resume",
				actionMessage: "...",
				sessionFile: child.sessionFile,
				worktreeNote: stoppedWorktreeNote,
			});
			sendDelivery(record, generation, () => pi.sendMessage(
				{
					customType: "subagent_result",
					content: envelope.content,
					display: true,
					details: {
						id: child.id,
						name: child.name,
						agent: child.agent,
						harness: child.harness,
						reason: "stopped",
						sessionFile: child.sessionFile,
						contextTokens: obs.snapshot?.context?.tokens,
						costUsd,
						expanded: {
							version: 1,
							notice,
							worktreeNote: stoppedWorktreeNote,
						} satisfies SubagentExpandedResultPresentation,
						presentation: resultPresentation(
							"stopped",
							exitElapsedSeconds,
							"No final result was delivered. Partial work may remain; expand for resume and worktree details.",
						),
					},
				},
				{ triggerTurn: true, deliverAs: "steer" },
			));
		}
		return;
	}

	// A ping is a help request, not a completion: hand the parent model
	// the question plus everything it needs to resume the child.
	if (result.reason === "ping") {
		const pingName = sanitizeDisplayText(result.pingName ?? child.name);
		const pingMessage = sanitizeDisplayText(result.pingMessage);
		sendDelivery(record, generation, () => pi.sendMessage(
			{
				customType: "subagent_ping",
				content:
					`Sub-agent "${pingName}" (id ${child.id}) needs help: ${pingMessage}\n\n` +
					`Answer with subagent_resume({ id: "${child.id}", message: "<your answer>" }). ` +
					"Its original system prompt, tools, and model are reapplied automatically.\n" +
					`Session: ${child.sessionFile} (pass as sessionPath instead of id if the id is no longer known)`,
				display: true,
				details: { id: child.id, name: child.name, sessionFile: child.sessionFile },
			},
			{ triggerTurn: true, deliverAs: "steer" },
		));
		return;
	}

	// Completion or failure: the summary is the child's last assistant
	// message. pi children: read from the session file (only entries after a
	// resume point, if any). External children: the value captured onto the
	// record at exit time (originally written verbatim to `<anchor>.result`
	// by the turn-complete notifier) - never re-read from disk here, because
	// a resume can clear the file while this record waits or retries. A null
	// capture flows into the same "produced no final message" handling below.
	const summary = child.harness
		? (record.externalSummary ?? null)
		: extractSummary(child.sessionFile, child.skipEntries);
	const generatedSummary = summary === null ? null : sanitizeDisplayText(summary);
	const resultTokens = generatedSummary === null ? undefined : estimateResultTokens(generatedSummary);
	const failed = result.exitCode !== 0 || result.reason === "error" || result.reason === "pane-closed";

	// Cleanup may overlap a reload. Store its promise on the stable record so
	// every generation awaits the same outcome instead of running it twice.
	let worktreeOutcome: WorktreeOutcome | undefined;
	if (child.worktree) {
		record.worktreeCleanup ??= finishWorktree({
			info: child.worktree,
			mode: config.worktreeCleanupMode,
			command: config.worktreeCleanupCommand,
			childSucceeded: !failed,
		});
		worktreeOutcome = await record.worktreeCleanup;
		if (!ownsFinalizer(record, generation)) return;
	}

	let response: string | undefined;
	let failureReason: string | undefined;
	let presentation: SubagentResultPresentation;
	if (!failed) {
		response = generatedSummary ?? "(the subagent produced no final message)";
		presentation = resultPresentation("completed", exitElapsedSeconds, response);
	} else {
		failureReason =
			result.reason === "error"
				? `provider/agent error: ${result.errorMessage}`
				: result.reason === "pane-closed"
					? result.errorMessage
					: `exit code ${result.exitCode}`;
		response = generatedSummary ?? undefined;
		presentation = resultPresentation("failed", exitElapsedSeconds, response ?? failureReason);
	}

	const note = child.worktree && worktreeOutcome
		? worktreeNote(child.worktree, worktreeOutcome)
		: undefined;
	const envelope = buildSubagentResultEnvelope({
		status: failed ? "failed" : "completed",
		name: child.name,
		agent: child.agent ?? "worker",
		harness: child.harness,
		id: child.id,
		elapsed,
		contextTokens: obs.snapshot?.context?.tokens ?? undefined,
		resultTokens,
		costUsd,
		response,
		failureReason,
		action: failed ? "Retry" : "Resume",
		actionMessage: failed ? "<guidance>" : "...",
		sessionFile: child.sessionFile,
		worktreeNote: note,
	});
	const content = envelope.content;
	const expanded: SubagentExpandedResultPresentation = {
		version: 1,
		response: envelope.response,
		failureReason,
		worktreeNote: note,
	};

	sendDelivery(record, generation, () => pi.sendMessage(
		{
			customType: "subagent_result",
			content,
			display: true,
			details: {
				id: child.id,
				name: child.name,
				agent: child.agent,
				harness: child.harness,
				exitCode: result.exitCode,
				reason: result.reason,
				sessionFile: child.sessionFile,
				tools: child.tools,
				model: child.model,
				worktreeDir: child.worktree?.dir,
				worktreeBranch: child.worktree?.branch,
				worktreeStatus: worktreeOutcome?.status,
				// Raw context telemetry remains available to the TUI and tooling
				// (undefined without a snapshot; null just after compaction).
				contextTokens: obs.snapshot?.context?.tokens,
				contextWindow: obs.snapshot?.context?.window,
				resultTokens,
				costUsd,
				expanded,
				presentation,
			},
		},
		{ triggerTurn: true, deliverAs: "steer" },
	));
}
