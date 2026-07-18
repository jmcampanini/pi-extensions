/**
 * harnesses.ts - external tool profiles: running a child that is not pi.
 *
 * A "harness" is the command-line coding tool a child runs as. The default is
 * pi (all the existing machinery); this file holds everything that is
 * specific to OTHER tools, packaged as one small profile per tool. The core
 * extension stays generic: it mints an anchor path, opens a pane, polls the
 * same sidecar files, and delivers the result - only the launch/resume
 * command line and the effort/tool vocabularies differ per tool, and those
 * live here.
 *
 * How an external child reports back: the launch command registers lifecycle
 * notifiers (Claude Code calls them "hooks") via a per-run `--settings` JSON,
 * each pointing at the dependency-free claude-hook.mjs script next to this
 * file with its arguments baked in. The notifiers write the SAME sidecar
 * files the supervisor already polls (see plan below), so the extension never
 * opens the external tool's own session storage:
 *
 *   <anchor>.activity      liveness snapshot (activity.ts v1 schema)
 *   <anchor>.result        the child's final message, verbatim from the
 *                          turn-complete notifier's stdin payload
 *   <anchor>.exit          one-shot completion marker, written LAST
 *   <anchor>.harness.json  the external tool's own session id, read on resume
 *
 * The anchor is the same per-child path launch.ts mints for pi children, but
 * for an external child no file is ever created at the anchor itself - it
 * never appears in pi's session picker; it only names the sidecars.
 *
 * More tools (e.g. Codex) can be added later as additional profiles in the
 * registry below without touching the core. A future tool WITHOUT per-tool
 * lifecycle events would instead detect liveness from pane-content changes -
 * deliberately not built in v1.
 *
 * Like models.ts, this module is a pure leaf (node:fs, node:path, protocol,
 * tmux's shellQuote) so it unit-tests under plain node.
 */

import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SENTINEL_ECHO_SUFFIX } from "./protocol.ts";
import { shellQuote } from "./tmux.ts";

// ── the external sidecars ────────────────────────────────────────────────
// Path conventions shared with claude-hook.mjs, which cannot import this
// TypeScript module (lifecycle notifiers run under plain node) and therefore
// hardcodes the same suffixes - change them together.

export function externalResultPath(anchor: string): string {
	return `${anchor}.result`;
}

export function externalSessionIdPath(anchor: string): string {
	return `${anchor}.harness.json`;
}

/** The child's final message, or null when no completed turn wrote one. */
export function readExternalResult(anchor: string): string | null {
	try {
		const text = readFileSync(externalResultPath(anchor), "utf8");
		return text.trim() === "" ? null : text;
	} catch {
		return null;
	}
}

/** The external tool's own session id, or null when none was recorded. */
export function readExternalSessionId(anchor: string): string | null {
	try {
		const parsed = JSON.parse(readFileSync(externalSessionIdPath(anchor), "utf8")) as {
			sessionId?: unknown;
		};
		return typeof parsed.sessionId === "string" && parsed.sessionId !== "" ? parsed.sessionId : null;
	} catch {
		return null;
	}
}

/** Delete a stale result before (re)launching - a leftover one would be
 * reported as the NEW run's final message if that run produced none. */
export function clearExternalResult(anchor: string): void {
	rmSync(externalResultPath(anchor), { force: true });
}

// ── the profile seam ─────────────────────────────────────────────────────

/** Everything a launch or resume command needs. One options shape for both:
 * a launch passes `taskFile`, a resume passes `resumeSessionId` (and
 * optionally `messageFile`); the other fields are the child's identity. */
export interface HarnessCommandOptions {
	/** Directory to `cd` into first. */
	cwd: string;
	/** The anchor path the sidecars sit next to. */
	anchor: string;
	/** The 8-char run id stamping liveness-snapshot ownership. */
	runId: string;
	/** true = the parent closes the pane on the first completed turn. */
	autoExit: boolean;
	/** Model name, passed VERBATIM (external model names are the tool's own;
	 * pi's registry is never consulted). */
	model?: string;
	/** pi thinking level; the profile maps it to the tool's effort vocabulary
	 * and throws on an unmappable value. */
	thinking?: string;
	/** Allowed-tools list in the tool's own tool names. */
	tools?: string;
	/** File whose contents extend the child's system prompt. */
	systemPromptFile?: string;
	/** Extra command-line flags appended verbatim (frontmatter
	 * `harness-pass-through`). */
	passThrough?: string;
	/** The task file (launch only). */
	taskFile?: string;
	/** The follow-up message file (resume only, optional). */
	messageFile?: string;
	/** The external tool's own session id (resume only). */
	resumeSessionId?: string;
}

export interface HarnessProfile {
	/** The frontmatter `harness:` value ("claude-code"). */
	name: string;
	/**
	 * Map a pi thinking level to the tool's effort value. Throws on an
	 * unmappable level: Claude Code only WARNS on an out-of-range `--effort`
	 * and silently falls back to its default, so relying on the tool to
	 * reject a bad value would hide the mistake.
	 */
	mapEffort(thinking: string): string;
	/** Map the frontmatter `tools:` list to the tool's allowed-tools argument. */
	mapTools(tools: string): string;
	/** How a fresh task tells the child its run ends (appended to the task).
	 * Must not mention pi-only control tools - external children have none. */
	completionInstruction(autoExit: boolean): string;
	buildLaunchCommand(options: HarnessCommandOptions): string;
	buildResumeCommand(options: HarnessCommandOptions): string;
}

// ── the Claude Code profile ──────────────────────────────────────────────

/** Absolute path of the lifecycle-notifier script, sibling of this file. */
const THIS_DIR = dirname(fileURLToPath(import.meta.url));
export const CLAUDE_HOOK_PATH = join(THIS_DIR, "claude-hook.mjs");

/**
 * pi thinking level → `claude --effort` value. The valid effort set was
 * verified against Claude Code 2.1.214: exactly low, medium, high, xhigh,
 * max. pi's "minimal" maps down to "low"; "off" has no counterpart and is a
 * loud error rather than a silent fallback.
 */
const CLAUDE_EFFORT_BY_THINKING: Record<string, string> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

function mapClaudeEffort(thinking: string): string {
	const effort = CLAUDE_EFFORT_BY_THINKING[thinking];
	if (effort === undefined) {
		throw new Error(
			`Thinking level "${thinking}" has no claude-code effort mapping - ` +
				`mappable levels: ${Object.keys(CLAUDE_EFFORT_BY_THINKING).join(", ")}.`,
		);
	}
	return effort;
}

/**
 * The per-run `--settings` JSON registering the five lifecycle notifiers.
 * Each command is `node <claude-hook.mjs> <event> <anchor> <run id>` with
 * paths shell-quoted (Claude Code runs hook commands through a shell).
 * SessionStart writes the baseline liveness snapshot (the analog of the pi
 * implant's "snapshot #1") so an idle human-driven child reads "waiting",
 * not an aged-out "stalled". The turn-complete notifier carries --auto-exit
 * only for autonomous children: that is what makes it write the one-shot
 * completion marker, which the parent's poller consumes to close the pane.
 */
export function claudeLifecycleSettings(anchor: string, runId: string, autoExit: boolean): string {
	const command = (event: string, extraArgs: string[] = []): string =>
		["node", shellQuote(CLAUDE_HOOK_PATH), event, shellQuote(anchor), shellQuote(runId), ...extraArgs].join(" ");
	const entry = (cmd: string, matcher?: string) => [
		{
			...(matcher === undefined ? {} : { matcher }),
			hooks: [{ type: "command", command: cmd }],
		},
	];
	return JSON.stringify({
		hooks: {
			SessionStart: entry(command("session-start")),
			UserPromptSubmit: entry(command("prompt-start")),
			PreToolUse: entry(command("tool-start"), "*"),
			PostToolUse: entry(command("tool-end"), "*"),
			Stop: entry(command("turn-complete", autoExit ? ["--auto-exit"] : [])),
		},
	});
}

/** The identity flags shared by launch and resume, in a fixed order. */
function claudeIdentityFlags(options: HarnessCommandOptions): string[] {
	return [
		options.model ? `--model ${shellQuote(options.model)}` : "",
		options.thinking ? `--effort ${shellQuote(mapClaudeEffort(options.thinking))}` : "",
		options.tools ? `--allowedTools ${shellQuote(claudeCodeProfile.mapTools(options.tools))}` : "",
		options.systemPromptFile ? `--append-system-prompt-file ${shellQuote(options.systemPromptFile)}` : "",
		options.passThrough ?? "",
	];
}

/** The task/message argument: `"$(cat <file>)"` expands at RUN time inside
 * the pane's bash script, so multi-KB task text never rides the command line
 * itself and needs no escaping beyond the file path. */
function catArg(file: string): string {
	return `"$(cat ${shellQuote(file)})"`;
}

export const claudeCodeProfile: HarnessProfile = {
	name: "claude-code",
	mapEffort: mapClaudeEffort,
	// Claude Code's --allowedTools takes one comma-separated argument of its
	// OWN tool names, same shape as the frontmatter value - pass it through.
	mapTools: (tools: string) => tools.trim(),
	completionInstruction(autoExit: boolean): string {
		return autoExit
			? "Complete your task autonomously. When you finish your final reply, this session closes " +
					"automatically and that reply is reported back to the caller as your result."
			: "A human may drive this session; it ends when they close it. After each of your completed " +
					"replies, the most recent reply is what gets reported back to the caller as your result.";
	},
	buildLaunchCommand(options: HarnessCommandOptions): string {
		if (!options.taskFile) throw new Error("claude-code launch needs a task file.");
		return (
			[
				`cd ${shellQuote(options.cwd)} &&`,
				`claude --settings ${shellQuote(claudeLifecycleSettings(options.anchor, options.runId, options.autoExit))}`,
				...claudeIdentityFlags(options),
				catArg(options.taskFile),
			]
				.filter((part) => part !== "")
				.join(" ") + SENTINEL_ECHO_SUFFIX
		);
	},
	buildResumeCommand(options: HarnessCommandOptions): string {
		if (!options.resumeSessionId) throw new Error("claude-code resume needs the recorded session id.");
		return (
			[
				`cd ${shellQuote(options.cwd)} &&`,
				`claude --resume ${shellQuote(options.resumeSessionId)}`,
				`--settings ${shellQuote(claudeLifecycleSettings(options.anchor, options.runId, options.autoExit))}`,
				...claudeIdentityFlags(options),
				options.messageFile ? catArg(options.messageFile) : "",
			]
				.filter((part) => part !== "")
				.join(" ") + SENTINEL_ECHO_SUFFIX
		);
	},
};

// ── the registry ─────────────────────────────────────────────────────────
// Add future tools here as additional profiles; nothing else in the core
// names a specific external tool.

const HARNESS_PROFILES: Record<string, HarnessProfile> = {
	[claudeCodeProfile.name]: claudeCodeProfile,
};

/** The names external children can use in `harness:` frontmatter. */
export function externalHarnessNames(): string[] {
	return Object.keys(HARNESS_PROFILES);
}

/** The valid `harness:` frontmatter values, for validation messages. */
export function validHarnessValues(): string[] {
	return ["pi", ...externalHarnessNames()];
}

export function harnessProfile(name: string): HarnessProfile | undefined {
	return HARNESS_PROFILES[name];
}

/** Lookup that fails loud - callers reach this only after frontmatter
 * validation, so a miss means an internal inconsistency worth surfacing. */
export function requireHarnessProfile(name: string): HarnessProfile {
	const profile = harnessProfile(name);
	if (!profile) {
		throw new Error(`Unknown harness "${name}" - known harnesses: ${validHarnessValues().join(", ")}.`);
	}
	return profile;
}
