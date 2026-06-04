import type { ExtensionAPI, ToolExecutionComponent as ToolExecutionComponentType } from "@earendil-works/pi-coding-agent";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, type Component } from "@earendil-works/pi-tui";

const PATCH_KEY = Symbol.for("jmcampanini.pi-extensions.compact-read-tools.patch");

// Built-in Pi docs reads render as the built-in `read` tool with a compact
// "read docs ..." label, so `read` covers both normal file reads and docs reads.
// Keep a couple of common custom-tool spellings here too in case a separate
// docs reader is installed later.
const READ_LIKE_TOOL_NAMES = new Set(["read", "read_docs", "read-docs", "read docs", "readdocs"]);

const ANSI_PATTERN = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|_[^\x07]*(?:\x07|\x1B\\)|P[^\x07]*(?:\x07|\x1B\\)|[()][0-?]*[ -/]*[@-~]|[=>78])/g;

type ContainerPrototype = typeof Container.prototype;
type Render = ContainerPrototype["render"];

type PatchState = {
	originalRender: Render;
	patchedRender: Render;
};

type ToolExecutionLike = ToolExecutionComponentType & {
	toolName?: string;
	expanded?: boolean;
	result?: { isError?: boolean };
};

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

function isBlankLine(line: string): boolean {
	return stripAnsi(line).trim() === "";
}

function removeTrailingBlankLines(lines: string[]): void {
	while (lines.length > 0 && isBlankLine(lines[lines.length - 1] ?? "")) {
		lines.pop();
	}
}

function removeLeadingBlankLines(lines: string[]): string[] {
	let start = 0;
	while (start < lines.length && isBlankLine(lines[start] ?? "")) {
		start++;
	}
	return start === 0 ? lines : lines.slice(start);
}

function isToolExecutionComponent(component: unknown): component is ToolExecutionLike {
	return (
		component instanceof ToolExecutionComponent ||
		(component !== null &&
			typeof component === "object" &&
			(component as { constructor?: { name?: string } }).constructor?.name === "ToolExecutionComponent")
	);
}

function isCollapsibleReadToolExecution(component: unknown): component is ToolExecutionLike {
	if (!isToolExecutionComponent(component)) return false;

	const toolName = (component as { toolName?: unknown }).toolName;
	if (typeof toolName !== "string" || !READ_LIKE_TOOL_NAMES.has(toolName.toLowerCase())) return false;

	// Only collapse the compact read rows. If output is expanded or the read errored,
	// keep Pi's normal spacing so visible result/error content stays readable.
	return component.expanded !== true && component.result?.isError !== true;
}

function hasToolExecutionChildren(children: Component[]): boolean {
	return children.some(isToolExecutionComponent);
}

function renderWithCompactedConsecutiveReads(
	children: Component[],
	width: number,
	originalRender: Render,
	container: Container,
): string[] {
	if (!hasToolExecutionChildren(children)) {
		return originalRender.call(container, width);
	}

	const lines: string[] = [];
	let previousVisibleChildWasRead = false;

	for (const child of children) {
		const childLines = child.render(width);
		const currentChildIsRead = isCollapsibleReadToolExecution(child);

		if (childLines.length === 0) {
			continue;
		}

		if (currentChildIsRead && previousVisibleChildWasRead) {
			removeTrailingBlankLines(lines);
			lines.push(...removeLeadingBlankLines(childLines));
		} else {
			lines.push(...childLines);
		}

		previousVisibleChildWasRead = currentChildIsRead;
	}

	return lines;
}

function installPatch(): PatchState {
	const globalState = globalThis as typeof globalThis & { [PATCH_KEY]?: PatchState };
	if (globalState[PATCH_KEY]) return globalState[PATCH_KEY];

	const originalRender = Container.prototype.render;
	const patchedRender: Render = function (this: Container, width: number) {
		return renderWithCompactedConsecutiveReads(this.children, width, originalRender, this);
	};

	Container.prototype.render = patchedRender;

	const patchState = { originalRender, patchedRender };
	globalState[PATCH_KEY] = patchState;
	return patchState;
}

function uninstallPatch(patchState: PatchState): void {
	const globalState = globalThis as typeof globalThis & { [PATCH_KEY]?: PatchState };
	if (Container.prototype.render === patchState.patchedRender) {
		Container.prototype.render = patchState.originalRender;
	}
	if (globalState[PATCH_KEY] === patchState) {
		delete globalState[PATCH_KEY];
	}
}

export default function (_pi: ExtensionAPI) {
	const patchState = installPatch();

	_pi.on("session_shutdown", () => {
		uninstallPatch(patchState);
	});
}
