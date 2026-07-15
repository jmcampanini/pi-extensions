import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import { AssistantMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Keep Pi's configured base padding, then add 4 columns of extra
// indentation for expanded thinking blocks only.
const EXTRA_THINKING_INDENT_X = 4;

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

type AssistantMessageComponentInternals = {
	contentContainer?: { children?: unknown[] };
	hideThinkingBlock?: boolean;
};

type PatchState = {
	originalUpdateContent: UpdateContent;
	patchedUpdateContent: UpdateContent;
	owners: number;
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

function addPaddingX(component: unknown, paddingX: number): void {
	const maybePadded = component as PaddingComponent | undefined;
	if (!maybePadded || typeof maybePadded !== "object" || typeof maybePadded.paddingX !== "number") return;

	maybePadded.paddingX += paddingX;
	maybePadded.invalidate?.();
}

function applyThinkingPadding(component: AssistantMessageComponent, message: AssistantMessage): void {
	const internals = component as unknown as AssistantMessageComponentInternals;
	if (internals.hideThinkingBlock !== false) return;

	const children = internals.contentContainer?.children;
	if (!Array.isArray(children)) return;

	let childIndex = hasVisibleAssistantContent(message) ? 1 : 0; // Initial spacer.

	for (let index = 0; index < message.content.length; index++) {
		const content = message.content[index];
		if (content.type === "text" && content.text.trim()) {
			childIndex++;
			continue;
		}

		if (content.type !== "thinking" || !content.thinking.trim()) continue;

		addPaddingX(children[childIndex], EXTRA_THINKING_INDENT_X);
		childIndex++;

		if (hasVisibleAssistantContentAfter(message, index)) {
			childIndex++; // Spacer after this thinking block.
		}
	}
}

function installPatch(): PatchState {
	const globalState = globalThis as typeof globalThis & { [PATCH_KEY]?: PatchState };
	if (globalState[PATCH_KEY]) {
		globalState[PATCH_KEY].owners++;
		return globalState[PATCH_KEY];
	}

	const originalUpdateContent = AssistantMessageComponent.prototype.updateContent;
	const patchedUpdateContent: UpdateContent = function (this: AssistantMessageComponent, message: AssistantMessage) {
		originalUpdateContent.call(this, message);
		applyThinkingPadding(this, message);
	};

	AssistantMessageComponent.prototype.updateContent = patchedUpdateContent;

	const patchState = { originalUpdateContent, patchedUpdateContent, owners: 1 };
	globalState[PATCH_KEY] = patchState;
	return patchState;
}

function uninstallPatch(patchState: PatchState): void {
	const globalState = globalThis as typeof globalThis & { [PATCH_KEY]?: PatchState };
	if (globalState[PATCH_KEY] !== patchState) return;

	patchState.owners--;
	if (patchState.owners > 0) return;

	if (AssistantMessageComponent.prototype.updateContent === patchState.patchedUpdateContent) {
		AssistantMessageComponent.prototype.updateContent = patchState.originalUpdateContent;
	}
	delete globalState[PATCH_KEY];
}

export default function (pi: ExtensionAPI) {
	const patchState = installPatch();
	let ownsPatch = true;

	pi.on("session_shutdown", () => {
		if (!ownsPatch) return;
		ownsPatch = false;
		uninstallPatch(patchState);
	});
}
