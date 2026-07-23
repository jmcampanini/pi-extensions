/**
 * tool-spawn.ts — the `subagent_spawn` tool: spawn a child pi session.
 *
 * pi API in play: `pi.registerTool(...)` exposes a tool to the MODEL. The
 * `description`, `promptGuidelines`, and every `parameters` field description
 * are read by the model when it decides whether and how to call the tool —
 * they are prompts, not documentation, so they carry behavioral instructions
 * ("do not poll").
 * `execute(toolCallId, params, signal, onUpdate, ctx)` runs when the model
 * calls it; whatever `content` it returns (or the message of whatever it
 * throws) goes straight back into the model's context as the tool result.
 *
 * The spawn itself: resolve the agent definition (explicit params beat
 * frontmatter beat built-in defaults) into a pure LAUNCH SPEC, then either
 * run the launch pipeline now (a concurrency slot was free — the tool
 * returns 'started' as soon as the child is RUNNING) or queue the spec
 * (capacity.ts launches it when a slot frees — the tool returns 'queued'
 * immediately). The pipeline writes the task and system prompt as artifact
 * files, builds the launch command (launch.ts), opens a pane (tmux.ts), and
 * hands the child to the watcher (watcher.ts). Results always arrive later
 * as steered messages.
 */

import { keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { activityFilePath, clearActivityFile } from "./activity.ts";
import { assertValidAgentIdentifier } from "./agent-identifier.ts";
import { agentDefsDir, loadAgentDefinition, projectDefsDir, type AgentDefinition } from "./agents.ts";
import {
	AbandonLaunch,
	admitLaunch,
	assertLaunchStillWanted,
	registerLauncher,
	releaseClaim,
	requestDrain,
	RequeueLaunch,
	type SpawnSpec,
} from "./capacity.ts";
import { config } from "./config.ts";
import { clearExternalResult, requireHarnessProfile } from "./harnesses.ts";
import {
	artifactBase,
	buildChildEnv,
	buildLaunchCommand,
	clearExitSidecar,
	generateChildSessionFile,
	slugify,
	writeLaunchMeta,
} from "./launch.ts";
import { assertValidThinkingLevel, resolveUsableModel, THINKING_LEVELS } from "./models.ts";
import { countEntries, seedForkSession, seedFreshSession } from "./session.ts";
import { moduleGeneration } from "./state.ts";
import { formatCollapsedSubagentCall, formatExpandedSubagentCall } from "./subagent-call.ts";
import { renderSubagentLaunchResult } from "./subagent-result.ts";
import { updateRunningWidget } from "./running-widget.ts";
import { closePane, createPane, isTmuxAvailable, shellQuote, stageLaunchScript } from "./tmux.ts";
import { trackChild } from "./watcher.ts";
import { createWorktree, removeWorktree, type WorktreeInfo } from "./worktree.ts";

const SubagentSpawnParams = Type.Object({
	name: Type.String({
		description:
			"Short display name describing the TASK, e.g. 'Auth flow' — shown in the widget next to the agent type, so do not repeat the agent type in it.",
	}),
	task: Type.String({
		description:
			"Task prompt. With fresh context, make it self-contained: include the objective, relevant facts and paths, constraints, whether edits are allowed, and the expected output or verification. " +
			"With forked context, the task can be a directive that refers to the inherited conversation.",
	}),
	agent: Type.Optional(
		Type.String({
			description:
				"Agent definition identifier to load defaults from (a <name>.md file in <cwd>/.pi/subagents/ or the global subagents dir; no whitespace, at most 20 display columns; project shadows global — see subagent_available). Default: 'worker'",
		}),
	),
	context: Type.Optional(
		Type.Union([Type.Literal("fresh"), Type.Literal("forked")], {
			description:
				"'fresh' = no parent conversation (default; project files and instructions still load). Use for self-contained work and include all needed context in `task`. " +
				"'forked' = copies this conversation up to the moment the child actually launches — immediately when a concurrency slot is free, or later when a queued launch starts. Use when the task materially depends on accumulated discussion, reads, or decisions that would be difficult or lossy to restate, or to try parallel approaches from the same starting point. " +
				"Forked history is sent to the child's selected model/provider, so prefer fresh when that history is unnecessary or sensitive. Use subagent_resume instead when a follow-up depends on a previous child's own context. Overrides the agent definition.",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"Model override: 'provider/model' (e.g. 'openai-codex/gpt-5.5'), or a bare model id when exactly one configured provider offers it. " +
				"Validated like the agent's models list — unknown or credential-less models error immediately.",
		}),
	),
	tools: Type.Optional(Type.String({ description: "Comma-separated tool allowlist, e.g. 'read,bash' (overrides the agent default)" })),
	thinking: Type.Optional(
		Type.String({
			description:
				`Thinking/effort level override: ${THINKING_LEVELS.join(", ")}. Defaults to the agent definition's \`thinking:\` value.`,
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description:
				"Working directory for the subagent (defaults to this session's cwd). " +
				"Passing cwd also overrides an agent's frontmatter worktree default — the child runs here, not in a worktree.",
		}),
	),
	worktree: Type.Optional(
		Type.Boolean({
			description:
				"true = run the subagent in a fresh git worktree (own branch + directory). " +
				"Result reports path/branch; clean worktrees are auto-removed. Cannot be combined with cwd.",
		}),
	),
	autoExit: Type.Optional(
		Type.Boolean({
			description:
				"true (default) = autonomous: the child exits when its turn completes. " +
				"false = interactive: the child stays open for a human until it calls subagent_done.",
		}),
	),
});
type SubagentSpawnParamsType = Static<typeof SubagentSpawnParams>;

interface EffectiveSpawnBehavior {
	context: "fresh" | "forked";
	autoExit: boolean;
	useWorktree: boolean;
	harness: string;
}

interface SpawnBehaviorPresentation {
	version: 1;
	behavior: EffectiveSpawnBehavior;
	/** Optional so persisted v1 rows from before model presentation still render. */
	model?: string | null;
}

interface ParsedSpawnPresentation {
	behavior: EffectiveSpawnBehavior;
	model?: string | null;
}

interface SpawnRenderState {
	effectiveBehavior?: EffectiveSpawnBehavior;
	effectiveModel?: string | null;
	presentationSettled?: boolean;
}

function parseSpawnPresentation(details: unknown): ParsedSpawnPresentation | undefined {
	if (!details || typeof details !== "object") return undefined;
	const presentation = (details as { presentation?: unknown }).presentation;
	if (!presentation || typeof presentation !== "object") return undefined;
	const candidate = presentation as Partial<SpawnBehaviorPresentation>;
	if (candidate.version !== 1 || !candidate.behavior || typeof candidate.behavior !== "object") return undefined;
	const behavior = candidate.behavior as Partial<EffectiveSpawnBehavior>;
	if ((behavior.context !== "fresh" && behavior.context !== "forked")
		|| typeof behavior.autoExit !== "boolean"
		|| typeof behavior.useWorktree !== "boolean"
		|| typeof behavior.harness !== "string") return undefined;
	if (candidate.model !== undefined && candidate.model !== null && typeof candidate.model !== "string") return undefined;
	return { behavior: behavior as EffectiveSpawnBehavior, model: candidate.model };
}

function effectiveSpawnBehavior(
	params: Pick<SubagentSpawnParamsType, "context" | "autoExit" | "worktree" | "cwd">,
	agentDef: AgentDefinition | null,
): EffectiveSpawnBehavior {
	return {
		context: params.context ?? agentDef?.context ?? "fresh",
		autoExit: params.autoExit ?? agentDef?.autoExit ?? true,
		useWorktree: params.worktree ?? (params.cwd ? false : (agentDef?.worktree ?? false)),
		harness: agentDef?.harness ?? "pi",
	};
}

function spawnCallPresentation(
	params: SubagentSpawnParamsType,
	cwd: string,
): SubagentSpawnParamsType & EffectiveSpawnBehavior & { effectiveModel: string | null; modelPending: boolean } {
	let agentDef: AgentDefinition | null = null;
	try {
		agentDef = loadAgentDefinition(params.agent ?? "worker", cwd);
	} catch {}
	const behavior = effectiveSpawnBehavior(params, agentDef);
	const requestedModel = params.model ?? agentDef?.models?.[0];
	const modelPending = behavior.harness === "pi" && requestedModel !== undefined;
	return {
		...params,
		...behavior,
		effectiveModel: modelPending ? null : (requestedModel ?? null),
		modelPending,
	};
}

const CALL_TEXT_METRICS = {
	visibleWidth,
	truncateToWidth,
	renderText: (text: string, width: number) => new Text(text, 0, 0).render(width),
};

export function registerSubagentSpawnTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "subagent_spawn",
		label: "Spawn Subagent",
		description:
			"Spawn a sub-agent in a tmux pane to work on a task. ASYNC — this returns " +
			"immediately with status 'started', or status 'queued' when " +
			`${config.maxConcurrentSubagents} sub-agents (the concurrency limit, shared ` +
			"with subagent_resume) are already running. Queued sub-agents start " +
			"automatically, in order, as running ones finish — never re-issue a queued " +
			"spawn. Either way the sub-agent's result is automatically " +
			"steered into this conversation when it finishes. NEVER poll for results: " +
			"do not sleep, do not read the child session file, do not check panes. " +
			"Just continue with other work or end your turn — you will be woken with " +
			"the result. Call this multiple times only when tasks " +
			"are independent, bounded, and able to proceed concurrently.",
		promptGuidelines: [
			"Use subagent_spawn with context 'fresh' by default for self-contained work; put all needed facts, constraints, and expected output in `task`. Use 'forked' only when the task materially depends on accumulated parent discussion, reads, or decisions that would be difficult or lossy to restate, and remember that the copied history goes to the child's selected model/provider. Use subagent_resume instead when a follow-up depends on the child's own prior context.",
			"Use subagent_spawn only for concrete, bounded tasks that can proceed independently. Keep trivial tasks, tightly coupled or sequential work, and critical-path blockers in the parent. Never give parallel sub-agents overlapping write scopes in the same checkout; use disjoint scopes or worktree isolation.",
		],
		parameters: SubagentSpawnParams,
		renderCall(args, theme, context) {
			const fallbackPresentation = spawnCallPresentation(args, context.cwd);
			const state = context.state as SpawnRenderState;
			const style = {
				title: (text: string) => theme.fg("toolTitle", theme.bold(text)),
				name: (text: string) => theme.fg("accent", text),
				agent: (text: string) => theme.fg("muted", text),
				hint: (text: string) => theme.fg("dim", text),
				preview: (text: string) => theme.fg("dim", text),
				metadata: (text: string) => theme.fg("muted", text),
				body: (text: string) => theme.fg("toolOutput", text),
			};
			const expandHint = keyHint("app.tools.expand", "to expand");
			return {
				invalidate(): void {},
				render(width: number): string[] {
					const fallbackHasSelectedModel = fallbackPresentation.modelPending
						|| fallbackPresentation.effectiveModel !== null;
					const presentation = state.presentationSettled || state.effectiveBehavior
						? {
							...fallbackPresentation,
							...args,
							...(state.effectiveBehavior ?? {}),
							effectiveModel: state.effectiveModel === undefined
								? fallbackPresentation.effectiveModel
								: state.effectiveModel,
							modelPending: !state.presentationSettled && fallbackPresentation.modelPending,
							modelUnknown: state.presentationSettled
								&& state.effectiveModel === undefined
								&& fallbackHasSelectedModel,
						}
						: fallbackPresentation;
					if (context.expanded) {
						return formatExpandedSubagentCall(presentation, width, CALL_TEXT_METRICS, style);
					}
					return formatCollapsedSubagentCall(
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
			const state = context.state as SpawnRenderState;
			state.presentationSettled = true;
			const presentation = context.isError ? undefined : parseSpawnPresentation(result.details);
			if (presentation) {
				state.effectiveBehavior = presentation.behavior;
				if (presentation.model !== undefined) state.effectiveModel = presentation.model;
			}
			return renderSubagentLaunchResult(result, context.isError, (text) =>
				new Text(theme.fg("error", text), 0, 0),
			);
		},
		async execute(_toolCallId, params: SubagentSpawnParamsType, _signal, _onUpdate, ctx) {
			const agentName = params.agent ?? "worker";
			assertValidAgentIdentifier(agentName);

			// Guards: we need tmux and a persistent parent session.
			if (!isTmuxAvailable()) {
				throw new Error(
					"Subagents need tmux 3.0a+ with pi running inside a session (e.g. `tmux new -A -s pi 'pi'`).",
				);
			}
			const parentSessionFile = ctx.sessionManager.getSessionFile();
			if (!parentSessionFile) {
				throw new Error("Subagents require a persistent session (the parent session has no session file).");
			}

			// Resolve agent defaults: explicit params beat frontmatter beats built-in defaults.
			// There is no "bare" spawn: a call without `agent` IS the "worker"
			// agent — same definition machinery, same file, same rules. If
			// worker.md is missing that's a loud error telling you to create
			// it, not a silently different kind of child.
			const agentDef = loadAgentDefinition(agentName, ctx.cwd);
			if (!agentDef) {
				throw new Error(
					params.agent
						? `Unknown agent "${agentName}" — no ${agentName}.md in ${projectDefsDir(ctx.cwd)} or ${agentDefsDir()}. Use subagent_available to see available agents.`
						: `No agent given, so this spawn defaults to "worker" — but ${join(agentDefsDir(), "worker.md")} does not exist. Create it (it defines the default sub-agent), or pass an agent explicitly.`,
				);
			}
			// Frontmatter problems (e.g. an unknown context or worktree value) fail the
			// spawn instead of silently running with a default the file didn't ask for.
			if (agentDef.problems.length > 0) {
				throw new Error(`Agent "${agentName}" (${agentDef.filePath}): ${agentDef.problems.join("; ")}`);
			}
			// Which tool runs the child. Frontmatter validation already flagged
			// unknown names as problems above, so this lookup can only fail on
			// an internal inconsistency - and then it fails loud.
			const behavior = effectiveSpawnBehavior(params, agentDef);
			const { harness, context, autoExit, useWorktree } = behavior;
			const profile = harness === "pi" ? undefined : requireHarnessProfile(harness);
			// The frontmatter combination is already a problem (checked above);
			// this catches an explicit context param against an external agent.
			if (profile && context === "forked") {
				throw new Error(
					`Agent "${agentName}" runs on harness "${harness}" - context "forked" is not supported for external tools (a pi conversation cannot be transplanted into a different tool).`,
				);
			}
			// An explicit param is just a one-entry candidate list — same
			// resolution path as the agent's `models:` list, so a bad override
			// fails fast with the same clear error. No candidates at all means
			// the child inherits pi's default model. External model names are
			// the tool's own: pi's registry never applies, the first candidate
			// is passed verbatim.
			const modelCandidates = params.model ? [params.model] : (agentDef.models ?? []);
			const model = profile
				? modelCandidates[0]
				: modelCandidates.length > 0
					? resolveUsableModel(modelCandidates, ctx.modelRegistry)
					: undefined;
			const presentation: SpawnBehaviorPresentation = {
				version: 1,
				behavior: { ...behavior },
				model: model ?? null,
			};
			// Thinking/effort level: param beats frontmatter. Passed to the
			// child as pi's standalone `--thinking` flag so it works with or
			// without a resolved model. Validated here so a typo fails the
			// tool call instead of erroring later inside the child's pane. For
			// external tools the profile's effort mapping IS the validity
			// check: Claude Code only warns on a bad --effort and silently
			// falls back, so relying on the tool to reject it would hide the
			// mistake.
			const thinking = params.thinking ?? agentDef.thinking;
			if (thinking) {
				if (profile) profile.mapEffort(thinking);
				else assertValidThinkingLevel(thinking);
			}
			const tools = params.tools ?? agentDef.tools;
			// Worktree isolation: param beats frontmatter, default off. An
			// explicit cwd contradicts "run in a fresh worktree" (the worktree
			// IS the child's cwd) — but only when BOTH were explicitly passed
			// is that a caller error. When the worktree flag merely comes from
			// the agent's frontmatter default, an explicit cwd param wins, the
			// same way params beat frontmatter for every other setting.
			if (params.worktree && params.cwd) {
				throw new Error(
					"The `worktree` and `cwd` parameters cannot be combined — the worktree becomes the sub-agent's working directory.",
				);
			}

			// Fork needs the parent's session file on disk. pi buffers a brand-new
			// session in memory until the first assistant reply, so a fork on the
			// very first turn can race this. Checked before worktree creation so
			// this pure validation failure never leaves a worktree behind.
			if (context === "forked" && !existsSync(parentSessionFile)) {
				throw new Error(
					"Cannot fork yet: the parent session file has not been written to disk. Try again after this reply, or use context 'fresh'.",
				);
			}

			const id = randomUUID().slice(0, 8);

			// Resolve a non-worktree cwd now — it is pure (worktree directories
			// are only created at launch time): relative paths resolve against
			// this session's cwd and a leading ~ expands.
			let cwd: string | undefined;
			if (!useWorktree) {
				const rawCwd = params.cwd ?? ctx.cwd;
				const tildeExpanded =
					rawCwd === "~" ? homedir() : rawCwd.startsWith("~/") ? join(homedir(), rawCwd.slice(2)) : rawCwd;
				cwd = resolve(ctx.cwd, tildeExpanded);
				if (!existsSync(cwd)) {
					throw new Error(`Subagent cwd does not exist: ${cwd}`);
				}
			}

			// Everything a launch needs, as pure data (see capacity.ts): the
			// launch may run right now, or later when a concurrency slot frees.
			const spec: SpawnSpec = {
				kind: "spawn",
				id,
				name: params.name,
				task: params.task,
				agentName,
				harness,
				agentBody: agentDef.body,
				harnessPassThrough: agentDef.harnessPassThrough,
				context,
				model,
				thinking,
				tools,
				autoExit,
				useWorktree,
				cwd,
				parentCwd: ctx.cwd,
				parentSessionFile,
				base: artifactBase(ctx),
				slug: slugify(params.name),
			};

			// The fork: claim a slot and launch now, or join the queue. No await
			// sits between admitLaunch and either outcome, so parallel spawn
			// calls cannot race past the limit (see capacity.ts).
			const admission = admitLaunch(spec);
			if (admission.status === "queued") {
				updateRunningWidget();
				const ahead = admission.ahead > 0 ? `, ${admission.ahead} ahead of it in the queue` : "";
				const forkNote =
					context === "forked"
						? " Its forked context will copy this conversation as of the moment it launches."
						: "";
				return {
					content: [
						{
							type: "text",
							text:
								`Sub-agent "${params.name}" queued (id ${id}, ${context} context): all ` +
								`${config.maxConcurrentSubagents} concurrency slots are busy${ahead}. ` +
								"It starts automatically when a slot frees, and its result arrives like " +
								`any other sub-agent's — do not poll, and do not re-issue this spawn.${forkNote}`,
						},
					],
					details: { id, status: "queued", ahead: admission.ahead, presentation },
				};
			}

			let launched: LaunchedSpawn;
			try {
				launched = await runSpawnLaunch(pi, spec);
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
						"Sub-agent launch was interrupted by a session reload/shutdown before it started — " +
							"nothing is running. Re-issue the call if the work is still needed.",
					);
				}
				throw error;
			}

			// Worktree spawns also tell the model WHERE the child works, so it
			// can inspect or merge later. Branch phrasing is skipped when the
			// worktree is on a detached HEAD (there is no branch to name).
			const worktree = launched.worktree;
			const where = worktree
				? ` in worktree ${worktree.dir}` + (worktree.branch === "HEAD" ? "" : ` on branch ${worktree.branch}`)
				: "";
			return {
				content: [
					{
						type: "text",
						text:
							`Sub-agent "${params.name}" started (id ${id}, ${context} context)${where}. ` +
							"Its result will arrive automatically — do not poll; continue with other work or end your turn.",
					},
				],
				details: {
					id,
					presentation,
					sessionFile: launched.childSessionFile,
					paneId: launched.paneId,
					launchScript: launched.scriptPath,
					worktreeDir: worktree?.dir,
					worktreeBranch: worktree?.branch,
				},
			};
		},
	});

	// The queue drain launches spawns through the same pipeline the inline
	// path uses. Registered here rather than at module load so the registry
	// always holds the closures of the module generation pi just activated.
	registerLauncher("spawn", (piApi, spec) => runSpawnLaunch(piApi, spec as SpawnSpec));
}

interface LaunchedSpawn {
	paneId: string;
	childSessionFile: string;
	scriptPath: string;
	worktree?: WorktreeInfo;
}

/**
 * The launch pipeline — every side effect of starting a child, in rollback
 * scopes. Runs inline (a slot was free at call time) or from the queue drain
 * (capacity.ts), which is why it takes a pure spec instead of tool params: by
 * the time a queued launch runs, the tool call that created it is long gone.
 * Contract with capacity.ts: the claim is released in the same synchronous
 * step that registers the child; on a throw every side effect is rolled back
 * and the CALLER releases the claim.
 */
async function runSpawnLaunch(pi: ExtensionAPI, spec: SpawnSpec): Promise<LaunchedSpawn> {
	const launchGeneration = moduleGeneration();
	const profile = spec.harness === "pi" ? undefined : requireHarnessProfile(spec.harness);

	// Resolve the working directory. Worktree mode asks the user-pluggable
	// create command for a fresh directory; a plain cwd was already validated
	// at call time but is re-checked — it can vanish while a launch queues.
	let cwd: string;
	let worktree: WorktreeInfo | undefined;
	if (spec.useWorktree) {
		worktree = await createWorktree({
			name: `${spec.slug}-${spec.id}`,
			parentCwd: spec.parentCwd,
			command: config.worktreeCreateCommand,
		});
		cwd = worktree.dir;
	} else {
		cwd = spec.cwd as string;
		if (!existsSync(cwd)) {
			throw new Error(`Sub-agent cwd no longer exists: ${cwd}`);
		}
	}

	// Everything below has side effects (files on disk, a tmux pane, a
	// watcher). If any of it throws after a worktree was created, roll
	// the worktree back — it is seconds old and provably clean, so
	// removing it cannot destroy work — then rethrow the real error.
	try {
		const childSessionFile = generateChildSessionFile(cwd);
		mkdirSync(dirname(childSessionFile), { recursive: true });
		// Fresh UUID paths make a leftover sidecar, activity, or result
		// file impossible today, but the poller and the liveness reader
		// trust these paths completely — keep them provably clean.
		clearExitSidecar(childSessionFile);
		clearActivityFile(childSessionFile);
		clearExternalResult(childSessionFile);

		// pi children pre-seed the child's session file so pi's session picker
		// shows a readable entry: the header's parentSession nests the child
		// under THIS session in threaded view, and the seeded display name
		// ("subagent › <agent> › <name>") replaces the raw @file task text.
		// Forked additionally copies the parent's conversation — as of LAUNCH
		// time, so a fork that waited in the queue forks the parent as of when
		// it actually starts — and records the seed's entry count so the
		// eventual summary can only come from turns the CHILD added.
		// External children get NO session file at all: the path is only the
		// anchor their sidecars sit next to, so it never appears in pi's
		// session picker, and the result is read from `<anchor>.result`.
		let skipEntries = 0;
		if (!profile) {
			const sessionLabel = `subagent › ${spec.agentName} › ${spec.name}`;
			if (spec.context === "forked") {
				seedForkSession({
					parentSessionFile: spec.parentSessionFile,
					childSessionFile,
					childCwd: cwd,
					name: sessionLabel,
				});
				skipEntries = countEntries(childSessionFile);
			} else {
				seedFreshSession({
					parentSessionFile: spec.parentSessionFile,
					childSessionFile,
					childCwd: cwd,
					name: sessionLabel,
				});
			}
		}

		// The child session file now exists on disk, so from here until the
		// pane is created, a failure (tmux gone, pane limits, disk errors)
		// must delete the seed again — otherwise every failed spawn leaves a
		// phantom named session in pi's picker. Pane creation starts the child
		// immediately, so once createPane succeeds the child owns the file and
		// deleting it would corrupt a live session — hence this exact try range.
		// (The outer catch then rolls back the worktree, if any.)
		const scriptPath = join(spec.base, "scripts", `${spec.slug}-${spec.id}.sh`);
		let paneId: string | undefined;
		try {
			// The task the child receives — always delivered as a file: multi-KB
			// tasks never touch the shell command line, tasks starting with "-" or
			// "@" can't be misparsed as CLI flags, and the exact text stays
			// inspectable under artifacts/. Forked children already carry the
			// conversation so they get the raw task; fresh children also get
			// instructions about how their run ends — from the profile for
			// external children, whose panes have no pi control tools.
			const fullTask =
				spec.context === "forked"
					? spec.task
					: `# Your task\n\n${spec.task}\n\n---\n` +
						(profile
							? profile.completionInstruction(spec.autoExit)
							: (spec.autoExit
									? "Complete your task autonomously. When you finish your final reply, this session closes automatically. "
									: "When your task is complete, write a final summary message and then call the subagent_done tool. If you are blocked, call caller_ping. ") +
								"Your final assistant message is reported back to the caller as your result.");
			const taskFile = join(spec.base, "tasks", `${spec.slug}-${spec.id}.md`);
			mkdirSync(dirname(taskFile), { recursive: true });
			writeFileSync(taskFile, fullTask, "utf8");

			// The agent's body becomes an appended system prompt. We pass a FILE
			// PATH — pi auto-reads existing paths for --append-system-prompt —
			// which sidesteps shell-escaping of multiline text entirely.
			let systemPromptFile: string | undefined;
			if (spec.agentBody !== "") {
				systemPromptFile = join(spec.base, "sysprompts", `${spec.slug}-${spec.id}.md`);
				mkdirSync(dirname(systemPromptFile), { recursive: true });
				writeFileSync(systemPromptFile, spec.agentBody, "utf8");
			}

			// Assemble the launch command: the external profile builds its
			// tool's command line (lifecycle notifiers baked in); pi children
			// go through launch.ts as before (see both for every piece).
			const command = profile
				? profile.buildLaunchCommand({
						cwd,
						anchor: childSessionFile,
						runId: spec.id,
						autoExit: spec.autoExit,
						model: spec.model,
						thinking: spec.thinking,
						tools: spec.tools,
						systemPromptFile,
						passThrough: spec.harnessPassThrough,
						taskFile,
					})
				: buildLaunchCommand({
						cwd,
						env: buildChildEnv({
							PI_SUBAGENT_SESSION: childSessionFile,
							PI_SUBAGENT_NAME: spec.name,
							// The liveness pair (see activity.ts): the run id stamps
							// snapshot ownership, the path tells the recorder where to
							// write.
							PI_SUBAGENT_ID: spec.id,
							PI_SUBAGENT_ACTIVITY_FILE: activityFilePath(childSessionFile),
							PI_SUBAGENT_AGENT: spec.agentName,
							PI_SUBAGENT_AUTO_EXIT: spec.autoExit ? "1" : undefined,
						}),
						sessionFile: childSessionFile,
						model: spec.model,
						thinking: spec.thinking,
						systemPromptFile,
						tools: spec.tools,
						passThrough: spec.harnessPassThrough,
						promptArg: shellQuote(`@${taskFile}`),
					});

			// Launch-metadata sidecar: records the child's identity settings so
			// subagent_resume can reapply them later (system prompt, tools,
			// model, thinking, auto-exit, worktree, harness). Without this, a
			// resumed agent silently loses its system prompt and restrictions —
			// they live on the command line, not in the conversation. The cwd is
			// recorded only for external children, which have no session header
			// to read it back from.
			writeLaunchMeta(childSessionFile, {
				name: spec.name,
				agent: spec.agentName,
				tools: spec.tools,
				model: spec.model,
				thinking: spec.thinking,
				systemPromptFile,
				autoExit: spec.autoExit,
				context: spec.context,
				worktree,
				harness: profile ? spec.harness : undefined,
				harnessPassThrough: spec.harnessPassThrough,
				cwd: profile ? cwd : undefined,
			});

			// Stage the debuggable script, then assert at the pane-creation
			// boundary. Nothing can currently interleave here; the guard is a
			// defensive assertion against a future await added upstream. After
			// createPane starts the child, it owns the session file and this
			// catch must not roll it back.
			stageLaunchScript(command, scriptPath);
			assertLaunchStillWanted(launchGeneration);
			paneId = createPane(spec.name, scriptPath);
		} catch (error) {
			rmSync(childSessionFile, { force: true });
			rmSync(`${childSessionFile}.meta`, { force: true });
			clearActivityFile(childSessionFile);
			clearExternalResult(childSessionFile);
			if (paneId !== undefined) closePane(paneId);
			throw error;
		}

		trackChild(pi, {
			id: spec.id,
			name: spec.name,
			agent: spec.agentName,
			harness: profile ? spec.harness : undefined,
			paneId,
			sessionFile: childSessionFile,
			startTime: Date.now(),
			skipEntries,
			tools: spec.tools,
			model: spec.model,
			autoExit: spec.autoExit,
			context: spec.context,
			worktree,
			abort: new AbortController(),
			// A spawn always delivers a task, so the starting watchdog is
			// always armed (see status.ts).
			expectsRun: true,
		});
		releaseClaim(spec.id);

		return { paneId, childSessionFile, scriptPath, worktree };
	} catch (error) {
		// Best-effort rollback; removeWorktree never throws, and the
		// original launch error is what the model needs to see — but a
		// rollback that ITSELF failed must not be silent, or the leaked
		// worktree (and branch) would linger with zero signal anywhere.
		// The warning is appended to the ORIGINAL error rather than thrown
		// as a new one: capacity.ts dispatches on the error's class
		// (RequeueLaunch/AbandonLaunch), and wrapping would silently turn a
		// requeue into a dropped entry.
		if (worktree) {
			const rollback = await removeWorktree(worktree, config.worktreeCleanupCommand);
			if (rollback.status === "cleanup-failed") {
				const warning =
					`\n\nAlso: rolling back the worktree failed (${rollback.error}) — ` +
					`remove ${worktree.dir} manually.`;
				if (error instanceof Error) {
					error.message += warning;
					throw error;
				}
				throw new Error(`${String(error)}${warning}`);
			}
		}
		throw error;
	}
}
