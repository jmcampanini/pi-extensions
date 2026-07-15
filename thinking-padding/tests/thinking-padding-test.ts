import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	initTheme,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import thinkingPadding from "../index.ts";

let pass = 0;
let fail = 0;

function eq(label: string, got: unknown, want: unknown): void {
	const actual = JSON.stringify(got);
	const expected = JSON.stringify(want);
	if (actual === expected) {
		pass++;
		console.log(`  ok  ${label}`);
	} else {
		fail++;
		console.log(`  FAIL ${label}:\n    got  ${actual}\n    want ${expected}`);
	}
}

function renderedLine(component: AssistantMessageComponent, text: string): string {
	return component
		.render(80)
		.map((line) => stripVTControlCharacters(line).trimEnd())
		.find((line) => line.includes(text)) ?? "";
}

const message = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "Detailed reasoning." },
		{ type: "text", text: "Final answer." },
	],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "test-model",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 1,
} as AssistantMessage;

initTheme(undefined, false);

const originalUpdateContent = AssistantMessageComponent.prototype.updateContent;
let shutdown: (() => void) | undefined;
const pi = {
	on(event: string, handler: () => void): void {
		if (event === "session_shutdown") shutdown = handler;
	},
} as unknown as ExtensionAPI;

thinkingPadding(pi);

try {
	const expanded = new AssistantMessageComponent(message, false);
	eq("expanded thinking receives five columns of padding", renderedLine(expanded, "Detailed reasoning."), "     Detailed reasoning.");
	eq("assistant text keeps native padding", renderedLine(expanded, "Final answer."), " Final answer.");

	expanded.setHideThinkingBlock(true);
	eq("collapsing restores native padding", renderedLine(expanded, "Thinking..."), " Thinking...");
	eq("collapsed output does not render the reasoning", renderedLine(expanded, "Detailed reasoning."), "");

	expanded.setHideThinkingBlock(false);
	eq("expanding reapplies extra padding", renderedLine(expanded, "Detailed reasoning."), "     Detailed reasoning.");

	const initiallyCollapsed = new AssistantMessageComponent(message, true, undefined, "Thinking...", 2);
	eq("initially collapsed thinking preserves configured native padding", renderedLine(initiallyCollapsed, "Thinking..."), "  Thinking...");
} finally {
	shutdown?.();
}

eq("shutdown restores Pi's renderer", AssistantMessageComponent.prototype.updateContent, originalUpdateContent);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
