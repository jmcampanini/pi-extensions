// External-editor handoff machinery shared by extensions that hand the
// terminal to an editor process (fuzzy-explorer's smart open, comment's
// quote editing): editor resolution, shell-free command parsing, editor
// capability tables, and the process runner.

import { spawn } from "node:child_process";
import { basename } from "node:path";

export interface ExternalEditorSettings {
	externalEditor?: string;
}

export type EditorEnvironment = Readonly<Record<string, string | undefined>>;

export type EditorResolver = (
	settings: ExternalEditorSettings,
	environment: EditorEnvironment,
	platform: NodeJS.Platform,
) => string;

/** TUI handle a handoff must stop while the editor owns the terminal. */
export interface EditorTui {
	stop(): void;
	start(): void;
	requestRender(force?: boolean): void;
}

export interface EditorInvocation {
	command: string;
	args: string[];
}

export interface EditorProcessRunner {
	run(command: string, args: string[]): Promise<number | null>;
}

export function resolveExternalEditor(
	settings: ExternalEditorSettings = {},
	environment: EditorEnvironment = process.env,
	platform: NodeJS.Platform = process.platform,
): string {
	const configured = settings.externalEditor;
	if (typeof configured === "string" && configured.trim() !== "") return configured;
	if (environment.VISUAL) return environment.VISUAL;
	if (environment.EDITOR) return environment.EDITOR;
	return platform === "win32" ? "notepad" : "nano";
}

export function parseEditorCommand(editorCommand: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quote: "'" | "\"" | undefined;
	let started = false;

	for (let index = 0; index < editorCommand.length; index++) {
		const character = editorCommand[index]!;
		if (quote === "'") {
			if (character === "'") quote = undefined;
			else current += character;
			started = true;
			continue;
		}

		if (quote === "\"") {
			if (character === "\"") {
				quote = undefined;
			} else if (character === "\\" && /["\\]/.test(editorCommand[index + 1] ?? "")) {
				current += editorCommand[++index]!;
			} else {
				current += character;
			}
			started = true;
			continue;
		}

		if (character === "'" || character === "\"") {
			quote = character;
			started = true;
		} else if (/\s/.test(character)) {
			if (started) {
				parts.push(current);
				current = "";
				started = false;
			}
		} else if (character === "\\" && /[\s'"\\]/.test(editorCommand[index + 1] ?? "")) {
			current += editorCommand[++index]!;
			started = true;
		} else {
			current += character;
			started = true;
		}
	}

	if (quote) throw new Error("External editor command has an unmatched quote");
	if (started) parts.push(current);
	if (!parts[0]) throw new Error("External editor command is empty");
	return parts;
}

const PLUS_LINE_EDITORS = new Set([
	"emacs",
	"emacsclient",
	"ex",
	"gvim",
	"mvim",
	"nano",
	"nvim",
	"nvimdiff",
	"pico",
	"vi",
	"view",
	"vim",
	"vimdiff",
]);

const END_OF_OPTIONS_EDITORS = new Set([
	"ex", "gvim", "mvim", "nvim", "nvimdiff", "vi", "view", "vim", "vimdiff",
]);

function editorExecutableName(command: string): string {
	return basename(command).toLowerCase().replace(/\.(?:bat|cmd|exe)$/i, "");
}

export function editorSupportsPlusLine(command: string): boolean {
	return PLUS_LINE_EDITORS.has(editorExecutableName(command));
}

export function editorNeedsOptionsTerminator(command: string): boolean {
	return END_OF_OPTIONS_EDITORS.has(editorExecutableName(command));
}

export const nodeEditorProcessRunner: EditorProcessRunner = {
	run(command, args): Promise<number | null> {
		return new Promise((resolve, reject) => {
			const child = spawn(command, args, { stdio: "inherit", shell: false });
			child.once("error", reject);
			child.once("close", resolve);
		});
	},
};
