import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import hljs from "highlight.js";
import { componentFiles, readerAssets, renderComponent, type ComponentData } from "./components.ts";
import { prepareSession, renderSession } from "./render.ts";
import type { ReaderSnapshot } from "./session.ts";

const snapshot: ReaderSnapshot = {
	title: "Reader component examples",
	cwd: process.cwd(),
	messageCount: 9,
	blocks: [
		{
			kind: "message",
			role: "user",
			text: `<skill name="pivotal-questions" location="/example/skills/pivotal-questions/SKILL.md">
Interview me about this topic until the design decisions are settled.
</skill>

Keep my question beside your answer. Show the headings in an outline and let me copy the Markdown.

<skill name="when-designing-code" location="/example/skills/when-designing-code/SKILL.md">
Choose the data structures before writing the logic.
</skill>

Preserve this text after both skills.`,
		},
		{ kind: "message", role: "assistant", text: "## Progress\n\nI'll inspect the reader components first." },
		{
			kind: "activity",
			calls: [
				{ name: "read", argument: "read-session/components/message.html", status: "returned" },
				{ name: "edit", argument: "read-session/reader.css", status: "failed" },
				{ name: "bash", argument: "make check", status: "pending" },
			],
		},
		{
			kind: "message",
			role: "assistant",
			text: `## What changed

Each visual component has an HTML template. **Edit the markup where you see it.**

### Composition

The exchange includes messages and tool activity. Messages and code blocks include the same copy button.

\`\`\`html
<article class="message {{role}}">
  {{> copy-button sourceId=sourceId}}
  <div class="markdown">{{{markdownHtml}}}</div>
</article>
\`\`\`

| Component | Edit |
| --- | --- |
| Message | Metadata, copy button, and response content |
| Exchange | Answer and prompt placement |

### Next step

- [x] Keep all session messages.
- [x] Follow the system's light or dark mode.
- [ ] Read this page and reply in Pi.

> Copy a passage when you want to discuss it.

Open [the editing guide](read-session/README.md). Images appear as links: ![example screenshot](example.png).`,
		},
		{
			kind: "message",
			role: "user",
			text: "## Keep the full request\n\nShow my message in the reading thread and keep the sticky context beside it.\n\n- Preserve long paragraphs and lists.\n- Let wide code scroll inside the prompt.\n- Keep copy buttons usable in both places.\n\n```typescript\nconst request = { inline: true, context: true };\nconsole.log(request);\n```",
		},
		{
			kind: "message",
			role: "assistant",
			text: "Both copies include the complete request, with their own copy controls.",
		},
		{ kind: "message", role: "user", text: "Use sentence case for the headings." },
		{ kind: "message", role: "assistant", text: "I'll keep the headings in sentence case." },
		{ kind: "message", role: "user", text: "What does an interrupted response look like?" },
		{ kind: "failure", status: "aborted" },
		{
			kind: "failure",
			status: "error",
			details: "The example provider is unavailable.\nRetry when it is reachable.",
		},
		{
			kind: "message",
			role: "assistant",
			status: "error",
			text: "This response stopped before it finished. Its recorded text stays readable.",
		},
	],
};

const paired = prepareSession(snapshot, "paired");
const isolated = prepareSession(snapshot, "isolated");
const examples: ComponentData["gallery"]["examples"] = [];

function addExample<Name extends keyof ComponentData>(
	id: string,
	title: string,
	description: string,
	component: Name,
	data: ComponentData[Name],
): void {
	const file = componentFiles[component];
	examples.push({
		id,
		sourceId: `${id}-template`,
		title,
		description,
		file,
		source: readFileSync(new URL(file, import.meta.url), "utf8"),
		previewHtml: renderComponent(component, data),
	});
}

for (const [index, exchange] of paired.exchanges.entries()) {
	addExample(
		`exchange-${index}`,
		index === 0 ? "Interrupted exchange" : "Complete exchange",
		"The exchange composes a prompt, responses, tool activity, and failure notices.",
		"exchange",
		exchange,
	);
}
for (const [index, exchange] of isolated.exchanges.entries()) {
	if (exchange.prompt) {
		addExample(
			`prompt-${index}`,
			"User prompt content",
			"The exchange places this content inline and in the sticky context column.",
			"message",
			exchange.prompt,
		);
	}
	for (const [answerIndex, answer] of exchange.answers.entries()) {
		const id = `component-${index}-${answerIndex}`;
		switch (answer.component) {
			case "message":
				addExample(
					id,
					index === 0 ? "Interrupted response" : "Agent response",
					"Responses have no role header. Copy controls and interruption statuses remain available.",
					"message",
					answer.data,
				);
				break;
			case "tool-activity":
				addExample(id, "Tool activity", "Returned, failed, and pending calls.", "tool-activity", answer.data);
				break;
			case "failure":
				addExample(
					id,
					answer.data.details ? "Failure with details" : "Aborted turn",
					"Details expand when present; a turn without details stays a single line.",
					"failure",
					answer.data,
				);
				break;
		}
	}
}
addExample("skill", "Skill card", "Display and message copying both use $skill-name.", "skill-card", {
	name: "pivotal-questions",
});
const code = 'const theme = "system";\nconsole.log(theme);';
addExample("code", "Code block", "Code blocks share the message's copy-button component.", "code-block", {
	sourceId: "standalone-code",
	source: code,
	language: "typescript",
	highlightedHtml: hljs.highlight(code, { language: "typescript" }).value,
});
addExample("outline", "Turn outline", "These links jump to the paired examples above.", "outline", paired.outline);
addExample("empty-outline", "Empty outline", "A session with no exchanges has no turn links.", "outline", {
	turns: [],
});

const directory = resolve(".sandbox/read-session-preview");
mkdirSync(directory, { recursive: true });
writeFileSync(resolve(directory, "index.html"), renderSession(snapshot));
const galleryPath = resolve(directory, "components.html");
writeFileSync(
	galleryPath,
	renderComponent("gallery", {
		...readerAssets,
		galleryCss: readFileSync(new URL("gallery.css", import.meta.url), "utf8"),
		examples,
		outline: paired.outline,
	}),
);
console.log(`Component gallery: ${galleryPath}\nSample session: ${resolve(directory, "index.html")}`);
if (process.argv.includes("--open")) execFileSync("open", [galleryPath]);
