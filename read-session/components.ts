import { readFileSync } from "node:fs";
import Handlebars from "handlebars";
import type { ReaderTool } from "./session.ts";

export interface MessageView {
	id: string;
	role: "user" | "assistant";
	label: string;
	status: string | null;
	copyLabel: string;
	sourceId: string;
	source: string;
	markdownHtml: string;
}

export interface OutlineView {
	turns: {
		id: string;
		number: number;
		headings: { id: string; text: string; indent: number }[];
	}[];
}

export interface ExchangeView {
	id: string;
	prompt: MessageView | null;
	contextPrompt: MessageView | null;
	answers: {
		[Name in "message" | "tool-activity" | "failure"]: { component: Name; data: ComponentData[Name] };
	}["message" | "tool-activity" | "failure"][];
}

export interface SessionView {
	title: string;
	outline: OutlineView;
	exchanges: ExchangeView[];
}

export interface ComponentData {
	message: MessageView;
	"skill-card": { name: string };
	"copy-button": { sourceId: string; variant: string; label: string; title: string };
	"code-block": { sourceId: string; source: string; language: string; highlightedHtml: string };
	table: { tableHtml: string };
	heading: { level: number; id: string; textHtml: string };
	link: { href: string; image: boolean; labelHtml: string };
	"tool-activity": {
		summary: string;
		calls: { name: string; argument: string; status: ReaderTool["status"]; statusLabel: string }[];
	};
	failure: { label: string; details: string | null };
	outline: OutlineView;
	exchange: ExchangeView;
	controls: { outline: OutlineView };
	reader: SessionView & { stylesCss: string; scriptJs: string };
	gallery: {
		stylesCss: string;
		scriptJs: string;
		galleryCss: string;
		outline: OutlineView;
		examples: {
			id: string;
			sourceId: string;
			title: string;
			description: string;
			file: string;
			source: string;
			previewHtml: string;
		}[];
	};
}

export const componentFiles = {
	message: "components/message.html",
	"skill-card": "components/skill-card.html",
	"copy-button": "components/copy-button.html",
	"code-block": "components/code-block.html",
	table: "components/table.html",
	heading: "components/heading.html",
	link: "components/link.html",
	"tool-activity": "components/tool-activity.html",
	failure: "components/failure.html",
	outline: "components/outline.html",
	exchange: "components/exchange.html",
	controls: "components/controls.html",
	reader: "reader.html",
	gallery: "gallery.html",
} satisfies Record<keyof ComponentData, string>;

const handlebars = Handlebars.create();
const templates = new Map<keyof ComponentData, Handlebars.TemplateDelegate>();
for (const [name, file] of Object.entries(componentFiles)) {
	const template = handlebars.compile(readFileSync(new URL(file, import.meta.url), "utf8").trim(), {
		strict: true,
		explicitPartialContext: true,
		// Indenting a partial must not add whitespace to code or copied Markdown.
		preventIndent: true,
	});
	handlebars.registerPartial(name, template);
	templates.set(name as keyof ComponentData, template);
}

export const readerAssets = {
	stylesCss: readFileSync(new URL("reader.css", import.meta.url), "utf8"),
	scriptJs: readFileSync(new URL("reader.js", import.meta.url), "utf8"),
};

export function renderComponent<Name extends keyof ComponentData>(name: Name, data: ComponentData[Name]): string {
	return templates.get(name)!(data);
}
