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
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
	createPane,
	closePane,
	focusPane,
	isTmuxAvailable,
	pollForExit,
	refreshLayout,
	sendLongCommand,
	shellQuote,
	type ExitResult,
} from "./tmux.ts";
import { countEntries, extractSummary, readSessionCwd, seedForkSession } from "./session.ts";
import { assertValidThinkingLevel, resolveUsableModel } from "./models.ts";
import { agentConfigDir, config } from "./config.ts";
import { formatElapsed, formatRunningWidgetLines } from "./widget.ts";

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

/** The global agent-definitions dir. */
function agentDefsDir(): string {
	return join(agentConfigDir(), "subagents");
}

/** The project-local agent-definitions dir for a working directory. */
function projectDefsDir(cwd: string): string {
	return join(cwd, ".pi", "subagents");
}

// ── agent definitions ────────────────────────────────────────────────────
// An agent definition is `<name>.md` in the global agents dir: a small
// frontmatter block plus a body that becomes the child's appended system
// prompt. The FILENAME is the agent name — there is no `name:` key.

interface AgentDefinition {
	name: string;
	/** Which layer this definition came from (project shadows global). */
	source: "project" | "global";
	/** The definition file itself. */
	filePath: string;
	description?: string;
	/**
	 * Ordered model candidates, each fully qualified as "provider/model"
	 * (e.g. "openai-codex/gpt-5.5"). At spawn time the FIRST entry that is
	 * both known to pi and whose provider has credentials on this machine
	 * wins — that's what makes one agent file portable across computers
	 * with different provider setups.
	 */
	models?: string[];
	/** Thinking/effort level, passed to the child via `pi --thinking` (works
	 * with or without a models list). */
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

function parseAgentMarkdown(
	name: string,
	markdown: string,
	source: "project" | "global",
	filePath: string,
): AgentDefinition {
	// Normalize Windows line endings first — otherwise the fence regex below
	// silently fails to match and the whole frontmatter is treated as body.
	markdown = markdown.replace(/\r\n/g, "\n");
	// Frontmatter = the block between the leading `---` fences (optional).
	const match = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
	const frontmatter = match ? match[1] : "";
	const body = (match ? markdown.slice(match[0].length) : markdown).trim();

	const rawMode = frontmatterValue(frontmatter, "mode");
	const rawAutoExit = frontmatterValue(frontmatter, "auto-exit");
	const rawModels = frontmatterValue(frontmatter, "models");

	return {
		name,
		source,
		filePath,
		description: frontmatterValue(frontmatter, "description"),
		models: rawModels
			? rawModels.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "")
			: undefined,
		thinking: frontmatterValue(frontmatter, "thinking"),
		tools: frontmatterValue(frontmatter, "tools"),
		mode: rawMode === "fork" || rawMode === "fresh" ? rawMode : undefined,
		autoExit: rawAutoExit === "true" ? true : rawAutoExit === "false" ? false : undefined,
		body,
	};
}

function loadAgentDefinition(name: string, cwd: string): AgentDefinition | null {
	// Project first, then global — most specific wins, so a repo can
	// specialize scout/worker for its own conventions.
	const projectPath = join(projectDefsDir(cwd), `${name}.md`);
	if (existsSync(projectPath)) {
		return parseAgentMarkdown(name, readFileSync(projectPath, "utf8"), "project", projectPath);
	}
	const globalPath = join(agentDefsDir(), `${name}.md`);
	if (!existsSync(globalPath)) return null;
	return parseAgentMarkdown(name, readFileSync(globalPath, "utf8"), "global", globalPath);
}

/** All *.md names in a dir (missing dir = empty). */
function agentNamesIn(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter((file) => file.endsWith(".md"))
			.map((file) => file.slice(0, -3));
	} catch {
		return [];
	}
}

function listAgentDefinitions(cwd: string): AgentDefinition[] {
	// Union of global + project names; loadAgentDefinition applies the same
	// shadowing rule, so both views can never disagree.
	const names = new Set(agentNamesIn(agentDefsDir()));
	for (const name of agentNamesIn(projectDefsDir(cwd))) names.add(name);
	return [...names]
		.sort()
		.map((name) => loadAgentDefinition(name, cwd))
		.filter((def): def is AgentDefinition => def !== null);
}

// ── the agent inventory: one loader, many presenters ─────────────────────
// Everything a consumer could want to know about each agent, loaded once:
// identity, source file, what would actually run on THIS machine, and any
// problems that would break a spawn. The model-facing subagents_list tool
// and the human-facing /subagents-available command are both views over this —
// they differ only in how much of it they show.

interface AgentInfo {
	name: string;
	/** Which layer it came from — "project" (.pi/subagents) or "global". */
	source: "project" | "global";
	description?: string;
	/** The definition file this agent came from. */
	filePath: string;
	/** The model that wins on this machine (canonical provider/model), if the agent lists any. */
	resolvedModel?: string;
	thinking?: string;
	tools?: string;
	mode: "fork" | "fresh";
	autoExit: boolean;
	/** Anything that would break or degrade spawning this agent. Empty = valid. */
	problems: string[];
}

function collectAgentInventory(registry: ExtensionContext["modelRegistry"], cwd: string): AgentInfo[] {
	return listAgentDefinitions(cwd).map((def) => {
		const problems: string[] = [];
		let resolvedModel: string | undefined;

		if (def.models && def.models.length > 0) {
			try {
				resolvedModel = resolveUsableModel(def.models, registry);
			} catch {
				problems.push("no usable model on this machine");
			}
		}
		if (def.thinking) {
			try {
				assertValidThinkingLevel(def.thinking);
			} catch (error) {
				problems.push(error instanceof Error ? error.message : String(error));
			}
		}

		return {
			name: def.name,
			source: def.source,
			description: def.description,
			filePath: def.filePath,
			resolvedModel,
			thinking: def.thinking,
			tools: def.tools,
			mode: def.mode ?? "fresh",
			autoExit: def.autoExit ?? true,
			problems,
		};
	});
}

/** The human-facing rendering of the inventory (used by /subagents-available). */
function formatAgentOverviewLines(inventory: AgentInfo[], dir: string): string[] {
	if (inventory.length === 0) {
		return [
			`Sub-agents · none found in ${dir}`,
			"  Create <name>.md files there (frontmatter: description, models, thinking, tools, mode, auto-exit; body = system prompt).",
		];
	}
	const lines: string[] = [`Sub-agents · ${inventory.length}`];
	for (const agent of inventory) {
		const thinking = agent.thinking ? ` · thinking ${agent.thinking}` : "";
		lines.push("");
		const isDefault = agent.name === "worker" ? " (default)" : "";
		lines.push(`  ${agent.name}${isDefault} — ${agent.resolvedModel ?? "default model"}${thinking}`);
		for (const problem of agent.problems) {
			lines.push(`    ⚠ ${problem}`);
		}
		if (agent.description) lines.push(`    ${agent.description}`);
		lines.push(`    tools: ${agent.tools ?? "(all)"} · ${agent.mode} · ${agent.autoExit ? "auto-exit" : "interactive"}`);
		lines.push(`    ${agent.filePath}`);
	}
	lines.push("");
	lines.push("  (run /subagents-available again or send a message to dismiss)");
	return lines;
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
	/** Cancels this child's watcher (used by the picker's x = stop). */
	abort: AbortController;
	/** True when a human stopped it via the picker — the model gets told. */
	stoppedByUser?: boolean;
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

function updateWidget(): void {
	const ctx = latestCtx;
	if (!ctx || !ctx.hasUI) return;

	if (running.size === 0) {
		ctx.ui.setWidget(WIDGET_KEY, undefined as unknown as string[]);
		stopWidgetTimer();
		return;
	}

	// Snapshot the rows now; the component form gets the real terminal width
	// at render time, which is what lets the elapsed clock right-anchor.
	const rows = [...running.values()].map((child) => ({
		name: child.name,
		agent: child.agent,
		elapsedSeconds: Math.round((Date.now() - child.startTime) / 1000),
	}));
	ctx.ui.setWidget(
		WIDGET_KEY,
		(_tui, theme) => ({
			invalidate(): void {},
			render(width: number): string[] {
				return formatRunningWidgetLines(rows, width, {
					dim: (text) => theme.fg("dim", text),
					border: (text) => theme.fg("borderMuted", text),
				});
			},
		}),
		{ placement: "aboveEditor" },
	);
}

function ensureWidgetTimer(): void {
	if ((globalThis as any)[TIMER_KEY]) return;
	(globalThis as any)[TIMER_KEY] = setInterval(updateWidget, 1000);
}

// ── the /subagents-available overview widget ────────────────────────────
// The human-facing agent overview is shown as a WIDGET, not a message or
// session entry: it lives only on screen, so it never enters the model's
// context and costs zero tokens. (pi 0.80.x has no renderer for display-only
// session entries yet; when registerEntryRenderer ships, this could become a
// persistent transcript entry instead.)

const OVERVIEW_WIDGET_KEY = "interactive-subagents-overview";

/** When the overview was shown; null = hidden. */
let overviewShownAt: number | null = null;

function hideOverview(): void {
	overviewShownAt = null;
	if (latestCtx?.hasUI) {
		latestCtx.ui.setWidget(OVERVIEW_WIDGET_KEY, undefined as unknown as string[]);
	}
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
	name: Type.String({
		description:
			"Short display name describing the TASK, e.g. 'Auth flow' — shown in the widget next to the agent type, so do not repeat the agent type in it.",
	}),
	task: Type.String({ description: "The task prompt for the subagent" }),
	agent: Type.Optional(
		Type.String({ description: "Agent definition to load defaults from (a <name>.md file in the global agents dir — see subagents_list). Default: 'worker'" }),
	),
	mode: Type.Optional(
		Type.Union([Type.Literal("fork"), Type.Literal("fresh")], {
			description:
				"'fork' = child inherits this conversation's context (good for follow-up work, reuses the provider prompt cache). " +
				"'fresh' = clean context (default). Overrides the agent definition.",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"Model override, fully qualified as 'provider/model' (e.g. 'openai-codex/gpt-5.5'). " +
				"Must be known to pi with credentials configured, or the call errors. Overrides the agent's models list.",
		}),
	),
	tools: Type.Optional(Type.String({ description: "Comma-separated tool allowlist, e.g. 'read,bash' (overrides the agent default)" })),
	thinking: Type.Optional(
		Type.String({
			description:
				"Thinking/effort level override: off, minimal, low, medium, high, or xhigh. Defaults to the agent definition's `thinking:` value.",
		}),
	),
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
		overviewShownAt = null;
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
				signal: AbortSignal.any([moduleSignal(), child.abort.signal]),
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
		// Re-flow the remaining subagent panes so they reclaim this one's space.
		if (running.size > 0) refreshLayout();

		const elapsed = humanElapsed(Math.round((Date.now() - child.startTime) / 1000));

		if (result.reason === "aborted") {
			// Two ways to get aborted: the session is shutting down (stay
			// silent — nobody is left to tell) or a human pressed x in the
			// picker. The model must hear about the latter, because it was
			// promised a result for this child and would otherwise wait for
			// one that can never arrive.
			if (child.stoppedByUser) {
				pi.sendMessage(
					{
						customType: "subagent_result",
						content:
							`Sub-agent "${child.name}" (id ${child.id}) was stopped by the user after ${elapsed}. ` +
							`Do not treat this as a failure of the sub-agent.\n\n` +
							`Session: ${child.sessionFile}\nResume with subagent_resume({ id: "${child.id}", message: "..." }) if the work should continue.`,
						display: true,
						details: { id: child.id, name: child.name, reason: "stopped", sessionFile: child.sessionFile },
					},
					{ triggerTurn: true, deliverAs: "steer" },
				);
			}
			return;
		}

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
			const mode = params.mode ?? agentDef.mode ?? "fresh";
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
			const command =
				[
					`cd ${shellQuote(cwd)} &&`,
					env,
					`pi --session ${shellQuote(childSessionFile)}`,
					`-e ${shellQuote(IMPLANT_PATH)}`,
					model ? `--model ${shellQuote(model)}` : "",
					thinking ? `--thinking ${shellQuote(thinking)}` : "",
					systemPromptFile ? `--append-system-prompt ${shellQuote(systemPromptFile)}` : "",
					tools ? `--tools ${shellQuote(withControlTools(tools))}` : "",
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
			// model, thinking, auto-exit). Without this, a resumed agent
			// silently loses its system prompt and restrictions — they live on
			// the command line, not in the conversation.
			writeFileSync(
				`${childSessionFile}.meta`,
				JSON.stringify({ name: params.name, agent: agentName, tools, model, thinking, systemPromptFile, autoExit }),
				"utf8",
			);

			// Create the pane, give its shell a moment, then run the launch
			// script (written to artifacts for debuggability).
			const paneId = createPane(params.name);
			await sleep(config.shellReadyDelayMs);
			const scriptPath = join(base, "scripts", `${slug}-${id}.sh`);
			sendLongCommand(paneId, command, scriptPath);

			trackChild({
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
				abort: new AbortController(),
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

	// ── command: /subagents-available (human-facing) ───────────────────────
	// Shows the full inventory in the overview widget above the editor —
	// human-only and zero-token (see the widget section). Toggles: run it
	// again to hide, or it clears on your next submitted message.
	pi.registerCommand("subagents-available", {
		description: "List the available sub-agent definitions and their details",
		handler: async (_args, ctx) => {
			if (overviewShownAt !== null) {
				hideOverview();
				return;
			}
			if (!latestCtx?.hasUI) {
				ctx.ui.notify("The sub-agent overview needs the interactive TUI.", "warning");
				return;
			}
			const lines = formatAgentOverviewLines(collectAgentInventory(ctx.modelRegistry, ctx.cwd), agentDefsDir());
			latestCtx.ui.setWidget(OVERVIEW_WIDGET_KEY, lines, { placement: "aboveEditor" });
			overviewShownAt = Date.now();
		},
	});

	// Dismiss the overview on the next submitted input. The grace period
	// keeps the command's own submission from hiding it instantly.
	pi.on("input", () => {
		if (overviewShownAt !== null && Date.now() - overviewShownAt > 500) {
			hideOverview();
		}
	});

	// ── command: /subagents-running (human-facing) ─────────────────────────
	// Opens a focused picker over the running children. Up/down to choose,
	// Enter jumps to the pane (switching windows if needed), z jumps AND
	// zooms it (tmux prefix+z un-zooms), Escape cancels.
	pi.registerCommand("subagents-running", {
		description: "Pick a running sub-agent and jump to its pane (z = jump + zoom)",
		handler: async (_args, ctx) => {
			if (running.size === 0) {
				ctx.ui.notify("No sub-agents running.", "info");
				return;
			}
			const choice = await ctx.ui.custom<{ child: RunningSubagent; action: "goto" | "zoom" | "stop" } | undefined>(
				(tui, theme, _keybindings, done) => {
					const children = [...running.values()];
					let cursor = 0;
					return {
						handleInput(data: string): void {
							if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
								done(undefined);
							} else if (matchesKey(data, "up") || data === "k") {
								cursor = (cursor - 1 + children.length) % children.length;
								tui.requestRender();
							} else if (matchesKey(data, "down") || data === "j") {
								cursor = (cursor + 1) % children.length;
								tui.requestRender();
							} else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
								done({ child: children[cursor], action: "goto" });
							} else if (data === "z") {
								done({ child: children[cursor], action: "zoom" });
							} else if (data === "x") {
								done({ child: children[cursor], action: "stop" });
							}
						},
						invalidate(): void {},
						render(width: number): string[] {
							const th = theme;
							const lines: string[] = [""];
							lines.push(truncateToWidth(th.fg("accent", " Jump to sub-agent "), width));
							for (let i = 0; i < children.length; i++) {
								const child = children[i];
								const elapsed = formatElapsed(Math.round((Date.now() - child.startTime) / 1000));
								const agentTag = child.agent ? ` (${child.agent})` : "";
								const row = `${i === cursor ? "→" : " "} ${elapsed}  ${child.name}${agentTag}`;
								lines.push(truncateToWidth(i === cursor ? th.fg("accent", row) : th.fg("text", row), width));
							}
							lines.push(truncateToWidth(th.fg("dim", " ↑/↓ or j/k · enter: go · z: go + zoom · x: stop · esc: cancel"), width));
							lines.push("");
							return lines;
						},
					};
				},
			);

			if (!choice) return;
			if (choice.action === "stop") {
				// Mark first, then abort: the watcher reads the flag when its
				// poll loop notices the abort, closes the pane, and steers the
				// "stopped by the user" note to the model.
				choice.child.stoppedByUser = true;
				choice.child.abort.abort();
				return;
			}
			try {
				focusPane(choice.child.paneId, { zoom: choice.action === "zoom" });
			} catch {
				ctx.ui.notify(`Pane for "${choice.child.name}" is gone.`, "warning");
			}
		},
	});

	// ── tool: subagents_list ───────────────────────────────────────────────
	pi.registerTool({
		name: "subagents_list",
		label: "List Subagent Definitions",
		description: "List the available agent definitions (global <name>.md files) usable as the `agent` parameter of the subagent tool.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const inventory = collectAgentInventory(ctx.modelRegistry, ctx.cwd);
			if (inventory.length === 0) {
				return {
					content: [
						{
							type: "text",
							text:
								`No agent definitions found in ${agentDefsDir()}. ` +
								"The subagent tool also works without an agent definition.",
						},
					],
					details: {},
				};
			}
			// Terse on purpose: the model only needs enough to CHOOSE an agent
			// (name + description), plus whether the result comes back on its
			// own (interactive agents wait for a human), plus a warning when a
			// spawn would fail. Tools/model/paths stay in the human view.
			const lines = inventory.map((agent) => {
				const interactive = agent.autoExit ? "" : " (interactive — a human drives it)";
				const warning = agent.problems.length > 0 ? ` [⚠ not spawnable: ${agent.problems.join("; ")}]` : "";
				const isDefault = agent.name === "worker" ? " (default)" : "";
				const source = agent.source === "project" ? " (project)" : "";
				return `• ${agent.name}${isDefault}${source}${interactive}${warning} — ${agent.description ?? "(no description)"}`;
			});
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { count: inventory.length },
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
				agent?: string;
				tools?: string;
				model?: string;
				thinking?: string;
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
			// Re-resolve the model on THIS machine (an old session may name a
			// provider this computer has no credentials for — fail fast here,
			// not in the pane). Param overrides go through the same check.
			const modelCandidates = params.model ? [params.model] : meta.model ? [meta.model] : [];
			const model =
				modelCandidates.length > 0 ? resolveUsableModel(modelCandidates, ctx.modelRegistry) : undefined;
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
					thinking ? `--thinking ${shellQuote(thinking)}` : "",
					systemPromptFile ? `--append-system-prompt ${shellQuote(systemPromptFile)}` : "",
					tools ? `--tools ${shellQuote(withControlTools(tools))}` : "",
					messageArg,
				]
					.filter((part) => part !== "")
					.join(" ") + ` ; echo '__SUBAGENT_DONE_'$?'__'`;

			const paneId = createPane(name);
			await sleep(config.shellReadyDelayMs);
			const scriptPath = join(base, "scripts", `${slug}-${id}-resume.sh`);
			sendLongCommand(paneId, command, scriptPath);

			trackChild({
				id,
				name,
				agent: meta.agent,
				paneId,
				sessionFile: sessionPath,
				startTime: Date.now(),
				skipEntries,
				tools,
				model,
				autoExit,
				abort: new AbortController(),
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
