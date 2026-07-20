import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type {
	Block,
	BlockTruncation,
	HighlightSpan,
	SearchResult,
} from "./types.ts";

export interface RenderStyles {
	title: (text: string) => string;
	accent: (text: string) => string;
	muted: (text: string) => string;
	dim: (text: string) => string;
	body: (text: string) => string;
	selected: (text: string) => string;
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
	selected: identity,
	highlight: identity,
	border: identity,
});

function renderStyles(overrides: RenderStyleOverrides): RenderStyles {
	return { ...PLAIN_RENDER_STYLES, ...overrides };
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
	spans: readonly HighlightSpan[];
	bodyTokens: readonly string[];
} {
	if ("block" in value && "match" in value) {
		return {
			block: value.block,
			spans: value.match.highlightSpans,
			bodyTokens: value.match.bodyHighlightTokens ?? [],
		};
	}
	return { block: value, spans: [], bodyTokens: [] };
}

interface TextSpan {
	start: number;
	end: number;
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
	normalized = normalized
		.filter((span) => span.end > span.start)
		.sort((left, right) => left.start - right.start || left.end - right.end);

	const merged: TextSpan[] = [];
	for (const span of normalized) {
		const previous = merged.at(-1);
		if (previous !== undefined && span.start <= previous.end) {
			previous.end = Math.max(previous.end, span.end);
		} else {
			merged.push({ ...span });
		}
	}
	return { text, spans: merged };
}

function styledHighlightedText(
	rawText: string,
	spans: readonly TextSpan[],
	baseStyle: (text: string) => string,
	highlightStyle: (text: string) => string,
): string {
	const safe = sanitizedSpans(rawText, spans);
	if (safe.spans.length === 0) return baseStyle(safe.text);

	const parts: string[] = [];
	let cursor = 0;
	for (const span of safe.spans) {
		if (span.start > cursor) parts.push(baseStyle(safe.text.slice(cursor, span.start)));
		parts.push(highlightStyle(safe.text.slice(span.start, span.end)));
		cursor = span.end;
	}
	if (cursor < safe.text.length) parts.push(baseStyle(safe.text.slice(cursor)));
	return parts.join("");
}

function styledMatchExcerpt(
	rawText: string,
	spans: readonly TextSpan[],
	maximumCharacters: number,
	baseStyle: (text: string) => string,
	highlightStyle: (text: string) => string,
): string {
	const safe = sanitizedSpans(rawText, spans);
	const focus = safe.spans[0];
	let start = focus === undefined ? 0 : Math.max(0, focus.start - Math.floor(maximumCharacters / 3));
	let end = Math.min(safe.text.length, start + maximumCharacters);
	if (focus && focus.end > end) {
		end = Math.min(safe.text.length, focus.end + Math.floor(maximumCharacters / 3));
		start = Math.max(0, end - maximumCharacters);
	}
	const excerptSpans = safe.spans
		.filter((span) => span.end > start && span.start < end)
		.map((span) => ({ start: Math.max(0, span.start - start), end: Math.min(end - start, span.end - start) }));
	const excerpt = styledHighlightedText(
		safe.text.slice(start, end),
		excerptSpans,
		baseStyle,
		highlightStyle,
	).replace(/\s+/gu, " ").trim();
	return `${start > 0 ? baseStyle("…") : ""}${excerpt}${end < safe.text.length ? baseStyle("…") : ""}`;
}

function spansForZone(spans: readonly HighlightSpan[], zone: HighlightSpan["zone"]): TextSpan[] {
	return spans
		.filter((span) => span.zone === zone)
		.map(({ start, end }) => ({ start, end }));
}

function bodyHighlightSpans(
	body: string,
	spans: readonly HighlightSpan[],
	tokens: readonly string[],
	allOccurrences: boolean,
): TextSpan[] {
	const matches = spansForZone(spans, "body");
	const bodyLower = body.toLowerCase();
	for (const token of tokens) {
		const tokenLower = token.toLowerCase();
		if (tokenLower === "") continue;
		for (
			let start = bodyLower.indexOf(tokenLower);
			start !== -1;
			start = allOccurrences ? bodyLower.indexOf(tokenLower, start + 1) : -1
		) {
			matches.push({ start, end: start + token.length });
		}
	}
	return matches;
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

function compactTimestamp(timestamp: string): string {
	const safe = singleLine(timestamp);
	const isoMatch = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?)/u.exec(safe);
	return isoMatch === null ? safe : `${isoMatch[1]} ${isoMatch[2]}`;
}

function blockHeader(block: Block, styles: RenderStyles, compactWidth?: number): string {
	const title = singleLine(block.title) || singleLine(block.toolName ?? "") || block.kind;
	const primary = singleLine(block.fileReference?.path ?? block.subtitle ?? "");
	const compact = (text: string): string => compactWidth === undefined
		? text
		: truncateToWidth(text, compactWidth, "…");
	const pieces = [styles.title(compact(title))];
	if (primary !== "" && primary !== title) pieces.push(styles.muted(" "), styles.accent(compact(primary)));
	pieces.push(styles.muted(` · ${block.kind}`));
	if (block.isError === true) pieces.push(styles.muted(" · error"));
	if (block.label !== undefined && singleLine(block.label) !== "") {
		pieces.push(styles.muted(" · label "), styles.accent(compact(singleLine(block.label))));
	}
	return pieces.join("");
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

/** Format one chronological result row with a match-centered compact preview. */
export function formatResultRow(
	value: RenderBlock,
	selected: boolean,
	width: number,
	styleOverrides: RenderStyleOverrides = {},
): string {
	const maxWidth = safeWidth(width);
	if (maxWidth === 0) return "";
	const { block, spans, bodyTokens } = unpack(value);
	const styles = renderStyles(styleOverrides);
	const bodySpans = bodyHighlightSpans(block.body, spans, bodyTokens, false);
	const fieldSpans = spansForZone(spans, "fields");
	const headerPartWidth = Math.max(10, Math.floor(maxWidth / (bodySpans.length > 0 ? 8 : 4)));
	const pieces = [
		selected ? "› " : "  ",
		blockHeader(block, styles, headerPartWidth),
	];
	const showBody = bodySpans.length > 0 || (fieldSpans.length === 0 && block.body !== "");
	const previewText = showBody ? block.body : block.fields;
	const previewSpans = showBody ? bodySpans : fieldSpans;
	if (singleLine(previewText) !== "") {
		pieces.push(
			styles.muted(" · "),
			styledMatchExcerpt(previewText, previewSpans, Math.max(24, maxWidth), styles.dim, styles.highlight),
		);
	}
	const timestamp = compactTimestamp(block.timestamp);
	if (timestamp !== "") pieces.push(styles.muted(` · ${timestamp}`));
	const row = clampLine(pieces.join(""), maxWidth);
	return clampLine(selected ? styles.selected(row) : row, maxWidth);
}

function previewClippedMarker(styles: RenderStyles): string {
	return styles.dim("[preview clipped; enter opens the complete detail]");
}

/** Format the bounded bottom preview pane. */
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
	const { block, spans, bodyTokens } = unpack(value);
	const styles = renderStyles(styleOverrides);
	const content = block.canonicalText !== "" ? block.canonicalText : block.body;
	const bodySpans = bodyHighlightSpans(block.body, spans, bodyTokens, true);
	const contentSpans = canonicalBodySpans(block, bodySpans, content);
	const styledContent = styledHighlightedText(content, contentSpans, styles.body, styles.highlight);
	const contentLines = wrapStyledText(styledContent, maxWidth);
	if (contentLines.length === 0) contentLines.push(styles.dim("(empty block)"));

	const header = clampLine(`${styles.border("Preview")} ${styles.muted("·")} ${blockHeader(block, styles)}`, maxWidth);
	const fieldSpans = spansForZone(spans, "fields");
	const fieldMatchLine = fieldSpans.length === 0
		? undefined
		: clampLine(
			`${styles.muted("match · ")}${styledMatchExcerpt(block.fields, fieldSpans, Math.max(24, maxWidth), styles.muted, styles.highlight)}`,
			maxWidth,
		);
	const rawTruncationMarker = formatTruncationMarker(block.truncation, pathExists);
	const sourceMarker = rawTruncationMarker === undefined
		? undefined
		: clampLine(styles.dim(rawTruncationMarker), maxWidth);
	const fixedTail = sourceMarker === undefined ? [] : [sourceMarker];
	if (fixedTail.length >= lineLimit) return fixedTail.slice(-lineLimit);

	const headCandidates = fieldMatchLine === undefined ? [header] : [header, fieldMatchLine];
	const roomBeforeTail = lineLimit - fixedTail.length;
	const headLines = headCandidates.slice(0, Math.max(0, roomBeforeTail - 1));
	let availableContent = Math.max(1, roomBeforeTail - headLines.length);
	const clipped = contentLines.length > availableContent;
	if (clipped && availableContent > 1) availableContent--;
	const lines = [...headLines, ...contentLines.slice(0, availableContent)];
	if (clipped && lines.length < roomBeforeTail) {
		lines.push(clampLine(previewClippedMarker(styles), maxWidth));
	}
	lines.push(...fixedTail);
	return lines.slice(0, lineLimit).map((line) => clampLine(line, maxWidth));
}

/** Format every line in the full detail view; the controller owns scrolling. */
export function formatDetailLines(
	value: RenderBlock,
	width: number,
	styleOverrides: RenderStyleOverrides = {},
	pathExists: PathExists = () => false,
): string[] {
	const maxWidth = safeWidth(width);
	if (maxWidth === 0) return [];
	const { block, spans, bodyTokens } = unpack(value);
	const styles = renderStyles(styleOverrides);
	const lines: string[] = [clampLine(blockHeader(block, styles), maxWidth)];
	const fields = singleLine(block.fields);
	if (fields !== "") {
		lines.push(clampLine(
			styledMatchExcerpt(
				block.fields,
				spansForZone(spans, "fields"),
				Math.max(24, maxWidth),
				styles.muted,
				styles.highlight,
			),
			maxWidth,
		));
	}
	lines.push(clampLine(styles.border("─".repeat(maxWidth)), maxWidth));

	const content = block.canonicalText !== "" ? block.canonicalText : block.body;
	const styledContent = styledHighlightedText(
		content,
		canonicalBodySpans(block, bodyHighlightSpans(block.body, spans, bodyTokens, true), content),
		styles.body,
		styles.highlight,
	);
	const contentLines = wrapStyledText(styledContent, maxWidth);
	lines.push(...(contentLines.length === 0 ? [styles.dim("(empty block)")] : contentLines));

	const truncationMarker = formatTruncationMarker(block.truncation, pathExists);
	if (truncationMarker !== undefined) lines.push(clampLine(styles.dim(truncationMarker), maxWidth));
	return lines.map((line) => clampLine(line, maxWidth));
}

/** Format width-safe footer hints for list, filter, and detail actions. */
export function formatHelpFooter(
	width: number,
	smartOpenHint: string,
	styleOverrides: RenderStyleOverrides = {},
	mode: "list" | "filter" | "detail" = "list",
): string[] {
	const maxWidth = safeWidth(width);
	if (maxWidth === 0) return [];
	const styles = renderStyles(styleOverrides);
	const rawOpenHint = singleLine(smartOpenHint) || "smart open";
	const openHint = truncateToWidth(rawOpenHint, Math.max(12, Math.floor(maxWidth / 2)), "…");
	const separator = styles.dim(" · ");
	const actionParts = mode === "filter"
		? [
			styles.muted("type query"), separator,
			styles.accent("↑/↓"), styles.dim(" move"), separator,
			styles.accent("ctrl+u"), styles.dim(" clear"), separator,
			styles.accent("enter"), styles.dim(" detail"), separator,
			styles.accent("esc"), styles.dim(" list"), separator,
		]
		: mode === "detail"
			? [
				styles.accent("j/k ↑/↓"), styles.dim(" scroll"), separator,
				styles.accent("u/d"), styles.dim(" page"), separator,
				styles.accent("J/K"), styles.dim(" blocks"), separator,
				styles.accent("y"), styles.dim(" copy"), separator,
				styles.accent("o"), styles.dim(` ${openHint}`), separator,
				styles.accent("esc"), styles.dim(" list"), separator,
			]
			: [
				styles.accent("j/k ↑/↓"), styles.dim(" move"), separator,
				styles.accent("u/d"), styles.dim(" page"), separator,
				styles.accent("g/G"), styles.dim(" ends"), separator,
				styles.accent("/"), styles.dim(" filter"), separator,
				styles.accent("enter"), styles.dim(" detail"), separator,
				styles.accent("y"), styles.dim(" copy"), separator,
				styles.accent("o"), styles.dim(` ${openHint}`), separator,
				styles.accent("esc"), styles.dim(" close"), separator,
			];
	const hint = [
		...actionParts,
		styles.muted("query "), styles.highlight("is:<type>"), styles.muted(" "), styles.highlight("tool:<name>"),
	].join("");
	return wrapStyledText(hint, maxWidth);
}
