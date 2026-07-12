/**
 * tool-subagent.ts — the `subagent` tool: spawn a child pi session.
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
 * frontmatter beat built-in defaults), write the task and system prompt as
 * artifact files, build the launch command (launch.ts), open a pane
 * (tmux.ts), and hand the child to the watcher (watcher.ts). The tool
 * returns as soon as the child is RUNNING — the result arrives later as a
 * steered message.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { activityFilePath, clearActivityFile } from "./activity.ts";
import { agentDefsDir, loadAgentDefinition, projectDefsDir } from "./agents.ts";
import { config } from "./config.ts";
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
import { formatCollapsedSubagentCall, formatExpandedSubagentCall } from "./subagent-call.ts";
import { renderSubagentLaunchResult } from "./subagent-result.ts";
import { closePane, createPane, isTmuxAvailable, sendLongCommand, shellQuote, sleep } from "./tmux.ts";
import { trackChild } from "./watcher.ts";
import { createWorktree, removeWorktree, type WorktreeInfo } from "./worktree.ts";

const SubagentParams = Type.Object({
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
				"Agent definition to load defaults from (a <name>.md file in <cwd>/.pi/subagents/ or the global subagents dir; project shadows global — see subagents_list). Default: 'worker'",
		}),
	),
	context: Type.Optional(
		Type.Union([Type.Literal("fresh"), Type.Literal("forked")], {
			description:
				"'fresh' = no parent conversation (default; project files and instructions still load). Use for self-contained work and include all needed context in `task`. " +
				"'forked' = copies this conversation before the current turn. Use when the task materially depends on accumulated discussion, reads, or decisions that would be difficult or lossy to restate, or to try parallel approaches from the same starting point. " +
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
type SubagentParamsType = Static<typeof SubagentParams>;

const CALL_TEXT_METRICS = {
	truncateToWidth,
	renderText: (text: string, width: number) => new Text(text, 0, 0).render(width),
};

export function registerSubagentTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Spawn a sub-agent in a tmux pane to work on a task. ASYNC — this returns " +
			"immediately with status 'started'; the sub-agent's result is automatically " +
			"steered into this conversation when it finishes. NEVER poll for results: " +
			"do not sleep, do not read the child session file, do not check panes. " +
			"Just continue with other work or end your turn — you will be woken with " +
			"the result. Up to 9 new or resumed sub-agents may run concurrently. This is " +
			"a capacity ceiling, not a target. Call this multiple times only when tasks " +
			"are independent, bounded, and able to proceed concurrently.",
		promptGuidelines: [
			"Default to subagent context 'fresh' for self-contained work; put all needed facts, constraints, and expected output in `task`. Use 'forked' only when the task materially depends on accumulated parent discussion, reads, or decisions that would be difficult or lossy to restate, and remember that the copied history goes to the child's selected model/provider. Use subagent_resume instead when a follow-up depends on the child's own prior context.",
			"Use subagent only for concrete, bounded tasks that can proceed independently. Keep trivial tasks, tightly coupled or sequential work, and critical-path blockers in the parent. Never give parallel sub-agents overlapping write scopes in the same checkout; use disjoint scopes or worktree isolation.",
		],
		parameters: SubagentParams,
		renderCall(args, theme, context) {
			const style = {
				title: (text: string) => theme.fg("toolTitle", theme.bold(text)),
				agent: (text: string) => theme.fg("accent", text),
				name: (text: string) => theme.fg("toolOutput", text),
				preview: (text: string) => theme.fg("dim", text),
			};
			return {
				invalidate(): void {},
				render(width: number): string[] {
					if (context.expanded) {
						return formatExpandedSubagentCall(args, width, CALL_TEXT_METRICS, style);
					}
					return formatCollapsedSubagentCall(args, width, CALL_TEXT_METRICS, style);
				},
			};
		},
		renderResult(result, _options, theme, context) {
			return renderSubagentLaunchResult(result, context.isError, (text) =>
				new Text(theme.fg("error", text), 0, 0),
			);
		},
		async execute(_toolCallId, params: SubagentParamsType, _signal, _onUpdate, ctx) {
			// Guards: we need tmux and a persistent parent session.
			if (!isTmuxAvailable()) {
				throw new Error(
					"Subagents need tmux: start pi inside a tmux session (e.g. `tmux new -A -s pi 'pi'`).",
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
			const agentName = params.agent ?? "worker";
			const agentDef = loadAgentDefinition(agentName, ctx.cwd);
			if (!agentDef) {
				throw new Error(
					params.agent
						? `Unknown agent "${agentName}" — no ${agentName}.md in ${projectDefsDir(ctx.cwd)} or ${agentDefsDir()}. Use subagents_list to see available agents.`
						: `No agent given, so this spawn defaults to "worker" — but ${join(agentDefsDir(), "worker.md")} does not exist. Create it (it defines the default sub-agent), or pass an agent explicitly.`,
				);
			}
			// Frontmatter problems (e.g. an unknown context or worktree value) fail the
			// spawn instead of silently running with a default the file didn't ask for.
			if (agentDef.problems.length > 0) {
				throw new Error(`Agent "${agentName}" (${agentDef.filePath}): ${agentDef.problems.join("; ")}`);
			}
			const context = params.context ?? agentDef.context ?? "fresh";
			// An explicit param is just a one-entry candidate list — same
			// resolution path as the agent's `models:` list, so a bad override
			// fails fast with the same clear error. No candidates at all means
			// the child inherits pi's default model.
			const modelCandidates = params.model ? [params.model] : (agentDef.models ?? []);
			const model =
				modelCandidates.length > 0 ? resolveUsableModel(modelCandidates, ctx.modelRegistry) : undefined;
			// Thinking/effort level: param beats frontmatter. Passed to the
			// child as pi's standalone `--thinking` flag so it works with or
			// without a resolved model. Validated here so a typo fails the
			// tool call instead of erroring later inside the child's pane.
			const thinking = params.thinking ?? agentDef.thinking;
			if (thinking) assertValidThinkingLevel(thinking);
			const tools = params.tools ?? agentDef.tools;
			const autoExit = params.autoExit ?? agentDef.autoExit ?? true;
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
			const useWorktree = params.worktree ?? (params.cwd ? false : (agentDef.worktree ?? false));

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
			const base = artifactBase(ctx);
			const slug = slugify(params.name);

			// Resolve the working directory to an absolute path — it feeds the
			// launch script's `cd`, the session-dir naming, and the fork header.
			// Worktree mode asks the user-pluggable create command for a fresh
			// directory (this is deliberately the LAST step before side effects,
			// so every earlier failure needs no rollback). Otherwise, relative
			// paths resolve against this session's cwd and a leading ~ expands.
			let cwd: string;
			let worktree: WorktreeInfo | undefined;
			if (useWorktree) {
				worktree = await createWorktree({
					name: `${slug}-${id}`,
					parentCwd: ctx.cwd,
					command: config.worktreeCreateCommand,
				});
				cwd = worktree.dir;
			} else {
				const rawCwd = params.cwd ?? ctx.cwd;
				const tildeExpanded =
					rawCwd === "~" ? homedir() : rawCwd.startsWith("~/") ? join(homedir(), rawCwd.slice(2)) : rawCwd;
				cwd = resolve(ctx.cwd, tildeExpanded);
				if (!existsSync(cwd)) {
					throw new Error(`Subagent cwd does not exist: ${cwd}`);
				}
			}

			// Everything below has side effects (files on disk, a tmux pane, a
			// watcher). If any of it throws after a worktree was created, roll
			// the worktree back — it is seconds old and provably clean, so
			// removing it cannot destroy work — then rethrow the real error.
			try {
				const childSessionFile = generateChildSessionFile(cwd);
				mkdirSync(dirname(childSessionFile), { recursive: true });
				// Fresh UUID paths make a leftover sidecar or activity file
				// impossible today, but the poller and the liveness reader trust
				// this path completely — keep it provably clean.
				clearExitSidecar(childSessionFile);
				clearActivityFile(childSessionFile);

				// Both contexts pre-seed the child's session file so pi's session picker
				// shows a readable entry: the header's parentSession nests the child
				// under THIS session in threaded view, and the seeded display name
				// ("subagent › <agent> › <name>") replaces the raw @file task text.
				// Forked additionally copies the parent's conversation, and records the
				// seed's entry count so the eventual summary can only come from turns
				// the CHILD added — without this, a copied parent assistant message
				// could be reported as the child's "result".
				const sessionLabel = `subagent › ${agentName} › ${params.name}`;
				let skipEntries = 0;
				if (context === "forked") {
					seedForkSession({ parentSessionFile, childSessionFile, childCwd: cwd, name: sessionLabel });
					skipEntries = countEntries(childSessionFile);
				} else {
					seedFreshSession({ parentSessionFile, childSessionFile, childCwd: cwd, name: sessionLabel });
				}

				// The child session file now exists on disk, so from here until the
				// launch command is actually sent, a failure (tmux gone, pane limits,
				// disk errors) must delete the seed again — otherwise every failed
				// spawn leaves a phantom named session in pi's picker. Once
				// sendLongCommand succeeds the child owns the file, and deleting it
				// would corrupt a live session — hence this exact try range. (The
				// outer catch then rolls back the worktree, if any.)
				const scriptPath = join(base, "scripts", `${slug}-${id}.sh`);
				let paneId: string | undefined;
				try {
					// The task the child receives — always delivered as an @file: multi-KB
					// tasks never touch the shell command line, tasks starting with "-" or
					// "@" can't be misparsed as CLI flags, and the exact text stays
					// inspectable under artifacts/. Forked children already carry the
					// conversation so they get the raw task; fresh children also get
					// instructions about how their run ends.
					const fullTask =
						context === "forked"
							? params.task
							: `# Your task\n\n${params.task}\n\n---\n` +
								(autoExit
									? "Complete your task autonomously. When you finish your final reply, this session closes automatically. "
									: "When your task is complete, write a final summary message and then call the subagent_done tool. If you are blocked, call caller_ping. ") +
								"Your final assistant message is reported back to the caller as your result.";
					const taskFile = join(base, "tasks", `${slug}-${id}.md`);
					mkdirSync(dirname(taskFile), { recursive: true });
					writeFileSync(taskFile, fullTask, "utf8");

					// The agent's body becomes an appended system prompt. We pass a FILE
					// PATH — pi auto-reads existing paths for --append-system-prompt —
					// which sidesteps shell-escaping of multiline text entirely.
					let systemPromptFile: string | undefined;
					if (agentDef.body !== "") {
						systemPromptFile = join(base, "sysprompts", `${slug}-${id}.md`);
						mkdirSync(dirname(systemPromptFile), { recursive: true });
						writeFileSync(systemPromptFile, agentDef.body, "utf8");
					}

					// Assemble the launch command (see launch.ts for every piece).
					const command = buildLaunchCommand({
						cwd,
						env: buildChildEnv({
							PI_SUBAGENT_SESSION: childSessionFile,
							PI_SUBAGENT_NAME: params.name,
							// The liveness pair (see activity.ts): the run id stamps
							// snapshot ownership, the path tells the recorder where to
							// write.
							PI_SUBAGENT_ID: id,
							PI_SUBAGENT_ACTIVITY_FILE: activityFilePath(childSessionFile),
							PI_SUBAGENT_AGENT: agentName,
							PI_SUBAGENT_AUTO_EXIT: autoExit ? "1" : undefined,
						}),
						sessionFile: childSessionFile,
						model,
						thinking,
						systemPromptFile,
						tools,
						promptArg: shellQuote(`@${taskFile}`),
					});

					// Launch-metadata sidecar: records the child's identity settings so
					// subagent_resume can reapply them later (system prompt, tools,
					// model, thinking, auto-exit, worktree). Without this, a resumed
					// agent silently loses its system prompt and restrictions — they
					// live on the command line, not in the conversation.
					writeLaunchMeta(childSessionFile, { name: params.name, agent: agentName, tools, model, thinking, systemPromptFile, autoExit, context, worktree });

					// Create the pane, give its shell a moment, then run the launch
					// script (written to artifacts for debuggability).
					paneId = createPane(params.name);
					await sleep(config.shellReadyDelayMs);
					sendLongCommand(paneId, command, scriptPath);
				} catch (error) {
					rmSync(childSessionFile, { force: true });
					rmSync(`${childSessionFile}.meta`, { force: true });
					clearActivityFile(childSessionFile);
					if (paneId !== undefined) closePane(paneId);
					throw error;
				}

				trackChild(pi, {
					id,
					name: params.name,
					agent: agentName,
					paneId,
					sessionFile: childSessionFile,
					startTime: Date.now(),
					skipEntries,
					tools,
					model,
					autoExit,
					context,
					worktree,
					abort: new AbortController(),
					// A spawn always delivers a task, so the starting watchdog is
					// always armed (see status.ts).
					expectsRun: true,
				});

				// Worktree spawns also tell the model WHERE the child works, so it
				// can inspect or merge later. Branch phrasing is skipped when the
				// worktree is on a detached HEAD (there is no branch to name).
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
						sessionFile: childSessionFile,
						paneId,
						launchScript: scriptPath,
						worktreeDir: worktree?.dir,
						worktreeBranch: worktree?.branch,
					},
				};
			} catch (error) {
				// Best-effort rollback; removeWorktree never throws, and the
				// original launch error is what the model needs to see — but a
				// rollback that ITSELF failed must not be silent, or the leaked
				// worktree (and branch) would linger with zero signal anywhere.
				if (worktree) {
					const rollback = await removeWorktree(worktree, config.worktreeCleanupCommand);
					if (rollback.status === "cleanup-failed") {
						const message = error instanceof Error ? error.message : String(error);
						throw new Error(
							`${message}\n\nAlso: rolling back the worktree failed (${rollback.error}) — ` +
								`remove ${worktree.dir} manually.`,
						);
					}
				}
				throw error;
			}
		},
	});
}
