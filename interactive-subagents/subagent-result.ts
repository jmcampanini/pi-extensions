import type { Component } from "@earendil-works/pi-tui";
import { sanitizeDisplayText } from "./display-text.ts";

interface ToolResultLike {
	content: Array<{ type: string; text?: string }>;
}

export function renderSubagentLaunchResult(
	result: ToolResultLike,
	isError: boolean,
	renderError: (text: string) => Component,
): Component {
	if (!isError) {
		return {
			invalidate(): void {},
			render: () => [],
		};
	}

	const text = result.content
		.filter(
			(content): content is { type: string; text: string } =>
				content.type === "text" && typeof content.text === "string",
		)
		.map((content) => content.text)
		.join("\n");
	return renderError(sanitizeDisplayText(text) || "Sub-agent launch failed.");
}
