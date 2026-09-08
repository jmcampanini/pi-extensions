import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { prepareSession, renderSession } from "../render.ts";
import { selectMessages, type ReaderSnapshot } from "../session.ts";
import { entries } from "./fixture.ts";

describe("renderSession", () => {
	const snapshot: ReaderSnapshot = { ...selectMessages(entries), title: "Reader test", cwd: "/project" };

	it("renders a deterministic document with formatted Markdown and original message sources", () => {
		const html = renderSession(snapshot);

		assert.equal(renderSession(snapshot), html);
		assert.equal((html.match(/id="message-\d+-source"/g) ?? []).length, 6);
		assert.match(html, /<strong>Your words and the agent&#39;s words stay intact\.<\/strong>/);
		assert.match(html, /<table>/);
		assert.match(html, /class="hljs-keyword"/);
		assert.doesNotMatch(html, /PRIVATE_THINKING|RAW_TOOL_OUTPUT|RAW_FAILURE/);
	});

	it("provides working outline links and detailed tool calls with their recorded statuses", () => {
		const html = renderSession(snapshot);

		assert.match(html, /<aside class="outline">/);
		assert.match(html, /aria-label="Show conversation outline"/);
		assert.match(html, /class="toc-heading"[^>]*>Next step<\/a>/);
		assert.match(
			html,
			/<li>\s*<code>edit<\/code>\s*<span class="tool-argument">read-session\/index.ts<\/span>\s*<span class="tool-state failed">failed<\/span>/,
		);
		assert.match(html, /README\.md<\/span>\s*<span class="tool-state returned">returned/);
		assert.match(html, /npm test<\/span>\s*<span class="tool-state pending">awaiting result/);
		for (const link of html.matchAll(/class="toc-(?:answer|heading)"[^>]*href="#([^"]+)"/g)) {
			assert.ok(html.includes(`id="${link[1]}"`), link[1]);
		}
	});

	it("preserves multiline copy sources through nested HTML components", () => {
		const code = "first line\n  two spaces\n\tone tab\n\nlast line";
		const markdown = `A paragraph.\n\n\`\`\`unknown-language\n${code}\n\`\`\`\n\nLiteral {{> message}} and $&.`;
		const html = renderSession({
			...snapshot,
			blocks: [
				{ kind: "message", role: "user", text: "Prompt.\n\n  Indented continuation." },
				{ kind: "message", role: "assistant", text: markdown },
			],
		});
		const source = html.match(/<textarea hidden id="message-2-code-1">([\s\S]*?)<\/textarea>/)?.[1];
		const message = html.match(/<textarea hidden id="message-2-source">([\s\S]*?)<\/textarea>/)?.[1];

		assert.equal(source, code);
		assert.equal(
			message,
			`A paragraph.\n\n&#x60;&#x60;&#x60;unknown-language\n${code}\n&#x60;&#x60;&#x60;\n\nLiteral {{&gt; message}} and $&amp;.`,
		);
		assert.ok(html.includes(`<code class="hljs">${code}</code>`));
	});

	it("reverses complete messages and tool calls while preserving message contents and prompt pairing", () => {
		const latestAnswer = "Latest answer.\n\n## Details\n\n1. First step\n2. Second step";
		const html = renderSession({
			...snapshot,
			blocks: [
				{ kind: "message", role: "user", text: "First question." },
				{ kind: "message", role: "assistant", text: "First answer." },
				{ kind: "message", role: "user", text: "Next question." },
				{ kind: "message", role: "assistant", text: "Progress." },
				{
					kind: "activity",
					calls: [
						{ name: "read", status: "returned" },
						{ name: "edit", status: "failed" },
					],
				},
				{ kind: "message", role: "assistant", text: latestAnswer },
				{ kind: "message", role: "user", text: "Follow-up question." },
				{ kind: "activity", calls: [{ name: "bash", status: "pending" }] },
			],
		});
		const sources = [...html.matchAll(/<textarea hidden id="message-\d+-source">([\s\S]*?)<\/textarea>/g)].map(
			(match) => match[1],
		);
		const exchanges = [...html.matchAll(/<section class="exchange">([\s\S]*?)<\/section>/g)].map((match) =>
			[...match[1]!.matchAll(/<textarea hidden id="message-\d+-source">([\s\S]*?)<\/textarea>/g)].map(
				(message) => message[1],
			),
		);
		const tools = [...html.matchAll(/<li>\s*<code>([^<]+)<\/code>/g)].map((match) => match[1]);

		assert.deepEqual(sources, [
			"Follow-up question.",
			latestAnswer,
			"Progress.",
			"Next question.",
			"First answer.",
			"First question.",
		]);
		assert.deepEqual(exchanges, [
			["Follow-up question."],
			[latestAnswer, "Progress.", "Next question."],
			["First answer.", "First question."],
		]);
		assert.deepEqual(tools, ["bash", "edit", "read"]);
	});

	it("shows failed turns with collapsed plain-text details and excludes them from the answer outline", () => {
		const html = renderSession({
			...snapshot,
			messageCount: 0,
			blocks: [
				{ kind: "failure", status: "aborted" },
				{ kind: "failure", status: "error", details: "<script>bad()</script>\nTry again." },
			],
		});

		assert.match(
			html,
			/<details>\s*<summary>Agent response failed<\/summary>\s*<pre>&lt;script&gt;bad\(\)&lt;\/script&gt;\nTry again\.<\/pre>\s*<\/details>/,
		);
		assert.match(html, /<p>Agent response aborted<\/p>/);
		assert.ok(html.indexOf("Agent response failed") < html.indexOf("Agent response aborted"));
		assert.doesNotMatch(html, /<script>bad\(\)<\/script>|class="toc-answer"|class="message assistant"/);
	});

	it("escapes text after raw HTML start tags in paragraphs, headings, and tables", () => {
		const messages = [
			"Use <code> <img/src=x onerror=alert(1)> here",
			"Start <pre>\n\n## Later <svg/onload=alert(2)>",
			"Start <kbd>\n\n| Content |\n| --- |\n| <img/src=x onerror=alert(3)> |",
			"Start <script>\n\nLater paragraph with <svg/onload=alert(4)>",
		];
		for (const text of messages) {
			const html = renderSession({ ...snapshot, blocks: [{ kind: "message", role: "assistant", text }] });

			assert.doesNotMatch(html, /<(?:img|svg)\//i, text);
			assert.match(html, /&lt;(?:img|svg)\//, text);
		}
	});

	it("escapes session HTML and prevents executable Markdown links while preserving local file links", () => {
		const html = renderSession({
			title: "</title><script>bad()</script>",
			cwd: "/project",
			messageCount: 1,
			blocks: [
				{
					kind: "message",
					role: "assistant",
					text: "<script>bad()</script>\n\n[unsafe](javascript:alert%281%29)\n\n[local](docs/guide.md)\n\n```html\n</textarea><script>bad()</script>\n```\n\nLiteral {{styles}} and {{script}}.",
				},
				{
					kind: "activity",
					calls: [{ name: "<custom-tool>", argument: '"><svg onload=bad()>', status: "returned" }],
				},
			],
		});

		assert.doesNotMatch(html, /<script>bad\(\)<\/script>|href="javascript:|<svg onload/);
		assert.match(html, /&lt;custom-tool&gt;/);
		assert.match(html, /href="file:\/\/\/project\/docs\/guide\.md"/);
		assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
		assert.match(html, /<p>Literal \{\{styles\}\} and \{\{script\}\}\.<\/p>/);
	});
});

describe("prepareSession", () => {
	const snapshot: ReaderSnapshot = { title: "Skill cards", cwd: "/project", messageCount: 1, blocks: [] };

	it("displays and copies every skill as a dollar reference while keeping surrounding text", () => {
		const text =
			'**Before**\n\n<skill name="first" location="/private/first">\n## HIDDEN_BODY\n</skill>\n\nBetween.\n\n<skill name="second" location="/private/second">HIDDEN_BODY</skill>\n\nAfter.';
		const view = prepareSession({
			...snapshot,
			blocks: [
				{ kind: "message", role: "user", text },
				{ kind: "message", role: "assistant", text },
			],
		});
		const exchange = view.exchanges[0]!;
		const messages = [
			exchange.prompt!,
			...exchange.answers.flatMap((answer) => (answer.component === "message" ? [answer.data] : [])),
		];

		for (const message of messages) {
			assert.equal(message.source, "**Before**\n\n$first\n\nBetween.\n\n$second\n\nAfter.", message.role);
			assert.match(
				message.markdownHtml,
				/<strong>Before<\/strong>[\s\S]*class="skill-card">\$first<\/span>[\s\S]*Between\.[\s\S]*class="skill-card">\$second<\/span>[\s\S]*After\./,
				message.role,
			);
			assert.doesNotMatch(message.markdownHtml, /HIDDEN_BODY|\/private\/|<details\b/, message.role);
		}
		assert.deepEqual(view.outline.answers[0]!.headings, []);
	});

	it("replaces skill blocks literally, including inside code examples", () => {
		const wrapper = '<skill name="review" location="/private/SKILL.md">HIDDEN_BODY</skill>';
		for (const text of [wrapper, `\`${wrapper}\``, `\`\`\`xml\n${wrapper}\n\`\`\``]) {
			const view = prepareSession({ ...snapshot, blocks: [{ kind: "message", role: "user", text }] });
			const message = view.exchanges[0]!.prompt!;

			assert.equal(message.source, text.replace(wrapper, "$review"), text);
			assert.match(message.markdownHtml, /class="skill-card">\$review<\/span>/, text);
			assert.doesNotMatch(message.markdownHtml, /HIDDEN_BODY|\/private\//, text);
		}
	});

	it("leaves a skill without a closing tag unchanged", () => {
		const text = '<skill name="incomplete">Keep this body.';
		const message = prepareSession({ ...snapshot, blocks: [{ kind: "message", role: "user", text }] }).exchanges[0]!
			.prompt!;

		assert.equal(message.source, text);
		assert.match(message.markdownHtml, /Keep this body\./);
		assert.doesNotMatch(message.markdownHtml, /class="skill-card"/);
	});

	it("escapes the skill name instead of interpreting it as HTML", () => {
		const name = "<script>alert(1)</script>";
		const text = `<skill name="${name}" location="/private/SKILL.md">HIDDEN_BODY</skill>`;
		const message = prepareSession({ ...snapshot, blocks: [{ kind: "message", role: "user", text }] }).exchanges[0]!
			.prompt!;

		assert.equal(message.source, `$${name}`);
		assert.match(message.markdownHtml, /class="skill-card">\$&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/span>/);
		assert.doesNotMatch(message.markdownHtml, /<script>|HIDDEN_BODY|\/private\//);
	});
});
