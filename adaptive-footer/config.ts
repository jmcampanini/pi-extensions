import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AdaptiveFooterConfig {
	issuePatterns: readonly string[];
}

export const DEFAULT_ISSUE_PATTERNS: readonly string[] = [
	String.raw`(?:^|[/_-])issues?[#/_-](?<number>[1-9][0-9]*)(?=$|[/_-])`,
];

const VALID_KEYS = ["issuePatterns"];
type Env = Record<string, string | undefined>;

export function agentConfigDir(env: Env = process.env): string {
	return env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function configFilePath(env: Env = process.env): string {
	return join(agentConfigDir(env), "adaptive-footer.json");
}

function hasNamedNumberCapture(source: string): boolean {
	let escaped = false;
	let inCharacterClass = false;

	for (let index = 0; index < source.length; index++) {
		const character = source[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === "[") {
			inCharacterClass = true;
			continue;
		}
		if (character === "]" && inCharacterClass) {
			inCharacterClass = false;
			continue;
		}
		if (!inCharacterClass && source.startsWith("(?<number>", index)) return true;
	}

	return false;
}

function requireIssuePatterns(value: unknown, source: string): string[] {
	if (!Array.isArray(value)) {
		throw new Error(`${source}: issuePatterns must be an array of regular expression strings`);
	}

	return value.map((pattern, index) => {
		const itemSource = `${source}: issuePatterns[${index}]`;
		if (typeof pattern !== "string") {
			throw new Error(`${itemSource} must be a regular expression string`);
		}
		try {
			new RegExp(pattern);
		} catch (error) {
			throw new Error(
				`${itemSource} is not a valid JavaScript regular expression: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!hasNamedNumberCapture(pattern)) {
			throw new Error(`${itemSource} must contain a named capture group (?<number>...)`);
		}
		return pattern;
	});
}

export function loadConfig(env: Env = process.env): AdaptiveFooterConfig {
	const result: AdaptiveFooterConfig = { issuePatterns: [...DEFAULT_ISSUE_PATTERNS] };
	const filePath = configFilePath(env);
	if (!existsSync(filePath)) return result;

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(filePath, "utf8"));
	} catch (error) {
		throw new Error(`${filePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error(`${filePath}: must be a JSON object like {"issuePatterns": ["issue-(?<number>[1-9][0-9]*)"]}`);
	}

	const file = raw as Record<string, unknown>;
	const unknownKeys = Object.keys(file).filter((key) => !VALID_KEYS.includes(key));
	if (unknownKeys.length > 0) {
		throw new Error(
			`${filePath}: unknown key(s) ${unknownKeys.join(", ")} — valid keys: ${VALID_KEYS.join(", ")}`,
		);
	}
	if (Object.hasOwn(file, "issuePatterns")) {
		result.issuePatterns = requireIssuePatterns(file.issuePatterns, filePath);
	}

	return result;
}

export const config = loadConfig();
