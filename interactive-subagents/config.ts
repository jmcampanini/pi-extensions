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
}

const DEFAULTS: SubagentsConfig = {
	layout: "window",
	mainWidth: "60%",
	shellReadyDelayMs: 500,
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
	const parsed = typeof value === "string" ? Number(value) : value;
	if (typeof parsed === "number" && Number.isInteger(parsed) && parsed >= 0) return parsed;
	throw new Error(`${source}: invalid shellReadyDelayMs ${JSON.stringify(value)} — use a non-negative integer`);
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
	}

	// Layer 3: env vars override the file (handy for direnv and one-offs).
	if (env.PI_SUBAGENT_LAYOUT) {
		result.layout = requireLayout(env.PI_SUBAGENT_LAYOUT.trim().toLowerCase(), "PI_SUBAGENT_LAYOUT");
	}
	if (env.PI_SUBAGENT_MAIN_WIDTH) {
		result.mainWidth = requireMainWidth(env.PI_SUBAGENT_MAIN_WIDTH, "PI_SUBAGENT_MAIN_WIDTH");
	}
	if (env.PI_SUBAGENT_SHELL_READY_DELAY_MS) {
		result.shellReadyDelayMs = requireDelayMs(
			env.PI_SUBAGENT_SHELL_READY_DELAY_MS,
			"PI_SUBAGENT_SHELL_READY_DELAY_MS",
		);
	}

	return result;
}

/** The resolved configuration — built (and validated) at extension load. */
export const config = loadConfig();
