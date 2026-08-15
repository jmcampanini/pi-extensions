import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type MarkdownTheme } from "@earendil-works/pi-tui";
import { fitText } from "../interactive-subagents/text-fit.ts";
import { SEPARATOR_CLASS, stripSeparators } from "./search.ts";
import { subagentView, type SubagentView } from "./subagent.ts";
import type { Block, BlockTruncation, SearchResult } from "./types.ts";

export interface RenderStyles {
	title: (text: string) => string;
	accent: (text: string) => string;
	muted: (text: string) => string;
	dim: (text: string) => string;
	body: (text: string) => string;
	highlight: (text: string) => string;
	border: (text: string) => string;
}

export type RenderStyleOverrides = Partial<RenderStyles>;
export type PathExists = (path: string) => boolean;
export type RenderBlock = Block | SearchResult;

const identity = (text: string): string => text;

export const PLAIN_RENDER_STYLES: Readonly<RenderStyles> = Object.freeze({
	title: identity,
	accent: identity,
	muted: identity,
	dim: identity,
	body: identity,
	highlight: identity,
	border: identity,
});

function renderStyles(overrides: RenderStyleOverrides): RenderStyles {
	return { ...PLAIN_RENDER_STYLES, ...overrides };
}

export const PLAIN_MARKDOWN_THEME: Readonly<MarkdownTheme> = Object.freeze({
	heading: identity,
	link: identity,
	linkUrl: identity,
	code: identity,
	codeBlock: identity,
	codeBlockBorder: identity,
	quote: identity,
	quoteBorder: identity,
	hr: identity,
	listBullet: identity,
	bold: identity,
	italic: identity,
	strikethrough: identity,
	underline: identity,
});

/**
 * Blocks whose detail view renders as markdown by default: the kinds Pi's own
 * transcript renders through its markdown theme, plus subagent tool traffic,
 * whose bodies are prose reports. Tool output, bash output, and canonical
 * invocation text stay raw.
 */
export function rendersMarkdownByDefault(block: Block): boolean {
	if (block.kind === "assistant" || block.kind === "user" || block.kind === "summary" || block.kind === "custom") {
		return true;
	}
	return block.kind === "tool" && (block.toolName?.startsWith("subagent_") ?? false);
}

function safeWidth(width: number): number {
	return Number.isFinite(width) && width > 0 ? Math.floor(width) : 0;
}

/** Remove data-controlled terminal instructions while retaining ordinary text and line breaks. */
export function sanitizeTerminalText(text: string): string {
	const withoutControls = stripVTControlCharacters(text).replace(/\r\n?/gu, "\n");
	return Array.from(withoutControls)
		.filter((character) => {
			const codePoint = character.codePointAt(0);
			if (codePoint === undefined) return false;
			if (codePoint === 0x09 || codePoint === 0x0a) return true;
			if (codePoint <= 0x1f) return false;
			if (codePoint >= 0x7f && codePoint <= 0x9f) return false;
			if (codePoint >= 0xfff9 && codePoint <= 0xfffb) return false;
			return true;
		})
		.join("");
}

function singleLine(text: string): string {
	return sanitizeTerminalText(text).replace(/\s+/gu, " ").trim();
}

function unpack(value: RenderBlock): {
	block: Block;
	keyTokens: readonly string[];
	bodyTokens: readonly string[];
} {
	if ("block" in value && "match" in value) {
		return {
			block: value.block,
			keyTokens: value.match.keyTokens,
			bodyTokens: value.match.bodyTokens,
		};
	}
	return { block: value, keyTokens: [], bodyTokens: [] };
}

// Highlight span derivation
//
// Search reports only which token forms matched; spans are greedily re-derived
// here against whatever text is actually displayed, so stripped-token matches
// highlight the original separator-bearing text.

interface TextSpan {
	start: number;
	end: number;
}

/** Lowercase without shifting indices: characters whose lowercase form grows stay as-is. */
function lowerPreservingLength(text: string): string {
	let folded = "";
	for (let index = 0; index < text.length; index++) {
		const lower = text[index]!.toLowerCase();
		folded += lower.length === 1 ? lower : text[index]!;
	}
	return folded;
}

function substringSpans(text: string, token: string, firstOnly: boolean): TextSpan[] {
	const spans: TextSpan[] = [];
	if (token === "") return spans;
	const haystack = lowerPreservingLength(text);
	const needle = token.toLowerCase();
	for (let start = haystack.indexOf(needle); start !== -1; start = haystack.indexOf(needle, start + 1)) {
		spans.push({ start, end: start + needle.length });
		if (firstOnly) break;
	}
	return spans;
}

function strippedSubstringSpans(text: string, token: string, firstOnly: boolean): TextSpan[] {
	const needle = stripSeparators(token).toLowerCase();
	if (needle === "") return [];

	const offsets: number[] = [];
	const kept: string[] = [];
	for (let index = 0; index < text.length; index++) {
		const character = text[index]!;
		if (SEPARATOR_CLASS.test(character)) continue;
		offsets.push(index);
		kept.push(character);
	}
	const haystack = lowerPreservingLength(kept.join(""));

	const spans: TextSpan[] = [];
	for (let start = haystack.indexOf(needle); start !== -1; start = haystack.indexOf(needle, start + 1)) {
		const first = offsets[start];
		const last = offsets[start + needle.length - 1];
		if (first === undefined || last === undefined) break;
		spans.push({ start: first, end: last + 1 });
		if (firstOnly) break;
	}
	return spans;
}

function swappedAlphaNumericToken(token: string): string | undefined {
	const alphaNumeric = /^(?<letters>[a-z]+)(?<digits>[0-9]+)$/i.exec(token);
	if (alphaNumeric?.groups) return `${alphaNumeric.groups.digits}${alphaNumeric.groups.letters}`;

	const numericAlpha = /^(?<digits>[0-9]+)(?<letters>[a-z]+)$/i.exec(token);
	if (numericAlpha?.groups) return `${numericAlpha.groups.letters}${numericAlpha.groups.digits}`;

	return undefined;
}

function greedySubsequenceSpans(token: string, text: string): TextSpan[] {
	const query = token.toLowerCase();
	const haystack = text.toLowerCase();
	const positions: number[] = [];
	let from = 0;

	for (const character of query) {
		const position = haystack.indexOf(character, from);
		if (position === -1) return [];
		positions.push(position);
		from = position + 1;
	}

	const spans: TextSpan[] = [];
	for (const position of positions) {
		const previous = spans.at(-1);
		if (previous && previous.end === position) previous.end++;
		else spans.push({ start: position, end: position + 1 });
	}
	return spans;
}

/** Spans for a key-matched token inside a displayed text segment (tag or detail). */
function keyTokenSpans(token: string, text: string): TextSpan[] {
	const substrings = substringSpans(text, token, false);
	if (substrings.length > 0) return substrings;

	const stripped = strippedSubstringSpans(text, token, false);
	if (stripped.length > 0) return stripped;

	const direct = greedySubsequenceSpans(token, text);
	if (direct.length > 0) return direct;

	const swapped = swappedAlphaNumericToken(token);
	return swapped === undefined ? [] : greedySubsequenceSpans(swapped, text);
}

/** Spans for a body-matched token: exact substring first, stripped mapping second. */
function bodyTokenSpans(text: string, token: string, firstOnly: boolean): TextSpan[] {
	const substrings = substringSpans(text, token, firstOnly);
	if (substrings.length > 0) return substrings;
	return strippedSubstringSpans(text, token, firstOnly);
}

function mergeSpans(spans: readonly TextSpan[]): TextSpan[] {
	const sorted = [...spans].sort((left, right) => left.start - right.start || left.end - right.end);
	const merged: TextSpan[] = [];
	for (const span of sorted) {
		const previous = merged.at(-1);
		if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
		else merged.push({ ...span });
	}
	return merged;
}

function sanitizedSpans(
	rawText: string,
	spans: readonly TextSpan[],
): { text: string; spans: TextSpan[] } {
	const text = sanitizeTerminalText(rawText);
	const rawSpans = spans
		.filter((span) => Number.isFinite(span.start) && Number.isFinite(span.end) && span.end > span.start)
		.map((span) => {
			const start = Math.max(0, Math.min(rawText.length, Math.floor(span.start)));
			return { start, end: Math.max(start, Math.min(rawText.length, Math.floor(span.end))) };
		})
		.filter((span) => span.end > span.start);

	let normalized: TextSpan[];
	if (text === rawText) {
		normalized = rawSpans;
	} else {
		const boundaries = [...new Set(rawSpans.flatMap((span) => [span.start, span.end]))]
			.sort((left, right) => left - right);
		const sanitizedOffsets = new Map<number, number>();
		let rawOffset = 0;
		let sanitizedOffset = 0;
		for (const boundary of boundaries) {
			sanitizedOffset += sanitizeTerminalText(rawText.slice(rawOffset, boundary)).length;
			sanitizedOffsets.set(boundary, Math.min(text.length, sanitizedOffset));
			rawOffset = boundary;
		}
		normalized = rawSpans.map((span) => ({
			start: sanitizedOffsets.get(span.start) ?? 0,
			end: sanitizedOffsets.get(span.end) ?? text.length,
		}));
	}
	normalized = normalized.filter((span) => span.end > span.start);

	return { text, spans: mergeSpans(normalized) };
}

function applySpanStyles(
	text: string,
	spans: readonly TextSpan[],
	baseStyle: (text: string) => string,
	highlightStyle: (text: string) => string,
): string {
	if (spans.length === 0) return baseStyle(text);

	const parts: string[] = [];
	let cursor = 0;
	for (const span of spans) {
		if (span.start > cursor) parts.push(baseStyle(text.slice(cursor, span.start)));
		parts.push(highlightStyle(text.slice(span.start, span.end)));
		cursor = span.end;
	}
	if (cursor < text.length) parts.push(baseStyle(text.slice(cursor)));
	return parts.join("");
}

function styledHighlightedText(
	rawText: string,
	spans: readonly TextSpan[],
	baseStyle: (text: string) => string,
	highlightStyle: (text: string) => string,
): string {
	const safe = sanitizedSpans(rawText, spans);
	return applySpanStyles(safe.text, safe.spans, baseStyle, highlightStyle);
}

/** Grep-style excerpt around the first match, marked with ⋯ at clipped ends. */
function styledMatchExcerpt(
	rawText: string,
	spans: readonly TextSpan[],
	maximumCharacters: number,
	baseStyle: (text: string) => string,
	highlightStyle: (text: string) => string,
): string {
	const safe = sanitizedSpans(rawText, spans);
	const focus = safe.spans[0];
	// Reserve room for the ⋯ markers so the clamped row never cuts them off.
	const budget = Math.max(1, safe.text.length > maximumCharacters ? maximumCharacters - 4 : maximumCharacters);
	let start = focus === undefined ? 0 : Math.max(0, focus.start - Math.floor(budget / 3));
	let end = Math.min(safe.text.length, start + budget);
	if (focus && focus.end > end) {
		end = Math.min(safe.text.length, focus.end + Math.floor(budget / 3));
		start = Math.max(0, end - budget);
	}
	const excerptSpans = safe.spans
		.filter((span) => span.end > start && span.start < end)
		.map((span) => ({ start: Math.max(0, span.start - start), end: Math.min(end - start, span.end - start) }));
	const excerpt = applySpanStyles(
		safe.text.slice(start, end),
		excerptSpans,
		baseStyle,
		highlightStyle,
	).replace(/\s+/gu, " ").trim();
	return `${start > 0 ? baseStyle("⋯ ") : ""}${excerpt}${end < safe.text.length ? baseStyle(" ⋯") : ""}`;
}

function canonicalBodySpans(block: Block, bodySpans: readonly TextSpan[], content: string): TextSpan[] {
	if (bodySpans.length === 0) return [];
	if (content === block.body) return [...bodySpans];
	const bodyOffset = block.canonicalBodyOffset;
	if (content !== block.canonicalText || bodyOffset === undefined) return [];
	return bodySpans.map((span) => ({
		start: span.start + bodyOffset,
		end: span.end + bodyOffset,
	}));
}

function clampLine(line: string, width: number): string {
	return truncateToWidth(line, width, "");
}

function wrapStyledText(text: string, width: number): string[] {
	if (width === 0) return [];
	return wrapTextWithAnsi(text, width).map((line) => clampLine(line, width));
}

// Block identity

function shortTime(timestamp: string): string {
	const match = /T(\d{2}:\d{2})/u.exec(timestamp);
	return match === null ? singleLine(timestamp) : match[1]!;
}

/** Aligned tag-column text: tool name for tool blocks, a short role label otherwise. */
export function formatBlockTag(block: Block): string {
	if (block.kind === "tool") return singleLine(block.toolName ?? "") || singleLine(block.title) || "tool";
	if (block.kind === "assistant") return "Assistant";
	if (block.kind === "user") return "User";
	return singleLine(block.title) || block.kind;
}

/** Identity for the titled preview rule: tag · HH:MM. */
export function formatPreviewIdentity(block: Block): string {
	return `${formatBlockTag(block)} · ${shortTime(block.timestamp)}`;
}

/** Identity for the detail-mode top border: kind[/tool] · HH:MM · distinct title. */
export function formatDetailIdentity(block: Block): string {
	const toolName = singleLine(block.toolName ?? "");
	const kindPart = block.kind === "tool" && toolName !== "" ? `tool/${toolName}` : block.kind;
	const pieces = [kindPart, shortTime(block.timestamp)];
	const title = singleLine(block.title);
	if (
		title !== ""
		&& title.toLowerCase() !== block.kind.toLowerCase()
		&& kindPart.toLowerCase() !== `tool/${title.toLowerCase()}`
	) {
		pieces.push(title);
	}
	return pieces.join(" · ");
}

// Row detail text

const TAG_WIDTH_LIMIT = 16;

export function computeTagWidth(values: readonly RenderBlock[]): number {
	let width = 4;
	for (const value of values) {
		const { block } = unpack(value);
		width = Math.max(width, Math.min(TAG_WIDTH_LIMIT, visibleWidth(singleLine(formatBlockTag(block)))));
	}
	return width;
}

function firstBodyLine(body: string): string {
	for (const line of sanitizeTerminalText(body).split("\n")) {
		const compact = line.replace(/\s+/gu, " ").trim();
		if (compact !== "") return compact;
	}
	return "";
}

export function formatSubagentFields(view: SubagentView): string {
	return (view.rowFields ?? view.fields).map((field) => `${field.key}=${field.value}`).join(" ");
}

export function formatSubagentTable(view: SubagentView): string {
	const keyWidth = Math.max(0, ...view.fields.map((field) => visibleWidth(field.key)));
	return view.fields
		.map((field) => `${field.key}${" ".repeat(keyWidth - visibleWidth(field.key) + 2)}${field.value}`)
		.join("\n");
}

export function formatSubagentResultDivider(width: number): string {
	const maxWidth = safeWidth(width);
	if (maxWidth === 0) return "";
	const prefix = fitText("─ result details ", maxWidth, "");
	return prefix + "─".repeat(Math.max(0, maxWidth - visibleWidth(prefix)));
}

/** Displayed preview/detail text: parsed result responses precede their canonical metadata table. */
export function displayContent(block: Block, width = 80): string {
	const view = subagentView(block);
	if (view !== undefined) {
		if (view.result) {
			const table = formatSubagentTable(view);
			return view.content !== "" && table !== ""
				? [view.content, formatSubagentResultDivider(width), table].join("\n\n")
				: [view.content, table].filter((text) => text !== "").join("\n\n");
		}
		return [formatSubagentFields(view), view.content].filter((text) => text !== "").join("\n\n");
	}
	return block.body !== "" ? block.body : block.canonicalText;
}

function rowDetailText(block: Block): string {
	const view = subagentView(block);
	if (view !== undefined && view.fields.length > 0) return formatSubagentFields(view);
	if (block.kind === "tool" || block.kind === "bash") {
		const subtitle = singleLine(block.subtitle ?? "");
		if (subtitle !== "") return subtitle;
	}
	return firstBodyLine(block.body);
}

function shrinkPathValue(value: string): string | undefined {
	let remainder = value.startsWith("…/") ? value.slice(2) : value;
	if (remainder.startsWith("/")) remainder = remainder.slice(1);
	const slash = remainder.indexOf("/");
	if (slash === -1) return undefined;
	const tail = remainder.slice(slash + 1);
	return tail === "" ? undefined : `…/${tail}`;
}

function shrinkPathWord(word: string): string | undefined {
	const separator = word.indexOf("=");
	const prefix = separator === -1 ? "" : word.slice(0, separator + 1);
	const value = separator === -1 ? word : word.slice(separator + 1);
	const shrunk = shrinkPathValue(value);
	return shrunk === undefined ? undefined : `${prefix}${shrunk}`;
}

/** Fit text into width, collapsing path prefixes so their tails survive. */
export function tailAwareTruncate(text: string, width: number): string {
	const maxWidth = safeWidth(width);
	if (maxWidth === 0) return "";
	let compact = singleLine(text);
	if (visibleWidth(compact) <= maxWidth) return compact;

	const words = compact.split(" ");
	while (visibleWidth(compact) > maxWidth) {
		let longestIndex = -1;
		for (let index = 0; index < words.length; index++) {
			if (shrinkPathWord(words[index]!) === undefined) continue;
			if (longestIndex === -1 || words[index]!.length > words[longestIndex]!.length) longestIndex = index;
		}
		if (longestIndex === -1) break;
		words[longestIndex] = shrinkPathWord(words[longestIndex]!)!;
		compact = words.join(" ");
	}
	return truncateToWidth(compact, maxWidth, "…");
}

/** Build the explicit status shown whenever the stored session output was truncated. */
export function formatTruncationMarker(
	truncation: BlockTruncation | undefined,
	pathExists: PathExists = () => false,
): string | undefined {
	if (truncation === undefined) return undefined;
	const outputLines = truncation.metadata?.outputLines;
	const totalLines = truncation.metadata?.totalLines;
	let kept: string;
	if (
		typeof outputLines === "number" && Number.isFinite(outputLines) && outputLines >= 0 &&
		typeof totalLines === "number" && Number.isFinite(totalLines) && totalLines >= 0
	) {
		kept = `${Math.floor(outputLines)}/${Math.floor(totalLines)} lines kept`;
	} else if (typeof outputLines === "number" && Number.isFinite(outputLines) && outputLines >= 0) {
		kept = `${Math.floor(outputLines)} lines kept; total unknown`;
	} else if (typeof totalLines === "number" && Number.isFinite(totalLines) && totalLines >= 0) {
		kept = `${Math.floor(totalLines)} total lines; kept count unknown`;
	} else {
		kept = "line counts unavailable";
	}

	const rawPath = truncation.fullOutputPath;
	if (rawPath === undefined || rawPath === "") {
		return `[stored output truncated: ${kept}; omitted output unavailable]`;
	}
	let exists = false;
	try {
		exists = pathExists(rawPath);
	} catch {
		exists = false;
	}
	const path = singleLine(rawPath) || "(unprintable path)";
	return exists
		? `[stored output truncated: ${kept}; full output available: ${path}]`
		: `[stored output truncated: ${kept}; full-output file missing: ${path}]`;
}

// Rows

/**
 * Format one list row: selection marker, aligned bold tag column, then detail
 * text — or a grep-style body excerpt when only the body matched.
 */
export function formatResultRow(
	value: RenderBlock,
	selected: boolean,
	width: number,
	tagWidth: number,
	styleOverrides: RenderStyleOverrides = {},
): string {
	const maxWidth = safeWidth(width);
	if (maxWidth === 0) return "";
	const { block, keyTokens, bodyTokens } = unpack(value);
	const styles = renderStyles(styleOverrides);

	const marker = selected ? styles.accent("▸ ") : "  ";
	const column = Math.max(1, Math.min(tagWidth, maxWidth - 2));
	const tagText = truncateToWidth(singleLine(formatBlockTag(block)), column, "…");
	const tagSpans = mergeSpans(keyTokens.flatMap((token) => keyTokenSpans(token, tagText)));
	const tag = applySpanStyles(tagText, tagSpans, (text) => styles.title(text), styles.highlight)
		+ " ".repeat(Math.max(0, column - visibleWidth(tagText)));

	const detailWidth = maxWidth - 2 - column - 2;
	if (detailWidth <= 0) return clampLine(`${marker}${tag}`, maxWidth);

	// A row whose only hit is in the body swaps its detail for the match excerpt.
	let detail: string;
	if (keyTokens.length === 0 && bodyTokens.length > 0) {
		const spans = mergeSpans(bodyTokens.flatMap((token) => bodyTokenSpans(block.body, token, true)));
		detail = styledMatchExcerpt(block.body, spans, detailWidth, styles.dim, styles.highlight);
	} else {
		const detailText = tailAwareTruncate(rowDetailText(block), detailWidth);
		const detailSpans = mergeSpans(keyTokens.flatMap((token) => keyTokenSpans(token, detailText)));
		detail = styledHighlightedText(detailText, detailSpans, styles.muted, styles.highlight);
	}
	return clampLine(`${marker}${tag}  ${detail}`, maxWidth);
}

// Preview and detail content

function previewClippedMarker(styles: RenderStyles): string {
	return styles.dim("[preview clipped; enter opens the complete detail]");
}

/** Format the bounded preview pane body: wrapped block content with body-match highlights. */
export function formatPreviewLines(
	value: RenderBlock,
	width: number,
	maxLines = 8,
	styleOverrides: RenderStyleOverrides = {},
	pathExists: PathExists = () => false,
): string[] {
	const maxWidth = safeWidth(width);
	const lineLimit = Number.isFinite(maxLines) && maxLines > 0 ? Math.floor(maxLines) : 0;
	if (maxWidth === 0 || lineLimit === 0) return [];
	const { block, bodyTokens } = unpack(value);
	const styles = renderStyles(styleOverrides);

	// Matched tokens are re-derived against whatever text is displayed, so the
	// subagent field/content transformation keeps its highlights.
	const content = displayContent(block, maxWidth);
	const spans = mergeSpans(bodyTokens.flatMap((token) => bodyTokenSpans(content, token, false)));
	const styledContent = styledHighlightedText(content, spans, styles.body, styles.highlight);
	const contentLines = wrapStyledText(styledContent, maxWidth);
	if (contentLines.length === 0) contentLines.push(styles.dim("(empty block)"));

	const rawTruncationMarker = formatTruncationMarker(block.truncation, pathExists);
	const fixedTail = rawTruncationMarker === undefined
		? []
		: [clampLine(styles.dim(rawTruncationMarker), maxWidth)];
	if (fixedTail.length >= lineLimit) return fixedTail.slice(-lineLimit);

	const room = lineLimit - fixedTail.length;
	let available = room;
	const clipped = contentLines.length > available;
	if (clipped && available > 1) available--;
	const lines = contentLines.slice(0, available);
	if (clipped && lines.length < room) lines.push(clampLine(previewClippedMarker(styles), maxWidth));
	lines.push(...fixedTail);
	return lines.slice(0, lineLimit).map((line) => clampLine(line, maxWidth));
}

/** Format every content line in the full detail view; the controller owns scrolling. */
export function formatDetailLines(
	value: RenderBlock,
	width: number,
	styleOverrides: RenderStyleOverrides = {},
	pathExists: PathExists = () => false,
): string[] {
	const maxWidth = safeWidth(width);
	if (maxWidth === 0) return [];
	const { block, bodyTokens } = unpack(value);
	const styles = renderStyles(styleOverrides);

	const content = block.canonicalText !== "" ? block.canonicalText : block.body;
	const bodySpans = mergeSpans(bodyTokens.flatMap((token) => bodyTokenSpans(block.body, token, false)));
	const styledContent = styledHighlightedText(
		content,
		canonicalBodySpans(block, bodySpans, content),
		styles.body,
		styles.highlight,
	);
	const lines = wrapStyledText(styledContent, maxWidth);
	if (lines.length === 0) lines.push(styles.dim("(empty block)"));

	const truncationMarker = formatTruncationMarker(block.truncation, pathExists);
	if (truncationMarker !== undefined) lines.push(clampLine(styles.dim(truncationMarker), maxWidth));
	return lines.map((line) => clampLine(line, maxWidth));
}

// Border chrome
//
// All chrome lives in the border: titles and counts sit inside the top border,
// section rules carry the preview identity, and keybind hints fill the bottom
// border, degrading to the highest-priority keys when narrow.

const BORDER_HORIZONTAL = "─";

export function formatBorderLine(
	width: number,
	corners: readonly [string, string],
	leftText = "",
	rightText = "",
	borderStyle: (text: string) => string = identity,
): string {
	const maxWidth = safeWidth(width);
	if (maxWidth === 0) return "";
	if (maxWidth === 1) return borderStyle(corners[0]);
	const inner = maxWidth - 2;

	let right = rightText === "" ? "" : ` ${rightText} `;
	if (visibleWidth(right) > inner) right = "";
	const leftBudget = inner - visibleWidth(right);
	const leftInner = leftText === "" ? "" : truncateToWidth(leftText, Math.max(0, leftBudget - 2), "…");
	const left = visibleWidth(leftInner) === 0 ? "" : ` ${leftInner} `;

	const fill = inner - visibleWidth(left) - visibleWidth(right);
	return borderStyle(corners[0])
		+ left
		+ borderStyle(BORDER_HORIZONTAL.repeat(Math.max(0, fill)))
		+ right
		+ borderStyle(corners[1]);
}

/** Bottom border filled with hints in priority order; later hints drop first. */
export function formatHintBorder(
	width: number,
	hints: readonly string[],
	styleOverrides: RenderStyleOverrides = {},
): string {
	const styles = renderStyles(styleOverrides);
	const maxWidth = safeWidth(width);
	const inner = Math.max(0, maxWidth - 2);

	let chosen = "";
	for (const hint of hints) {
		const candidate = chosen === "" ? hint : `${chosen} · ${hint}`;
		if (visibleWidth(candidate) + 2 > inner) break;
		chosen = candidate;
	}
	if (chosen === "" && hints.length > 0) {
		chosen = truncateToWidth(hints[0]!, Math.max(0, inner - 2), "…");
	}
	return formatBorderLine(
		maxWidth,
		["└", "┘"],
		chosen === "" ? "" : styles.muted(chosen),
		"",
		styles.border,
	);
}

/** Wrap one interior content line in side borders with one cell of padding. */
export function formatFrameLine(
	width: number,
	content: string,
	borderStyle: (text: string) => string = identity,
): string {
	const maxWidth = safeWidth(width);
	if (maxWidth === 0) return "";
	const innerWidth = Math.max(0, maxWidth - 4);
	const clamped = clampLine(content, innerWidth);
	const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clamped)));
	return clampLine(`${borderStyle("│")} ${clamped}${padding} ${borderStyle("│")}`, maxWidth);
}
