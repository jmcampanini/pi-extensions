import { Key, type KeyId } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ReaderConfig {
	openShortcut: KeyId | null;
}

const baseKeys = new Set([
	...Object.values(Key).filter((value) => typeof value === "string"),
	..."abcdefghijklmnopqrstuvwxyz0123456789".split(""),
]);
const modifiers = new Set(["ctrl", "shift", "alt", "super"]);

export function loadConfig(env: Record<string, string | undefined> = process.env): ReaderConfig {
	const filePath = join(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "read-session.json");
	const config: ReaderConfig = { openShortcut: "ctrl+r" };
	if (existsSync(filePath)) {
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(filePath, "utf8"));
		} catch (error) {
			throw new Error(`Could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			throw new Error(`${filePath}: expected an object with an openShortcut key`);
		}
		const file = raw as Record<string, unknown>;
		const unknownKeys = Object.keys(file).filter((key) => key !== "openShortcut");
		if (unknownKeys.length > 0) throw new Error(`${filePath}: unknown keys: ${unknownKeys.join(", ")}`);
		if (file.openShortcut !== undefined) config.openShortcut = requireShortcut(file.openShortcut, filePath);
	}
	if (env.PI_READ_SESSION_OPEN_SHORTCUT !== undefined) {
		config.openShortcut = requireShortcut(
			env.PI_READ_SESSION_OPEN_SHORTCUT === "" ? null : env.PI_READ_SESSION_OPEN_SHORTCUT,
			"PI_READ_SESSION_OPEN_SHORTCUT",
		);
	}
	return config;
}

function requireShortcut(value: unknown, source: string): KeyId | null {
	if (value === null) return null;
	if (typeof value !== "string") throw new Error(`${source}: openShortcut must be a Pi KeyId or null`);

	let key = value;
	const seen = new Set<string>();
	while (key.includes("+")) {
		const separator = key.indexOf("+");
		const modifier = key.slice(0, separator);
		if (!modifiers.has(modifier)) break;
		if (seen.has(modifier)) throw new Error(`${source}: repeated shortcut modifier ${modifier}`);
		seen.add(modifier);
		key = key.slice(separator + 1);
	}
	if (!baseKeys.has(key)) throw new Error(`${source}: invalid openShortcut ${JSON.stringify(value)}`);
	const isFunctionKey = /^f(?:[1-9]|1[0-2])$/.test(key);
	const hasShortcutModifier = seen.has("ctrl") || seen.has("alt") || seen.has("super");
	if (!isFunctionKey && !hasShortcutModifier) {
		throw new Error(`${source}: openShortcut needs ctrl, alt, or super, or a function key such as f6`);
	}
	return value as KeyId;
}
