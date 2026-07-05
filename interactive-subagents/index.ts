/**
 * interactive-subagents — spawn sub-agents as real pi sessions in tmux panes.
 *
 * The parent model calls the `subagent` tool, which RETURNS IMMEDIATELY.
 * The child runs as a full `pi` process in its own tmux pane (watch it, or
 * take it over by typing). A background watcher polls for the child's exit
 * and steers the result back into the parent conversation, waking the model.
 *
 * The moving parts (see PLAN.md for the full design):
 *
 *   parent pane                      filesystem                child pane
 *   ───────────                      ──────────                ──────────
 *   subagent tool ──── writes ────▶  task file, launch script
 *                 ──── tmux ─────────────────────────────────▶ pi --session … -e implant.ts
 *   watcher (1s)  ◀─── reads ─────  <session>.jsonl.exit  ◀──  implant (done/ping/error)
 *                 ◀─── reads ─────  <session>.jsonl       ◀──  pi (the transcript)
 *   pi.sendMessage(steer) → parent model wakes with the result
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createPane,
	closePane,
	isTmuxAvailable,
	pollForExit,
	sendLongCommand,
	shellQuote,
	type ExitResult,
} from "./tmux.ts";
import { countEntries, extractSummary, readSessionCwd, seedForkSession } from "./session.ts";

// ── am I running inside a subagent? ──────────────────────────────────────
// This extension is installed globally, so it also loads inside every child
// we spawn. Children must NOT get the spawn tools (that would allow runaway
// recursive orchestration), so we detect child-mode via the env var the
// parent set and register nothing. Depth is hard-capped at 1.
const IS_SUBAGENT_CHILD = Boolean(process.env.PI_SUBAGENT_SESSION);

// ── paths ────────────────────────────────────────────────────────────────

/** Absolute path to this directory, so we can point `-e` at implant.ts. */
const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const IMPLANT_PATH = join(THIS_DIR, "implant.ts");

/** pi's config root: $PI_CODING_AGENT_DIR or ~/.pi/agent. */
function agentConfigDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/** Where agent definitions live. Global only, by design (see PLAN.md). */
function agentDefsDir(): string {
	return join(agentConfigDir(), "agents");
}

// ── agent definitions ────────────────────────────────────────────────────
// An agent definition is `<name>.md` in the global agents dir: a small
// frontmatter block plus a body that becomes the child's appended system
// prompt. The FILENAME is the agent name — there is no `name:` key.

interface AgentDefinition {
	name: string;
	description?: string;
	/** e.g. "anthropic/claude-haiku-4-5" — passed to `pi --model`. */
	model?: string;
	/** Thinking level, appended to the model as `model:thinking`. */
	thinking?: string;
	/** Comma-separated tool allowlist for `pi --tools`. */
	tools?: string;
	/** "fork" (inherit parent conversation) or "fresh" (clean context). */
	mode?: "fork" | "fresh";
	/** true = autonomous (exits when its turn completes). Default true. */
	autoExit?: boolean;
	/** Everything after the frontmatter: the agent's system-prompt text. */
	body: string;
}

/** Pull one `key: value` line out of a frontmatter block. */
function frontmatterValue(frontmatter: string, key: string): string | undefined {
	const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
	return match ? match[1].trim() : undefined;
}

function parseAgentMarkdown(name: string, markdown: string): AgentDefinition {
	// Normalize Windows line endings first — otherwise the fence regex below
	// silently fails to match and the whole frontmatter is treated as body.
	markdown = markdown.replace(/\r\n/g, "\n");
	// Frontmatter = the block between the leading `---` fences (optional).
	const match = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
	const frontmatter = match ? match[1] : "";
	const body = (match ? markdown.slice(match[0].length) : markdown).trim();

	const rawMode = frontmatterValue(frontmatter, "mode");
	const rawAutoExit = frontmatterValue(frontmatter, "auto-exit");

	return {
		name,
		description: frontmatterValue(frontmatter, "description"),
		model: frontmatterValue(frontmatter, "model"),
		thinking: frontmatterValue(frontmatter, "thinking"),
		tools: frontmatterValue(frontmatter, "tools"),
		mode: rawMode === "fork" || rawMode === "fresh" ? rawMode : undefined,
		autoExit: rawAutoExit === "true" ? true : rawAutoExit === "false" ? false : undefined,
		body,
	};
}

function loadAgentDefinition(name: string): AgentDefinition | null {
	const path = join(agentDefsDir(), `${name}.md`);
	if (!existsSync(path)) return null;
	return parseAgentMarkdown(name, readFileSync(path, "utf8"));
}

function listAgentDefinitions(): AgentDefinition[] {
	try {
		return readdirSync(agentDefsDir())
			.filter((file) => file.endsWith(".md"))
			.sort()
			.map((file) => parseAgentMarkdown(file.slice(0, -3), readFileSync(join(agentDefsDir(), file), "utf8")));
	} catch {
		return []; // directory doesn't exist yet
	}
}

// ── per-child bookkeeping ────────────────────────────────────────────────

interface RunningSubagent {
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
}

/** All children currently running, keyed by their 8-char run id. */
const running = new Map<string, RunningSubagent>();

/**
 * Every child this session has ever tracked (running or finished), so
 * subagent_resume can accept a short id instead of a long session path.
 * The path fallback still exists because this ledger is in-memory only —
 * it dies with the parent process, but the session file doesn't.
 */
const ledger = new Map<string, { sessionFile: string; name: string }>();

// ── /reload survival ─────────────────────────────────────────────────────
// pi's /reload re-imports this module, but timers and watcher loops from the
// PREVIOUS import keep running in their old closures. We park the widget
// timer and one AbortController on globalThis under stable Symbol keys; on
// re-import we tear down whatever the previous module left behind.

const TIMER_KEY = Symbol.for("interactive-subagents/widget-timer");
const ABORT_KEY = Symbol.for("interactive-subagents/abort-controller");

{
	const previousTimer = (globalThis as any)[TIMER_KEY];
	if (previousTimer) clearInterval(previousTimer);
	(globalThis as any)[TIMER_KEY] = null;

	const previousAbort = (globalThis as any)[ABORT_KEY] as AbortController | undefined;
	if (previousAbort) previousAbort.abort();
	(globalThis as any)[ABORT_KEY] = new AbortController();
}

/** Signal that fires when the session shuts down or the module is reloaded. */
function moduleSignal(): AbortSignal {
	return ((globalThis as any)[ABORT_KEY] as AbortController).signal;
}

// ── the widget (v1: dumb) ────────────────────────────────────────────────
// A few plain-text lines above the editor listing running children with
// elapsed time. No liveness states yet — that is v2, driven by activity
// snapshots and a state machine. This just proves the surface.

const WIDGET_KEY = "interactive-subagents";

/** The latest ExtensionContext, captured at session_start. Widget updates
 * happen from timers/watchers where no ctx is handed to us. */
let latestCtx: ExtensionContext | null = null;

function formatMMSS(totalSeconds: number): string {
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function updateWidget(): void {
	const ctx = latestCtx;
	if (!ctx || !ctx.hasUI) return;

	if (running.size === 0) {
		ctx.ui.setWidget(WIDGET_KEY, undefined as unknown as string[]);
		stopWidgetTimer();
		return;
	}

	const lines = [`── subagents · ${running.size} running ──`];
	for (const child of running.values()) {
		const elapsed = formatMMSS(Math.round((Date.now() - child.startTime) / 1000));
		const agentTag = child.agent ? ` (${child.agent})` : "";
		lines.push(`  ${elapsed}  ${child.name}${agentTag}  running…`);
	}
	ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
}

function ensureWidgetTimer(): void {
	if ((globalThis as any)[TIMER_KEY]) return;
	(globalThis as any)[TIMER_KEY] = setInterval(updateWidget, 1000);
}

function stopWidgetTimer(): void {
	const timer = (globalThis as any)[TIMER_KEY];
	if (timer) clearInterval(timer);
	(globalThis as any)[TIMER_KEY] = null;
}

// ── small helpers ────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Turn a display name into something safe for filenames. */
function slugify(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "subagent";
}

function humanElapsed(totalSeconds: number): string {
	if (totalSeconds < 60) return `${totalSeconds}s`;
	return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

/**
 * Fresh panes run the user's login shell, and slow shell init (direnv etc.)
 * can silently drop keystrokes typed before the prompt is ready. We wait a
 * little before typing the launch command. Tunable via env when 500ms is
 * not enough.
 */
function shellReadyDelayMs(): number {
	const parsed = Number.parseInt(process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS ?? "", 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

/** Artifacts for this extension live under the parent session's artifact dir. */
function artifactBase(ctx: ExtensionContext): string {
	return join(
		ctx.sessionManager.getSessionDir(),
		"artifacts",
		ctx.sessionManager.getSessionId(),
		"interactive-subagents",
	);
}

/**
 * Pre-generate the child's session file path BEFORE the child exists. The
 * parent choosing the path (rather than discovering it afterwards) is what
 * makes parallel spawns race-free: every watcher knows exactly which file
 * belongs to its child. The directory naming mimics pi's own convention
 * (`sessions/--<cwd with separators as dashes>--/`) so child sessions appear
 * in pi's session picker like any other session for that directory.
 */
function generateChildSessionFile(childCwd: string): string {
	const dirName = "--" + childCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	return join(agentConfigDir(), "sessions", dirName, `${timestamp}_${randomUUID()}.jsonl`);
}

/**
 * Build the `KEY='value'` env prefix for the child's launch command.
 * tmux panes run a fresh shell that inherits NOTHING from the parent pi
 * process, so every variable the child needs must ride on the command line.
 * All child env vars flow through here — v2 adds its liveness vars here too.
 */
function buildChildEnv(vars: Record<string, string | undefined>): string {
	const parts: string[] = [];
	// Propagate a custom config root so the child resolves the same models,
	// providers, and extensions as the parent.
	if (process.env.PI_CODING_AGENT_DIR) {
		parts.push(`PI_CODING_AGENT_DIR=${shellQuote(process.env.PI_CODING_AGENT_DIR)}`);
	}
	for (const [key, value] of Object.entries(vars)) {
		if (value !== undefined) parts.push(`${key}=${shellQuote(value)}`);
	}
	return parts.join(" ");
}

/**
 * pi's `--tools` allowlist filters EXTENSION tools too (since pi 0.70), so a
 * restricted child would lose the very tools it needs to signal completion.
 * Always union the implant's control tools into any allowlist.
 */
function withControlTools(tools: string): string {
	const names = new Set(
		tools.split(",").map((t) => t.trim()).filter((t) => t !== ""),
	);
	names.add("subagent_done");
	names.add("caller_ping");
	return [...names].join(",");
}

// ── tool parameter schemas ───────────────────────────────────────────────

const SubagentParams = Type.Object({
	name: Type.String({ description: "Short display name for this subagent (shown in the widget and pane title)" }),
	task: Type.String({ description: "The task prompt for the subagent" }),
	agent: Type.Optional(
		Type.String({ description: "Agent definition to load defaults from (a <name>.md file in the global agents dir — see subagents_list)" }),
	),
	mode: Type.Optional(
		Type.Union([Type.Literal("fork"), Type.Literal("fresh")], {
			description:
				"'fork' = child inherits this conversation's context (good for follow-up work, reuses the provider prompt cache). " +
				"'fresh' = clean context (default). Overrides the agent definition.",
		}),
	),
	model: Type.Optional(Type.String({ description: "Model override, e.g. 'anthropic/claude-haiku-4-5' (overrides the agent default)" })),
	tools: Type.Optional(Type.String({ description: "Comma-separated tool allowlist, e.g. 'read,bash' (overrides the agent default)" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the subagent (defaults to this session's cwd)" })),
	autoExit: Type.Optional(
		Type.Boolean({
			description:
				"true (default) = autonomous: the child exits when its turn completes. " +
				"false = interactive: the child stays open for a human until it calls subagent_done.",
		}),
	),
});
type SubagentParamsType = Static<typeof SubagentParams>;

const ResumeParams = Type.Object({
	id: Type.Optional(
		Type.String({ description: "The sub-agent's short id from a result/ping message (preferred). Use sessionPath instead if pi was restarted since." }),
	),
	sessionPath: Type.Optional(
		Type.String({ description: "Path to the child session .jsonl file — fallback when the id is no longer known (e.g. after a pi restart)" }),
	),
	message: Type.Optional(Type.String({ description: "Follow-up prompt or answer to send to the resumed subagent" })),
	name: Type.Optional(Type.String({ description: "Display name for the resumed subagent (default: 'Resumed')" })),
	autoExit: Type.Optional(Type.Boolean({ description: "true (default) = exit after finishing the follow-up; false = stay open for a human" })),
	tools: Type.Optional(Type.String({ description: "Override the tool allowlist (default: the child's original tools, restored from its launch metadata)" })),
	model: Type.Optional(Type.String({ description: "Override the model (default: the child's original model, restored from its launch metadata)" })),
});
type ResumeParamsType = Static<typeof ResumeParams>;

// ── the extension ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Track the live context for widget updates, and clean everything up when
	// the session ends or is replaced (/new, /resume, quit, reload).
	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
	});

	pi.on("session_shutdown", () => {
		stopWidgetTimer();
		((globalThis as any)[ABORT_KEY] as AbortController).abort(); // stop all watchers
		(globalThis as any)[ABORT_KEY] = new AbortController();
		running.clear();
	});

	// Inside a child: register nothing. The implant (loaded via -e) provides
	// the child-side tools; withholding the spawn tools here is what enforces
	// the no-recursion rule.
	if (IS_SUBAGENT_CHILD) return;

	// ── the watcher: one detached promise per child ────────────────────────
	// The subagent tool has already returned by the time this runs, so this
	// promise is the child's only supervisor. It must never reject silently —
	// every path ends in either a steered message or a deliberate no-op.
	async function watchSubagent(child: RunningSubagent): Promise<void> {
		let result: ExitResult;
		try {
			result = await pollForExit({
				paneId: child.paneId,
				sessionFile: child.sessionFile,
				signal: moduleSignal(),
				// v2 seam: liveness snapshot observation attaches here.
			});
		} catch (error) {
			result = {
				reason: "error",
				exitCode: 1,
				errorMessage: `Watcher failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}

		running.delete(child.id);
		updateWidget();
		closePane(child.paneId);

		// Session is shutting down — nobody left to tell.
		if (result.reason === "aborted") return;

		const elapsed = humanElapsed(Math.round((Date.now() - child.startTime) / 1000));

		// A ping is a help request, not a completion: hand the parent model
		// the question plus everything it needs to resume the child. The
		// message TEXT carries the session path and restrictions because
		// custom-message `details` are never shown to the model — the prose
		// is the protocol.
		if (result.reason === "ping") {
			pi.sendMessage(
				{
					customType: "subagent_ping",
					content:
						`Sub-agent "${result.pingName ?? child.name}" (id ${child.id}) needs help: ${result.pingMessage}\n\n` +
						`Answer with subagent_resume({ id: "${child.id}", message: "<your answer>" }). ` +
						"Its original system prompt, tools, and model are reapplied automatically.\n" +
						`Session: ${child.sessionFile} (pass as sessionPath instead of id if the id is no longer known)`,
					display: true,
					details: { id: child.id, name: child.name, sessionFile: child.sessionFile },
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
			return;
		}

		// Completion or failure: the summary is the child's last assistant
		// message, read from its session file (only entries after a resume
		// point, if any).
		const summary = extractSummary(child.sessionFile, child.skipEntries);
		const failed = result.exitCode !== 0 || result.reason === "error" || result.reason === "pane-closed";

		let content: string;
		if (!failed) {
			content =
				`Sub-agent "${child.name}" (id ${child.id}) completed (${elapsed}).\n\n` +
				`${summary ?? "(the subagent produced no final message)"}\n\n` +
				`For follow-up work: subagent_resume({ id: "${child.id}", message: "..." }). Session: ${child.sessionFile}`;
		} else {
			const reasonText =
				result.reason === "error"
					? `provider/agent error: ${result.errorMessage}`
					: result.reason === "pane-closed"
						? result.errorMessage
						: `exit code ${result.exitCode}`;
			content =
				`Sub-agent "${child.name}" (id ${child.id}) failed after ${elapsed} (${reasonText}).\n\n` +
				(summary ? `Last output:\n${summary}\n\n` : "") +
				`You can retry with subagent_resume({ id: "${child.id}", message: "<guidance>" }). Session: ${child.sessionFile}`;
		}

		pi.sendMessage(
			{
				customType: "subagent_result",
				content,
				display: true,
				details: {
					id: child.id,
					name: child.name,
					agent: child.agent,
					exitCode: result.exitCode,
					reason: result.reason,
					sessionFile: child.sessionFile,
					tools: child.tools,
					model: child.model,
				},
			},
			{ triggerTurn: true, deliverAs: "steer" },
		);
	}

	/** Register a child and start its supervision machinery. */
	function trackChild(child: RunningSubagent): void {
		running.set(child.id, child);
		ledger.set(child.id, { sessionFile: child.sessionFile, name: child.name });
		ensureWidgetTimer();
		updateWidget();
		void watchSubagent(child);
	}

	// ── tool: subagent ─────────────────────────────────────────────────────
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Spawn a sub-agent in a tmux pane to work on a task. ASYNC — this returns " +
			"immediately with status 'started'; the sub-agent's result is automatically " +
			"steered into this conversation when it finishes. NEVER poll for results: " +
			"do not sleep, do not read the child session file, do not check panes. " +
			"Just continue with other work or end your turn — you will be woken with " +
			"the result. Call this multiple times to run sub-agents in parallel.",
		parameters: SubagentParams,
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
			let agentDef: AgentDefinition | null = null;
			if (params.agent) {
				agentDef = loadAgentDefinition(params.agent);
				if (!agentDef) {
					throw new Error(
						`Unknown agent "${params.agent}" — no ${params.agent}.md in ${agentDefsDir()}. Use subagents_list to see available agents.`,
					);
				}
			}
			const mode = params.mode ?? agentDef?.mode ?? "fresh";
			const model = params.model ?? agentDef?.model;
			const tools = params.tools ?? agentDef?.tools;
			const autoExit = params.autoExit ?? agentDef?.autoExit ?? true;

			// Resolve the working directory to an absolute path up front — it
			// feeds the launch script's `cd`, the session-dir naming, and the
			// fork header, all of which need a real absolute path. Relative
			// paths resolve against this session's cwd; a leading ~ expands.
			const rawCwd = params.cwd ?? ctx.cwd;
			const tildeExpanded =
				rawCwd === "~" ? homedir() : rawCwd.startsWith("~/") ? join(homedir(), rawCwd.slice(2)) : rawCwd;
			const cwd = resolve(ctx.cwd, tildeExpanded);
			if (!existsSync(cwd)) {
				throw new Error(`Subagent cwd does not exist: ${cwd}`);
			}

			// Fork needs the parent's session file on disk. pi buffers a brand-new
			// session in memory until the first assistant reply, so a fork on the
			// very first turn can race this.
			if (mode === "fork" && !existsSync(parentSessionFile)) {
				throw new Error(
					"Cannot fork yet: the parent session file has not been written to disk. Try again after this reply, or use mode 'fresh'.",
				);
			}

			const id = randomUUID().slice(0, 8);
			const base = artifactBase(ctx);
			const slug = slugify(params.name);
			const childSessionFile = generateChildSessionFile(cwd);
			mkdirSync(dirname(childSessionFile), { recursive: true });
			// Fresh UUID paths make a leftover sidecar impossible today, but the
			// poller trusts this path completely — keep it provably clean.
			rmSync(`${childSessionFile}.exit`, { force: true });

			// Fork mode: write the child's session file ourselves, seeded with the
			// parent's conversation. Fresh mode: seed nothing — pi creates it.
			// The seed's entry count is recorded so the eventual summary can only
			// come from turns the CHILD added — without this, a copied parent
			// assistant message could be reported as the child's "result".
			let skipEntries = 0;
			if (mode === "fork") {
				seedForkSession({ parentSessionFile, childSessionFile, childCwd: cwd });
				skipEntries = countEntries(childSessionFile);
			}

			// The task the child receives — always delivered as an @file: multi-KB
			// tasks never touch the shell command line, tasks starting with "-" or
			// "@" can't be misparsed as CLI flags, and the exact text stays
			// inspectable under artifacts/. Fork children already carry the
			// conversation so they get the raw task; fresh children also get
			// instructions about how their run ends.
			const fullTask =
				mode === "fork"
					? params.task
					: `# Your task\n\n${params.task}\n\n---\n` +
						(autoExit
							? "Complete your task autonomously. When you finish your final reply, this session closes automatically. "
							: "When your task is complete, write a final summary message and then call the subagent_done tool. If you are blocked, call caller_ping. ") +
						"Your final assistant message is reported back to the caller as your result.";
			const taskFile = join(base, "tasks", `${slug}-${id}.md`);
			mkdirSync(dirname(taskFile), { recursive: true });
			writeFileSync(taskFile, fullTask, "utf8");
			const taskArg = shellQuote(`@${taskFile}`);

			// The agent's body becomes an appended system prompt. We pass a FILE
			// PATH — pi auto-reads existing paths for --append-system-prompt —
			// which sidesteps shell-escaping of multiline text entirely.
			let systemPromptFile: string | undefined;
			if (agentDef && agentDef.body !== "") {
				systemPromptFile = join(base, "sysprompts", `${slug}-${id}.md`);
				mkdirSync(dirname(systemPromptFile), { recursive: true });
				writeFileSync(systemPromptFile, agentDef.body, "utf8");
			}

			// Assemble the launch command.
			const env = buildChildEnv({
				PI_SUBAGENT_SESSION: childSessionFile,
				PI_SUBAGENT_NAME: params.name,
				PI_SUBAGENT_AUTO_EXIT: autoExit ? "1" : undefined,
			});
			const modelArg = model ? `--model ${shellQuote(agentDef?.thinking && !params.model ? `${model}:${agentDef.thinking}` : model)}` : "";
			const toolsArg = tools ? `--tools ${shellQuote(withControlTools(tools))}` : "";
			const command =
				[
					`cd ${shellQuote(cwd)} &&`,
					env,
					`pi --session ${shellQuote(childSessionFile)}`,
					`-e ${shellQuote(IMPLANT_PATH)}`,
					modelArg,
					systemPromptFile ? `--append-system-prompt ${shellQuote(systemPromptFile)}` : "",
					toolsArg,
					taskArg,
				]
					.filter((part) => part !== "")
					.join(" ") +
				// Quote-split on purpose: the typed command shows `'$?'` unexpanded,
				// so the poller's digits-only regex can only match the real echo
				// that appears AFTER pi exits — never the command line itself.
				` ; echo '__SUBAGENT_DONE_'$?'__'`;

			// Launch-metadata sidecar: records the child's identity settings so
			// subagent_resume can reapply them later (system prompt, tools,
			// model, auto-exit). Without this, a resumed agent silently loses
			// its system prompt and restrictions — they live on the command
			// line, not in the conversation.
			writeFileSync(
				`${childSessionFile}.meta`,
				JSON.stringify({ name: params.name, agent: params.agent, tools, model, systemPromptFile, autoExit }),
				"utf8",
			);

			// Create the pane, give its shell a moment, then run the launch
			// script (written to artifacts for debuggability).
			const paneId = createPane(params.name);
			await sleep(shellReadyDelayMs());
			const scriptPath = join(base, "scripts", `${slug}-${id}.sh`);
			sendLongCommand(paneId, command, scriptPath);

			trackChild({
				id,
				name: params.name,
				agent: params.agent,
				paneId,
				sessionFile: childSessionFile,
				startTime: Date.now(),
				skipEntries,
				tools,
				model,
				autoExit,
			});

			return {
				content: [
					{
						type: "text",
						text:
							`Sub-agent "${params.name}" started (id ${id}, ${mode} mode). ` +
							"Its result will arrive automatically — do not poll; continue with other work or end your turn.",
					},
				],
				details: { id, sessionFile: childSessionFile, paneId, launchScript: scriptPath },
			};
		},
	});

	// ── tool: subagents_list ───────────────────────────────────────────────
	pi.registerTool({
		name: "subagents_list",
		label: "List Subagent Definitions",
		description: "List the available agent definitions (global <name>.md files) usable as the `agent` parameter of the subagent tool.",
		parameters: Type.Object({}),
		async execute() {
			const defs = listAgentDefinitions();
			if (defs.length === 0) {
				return {
					content: [
						{
							type: "text",
							text:
								`No agent definitions found in ${agentDefsDir()}. ` +
								"Create <name>.md files there with optional frontmatter (description, model, thinking, tools, mode, auto-exit) and a system-prompt body. The subagent tool also works without an agent definition.",
						},
					],
					details: {},
				};
			}
			const lines = defs.map((def) => {
				const model = def.model ? ` [${def.model}]` : "";
				const interactive = def.autoExit === false ? " (interactive)" : "";
				return `• ${def.name}${model}${interactive} — ${def.description ?? "(no description)"}`;
			});
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { count: defs.length },
			};
		},
	});

	// ── tool: subagent_resume ──────────────────────────────────────────────
	// Reopens an existing child session file in a new pane — used to answer a
	// caller_ping, retry a failure, or send follow-up work. Context survives
	// because the .jsonl file IS the conversation.
	pi.registerTool({
		name: "subagent_resume",
		label: "Resume Subagent",
		description:
			"Resume a previous sub-agent session with an optional follow-up message. Pass the `id` from a " +
			"result/ping message (preferred), or `sessionPath` if the id is no longer known (e.g. after a restart). " +
			"ASYNC — returns immediately; the result steers back automatically. Do not poll.",
		parameters: ResumeParams,
		async execute(_toolCallId, params: ResumeParamsType, _signal, _onUpdate, ctx) {
			if (!isTmuxAvailable()) {
				throw new Error("Subagents need tmux: start pi inside a tmux session.");
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
			if (!existsSync(sessionPath)) {
				throw new Error(`No session file at ${sessionPath}`);
			}

			// A leftover .exit sidecar from a previous run of this session would
			// be consumed by the poller's first tick and instantly fake a
			// completion (killing the fresh child). Clear it before launching.
			rmSync(`${sessionPath}.exit`, { force: true });

			// Refuse to attach a second pi process to a session that is still
			// running — two processes appending to one .jsonl corrupts it.
			// Checked synchronously (before any await) so parallel resume calls
			// cannot race past each other.
			const targetPath = resolve(sessionPath);
			for (const child of running.values()) {
				if (resolve(child.sessionFile) === targetPath) {
					throw new Error(
						`Sub-agent "${child.name}" (id ${child.id}) is still running on this session — wait for its result or ping before resuming.`,
					);
				}
			}

			// Reapply the child's original launch settings from the `.meta`
			// sidecar written at launch. Explicit params always win; a missing
			// meta file (e.g. a session not created by this extension) just
			// means no defaults.
			let meta: {
				name?: string;
				tools?: string;
				model?: string;
				systemPromptFile?: string;
				autoExit?: boolean;
			} = {};
			try {
				meta = JSON.parse(readFileSync(`${sessionPath}.meta`, "utf8"));
			} catch {
				// no metadata — resume with plain defaults
			}

			const name = params.name ?? meta.name ?? "Resumed";
			const autoExit = params.autoExit ?? meta.autoExit ?? true;
			const tools = params.tools ?? meta.tools;
			const model = params.model ?? meta.model;

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
			const base = artifactBase(ctx);
			const slug = slugify(name);

			// Only entries added AFTER this point count toward the new summary.
			const skipEntries = countEntries(sessionPath);

			// The follow-up message rides in as an @file, like task delivery.
			let messageArg = "";
			if (params.message) {
				const messageFile = join(base, "resume", `${slug}-${id}.md`);
				mkdirSync(dirname(messageFile), { recursive: true });
				writeFileSync(messageFile, params.message, "utf8");
				messageArg = shellQuote(`@${messageFile}`);
			}

			// Run in the directory the original child used (recorded in its
			// session header) so relative paths and tools behave the same.
			const sessionCwd = readSessionCwd(sessionPath);

			const env = buildChildEnv({
				PI_SUBAGENT_SESSION: sessionPath,
				PI_SUBAGENT_NAME: name,
				PI_SUBAGENT_AUTO_EXIT: autoExit ? "1" : undefined,
			});
			const command =
				[
					sessionCwd ? `cd ${shellQuote(sessionCwd)} &&` : "",
					env,
					`pi --session ${shellQuote(sessionPath)}`,
					`-e ${shellQuote(IMPLANT_PATH)}`,
					model ? `--model ${shellQuote(model)}` : "",
					systemPromptFile ? `--append-system-prompt ${shellQuote(systemPromptFile)}` : "",
					tools ? `--tools ${shellQuote(withControlTools(tools))}` : "",
					messageArg,
				]
					.filter((part) => part !== "")
					.join(" ") + ` ; echo '__SUBAGENT_DONE_'$?'__'`;

			const paneId = createPane(name);
			await sleep(shellReadyDelayMs());
			const scriptPath = join(base, "scripts", `${slug}-${id}-resume.sh`);
			sendLongCommand(paneId, command, scriptPath);

			trackChild({
				id,
				name,
				paneId,
				sessionFile: sessionPath,
				startTime: Date.now(),
				skipEntries,
				tools,
				model,
				autoExit,
			});

			return {
				content: [
					{
						type: "text",
						text: `Resumed sub-agent "${name}" (id ${id}). Its result will arrive automatically — do not poll.`,
					},
				],
				details: { id, sessionFile: sessionPath, paneId },
			};
		},
	});
}
