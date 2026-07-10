/**
 * widget.ts — rendering the running-subagents widget.
 *
 * The style: a bracketed agent-type tag, the task-focused display name, and
 * a right-anchored elapsed clock — no status column, no counts or hints.
 * A row EXISTING means that child is running, and the right edge is
 * reserved for v2's live activity states (`· bash 7m`).
 *
 *   ──────────────────────────────────────────────────────
 *   [scout]   Auth                                     00:23
 *   [worker]  quick fix                                00:04
 *
 * A faded rule tops the block to separate it from the transcript, the clock
 * sits one space off the edge and renders dim. Styling is injected as plain
 * string-wrapping functions (theme colors in pi, identity in tests), so this
 * module stays dependency-free and unit-testable.
 */

import { sanitizeDisplayText } from "./display-text.ts";

/** Optional styling hooks; identity (no styling) when omitted. */
export interface WidgetStyle {
	/** Applied to the elapsed clock (pi passes the theme's dim color). */
	dim?: (text: string) => string;
	/** Applied to the top rule (pi passes the theme's muted border color). */
	border?: (text: string) => string;
}

export interface WidgetRow {
	/** Display name — the `name` the model chose at spawn time. */
	name: string;
	/** Agent type ("worker", "scout", …). Missing only when a resume found no
	 * `.meta` launch metadata (a session not launched by this extension). */
	agent?: string;
	elapsedSeconds: number;
}

/** Zero-padded MM:SS, growing to H:MM:SS past an hour. */
export function formatElapsed(totalSeconds: number): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * The tag column states the agent type, so a name that repeats it
 * ("Scout: Auth" next to [scout]) is redundant — strip the exact type prefix
 * plus a separator, for DISPLAY only. Anything less exact stays untouched.
 */
export function stripAgentPrefix(name: string, agent: string | undefined): string {
	const safeName = sanitizeDisplayText(name);
	const safeAgent = agent === undefined ? undefined : sanitizeDisplayText(agent);
	if (!safeAgent) return safeName;
	const match = safeName.match(/^(\S+)\s*[:\-–—]\s*(.+)$/);
	if (match && match[1].toLowerCase() === safeAgent.toLowerCase() && match[2].trim() !== "") {
		return match[2].trim();
	}
	return safeName;
}

export function formatRunningWidgetLines(rows: WidgetRow[], width: number, style: WidgetStyle = {}): string[] {
	const dim = style.dim ?? ((text: string) => text);
	const border = style.border ?? ((text: string) => text);

	const safeRows = rows.map((row) => ({
		...row,
		name: sanitizeDisplayText(row.name),
		agent: row.agent === undefined ? undefined : sanitizeDisplayText(row.agent),
	}));

	// Tag column: "[scout]" padded so names align across rows. A row with no
	// agent type gets blank padding — absence communicates absence.
	const tags = safeRows.map((row) => (row.agent ? `[${row.agent}]` : ""));
	const tagWidth = Math.max(...tags.map((tag) => tag.length), 0);

	// A single faded rule separates the widget from the transcript above it.
	const lines = [border("─".repeat(Math.max(0, width)))];

	for (let i = 0; i < safeRows.length; i++) {
		const row = safeRows[i];
		const tag = tags[i].padEnd(tagWidth);
		const elapsed = formatElapsed(row.elapsedSeconds);
		const left = ` ${tag}  ${stripAgentPrefix(row.name, row.agent)}`;

		// Right-anchor the clock one space off the edge. The flex gap absorbs
		// the width; when space runs out the NAME gives way (ellipsis) — the
		// tag and the clock are the identity and the anchor; prose is
		// sacrificial. Layout is computed on plain text; the dim wrapper is
		// applied last so ANSI codes never enter the width math.
		const maxLeft = width - elapsed.length - 3;
		const clippedLeft = left.length > maxLeft ? left.slice(0, Math.max(tagWidth + 3, maxLeft - 1)) + "…" : left;
		const gap = Math.max(2, width - clippedLeft.length - elapsed.length - 1);
		lines.push(clippedLeft + " ".repeat(gap) + dim(elapsed) + " ");
	}
	return lines;
}
