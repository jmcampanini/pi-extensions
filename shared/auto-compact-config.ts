import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ThresholdSpec =
	| { thresholdTokens: number; thresholdPercent?: never }
	| { thresholdTokens?: never; thresholdPercent: number };

export type WindowClass = ThresholdSpec & { windowMax: number };

export interface AutoCompactConfig {
	enabled: boolean;
	classes: WindowClass[];
	default: ThresholdSpec;
}

const DEFAULTS: AutoCompactConfig = {
	enabled: true,
	classes: [
		{ windowMax: 300_000, thresholdPercent: 90 },
		{ windowMax: 500_000, thresholdPercent: 70 },
	],
	default: { thresholdTokens: 400_000 },
};

type Env = Record<string, string | undefined>;

export function agentConfigDir(env: Env = process.env): string {
	return env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function configFilePath(env: Env = process.env): string {
	return join(agentConfigDir(env), "autocompact.json");
}

function requireEnabled(value: unknown, source: string): boolean {
	if (typeof value === "boolean") return value;
	throw new Error(`${source}: invalid enabled ${JSON.stringify(value)} - use true or false`);
}

function requireObject(value: unknown, source: string, shape: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${source}: must be a JSON object like ${shape}`);
	}
	return value as Record<string, unknown>;
}

function rejectUnknownKeys(raw: Record<string, unknown>, source: string, validKeys: readonly string[]): void {
	const unknownKeys = Object.keys(raw).filter((key) => !validKeys.includes(key));
	if (unknownKeys.length > 0) {
		throw new Error(`${source}: unknown key(s) ${unknownKeys.join(", ")} - valid keys: ${validKeys.join(", ")}`);
	}
}

function requireThresholdSpec(value: unknown, source: string): ThresholdSpec {
	const raw = requireObject(value, source, '{"thresholdTokens": 400000} or {"thresholdPercent": 70}');
	rejectUnknownKeys(raw, source, ["thresholdTokens", "thresholdPercent"]);

	const hasTokens = raw.thresholdTokens !== undefined;
	const hasPercent = raw.thresholdPercent !== undefined;
	if (hasTokens === hasPercent) {
		throw new Error(`${source}: set exactly one of thresholdTokens or thresholdPercent`);
	}

	if (hasTokens) {
		const tokens = raw.thresholdTokens;
		if (typeof tokens !== "number" || !Number.isInteger(tokens) || tokens < 1) {
			throw new Error(`${source}: invalid thresholdTokens ${JSON.stringify(tokens)} - use a positive integer`);
		}
		return { thresholdTokens: tokens };
	}

	const percent = raw.thresholdPercent;
	if (typeof percent !== "number" || !Number.isInteger(percent) || percent < 1 || percent > 100) {
		throw new Error(`${source}: invalid thresholdPercent ${JSON.stringify(percent)} - use an integer from 1 through 100`);
	}
	return { thresholdPercent: percent };
}

function requireClasses(value: unknown, source: string): WindowClass[] {
	if (!Array.isArray(value)) {
		throw new Error(`${source}: must be an array of classes like [{"windowMax": 300000, "thresholdPercent": 90}]`);
	}

	const classes = value.map((entry, index) => {
		const entrySource = `${source}[${index}]`;
		const raw = requireObject(entry, entrySource, '{"windowMax": 300000, "thresholdPercent": 90}');
		rejectUnknownKeys(raw, entrySource, ["windowMax", "thresholdTokens", "thresholdPercent"]);

		const { windowMax, ...spec } = raw;
		if (typeof windowMax !== "number" || !Number.isInteger(windowMax) || windowMax < 1) {
			throw new Error(`${entrySource}: invalid windowMax ${JSON.stringify(windowMax)} - use a positive integer`);
		}

		return { windowMax, ...requireThresholdSpec(spec, entrySource) };
	});

	for (let index = 1; index < classes.length; index++) {
		if (classes[index].windowMax <= classes[index - 1].windowMax) {
			throw new Error(`${source}: windowMax values must be strictly ascending`);
		}
	}

	return classes;
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

		const file = requireObject(raw, filePath, '{"classes": [{"windowMax": 300000, "thresholdPercent": 90}], "default": {"thresholdTokens": 400000}, "enabled": true}');
		rejectUnknownKeys(file, filePath, Object.keys(DEFAULTS));

		if (file.enabled !== undefined) {
			result.enabled = requireEnabled(file.enabled, `${filePath}: enabled`);
		}
		if (file.classes !== undefined) {
			result.classes = requireClasses(file.classes, `${filePath}: classes`);
		}
		if (file.default !== undefined) {
			result.default = requireThresholdSpec(file.default, `${filePath}: default`);
		}
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
