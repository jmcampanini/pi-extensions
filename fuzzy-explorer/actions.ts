import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import type { Block } from "./types.ts";

export type ClipboardWriter = (text: string) => Promise<void>;

export interface ExternalEditorSettings {
	externalEditor?: string;
}

export type EditorEnvironment = Readonly<Record<string, string | undefined>>;

export type EditorResolver = (
	settings: ExternalEditorSettings,
	environment: EditorEnvironment,
	platform: NodeJS.Platform,
) => string;

export interface ActionTui {
	stop(): void;
	start(): void;
	requestRender(force?: boolean): void;
}

export interface SmartOpenFileSystem {
	pathExists(filePath: string): Promise<boolean>;
	createCanonicalTextFile(repositoryRoot: string, text: string): Promise<string>;
	removeFile(filePath: string): Promise<void>;
}

export interface EditorProcessRunner {
	run(command: string, args: string[]): Promise<number | null>;
}

export type SmartOpenTarget =
	| { kind: "file-reference"; path: string; line?: number; temporary: false }
	| { kind: "full-output"; path: string; temporary: false }
	| { kind: "canonical-text"; path: string; temporary: true };

export type SmartOpenDescription =
	| { kind: "file-reference"; path: string; line?: number }
	| { kind: "full-output"; path: string }
	| { kind: "canonical-text" };

export interface EditorInvocation {
	command: string;
	args: string[];
}

export interface SmartOpenOptions {
	tui: ActionTui;
	settings?: ExternalEditorSettings;
	environment?: EditorEnvironment;
	platform?: NodeJS.Platform;
	repositoryRoot?: string;
	fileSystem?: SmartOpenFileSystem;
	processRunner?: EditorProcessRunner;
	editorResolver?: EditorResolver;
}

export interface SmartOpenResult {
	target: SmartOpenTarget;
	invocation: EditorInvocation;
	exitCode: number | null;
}

// Canonical text

const ANSI_PATTERN = new RegExp(
	"(?:\\u001B\\][\\s\\S]*?(?:\\u0007|\\u001B\\u005C|\\u009C))|" +
		"[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]",
	"g",
);

export function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

export function blockCanonicalText(block: Block): string {
	return stripAnsi(block.canonicalText);
}

export async function copyBlockCanonicalText(
	block: Block,
	writeClipboard: ClipboardWriter = copyToClipboard,
): Promise<string> {
	const text = blockCanonicalText(block);
	await writeClipboard(text);
	return text;
}

// Target selection

function validLine(line: number | undefined): number | undefined {
	return line !== undefined && Number.isInteger(line) && line > 0 ? line : undefined;
}

function fileReferenceDescription(block: Block): SmartOpenDescription | undefined {
	if (!block.fileReference) return undefined;
	const line = validLine(block.fileReference.line);
	return line === undefined
		? { kind: "file-reference", path: block.fileReference.path }
		: { kind: "file-reference", path: block.fileReference.path, line };
}

function truncatedFullOutputPath(block: Block): string | undefined {
	return block.truncation?.truncated ? block.truncation.fullOutputPath : undefined;
}

export function describeSmartOpenSync(
	block: Block,
	pathExists: (path: string) => boolean,
): SmartOpenDescription {
	const fileReference = fileReferenceDescription(block);
	if (fileReference) return fileReference;
	const fullOutputPath = truncatedFullOutputPath(block);
	return fullOutputPath && pathExists(fullOutputPath)
		? { kind: "full-output", path: fullOutputPath }
		: { kind: "canonical-text" };
}

export async function describeSmartOpen(
	block: Block,
	fileSystem: SmartOpenFileSystem = nodeSmartOpenFileSystem,
): Promise<SmartOpenDescription> {
	const fileReference = fileReferenceDescription(block);
	if (fileReference) return fileReference;
	const fullOutputPath = truncatedFullOutputPath(block);
	return fullOutputPath && await fileSystem.pathExists(fullOutputPath)
		? { kind: "full-output", path: fullOutputPath }
		: { kind: "canonical-text" };
}

export async function resolveSmartOpenTarget(
	block: Block,
	repositoryRoot = process.cwd(),
	fileSystem: SmartOpenFileSystem = nodeSmartOpenFileSystem,
): Promise<SmartOpenTarget> {
	const description = await describeSmartOpen(block, fileSystem);
	if (description.kind === "file-reference") {
		return { ...description, temporary: false };
	}
	if (description.kind === "full-output") {
		return { ...description, temporary: false };
	}

	const path = await fileSystem.createCanonicalTextFile(repositoryRoot, blockCanonicalText(block));
	return { kind: "canonical-text", path, temporary: true };
}

export function formatSmartOpenHint(target: SmartOpenDescription): string {
	if (target.kind === "file-reference") {
		return `open ${target.path}${target.line === undefined ? "" : `:${target.line}`}`;
	}
	if (target.kind === "full-output") return `open full output ${target.path}`;
	return "open block text";
}

// Editor command handling

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

export function editorSupportsPlusLine(command: string): boolean {
	const executable = basename(command).toLowerCase().replace(/\.(?:bat|cmd|exe)$/i, "");
	return PLUS_LINE_EDITORS.has(executable);
}

export function buildEditorInvocation(editorCommand: string, target: SmartOpenTarget): EditorInvocation {
	const [command, ...configuredArgs] = parseEditorCommand(editorCommand);
	const args = [...configuredArgs];
	if (
		target.kind === "file-reference"
		&& target.line !== undefined
		&& editorSupportsPlusLine(command!)
	) {
		args.push(`+${target.line}`);
	}
	args.push(target.path);
	return { command: command!, args };
}

// External open lifecycle

export async function smartOpenBlock(block: Block, options: SmartOpenOptions): Promise<SmartOpenResult> {
	const fileSystem = options.fileSystem ?? nodeSmartOpenFileSystem;
	const processRunner = options.processRunner ?? nodeEditorProcessRunner;
	const environment = options.environment ?? process.env;
	const platform = options.platform ?? process.platform;
	const settings = options.settings ?? {};
	const repositoryRoot = options.repositoryRoot ?? process.cwd();
	const resolveEditor = options.editorResolver ?? resolveExternalEditor;
	const target = await resolveSmartOpenTarget(block, repositoryRoot, fileSystem);
	let tuiStopped = false;

	try {
		const invocation = buildEditorInvocation(resolveEditor(settings, environment, platform), target);
		options.tui.stop();
		tuiStopped = true;
		const exitCode = await processRunner.run(invocation.command, invocation.args);
		return { target, invocation, exitCode };
	} finally {
		if (target.temporary) {
			try {
				await fileSystem.removeFile(target.path);
			} catch {
				// Cleanup failure must not leave Pi's TUI stopped.
			}
		}
		if (tuiStopped) {
			options.tui.start();
			options.tui.requestRender(true);
		}
	}
}

export const nodeSmartOpenFileSystem: SmartOpenFileSystem = {
	async pathExists(filePath): Promise<boolean> {
		try {
			await access(filePath, constants.F_OK);
			return true;
		} catch {
			return false;
		}
	},
	async createCanonicalTextFile(repositoryRoot, text): Promise<string> {
		const directory = join(repositoryRoot, ".sandbox", "fuzzy-explorer");
		await mkdir(directory, { recursive: true });
		const filePath = join(directory, `block-${process.pid}-${Date.now()}-${randomUUID()}.md`);
		await writeFile(filePath, text, { encoding: "utf8", flag: "wx" });
		return filePath;
	},
	async removeFile(filePath): Promise<void> {
		await unlink(filePath);
	},
};

export const nodeEditorProcessRunner: EditorProcessRunner = {
	run(command, args): Promise<number | null> {
		return new Promise((resolve, reject) => {
			const child = spawn(command, args, { stdio: "inherit", shell: process.platform === "win32" });
			child.once("error", reject);
			child.once("close", resolve);
		});
	},
};
