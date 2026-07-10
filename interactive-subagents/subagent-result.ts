interface ToolResultLike {
	content: Array<{ type: string; text?: string }>;
}

interface RenderComponent {
	render(width: number): string[];
	invalidate(): void;
}

export function renderSubagentLaunchResult(
	result: ToolResultLike,
	isError: boolean,
	renderError: (text: string) => RenderComponent,
): RenderComponent {
	if (!isError) {
		return {
			invalidate(): void {},
			render: () => [],
		};
	}

	const text = result.content
		.filter((content): content is { type: string; text: string } => content.type === "text" && typeof content.text === "string")
		.map((content) => content.text)
		.join("\n");
	return renderError(text || "Sub-agent launch failed.");
}
