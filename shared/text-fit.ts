/**
 * text-fit.ts - width-fitting for TUI lines without `\x1b[0m` resets.
 *
 * pi-tui's truncateToWidth wraps its cut point and ellipsis in full SGR
 * resets. theme.bg() styles a card line by wrapping it once, so a mid-line
 * `[0m` also resets the background and everything after it renders on the
 * terminal default - the stray bright cells of issue #93. These helpers cut
 * without ever emitting `[0m`: attributes left open at the cut are closed
 * individually, leaving any enclosing background untouched.
 */

import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

/** Closes fg color and text attributes while leaving the background open. */
const END_STYLES = "\x1b[39;22;23;24;27;29m";

function cut(text: string, maxWidth: number, ellipsis: string): string {
	const ellipsisWidth = visibleWidth(ellipsis);
	if (ellipsisWidth >= maxWidth) return sliceByColumn(ellipsis, 0, maxWidth, true);
	const kept = sliceByColumn(text, 0, maxWidth - ellipsisWidth, true);
	return kept.includes("\x1b") ? kept + END_STYLES + ellipsis : kept + ellipsis;
}

/**
 * Truncate to maxWidth, appending an ellipsis when text was cut. Plain-text
 * input stays plain, so a style applied around the result also covers the
 * ellipsis; styled input gets its dangling attributes closed first.
 */
export function fitText(text: string, maxWidth: number, ellipsis = "…"): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(text) <= maxWidth) return text;
	return cut(text, maxWidth, ellipsis);
}

/** Hard width clamp for already-styled lines: cut without an ellipsis. */
export function clampStyled(line: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(line) <= maxWidth) return line;
	return cut(line, maxWidth, "");
}
