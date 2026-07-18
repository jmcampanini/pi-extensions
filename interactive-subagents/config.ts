/**
 * config.ts — extension configuration.
 *
 * Settings resolve in three layers, later wins:
 *
 *   built-in defaults  <  config file  <  environment variables
 *
 * The config file is `subagents.json` in pi's config root
 * ($PI_CODING_AGENT_DIR, default ~/.pi/agent) — matching the `subagents/`
 * directory the agent definitions live in. A missing file is fine (defaults apply); a
 * MALFORMED file or env value throws, and because `config` below is built at
 * module import, that failure happens at EXTENSION LOAD TIME: pi refuses to
 * start the extension and shows the error, so a broken config gets fixed
 * immediately instead of surfacing mid-spawn. Edits are picked up by /reload
 * (which re-imports this module and re-validates).
 *
 * Like models.ts, this module is dependency-free and takes its inputs
 * (environment) as a parameter, so it unit-tests with plain fakes.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SubagentsConfig {
	/** Pane strategy: main-vertical, dedicated tiled window, or plain splits. */
	layout: "main" | "window" | "off";
	/** Parent pane width in the "main" layout: "60%" or absolute columns like "120". */
	mainWidth: string;
	/** Pause between opening a pane and typing the launch command. */
	shellReadyDelayMs: number;
	/** Wrapped task or follow-up lines shown while a call is collapsed. */
	callPreviewLines: number;
	/** Wrapped response lines shown while a delivered result is collapsed. */
	resultPreviewLines: number;
	/** Shell command (run via bash -c) that creates a worktree and prints its directory. */
	worktreeCreateCommand: string;
	/** Shell command (run via bash -c) that removes a finished subagent's worktree. */
	worktreeCleanupCommand: string;
	/** "auto" removes clean worktrees after a successful child; "never" always keeps them. */
	worktreeCleanupMode: "auto" | "never";
}

// The default worktree commands are plain shell strings — they double as
// documentation of the contract a replacement command must follow (users
// override them to plug in tools like `grove`).
//
// Create: gets PI_SUBAGENT_WORKTREE_NAME in its env, must exit 0 and print
// the worktree directory as the last non-empty stdout line. Git's chatter is
// sent to stderr so stdout stays clean, and the `*` gitignore makes the
// `.pi/worktrees/` holding directory ignore itself in the parent repo.
export const DEFAULT_WORKTREE_CREATE_COMMAND = `ROOT="$(git rev-parse --show-toplevel)" && WT="$ROOT/.pi/worktrees/$PI_SUBAGENT_WORKTREE_NAME" && mkdir -p "$ROOT/.pi/worktrees" && printf '*\\n' >"$ROOT/.pi/worktrees/.gitignore" && git worktree add -b "pi/$PI_SUBAGENT_WORKTREE_NAME" "$WT" >&2 && echo "$WT"`;

// Cleanup: gets PI_SUBAGENT_WORKTREE_DIR and PI_SUBAGENT_WORKTREE_BRANCH
// (empty string when the worktree was on a detached HEAD — the `[ -n ]`
// guard skips branch deletion in that case).
export const DEFAULT_WORKTREE_CLEANUP_COMMAND = `git worktree remove "$PI_SUBAGENT_WORKTREE_DIR" >&2 && if [ -n "$PI_SUBAGENT_WORKTREE_BRANCH" ]; then git branch -D "$PI_SUBAGENT_WORKTREE_BRANCH" >&2; fi`;

const DEFAULTS: SubagentsConfig = {
	layout: "window",
	mainWidth: "60%",
	shellReadyDelayMs: 500,
	callPreviewLines: 3,
	resultPreviewLines: 5,
	worktreeCreateCommand: DEFAULT_WORKTREE_CREATE_COMMAND,
	worktreeCleanupCommand: DEFAULT_WORKTREE_CLEANUP_COMMAND,
	worktreeCleanupMode: "auto",
};

type Env = Record<string, string | undefined>;

/** Pi's config root: $PI_CODING_AGENT_DIR or ~/.pi/agent. */
export function agentConfigDir(env: Env = process.env): string {
	return env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function configFilePath(env: Env = process.env): string {
	return join(agentConfigDir(env), "subagents.json");
}

// ── validators ───────────────────────────────────────────────────────────
// Each takes the raw value plus a `source` ("<file>: layout" or an env var
// name) so the load-time error says exactly what to fix, and where.

function requireLayout(value: unknown, source: string): SubagentsConfig["layout"] {
	if (value === "main" || value === "window" || value === "off") return value;
	throw new Error(`${source}: invalid layout ${JSON.stringify(value)} — valid values: main, window, off`);
}

function requireMainWidth(value: unknown, source: string): string {
	if (typeof value === "string" && /^\d+%?$/.test(value.trim())) return value.trim();
	throw new Error(
		`${source}: invalid mainWidth ${JSON.stringify(value)} — use a percentage like "60%" or columns like "120"`,
	);
}

function requireDelayMs(value: unknown, source: string): number {
	if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
	throw new Error(`${source}: invalid shellReadyDelayMs ${JSON.stringify(value)} — use a non-negative integer`);
}

function requirePreviewLines(value: unknown, source: string): number {
	if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 20) return value;
	throw new Error(`${source}: invalid preview line count ${JSON.stringify(value)}; use an integer from 0 through 20`);
}

// Shared by both worktree commands: any non-empty string is a valid shell
// command (we can't validate shell syntax here — bash reports that at run
// time), but an empty/blank value would silently do nothing, so reject it.
function requireCommandString(value: unknown, source: string): string {
	if (typeof value === "string" && value.trim() !== "") return value;
	throw new Error(`${source}: invalid command ${JSON.stringify(value)} — use a non-empty shell command string`);
}

function requireWorktreeCleanupMode(value: unknown, source: string): SubagentsConfig["worktreeCleanupMode"] {
	if (value === "auto" || value === "never") return value;
	throw new Error(`${source}: invalid worktreeCleanupMode ${JSON.stringify(value)} — valid values: auto, never`);
}

// ── loading ──────────────────────────────────────────────────────────────

export function loadConfig(env: Env = process.env): SubagentsConfig {
	const result: SubagentsConfig = { ...DEFAULTS };

	// Layer 2: the config file (missing = fine, malformed = throw).
	const filePath = configFilePath(env);
	if (existsSync(filePath)) {
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(filePath, "utf8"));
		} catch (error) {
			throw new Error(`${filePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			throw new Error(`${filePath}: must be a JSON object like {"layout": "main"}`);
		}
		const file = raw as Record<string, unknown>;

		// Unknown keys are almost always typos — reject them by name.
		const unknownKeys = Object.keys(file).filter((key) => !(key in DEFAULTS));
		if (unknownKeys.length > 0) {
			throw new Error(
				`${filePath}: unknown key(s) ${unknownKeys.join(", ")} — valid keys: ${Object.keys(DEFAULTS).join(", ")}`,
			);
		}

		if (file.layout !== undefined) result.layout = requireLayout(file.layout, `${filePath}: layout`);
		if (file.mainWidth !== undefined) result.mainWidth = requireMainWidth(file.mainWidth, `${filePath}: mainWidth`);
		if (file.shellReadyDelayMs !== undefined) {
			result.shellReadyDelayMs = requireDelayMs(file.shellReadyDelayMs, `${filePath}: shellReadyDelayMs`);
		}
		if (file.callPreviewLines !== undefined) {
			result.callPreviewLines = requirePreviewLines(file.callPreviewLines, `${filePath}: callPreviewLines`);
		}
		if (file.resultPreviewLines !== undefined) {
			result.resultPreviewLines = requirePreviewLines(file.resultPreviewLines, `${filePath}: resultPreviewLines`);
		}
		if (file.worktreeCreateCommand !== undefined) {
			result.worktreeCreateCommand = requireCommandString(
				file.worktreeCreateCommand,
				`${filePath}: worktreeCreateCommand`,
			);
		}
		if (file.worktreeCleanupCommand !== undefined) {
			result.worktreeCleanupCommand = requireCommandString(
				file.worktreeCleanupCommand,
				`${filePath}: worktreeCleanupCommand`,
			);
		}
		if (file.worktreeCleanupMode !== undefined) {
			result.worktreeCleanupMode = requireWorktreeCleanupMode(
				file.worktreeCleanupMode,
				`${filePath}: worktreeCleanupMode`,
			);
		}
	}

	// Layer 3: env vars override the file (handy for direnv and one-offs).
	// The values go through the SAME validators as the file, so both layers
	// accept exactly the same inputs.
	if (env.PI_SUBAGENT_LAYOUT) {
		result.layout = requireLayout(env.PI_SUBAGENT_LAYOUT, "PI_SUBAGENT_LAYOUT");
	}
	if (env.PI_SUBAGENT_MAIN_WIDTH) {
		result.mainWidth = requireMainWidth(env.PI_SUBAGENT_MAIN_WIDTH, "PI_SUBAGENT_MAIN_WIDTH");
	}
	if (env.PI_SUBAGENT_SHELL_READY_DELAY_MS) {
		// Env values arrive as strings; convert before validating. A
		// non-numeric string becomes NaN, so we hand the validator the
		// original text and let it reject with a readable message.
		const raw = env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
		const converted = Number(raw);
		result.shellReadyDelayMs = requireDelayMs(
			Number.isNaN(converted) ? raw : converted,
			"PI_SUBAGENT_SHELL_READY_DELAY_MS",
		);
	}
	if (env.PI_SUBAGENT_CALL_PREVIEW_LINES) {
		const raw = env.PI_SUBAGENT_CALL_PREVIEW_LINES;
		const converted = Number(raw);
		result.callPreviewLines = requirePreviewLines(
			Number.isNaN(converted) ? raw : converted,
			"PI_SUBAGENT_CALL_PREVIEW_LINES",
		);
	}
	if (env.PI_SUBAGENT_RESULT_PREVIEW_LINES) {
		const raw = env.PI_SUBAGENT_RESULT_PREVIEW_LINES;
		const converted = Number(raw);
		result.resultPreviewLines = requirePreviewLines(
			Number.isNaN(converted) ? raw : converted,
			"PI_SUBAGENT_RESULT_PREVIEW_LINES",
		);
	}
	if (env.PI_SUBAGENT_WORKTREE_CREATE_COMMAND) {
		result.worktreeCreateCommand = requireCommandString(
			env.PI_SUBAGENT_WORKTREE_CREATE_COMMAND,
			"PI_SUBAGENT_WORKTREE_CREATE_COMMAND",
		);
	}
	if (env.PI_SUBAGENT_WORKTREE_CLEANUP_COMMAND) {
		result.worktreeCleanupCommand = requireCommandString(
			env.PI_SUBAGENT_WORKTREE_CLEANUP_COMMAND,
			"PI_SUBAGENT_WORKTREE_CLEANUP_COMMAND",
		);
	}
	if (env.PI_SUBAGENT_WORKTREE_CLEANUP_MODE) {
		result.worktreeCleanupMode = requireWorktreeCleanupMode(
			env.PI_SUBAGENT_WORKTREE_CLEANUP_MODE,
			"PI_SUBAGENT_WORKTREE_CLEANUP_MODE",
		);
	}

	return result;
}

/** The resolved configuration — built (and validated) at extension load. */
export const config = loadConfig();
