import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AutoCompactConfig {
	thresholdPercent: number;
	enabled: boolean;
}

const DEFAULTS: AutoCompactConfig = {
	thresholdPercent: 70,
	enabled: true,
};

type Env = Record<string, string | undefined>;

export function agentConfigDir(env: Env = process.env): string {
	return env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function configFilePath(env: Env = process.env): string {
	return join(agentConfigDir(env), "autocompact.json");
}

function requireThresholdPercent(value: unknown, source: string): number {
	if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100) return value;
	throw new Error(`${source}: invalid thresholdPercent ${JSON.stringify(value)} — use an integer from 1 through 100`);
}

function requireEnabled(value: unknown, source: string): boolean {
	if (typeof value === "boolean") return value;
	throw new Error(`${source}: invalid enabled ${JSON.stringify(value)} — use true or false`);
}

function coerceNumericEnvValue(value: string): number | string {
	const converted = Number(value);
	return Number.isFinite(converted) ? converted : value;
}

function coerceBooleanEnvValue(value: string): boolean | string {
	if (value === "true") return true;
	if (value === "false") return false;
	return value;
}

export function loadConfig(env: Env = process.env): AutoCompactConfig {
	const result: AutoCompactConfig = { ...DEFAULTS };
	const filePath = configFilePath(env);

	if (existsSync(filePath)) {
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(filePath, "utf8"));
		} catch (error) {
			throw new Error(`${filePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}

		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			throw new Error(`${filePath}: must be a JSON object like {"thresholdPercent": 70, "enabled": true}`);
		}

		const file = raw as Record<string, unknown>;
		const unknownKeys = Object.keys(file).filter((key) => !Object.hasOwn(DEFAULTS, key));
		if (unknownKeys.length > 0) {
			throw new Error(
				`${filePath}: unknown key(s) ${unknownKeys.join(", ")} — valid keys: ${Object.keys(DEFAULTS).join(", ")}`,
			);
		}

		if (file.thresholdPercent !== undefined) {
			result.thresholdPercent = requireThresholdPercent(file.thresholdPercent, `${filePath}: thresholdPercent`);
		}
		if (file.enabled !== undefined) {
			result.enabled = requireEnabled(file.enabled, `${filePath}: enabled`);
		}
	}

	if (env.PI_AUTO_COMPACT_THRESHOLD_PERCENT) {
		result.thresholdPercent = requireThresholdPercent(
			coerceNumericEnvValue(env.PI_AUTO_COMPACT_THRESHOLD_PERCENT),
			"PI_AUTO_COMPACT_THRESHOLD_PERCENT",
		);
	}
	if (env.PI_AUTO_COMPACT_ENABLED) {
		result.enabled = requireEnabled(
			coerceBooleanEnvValue(env.PI_AUTO_COMPACT_ENABLED),
			"PI_AUTO_COMPACT_ENABLED",
		);
	}

	return result;
}

export const config = loadConfig();
