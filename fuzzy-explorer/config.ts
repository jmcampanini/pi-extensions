import type { KeyId } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface FuzzyExplorerConfig {
	openShortcut: KeyId;
	openMode: "list" | "filter";
}

type Env = Record<string, string | undefined>;

// Configuration resolves in three layers: defaults, config file, then environment.
const DEFAULTS: FuzzyExplorerConfig = {
	openShortcut: "ctrl+r",
	openMode: "list",
};

const VALID_KEYS = Object.keys(DEFAULTS);

export function agentConfigDir(env: Env = process.env): string {
	return env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function configFilePath(env: Env = process.env): string {
	return join(agentConfigDir(env), "fuzzy-explorer.json");
}

// Key validation mirrors Pi's KeyId: a base key with optional, non-repeated modifiers.
const BASE_KEYS = new Set([
	..."abcdefghijklmnopqrstuvwxyz",
	..."0123456789",
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageUp",
	"pageDown",
	"up",
	"down",
	"left",
	"right",
	"f1",
	"f2",
	"f3",
	"f4",
	"f5",
	"f6",
	"f7",
	"f8",
	"f9",
	"f10",
	"f11",
	"f12",
	..."`-=[]\\;',./!@#$%^&*()_|~{}:<>?",
	"+",
]);
const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
const RESERVED_SHORTCUTS = new Set([
	"escape", "esc", "enter", "return",
	"ctrl+a", "ctrl+b", "ctrl+c", "ctrl+d", "ctrl+e", "ctrl+f", "ctrl+g", "ctrl+h", "ctrl+i",
	"ctrl+j", "ctrl+k", "ctrl+l", "ctrl+m", "ctrl+o", "ctrl+p", "ctrl+t", "ctrl+u", "ctrl+w", "ctrl+y", "ctrl+z",
	"ctrl+[", "ctrl+]", "ctrl+alt+]", "shift+ctrl+p", "ctrl+shift+p", "shift+tab", "shift+enter", "alt+enter",
	"alt+b", "alt+f", "alt+d",
]);

function isKeyId(value: string): value is KeyId {
	let key = value;
	const seenModifiers = new Set<string>();

	while (true) {
		const separator = key.indexOf("+");
		if (separator === -1) break;

		const modifier = key.slice(0, separator);
		if (!MODIFIERS.has(modifier)) break;
		if (seenModifiers.has(modifier)) return false;

		seenModifiers.add(modifier);
		key = key.slice(separator + 1);
	}

	return BASE_KEYS.has(key);
}

function requireOpenShortcut(value: unknown, source: string): KeyId {
	if (typeof value !== "string" || !isKeyId(value)) {
		throw new Error(
			`${source}: invalid openShortcut ${JSON.stringify(value)} — use a Pi KeyId such as "ctrl+r"`,
		);
	}
	const normalized = value.toLowerCase();
	const isBareFunctionKey = /^f(?:[1-9]|1[0-2])$/.test(normalized);
	const hasModifier = /^(?:(?:ctrl|shift|alt|super)\+)+/.test(normalized);
	const shiftedBase = normalized.startsWith("shift+") ? normalized.slice("shift+".length) : "";
	const isShiftedTextKey = BASE_KEYS.has(shiftedBase)
		&& (shiftedBase === "space" || shiftedBase.length === 1);
	if ((!hasModifier && !isBareFunctionKey) || isShiftedTextKey || RESERVED_SHORTCUTS.has(normalized)) {
		throw new Error(`${source}: openShortcut ${JSON.stringify(value)} is reserved by Pi's main editor`);
	}
	return value;
}

function requireOpenMode(value: unknown, source: string): FuzzyExplorerConfig["openMode"] {
	if (value === "list" || value === "filter") return value;
	throw new Error(`${source}: invalid openMode ${JSON.stringify(value)} — valid values: list, filter`);
}

export function loadConfig(env: Env = process.env): FuzzyExplorerConfig {
	const result: FuzzyExplorerConfig = { ...DEFAULTS };
	const filePath = configFilePath(env);

	// A missing file keeps defaults; an existing file must be valid JSON with known keys.
	if (existsSync(filePath)) {
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(filePath, "utf8"));
		} catch (error) {
			throw new Error(`${filePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}

		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			throw new Error(`${filePath}: must be a JSON object like {"openMode": "list"}`);
		}

		const file = raw as Record<string, unknown>;
		const unknownKeys = Object.keys(file).filter((key) => !VALID_KEYS.includes(key));
		if (unknownKeys.length > 0) {
			throw new Error(
				`${filePath}: unknown key(s) ${unknownKeys.join(", ")} — valid keys: ${VALID_KEYS.join(", ")}`,
			);
		}

		if (file.openShortcut !== undefined) {
			result.openShortcut = requireOpenShortcut(file.openShortcut, `${filePath}: openShortcut`);
		}
		if (file.openMode !== undefined) {
			result.openMode = requireOpenMode(file.openMode, `${filePath}: openMode`);
		}
	}

	// Environment values use the same validators and override the file one key at a time.
	if (env.PI_FUZZY_EXPLORER_OPEN_SHORTCUT !== undefined) {
		result.openShortcut = requireOpenShortcut(
			env.PI_FUZZY_EXPLORER_OPEN_SHORTCUT,
			"PI_FUZZY_EXPLORER_OPEN_SHORTCUT",
		);
	}
	if (env.PI_FUZZY_EXPLORER_OPEN_MODE !== undefined) {
		result.openMode = requireOpenMode(env.PI_FUZZY_EXPLORER_OPEN_MODE, "PI_FUZZY_EXPLORER_OPEN_MODE");
	}

	return result;
}

// Importing the extension validates configuration immediately; /reload rebuilds it.
export const config = loadConfig();
