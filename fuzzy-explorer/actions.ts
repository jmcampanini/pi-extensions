import { constants } from "node:fs";
import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import {
	editorNeedsOptionsTerminator,
	editorSupportsPlusLine,
	nodeEditorProcessRunner,
	parseEditorCommand,
	resolveExternalEditor,
	type EditorEnvironment,
	type EditorInvocation,
	type EditorProcessRunner,
	type EditorResolver,
	type EditorTui,
	type ExternalEditorSettings,
} from "../shared/external-editor.ts";
import type { Block } from "./types.ts";

export type ClipboardWriter = (text: string) => Promise<void>;

export interface SmartOpenFileSystem {
	pathExists(filePath: string): Promise<boolean>;
	createCanonicalTextFile(repositoryRoot: string, text: string): Promise<string>;
	removeFile(filePath: string): Promise<void>;
}

export type SmartOpenTarget =
	| { kind: "file-reference"; path: string; line?: number; temporary: false }
	| { kind: "full-output"; path: string; temporary: false }
	| { kind: "canonical-text"; path: string; temporary: true };

export type SmartOpenDescription =
	| { kind: "file-reference"; path: string; line?: number }
	| { kind: "full-output"; path: string }
	| { kind: "canonical-text" };

export interface SmartOpenOptions {
	tui: EditorTui;
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
		return { ...description, path: resolve(repositoryRoot, description.path), temporary: false };
	}
	if (description.kind === "full-output") {
		return { ...description, path: resolve(repositoryRoot, description.path), temporary: false };
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

// Editor invocation

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
	if (editorNeedsOptionsTerminator(command!)) args.push("--");
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
