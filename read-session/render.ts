import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Marked, Renderer } from "marked";
import hljs from "highlight.js";
import type { ReaderBlock, ReaderFailure, ReaderMessage, ReaderSnapshot, ReaderTool } from "./session.ts";

const template = readFileSync(new URL("./reader.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("./reader.css", import.meta.url), "utf8");
const script = readFileSync(new URL("./reader.js", import.meta.url), "utf8");
const copyIcon = `
	<svg viewBox="0 0 24 24" aria-hidden="true">
		<rect x="8" y="8" width="12" height="12" rx="2" />
		<path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
	</svg>
`;

interface RenderedMessage {
	message: ReaderMessage;
	id: string;
	html: string;
	headings: { id: string; text: string; depth: number }[];
}

export function renderSession(snapshot: ReaderSnapshot): string {
	const messages = snapshot.blocks
		.filter((block): block is ReaderMessage => block.kind === "message")
		.map((message, index) => renderMessage(message, index, snapshot.cwd));
	const slots = {
		title: escapeHtml(snapshot.title),
		styles: `<style>\n${styles}\n</style>`,
		script: `<script>\n${script}\n</script>`,
		transcript: renderTranscript(snapshot.blocks, messages),
		outline: renderOutline(messages),
	};
	return template.replace(
		/\{\{(title|styles|script|transcript|outline)\}\}/g,
		(_match, slot: keyof typeof slots) => slots[slot],
	);
}

function renderTranscript(blocks: readonly ReaderBlock[], messages: readonly RenderedMessage[]): string {
	let messageIndex = 0;
	const exchanges: { prompt: string; answer: string[] }[] = [];
	for (const block of blocks) {
		if (block.kind === "message" && block.role === "user") {
			exchanges.push({ prompt: renderMessageCard(messages[messageIndex++]!), answer: [] });
			continue;
		}
		if (exchanges.length === 0) exchanges.push({ prompt: "", answer: [] });
		const exchange = exchanges.at(-1)!;
		switch (block.kind) {
			case "message":
				exchange.answer.push(renderMessageCard(messages[messageIndex++]!));
				break;
			case "activity":
				exchange.answer.push(renderActivity([...block.calls].reverse()));
				break;
			case "failure":
				exchange.answer.push(renderFailure(block));
				break;
		}
	}
	return exchanges
		.reverse()
		.map(
			({ answer, prompt }) => `
			<section class="exchange">
				<div class="answer-column">
					${answer.reverse().join("\n")}
				</div>
				<div class="prompt-column">
					${prompt}
				</div>
			</section>
		`,
		)
		.join("\n");
}

function renderOutline(messages: readonly RenderedMessage[]): string {
	const outlineAnswers = messages
		.filter((item) => item.message.role === "assistant")
		.map((item, index) => ({ item, number: index + 1 }));
	const outline = outlineAnswers
		.reverse()
		.map(({ item, number }) => {
			const headings = item.headings
				.map(
					(heading) => `
				<a class="toc-heading"
					style="--depth:${Math.min(heading.depth - 1, 2)}"
					href="#${heading.id}">${escapeHtml(heading.text)}</a>
			`,
				)
				.join("\n");
			return `
				<a class="toc-answer" href="#${item.id}">Answer ${number}</a>
				${headings}
			`;
		})
		.join("\n");
	return `
		<nav aria-label="Answer outline">
			${outline || "No agent answers yet."}
		</nav>
	`;
}

function renderMessageCard(item: RenderedMessage): string {
	const { message, id, html } = item;
	const status = message.status
		? `<span class="message-status">${message.status === "error" ? "Interrupted by an error" : "Aborted"}</span>`
		: "";
	const label = message.role === "user" ? "You" : "Agent";
	return `
		<article class="message ${message.role}" id="${id}">
			<div class="message-meta">
				<span>${label}</span>
				${status}
				<button type="button" class="icon-button copy-message"
					data-copy="${id}-source"
					aria-label="Copy ${label.toLowerCase()} message as Markdown"
					title="Copy Markdown">
					${copyIcon}
				</button>
			</div>
			<div class="markdown">${html}</div>
			<textarea hidden id="${id}-source">${escapeHtml(message.text)}</textarea>
		</article>
	`;
}

function renderMessage(message: ReaderMessage, index: number, cwd: string): RenderedMessage {
	const id = `message-${index + 1}`;
	const headings: RenderedMessage["headings"] = [];
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
				headings.push({ id: headingId, text: token.text.replace(/[*_`]/g, ""), depth: token.depth });
				const depth = Math.min(token.depth + 1, 6);
				return `<h${depth} id="${headingId}">${this.parser.parseInline(token.tokens)}</h${depth}>`;
			},
			link(token) {
				const href = safeUrl(token.href, cwd);
				const text = this.parser.parseInline(token.tokens);
				return href
					? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">${text}</a>`
					: text;
			},
			image(token) {
				const href = safeUrl(token.href, cwd);
				const text = `Image: ${escapeHtml(token.text || "open image")}`;
				return href
					? `<a class="image-link" href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">${text}</a>`
					: text;
			},
			code(token) {
				const language = token.lang?.split(/\s+/)[0] || "text";
				const highlighted = hljs.getLanguage(language)
					? hljs.highlight(token.text, { language, ignoreIllegals: true }).value
					: escapeHtml(token.text);
				const codeId = `${id}-code-${++codeIndex}`;
				return `
					<div class="code-block">
						<button type="button" class="icon-button copy-code"
							data-copy="${codeId}" aria-label="Copy code" title="Copy code">
							${copyIcon}
						</button>
						<pre aria-label="${escapeHtml(language)} code"><code class="hljs">${highlighted}</code></pre>
						<textarea hidden id="${codeId}">${escapeHtml(token.text)}</textarea>
					</div>
				`;
			},
			table(token) {
				return `
					<div class="table-scroll" tabindex="0" role="region" aria-label="Table">
						${Renderer.prototype.table.call(this, token)}
					</div>
				`;
			},
		},
	});
	return { message, id, headings, html: parser.parse(message.text) as string };
}

function renderActivity(calls: ReaderTool[]): string {
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
			return `${count} ${escapeHtml(noun)}`;
		})
		.join(" · ");
	const failures = calls.filter((call) => call.status === "failed").length;
	const pending = calls.filter((call) => call.status === "pending").length;
	const statuses = `${failures ? ` · ${failures} failed` : ""}${pending ? ` · ${pending} awaiting result` : ""}`;
	const details = calls
		.map(
			(call) => `
		<li>
			<code>${escapeHtml(call.name)}</code>
			<span class="tool-argument">${escapeHtml(call.argument || "")}</span>
			<span class="tool-state ${call.status}">${call.status === "pending" ? "awaiting result" : call.status}</span>
		</li>
	`,
		)
		.join("\n");
	return `
		<aside class="activity" aria-label="Tool activity">
			<div class="activity-summary">
				<span class="activity-mark" aria-hidden="true">↳</span>
				<span>${summary}${statuses}</span>
			</div>
			<ul>
				${details}
			</ul>
		</aside>
	`;
}

function renderFailure(failure: ReaderFailure): string {
	const label = failure.status === "error" ? "Agent response failed" : "Agent response aborted";
	const content = failure.details?.trim()
		? `
			<details>
				<summary>${label}</summary>
				<pre>${escapeHtml(failure.details)}</pre>
			</details>
		`
		: `<p>${label}</p>`;
	return `
		<aside class="failure" aria-label="Agent turn failure">
			${content}
		</aside>
	`;
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
