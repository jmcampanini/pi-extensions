/**
 * tool-resume.ts — the `subagent_resume` tool: reopen a child session.
 *
 * Used to answer a caller_ping, retry a failure, or send follow-up work.
 * Context survives because the child's .jsonl file IS the conversation —
 * resuming just points a fresh pi process at the same file. The child's
 * launch identity (system prompt, tools, model, thinking, auto-exit) is
 * restored from its `.meta` sidecar; explicit params always win.
 *
 * A resume consumes a concurrency slot exactly like a spawn (it opens a new
 * pane and a new child process), so it goes through the same admission fork:
 * validation resolves everything into a pure spec, then the launch runs now
 * ('started') or queues (capacity.ts starts it when a slot frees, 'queued').
 */

import { keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { activityFilePath, clearActivityFile } from "./activity.ts";
import {
	AbandonLaunch,
	admitLaunch,
	assertLaunchStillWanted,
	findQueued,
	isPendingLaunch,
	pendingResumeFor,
	registerLauncher,
	releaseClaim,
	requestDrain,
	RequeueLaunch,
	type ResumeSpec,
} from "./capacity.ts";
import { config } from "./config.ts";
import {
	clearExternalResult,
	externalSessionIdPath,
	readExternalSessionId,
	requireHarnessProfile,
} from "./harnesses.ts";
import { artifactBase, buildChildEnv, buildLaunchCommand, clearExitSidecar, readLaunchMeta, slugify } from "./launch.ts";
import { resolveUsableModel } from "./models.ts";
import { appendSessionName, countEntries, readSessionCwd, readSessionName } from "./session.ts";
import {
	formatCollapsedSubagentResumeCall,
	formatExpandedSubagentResumeCall,
} from "./subagent-call.ts";
import { renderSubagentLaunchResult } from "./subagent-result.ts";
import { updateRunningWidget } from "./running-widget.ts";
import { closePane, createPane, isTmuxAvailable, shellQuote, stageLaunchScript } from "./tmux.ts";
import { ledger, moduleGeneration, running } from "./state.ts";
import { trackChild } from "./watcher.ts";

const ResumeParams = Type.Object({
	id: Type.Optional(
		Type.String({ description: "The sub-agent's short id from a result/ping message (preferred). Use sessionPath instead if pi was restarted since." }),
	),
	sessionPath: Type.Optional(
		Type.String({ description: "Path to the child session .jsonl file — fallback when the id is no longer known (e.g. after a pi restart)" }),
	),
	message: Type.Optional(Type.String({ description: "Follow-up prompt or answer to send to the resumed subagent" })),
	name: Type.Optional(
		Type.String({ description: "Display name override for the resumed subagent (defaults to the child's original name, then 'Resumed')" }),
	),
	autoExit: Type.Optional(
		Type.Boolean({
			description:
				"Override auto-exit behavior. If omitted, the child's original value is restored from launch metadata, falling back to true. " +
				"An effective true requires a message; false stays open for a human and permits a message-free handoff.",
		}),
	),
	tools: Type.Optional(Type.String({ description: "Override the tool allowlist (default: the child's original tools, restored from its launch metadata)" })),
	model: Type.Optional(Type.String({ description: "Override the model (default: the child's original model, restored from its launch metadata)" })),
});
type ResumeParamsType = Static<typeof ResumeParams>;

const CALL_TEXT_METRICS = {
	visibleWidth,
	truncateToWidth,
	renderText: (text: string, width: number) => new Text(text, 0, 0).render(width),
};

function resumeCallPresentation(params: ResumeParamsType): { name: string; agent?: string; message?: string } {
	const ledgerEntry = params.id ? ledger.get(params.id) : undefined;
	const sessionPath = params.sessionPath ?? ledgerEntry?.sessionFile;
	const meta = sessionPath ? readLaunchMeta(sessionPath) : {};
	return {
		name: params.name ?? meta.name ?? ledgerEntry?.name ?? "Resumed",
		agent: meta.agent,
		message: params.message,
	};
}

export function registerSubagentResumeTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "subagent_resume",
		label: "Resume Subagent",
		description:
			"Resume a previous sub-agent session with an optional follow-up message. Pass the `id` from a " +
			"result/ping message (preferred), or `sessionPath` if the id is no longer known (e.g. after a restart). " +
			"ASYNC — returns immediately with status 'started', or 'queued' when the concurrency limit of " +
			`${config.maxConcurrentSubagents} sub-agents (shared with subagent_spawn) is reached; a queued ` +
			"resume starts automatically as slots free. The result steers back automatically. Do not poll.",
		parameters: ResumeParams,
		renderCall(args, theme, context) {
			const presentation = resumeCallPresentation(args);
			const style = {
				title: (text: string) => theme.fg("toolTitle", theme.bold(text)),
				name: (text: string) => theme.fg("accent", text),
				agent: (text: string) => theme.fg("muted", text),
				hint: (text: string) => theme.fg("dim", text),
				preview: (text: string) => theme.fg("dim", text),
				body: (text: string) => theme.fg("toolOutput", text),
			};
			const expandHint = keyHint("app.tools.expand", "to expand");
			return {
				invalidate(): void {},
				render(width: number): string[] {
					if (context.expanded) {
						return formatExpandedSubagentResumeCall(presentation, width, CALL_TEXT_METRICS, style);
					}
					return formatCollapsedSubagentResumeCall(
						presentation,
						width,
						config.callPreviewLines,
						CALL_TEXT_METRICS,
						style,
						expandHint,
					);
				},
			};
		},
		renderResult(result, _options, theme, context) {
			return renderSubagentLaunchResult(result, context.isError, (text) =>
				new Text(theme.fg("error", text), 0, 0),
			);
		},
		async execute(_toolCallId, params: ResumeParamsType, _signal, _onUpdate, ctx) {
			if (!isTmuxAvailable()) {
				throw new Error("Subagents need tmux 3.0a+ with pi running inside a session.");
			}

			// A queued or just-dequeued child has never run (it is not in the
			// ledger yet), so there is no session to reopen — catch the id
			// here for a better answer than "unknown id".
			if (params.id && findQueued(params.id)) {
				throw new Error(
					`Sub-agent id "${params.id}" is still queued and has not started yet — there is nothing to resume. ` +
						"It launches automatically when a concurrency slot frees; wait for its result instead.",
				);
			}
			if (params.id && isPendingLaunch(params.id)) {
				throw new Error(
					`Sub-agent id "${params.id}" is starting right now — there is nothing to resume yet. Wait for its result instead.`,
				);
			}

			// Resolve which session to reopen: short id via this session's
			// ledger (preferred — no long path to copy around), else an
			// explicit path (survives parent restarts, when the ledger is gone).
			let sessionPath = params.sessionPath;
			if (!sessionPath && params.id) {
				sessionPath = ledger.get(params.id)?.sessionFile;
				if (!sessionPath) {
					throw new Error(
						`Unknown sub-agent id "${params.id}" — pass the sessionPath from the result/ping message instead.`,
					);
				}
			}
			if (!sessionPath) {
				throw new Error("subagent_resume needs either `id` (from a result/ping message) or `sessionPath`.");
			}

			// The `.meta` sidecar decides HOW to resume, so it is read before the
			// exists guard: an external child has no session file at its anchor
			// (the path only names its sidecars), so requiring one would make
			// every external resume fail. pi children keep the guard.
			const meta = readLaunchMeta(sessionPath);
			const harness = meta.harness ?? "pi";
			const profile = harness === "pi" ? undefined : requireHarnessProfile(harness);
			if (!profile && !existsSync(sessionPath)) {
				throw new Error(`No session file at ${sessionPath}`);
			}

			// Refuse to attach a second pi process to a session that is still
			// running — two processes appending to one .jsonl corrupts it.
			// Checked synchronously (before any await) against BOTH the running
			// map and capacity.ts's queue/claims, so parallel resume calls
			// cannot race each other into a double-attach: whichever call runs
			// first claims or queues, and the other sees it here.
			// Children in state.ts's delivering map are deliberately NOT
			// blocked: their pi process has exited, so there is no second
			// writer. A resume during that window mints a new id; the old
			// result still arrives later and describes the pre-resume run.
			const targetPath = resolve(sessionPath);
			for (const child of running.values()) {
				if (resolve(child.sessionFile) === targetPath) {
					throw new Error(
						`Sub-agent "${child.name}" (id ${child.id}) is still running on this session — wait for its result or ping before resuming.`,
					);
				}
			}
			if (pendingResumeFor(targetPath)) {
				throw new Error(
					"A resume of this session is already queued or starting — wait for its result instead of resuming again.",
				);
			}

			// Reapply the child's original launch settings from the `.meta`
			// sidecar (read above). Explicit params always win; a missing meta
			// file (e.g. a session not created by this extension) just means no
			// defaults.
			const name = params.name ?? meta.name ?? "Resumed";
			const autoExit = params.autoExit ?? meta.autoExit ?? true;
			const tools = params.tools ?? meta.tools;
			// Re-resolve the model on THIS machine (an old session may name a
			// provider this computer has no credentials for — fail fast here,
			// not in the pane). Param overrides go through the same check.
			// External model names are the tool's own and are not in pi's
			// registry: the requested or recorded name passes verbatim.
			const modelCandidates = params.model ? [params.model] : meta.model ? [meta.model] : [];
			const model = profile
				? modelCandidates[0]
				: modelCandidates.length > 0
					? resolveUsableModel(modelCandidates, ctx.modelRegistry)
					: undefined;
			const thinking = meta.thinking;

			// An autonomous resume with no message would open an idle session
			// that never completes: nothing prompts the child, so no turn runs,
			// so auto-exit never fires and the watcher polls forever.
			if (autoExit && !params.message) {
				throw new Error(
					"subagent_resume needs a `message` when the child is autonomous (autoExit) — pass your answer/follow-up, or set autoExit: false to hand the pane to a human.",
				);
			}
			const systemPromptFile =
				meta.systemPromptFile && existsSync(meta.systemPromptFile) ? meta.systemPromptFile : undefined;
			const id = randomUUID().slice(0, 8);

			// Run in the directory the original child used, so relative paths
			// and tools behave the same: pi children record it in their session
			// header; external children have no header, so it comes from the
			// `.meta` sidecar written at launch.
			const sessionCwd = profile ? (meta.cwd ?? null) : readSessionCwd(sessionPath);
			if (profile && sessionCwd === null) {
				throw new Error(
					`Cannot resume: the launch metadata at ${sessionPath}.meta records no working directory for this external child. Spawn a new subagent instead.`,
				);
			}

			// A vanished cwd would otherwise fail OBSCURELY: the pane's `cd`
			// fails, the sentinel reports exit 1 after ~1s, and the watcher
			// delivers a misleading "failed" result with a stale summary. Catch
			// it here and say what actually happened — for worktree children
			// that usually means auto-cleanup removed the directory. (The
			// launch pipeline re-checks: a queued resume can outlive its cwd.)
			if (sessionCwd && !existsSync(sessionCwd)) {
				throw vanishedCwdError(sessionCwd, meta.worktree !== undefined, meta.worktree?.dir);
			}

			// External children resume through their own tool's resume flag,
			// using the session id the turn-complete notifier recorded. No id
			// means no turn ever completed - there is nothing to reopen.
			let externalSessionId: string | undefined;
			if (profile) {
				const recorded = readExternalSessionId(sessionPath);
				if (recorded === null) {
					throw new Error(
						`Cannot resume: no external session id was recorded at ${externalSessionIdPath(sessionPath)} - ` +
							`the ${harness} child never completed a turn, so there is no session to reopen. Spawn a new subagent instead.`,
					);
				}
				externalSessionId = recorded;
			}

			// Everything a relaunch needs, as pure data (see capacity.ts). The
			// session-picker backfill label is decided here (sessions this
			// extension created, pi children only) but applied at launch, and
			// only if the session still has no name by then.
			const spec: ResumeSpec = {
				kind: "resume",
				id,
				sessionPath,
				name,
				agent: meta.agent,
				harness,
				autoExit,
				tools,
				model,
				thinking,
				systemPromptFile,
				message: params.message,
				context: meta.context,
				worktree: meta.worktree,
				harnessPassThrough: meta.harnessPassThrough,
				cwd: sessionCwd,
				cwdFromWorktree: meta.worktree !== undefined,
				backfillLabel:
					!profile && meta.name && meta.agent ? `subagent › ${meta.agent} › ${meta.name}` : undefined,
				externalSessionId,
				base: artifactBase(ctx),
				slug: slugify(name),
				// A resume without a message hands the pane to a human — that
				// child legitimately idles forever and must read "waiting", not
				// stuck-at-"starting" (see status.ts).
				expectsRun: Boolean(params.message),
			};

			// The fork: claim a slot and relaunch now, or join the queue — same
			// contract as subagent_spawn (see there for the race reasoning).
			const admission = admitLaunch(spec);
			if (admission.status === "queued") {
				updateRunningWidget();
				const ahead = admission.ahead > 0 ? `, ${admission.ahead} ahead of it in the queue` : "";
				return {
					content: [
						{
							type: "text",
							text:
								`Resume of sub-agent "${name}" queued (id ${id}): all ` +
								`${config.maxConcurrentSubagents} concurrency slots are busy${ahead}. ` +
								"It starts automatically when a slot frees, and its result arrives like " +
								"any other sub-agent's — do not poll, and do not re-issue this resume.",
						},
					],
					details: { id, sessionFile: sessionPath, status: "queued", ahead: admission.ahead },
				};
			}

			let launched: { paneId: string };
			try {
				launched = await runResumeLaunch(pi, spec);
			} catch (error) {
				releaseClaim(id);
				// The failed launch freed its slot — without this, queued work
				// behind it could sit forever with capacity free (nothing else
				// triggers a drain until some running child exits).
				requestDrain(pi);
				updateRunningWidget();
				// The boundary guards can only fire inline when the turn was
				// already aborted mid-launch; translate them for the transcript.
				if (error instanceof RequeueLaunch || error instanceof AbandonLaunch) {
					throw new Error(
						"Sub-agent resume was interrupted by a session reload/shutdown before it started — " +
							"nothing is running. Re-issue the call if the work is still needed.",
					);
				}
				throw error;
			}

			return {
				content: [
					{
						type: "text",
						text: `Resumed sub-agent "${name}" (id ${id}). Its result will arrive automatically — do not poll.`,
					},
				],
				details: { id, sessionFile: sessionPath, paneId: launched.paneId },
			};
		},
	});

	// The queue drain relaunches resumes through the same pipeline the inline
	// path uses (see the matching registration in tool-spawn.ts).
	registerLauncher("resume", (piApi, spec) => runResumeLaunch(piApi, spec as ResumeSpec));
}

function vanishedCwdError(cwd: string, fromWorktree: boolean, worktreeDir?: string): Error {
	if (fromWorktree) {
		return new Error(
			`Cannot resume: this sub-agent ran in a git worktree at ${worktreeDir ?? cwd} that no longer exists (usually auto-cleanup after it finished with no changes). Use subagent_spawn to launch a new child instead.`,
		);
	}
	return new Error(
		`Cannot resume: the sub-agent's working directory no longer exists: ${cwd}. Use subagent_spawn to launch a new child instead.`,
	);
}

/**
 * The relaunch pipeline — every side effect of reopening a child session.
 * Runs inline or from the queue drain; same claim/rollback contract as
 * tool-spawn.ts's runSpawnLaunch. Unlike the old inline-only code, a failure
 * after the pane opened now closes it again instead of leaking it.
 */
async function runResumeLaunch(pi: ExtensionAPI, spec: ResumeSpec): Promise<{ paneId: string }> {
	const launchGeneration = moduleGeneration();
	const profile = spec.harness === "pi" ? undefined : requireHarnessProfile(spec.harness);

	// Re-run the two liveness checks that can change while a resume waits in
	// the queue. The busy re-check is belt-and-braces (the admission dedupe
	// makes a second attach impossible by construction); the cwd re-check is
	// real — worktree auto-cleanup can remove it between queue and launch.
	const targetPath = resolve(spec.sessionPath);
	for (const child of running.values()) {
		if (resolve(child.sessionFile) === targetPath) {
			throw new Error(
				`Sub-agent "${child.name}" (id ${child.id}) is running on this session — the queued resume was skipped.`,
			);
		}
	}
	if (spec.cwd && !existsSync(spec.cwd)) {
		throw vanishedCwdError(spec.cwd, spec.cwdFromWorktree, spec.worktree?.dir);
	}

	// Every sidecar clear sits AFTER the admission and busy guards: a
	// rejected resume of a busy child must leave that child's files alone. A
	// leftover `.exit` from a previous run would fake an instant completion,
	// but clearing it while a child completes RIGHT NOW would delete its
	// just-written marker; the guards above make this window writer-free.
	// Clearing `.activity` for a live child would manufacture a false stall
	// steer ~60s later — same reasoning.
	clearExitSidecar(spec.sessionPath);
	clearActivityFile(spec.sessionPath);

	// Backfill: children spawned before display names were seeded show raw
	// @file task text in pi's session picker. Give them the same
	// "subagent › agent › name" label on resume — but only when the file
	// STILL has no name (a human may have renamed it in the picker; decided
	// at call time, re-checked here because a queued resume waits). Runs
	// before the child pi process starts, so there is one writer. Never for
	// external children: appending would CREATE a file at an anchor that
	// must stay absent from pi's session picker.
	if (spec.backfillLabel && readSessionName(spec.sessionPath) === undefined) {
		appendSessionName(spec.sessionPath, spec.backfillLabel);
	}

	// Only entries added AFTER this point count toward the new summary.
	// (External results come from `<anchor>.result`, not entry counting.)
	const skipEntries = profile ? 0 : countEntries(spec.sessionPath);

	// The follow-up message rides in as a file, like task delivery. For
	// external children the file is expanded onto the tool's command
	// line as a bare positional, where a dash-leading message would
	// parse as an option (verified: claude rejects "--foo ..." outright
	// and silently swallows "-v ..." as --version). The heading shield
	// mirrors the task path's "# Your task" and makes a dash-leading
	// first byte impossible; pi children are immune (@file delivery)
	// and keep the verbatim message.
	let messageFile: string | undefined;
	if (spec.message) {
		messageFile = join(spec.base, "resume", `${spec.slug}-${spec.id}.md`);
		mkdirSync(dirname(messageFile), { recursive: true });
		writeFileSync(messageFile, profile ? `# Follow-up\n\n${spec.message}` : spec.message, "utf8");
	}

	const command = profile
		? profile.buildResumeCommand({
				cwd: spec.cwd as string,
				anchor: spec.sessionPath,
				runId: spec.id,
				autoExit: spec.autoExit,
				model: spec.model,
				thinking: spec.thinking,
				tools: spec.tools,
				systemPromptFile: spec.systemPromptFile,
				passThrough: spec.harnessPassThrough,
				messageFile,
				resumeSessionId: spec.externalSessionId,
			})
		: buildLaunchCommand({
				cwd: spec.cwd,
				env: buildChildEnv({
					PI_SUBAGENT_SESSION: spec.sessionPath,
					PI_SUBAGENT_NAME: spec.name,
					// The liveness pair (see activity.ts): a resume mints a FRESH
					// run id, so any snapshot surviving the clear above is fenced
					// off as foreign by the reader.
					PI_SUBAGENT_ID: spec.id,
					PI_SUBAGENT_ACTIVITY_FILE: activityFilePath(spec.sessionPath),
					PI_SUBAGENT_AGENT: spec.agent,
					PI_SUBAGENT_AUTO_EXIT: spec.autoExit ? "1" : undefined,
				}),
				sessionFile: spec.sessionPath,
				model: spec.model,
				thinking: spec.thinking,
				systemPromptFile: spec.systemPromptFile,
				tools: spec.tools,
				passThrough: spec.harnessPassThrough,
				promptArg: messageFile ? shellQuote(`@${messageFile}`) : "",
			});

	// The stale result file is cleared LAST, once nothing below can
	// refuse the relaunch: left in place it would masquerade as the new
	// run's final message, but clearing it any earlier would let a
	// resume that still fails validation (or a resume racing an
	// undelivered result) destroy the only copy of the previous run's
	// outcome. (Delivery itself is safe regardless - the watcher
	// captures the summary onto the delivery record at exit time.)
	if (profile) clearExternalResult(spec.sessionPath);

	const scriptPath = join(spec.base, "scripts", `${spec.slug}-${spec.id}-resume.sh`);
	let paneId: string | undefined;
	try {
		// Same boundary discipline as spawn: there is currently no await in
		// this pipeline, so the guard is a defensive assertion against a
		// future refactor. Pane creation starts the child immediately.
		stageLaunchScript(command, scriptPath);
		assertLaunchStillWanted(launchGeneration);
		paneId = createPane(spec.name, scriptPath);
	} catch (error) {
		if (paneId !== undefined) closePane(paneId);
		throw error;
	}

	trackChild(pi, {
		id: spec.id,
		name: spec.name,
		agent: spec.agent,
		harness: profile ? spec.harness : undefined,
		paneId,
		sessionFile: spec.sessionPath,
		startTime: Date.now(),
		skipEntries,
		tools: spec.tools,
		model: spec.model,
		autoExit: spec.autoExit,
		context: spec.context,
		// The ORIGINAL worktree snapshot rides along unchanged: keeping
		// the original baseCommit means work committed in an earlier run
		// still counts as "changes" when this run's cleanup decides.
		worktree: spec.worktree,
		abort: new AbortController(),
		expectsRun: spec.expectsRun,
	});
	releaseClaim(spec.id);

	return { paneId };
}
