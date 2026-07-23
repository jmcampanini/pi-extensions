/**
 * launch.ts — the ONE way a child pi process gets launched.
 *
 * Both `subagent_spawn` (first launch) and `subagent_resume` (relaunch of
 * an existing session) go through the helpers in this file, so there is a
 * single place that decides what a child's command line looks like: the env
 * prefix, the pi flags, the control-tool union, and the prompt argument. If
 * spawn and resume ever behave differently, the difference is visible in
 * their own files — not hidden in two drifting copies of this logic.
 *
 * Also here: the `.meta` launch-metadata sidecar. It records the identity a
 * child was launched with (system prompt, tools, model, thinking, auto-exit)
 * so a later resume can reapply it — those settings live on the command
 * line, not in the conversation, so without `.meta` a resumed child would
 * silently lose them.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assertValidAgentIdentifier } from "./agent-identifier.ts";
import { agentConfigDir } from "./config.ts";
import type { ChildEnvVars } from "./protocol.ts";
import { shellQuote } from "./tmux.ts";
import type { WorktreeInfo } from "./worktree.ts";

// ── paths ────────────────────────────────────────────────────────────────

/** Absolute path to this directory, so we can point `pi -e` at implant.ts. */
const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const IMPLANT_PATH = join(THIS_DIR, "implant.ts");

/** Turn a display name into something safe for filenames. */
export function slugify(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "subagent";
}

/** Artifacts for this extension live under the parent session's artifact dir. */
export function artifactBase(ctx: ExtensionContext): string {
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
export function generateChildSessionFile(childCwd: string): string {
	const dirName = "--" + childCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	return join(agentConfigDir(), "sessions", dirName, `${timestamp}_${randomUUID()}.jsonl`);
}

// ── the launch command ───────────────────────────────────────────────────

/**
 * Build the `KEY='value'` env prefix for the child's launch command. Panes
 * inherit the tmux server's environment rather than the parent pi process's
 * current environment, so every child-specific variable rides on the command
 * line. All child env vars flow through here.
 */
export function buildChildEnv(vars: ChildEnvVars): string {
	if (vars.PI_SUBAGENT_AGENT !== undefined) assertValidAgentIdentifier(vars.PI_SUBAGENT_AGENT);
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

export interface LaunchCommandOptions {
	/** Directory to `cd` into first; null = launch wherever the shell is. */
	cwd: string | null;
	/** The env prefix from buildChildEnv(). */
	env: string;
	/** The child's session file (created fresh, seeded, or resumed). */
	sessionFile: string;
	model?: string;
	thinking?: string;
	/** File whose contents pi appends to the child's system prompt. */
	systemPromptFile?: string;
	/** Comma-separated tool allowlist; the control tools are unioned in. */
	tools?: string;
	/** Extra flags appended VERBATIM before the prompt argument (frontmatter
	 * `harness-pass-through` - allowed for pi children too, for uniform
	 * semantics across harnesses). */
	passThrough?: string;
	/** Shell-quoted `@file` prompt argument, or "" for none (resume without a message). */
	promptArg: string;
}

/**
 * The full command a child pane runs: optional `cd`, env prefix, `pi` with
 * its flags, and the prompt argument. Empty parts are dropped, so optional
 * settings simply don't appear.
 */
export function buildLaunchCommand(options: LaunchCommandOptions): string {
	return [
		options.cwd ? `cd ${shellQuote(options.cwd)} &&` : "",
		options.env,
		`pi --session ${shellQuote(options.sessionFile)}`,
		`-e ${shellQuote(IMPLANT_PATH)}`,
		options.model ? `--model ${shellQuote(options.model)}` : "",
		options.thinking ? `--thinking ${shellQuote(options.thinking)}` : "",
		options.systemPromptFile ? `--append-system-prompt ${shellQuote(options.systemPromptFile)}` : "",
		options.tools ? `--tools ${shellQuote(withControlTools(options.tools))}` : "",
		options.passThrough ?? "",
		options.promptArg,
	]
		.filter((part) => part !== "")
		.join(" ");
}

// ── the `.meta` launch-metadata sidecar ──────────────────────────────────

/** What `subagent_resume` needs to reapply a child's launch identity.
 * Every field is optional on read: a session not created by this extension
 * has no `.meta` at all, and that just means "no defaults". */
export interface LaunchMeta {
	name?: string;
	agent?: string;
	tools?: string;
	model?: string;
	thinking?: string;
	systemPromptFile?: string;
	autoExit?: boolean;
	/** How the conversation started (fresh/forked) — display-only, so the
	 * running widget can keep showing it after a resume. */
	context?: "fresh" | "forked";
	/** Set when the child ran in a git worktree — lets a resume keep the same
	 * cleanup behavior, and lets it explain a worktree that was removed. */
	worktree?: WorktreeInfo;
	/** Which tool ran the child ("claude-code"); absent = pi. On resume this
	 * is what routes the relaunch through the external profile. */
	harness?: string;
	/** Extra flags appended verbatim on every (re)launch. */
	harnessPassThrough?: string;
	/** The child's working directory. Recorded only for external children,
	 * which have no session header to read it back from on resume. */
	cwd?: string;
}

export function writeLaunchMeta(sessionFile: string, meta: LaunchMeta): void {
	if (meta.agent !== undefined) assertValidAgentIdentifier(meta.agent, "Launch metadata agent identifier");
	writeFileSync(`${sessionFile}.meta`, JSON.stringify(meta), "utf8");
}

/** Read a session's `.meta`. Missing or malformed JSON = `{}`; invalid identifiers fail loud. */
export function readLaunchMeta(sessionFile: string): LaunchMeta {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(`${sessionFile}.meta`, "utf8"));
	} catch {
		return {};
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
	const meta = raw as LaunchMeta;
	if (meta.agent !== undefined) assertValidAgentIdentifier(meta.agent, "Launch metadata agent identifier");
	return meta;
}

/**
 * Delete any leftover `.exit` sidecar before (re)launching into a session.
 * A stale sidecar from a previous run would be consumed by the poller's
 * first tick and instantly fake a completion, killing the fresh child.
 */
export function clearExitSidecar(sessionFile: string): void {
	rmSync(`${sessionFile}.exit`, { force: true });
}
