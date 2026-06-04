import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import { AssistantMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Pi's built-in thinking renderer uses paddingX=1. Keep that base padding,
// then add 4 columns of extra indentation for thinking blocks only.
const BASE_THINKING_PADDING_X = 1;
const EXTRA_THINKING_INDENT_X = 4;
const THINKING_PADDING_X = BASE_THINKING_PADDING_X + EXTRA_THINKING_INDENT_X;

// This extension changes a built-in component prototype because Pi does not
// currently expose thinking-block padding as a public setting. Keep patch state
// on globalThis so reloads/duplicate loads do not wrap updateContent repeatedly.
const PATCH_KEY = Symbol.for("jmcampanini.pi-extensions.thinking-padding.patch");

type AssistantMessageComponentPrototype = typeof AssistantMessageComponent.prototype;
type UpdateContent = AssistantMessageComponentPrototype["updateContent"];

type PaddingComponent = Component & {
	paddingX?: number;
	invalidate?: () => void;
};

type PatchState = {
	originalUpdateContent: UpdateContent;
	patchedUpdateContent: UpdateContent;
};

function hasVisibleAssistantContent(message: AssistantMessage): boolean {
	return message.content.some(
		(content) =>
			(content.type === "text" && content.text.trim()) ||
			(content.type === "thinking" && content.thinking.trim()),
	);
}

function hasVisibleAssistantContentAfter(message: AssistantMessage, index: number): boolean {
	return message.content
		.slice(index + 1)
		.some(
			(content) =>
				(content.type === "text" && content.text.trim()) ||
				(content.type === "thinking" && content.thinking.trim()),
		);
}

function setPaddingX(component: unknown, paddingX: number): void {
	const maybePadded = component as PaddingComponent | undefined;
	if (!maybePadded || typeof maybePadded !== "object" || !("paddingX" in maybePadded)) return;

	maybePadded.paddingX = paddingX;
	maybePadded.invalidate?.();
}

function applyThinkingPadding(component: AssistantMessageComponent, message: AssistantMessage): void {
	const contentContainer = (component as unknown as { contentContainer?: { children?: unknown[] } }).contentContainer;
	const children = contentContainer?.children;
	if (!Array.isArray(children)) return;

	let childIndex = hasVisibleAssistantContent(message) ? 1 : 0; // Initial spacer.

	for (let index = 0; index < message.content.length; index++) {
		const content = message.content[index];
		if (content.type === "text" && content.text.trim()) {
			childIndex++;
			continue;
		}

		if (content.type !== "thinking" || !content.thinking.trim()) continue;

		setPaddingX(children[childIndex], THINKING_PADDING_X);
		childIndex++;

		if (hasVisibleAssistantContentAfter(message, index)) {
			childIndex++; // Spacer after this thinking block.
		}
	}
}

function installPatch(): PatchState {
	const globalState = globalThis as typeof globalThis & { [PATCH_KEY]?: PatchState };
	if (globalState[PATCH_KEY]) return globalState[PATCH_KEY];

	const originalUpdateContent = AssistantMessageComponent.prototype.updateContent;
	const patchedUpdateContent: UpdateContent = function (this: AssistantMessageComponent, message: AssistantMessage) {
		originalUpdateContent.call(this, message);
		applyThinkingPadding(this, message);
	};

	AssistantMessageComponent.prototype.updateContent = patchedUpdateContent;

	const patchState = { originalUpdateContent, patchedUpdateContent };
	globalState[PATCH_KEY] = patchState;
	return patchState;
}

function uninstallPatch(patchState: PatchState): void {
	const globalState = globalThis as typeof globalThis & { [PATCH_KEY]?: PatchState };
	if (AssistantMessageComponent.prototype.updateContent === patchState.patchedUpdateContent) {
		AssistantMessageComponent.prototype.updateContent = patchState.originalUpdateContent;
	}
	if (globalState[PATCH_KEY] === patchState) {
		delete globalState[PATCH_KEY];
	}
}

export default function (pi: ExtensionAPI) {
	const patchState = installPatch();

	pi.on("session_shutdown", () => {
		uninstallPatch(patchState);
	});
}
