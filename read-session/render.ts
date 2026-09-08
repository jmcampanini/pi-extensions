import { pathToFileURL } from "node:url";
import { Marked, Renderer } from "marked";
import hljs from "highlight.js";
import {
	readerAssets,
	renderComponent,
	type ComponentData,
	type ExchangeView,
	type MessageView,
	type OutlineView,
	type SessionView,
} from "./components.ts";
import type { ReaderMessage, ReaderSnapshot, ReaderTool } from "./session.ts";

export function renderSession(snapshot: ReaderSnapshot): string {
	return renderComponent("reader", { ...prepareSession(snapshot), ...readerAssets });
}

export function prepareSession(snapshot: ReaderSnapshot, idPrefix = "message"): SessionView {
	const exchanges: ExchangeView[] = [];
	const outline: OutlineView = { answers: [] };
	let messageIndex = 0;
	for (const block of snapshot.blocks) {
		if (block.kind === "message") {
			const { message, headings } = prepareMessage(block, `${idPrefix}-${++messageIndex}`, snapshot.cwd);
			if (block.role === "user") {
				exchanges.push({ prompt: message, answers: [] });
				continue;
			}
			if (exchanges.length === 0) exchanges.push({ prompt: null, answers: [] });
			exchanges.at(-1)!.answers.push({ component: "message", data: message });
			outline.answers.push({ id: message.id, number: outline.answers.length + 1, headings });
			continue;
		}
		if (exchanges.length === 0) exchanges.push({ prompt: null, answers: [] });
		const answer = exchanges.at(-1)!.answers;
		if (block.kind === "activity") {
			answer.push({ component: "tool-activity", data: prepareActivity([...block.calls].reverse()) });
		} else {
			answer.push({
				component: "failure",
				data: {
					label: block.status === "error" ? "Agent response failed" : "Agent response aborted",
					details: block.details?.trim() ? block.details : null,
				},
			});
		}
	}
	return {
		title: snapshot.title,
		outline: { answers: outline.answers.reverse() },
		exchanges: exchanges.reverse().map(({ prompt, answers }) => ({ prompt, answers: answers.reverse() })),
	};
}

function prepareMessage(
	message: ReaderMessage,
	id: string,
	cwd: string,
): { message: MessageView; headings: OutlineView["answers"][number]["headings"] } {
	const headings: OutlineView["answers"][number]["headings"] = [];
	let codeIndex = 0;
	const parser = new Marked({ gfm: true, breaks: true, async: false });
	parser.use({
		renderer: {
			text(token) {
				return Renderer.prototype.text.call(this, { ...token, escaped: false });
			},
			html(token) {
				return escapeHtml(token.text);
			},
			heading(token) {
				const headingId = `${id}-heading-${headings.length + 1}`;
				headings.push({
					id: headingId,
					text: token.text.replace(/[*_`]/g, ""),
					indent: Math.min(token.depth - 1, 2),
				});
				return renderComponent("heading", {
					level: Math.min(token.depth + 1, 6),
					id: headingId,
					textHtml: this.parser.parseInline(token.tokens),
				});
			},
			link(token) {
				const href = safeUrl(token.href, cwd);
				const labelHtml = this.parser.parseInline(token.tokens);
				return href ? renderComponent("link", { href, image: false, labelHtml }) : labelHtml;
			},
			image(token) {
				const href = safeUrl(token.href, cwd);
				const labelHtml = `Image: ${escapeHtml(token.text || "open image")}`;
				return href ? renderComponent("link", { href, image: true, labelHtml }) : labelHtml;
			},
			code(token) {
				const language = token.lang?.split(/\s+/)[0] || "text";
				const highlightedHtml = hljs.getLanguage(language)
					? hljs.highlight(token.text, { language, ignoreIllegals: true }).value
					: escapeHtml(token.text);
				return renderComponent("code-block", {
					sourceId: `${id}-code-${++codeIndex}`,
					source: token.text,
					language,
					highlightedHtml,
				});
			},
			table(token) {
				return renderComponent("table", { tableHtml: Renderer.prototype.table.call(this, token) });
			},
		},
	});
	const html: string[] = [];
	const source: string[] = [];
	const skillBlocks = /<skill\s+(?:[^>]*?\s)?name="([^"]+)"[^>]*>[\s\S]*?<\/skill>/g;
	let cursor = 0;
	for (const match of message.text.matchAll(skillBlocks)) {
		const before = message.text.slice(cursor, match.index);
		html.push(parser.parse(before) as string, renderComponent("skill-card", { name: match[1]! }));
		source.push(before, `$${match[1]}`);
		cursor = match.index + match[0].length;
	}
	const after = message.text.slice(cursor);
	html.push(parser.parse(after) as string);
	source.push(after);

	const label = message.role === "user" ? "You" : "Agent";
	return {
		message: {
			id,
			role: message.role,
			label,
			status: message.status ? (message.status === "error" ? "Interrupted by an error" : "Aborted") : null,
			copyLabel: `Copy ${label.toLowerCase()} message as Markdown`,
			sourceId: `${id}-source`,
			source: source.join(""),
			markdownHtml: html.join(""),
		},
		headings,
	};
}

function prepareActivity(calls: ReaderTool[]): ComponentData["tool-activity"] {
	const counts = new Map<string, number>();
	for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
	const nouns: Record<string, readonly [string, string]> = {
		read: ["read", "reads"],
		edit: ["edit", "edits"],
		write: ["write", "writes"],
		bash: ["command", "commands"],
	};
	const summary = [...counts]
		.map(([name, count]) => {
			const noun = nouns[name]?.[count === 1 ? 0 : 1] ?? `${name} ${count === 1 ? "call" : "calls"}`;
			return `${count} ${noun}`;
		})
		.join(" · ");
	const failures = calls.filter((call) => call.status === "failed").length;
	const pending = calls.filter((call) => call.status === "pending").length;
	const statuses = `${failures ? ` · ${failures} failed` : ""}${pending ? ` · ${pending} awaiting result` : ""}`;
	return {
		summary: summary + statuses,
		calls: calls.map((call) => ({
			name: call.name,
			argument: call.argument || "",
			status: call.status,
			statusLabel: call.status === "pending" ? "awaiting result" : call.status,
		})),
	};
}

function safeUrl(raw: string, cwd: string): string | undefined {
	const value = Array.from(raw)
		.filter((character) => {
			const code = character.charCodeAt(0);
			return code > 0x1f && code !== 0x7f;
		})
		.join("")
		.trim();
	if (!value) return undefined;
	const scheme = value.match(/^([^/?#]*):/);
	if (scheme && !/^(https?|mailto|file)$/i.test(scheme[1]!)) return undefined;
	if (value.startsWith("//")) return `https:${value}`;
	if (scheme || value.startsWith("#")) return value;
	return new URL(value, pathToFileURL(`${cwd}/`)).href;
}

function escapeHtml(text: string): string {
	return text.replace(
		/[&<>"']/g,
		(character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
	);
}
