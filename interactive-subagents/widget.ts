/**
 * widget.ts — rendering the running-subagents widget.
 *
 * The style: a bracketed agent-type tag, the task-focused display name, and
 * a right-anchored elapsed clock — no status column, no counts or hints.
 * A row EXISTING means that child is running, and the right edge is
 * reserved for v2's live activity states (`· bash 7m`).
 *
 * Each row is a fixed four-column grid: the bracketed agent-type tag
 * (padded to the widest tag), one space, a two-column state slot (`f` when
 * the conversation is forked, `w` when the child runs in a worktree, blank
 * when a state doesn't apply), one padding space, then the name. The marks
 * render extra-faint — quieter than the clock — so they read as texture:
 *
 *   ──────────────────────────────────────────────────────
 *   [scout]  fw Auth                                  00:23
 *   [worker]    quick fix                             00:04
 *   [judge]   w API review                            01:12
 *
 * A faded rule tops the block to separate it from the transcript, the clock
 * sits one space off the edge and renders dim. Styling is injected as plain
 * string-wrapping functions (theme colors in pi, identity in tests), so this
 * module stays dependency-free and unit-testable.
 */

import { sanitizeDisplayText } from "./display-text.ts";

// ── the state marks ──────────────────────────────────────────────────────
// Plain letters, so they render identically in every font and terminal.

/** Marks a child whose conversation is a fork of the parent's. */
export const FORK_MARK = "f";
/** Marks a child running in its own git worktree. */
export const WORKTREE_MARK = "w";

/** Optional styling hooks; identity (no styling) when omitted. */
export interface WidgetStyle {
	/** Applied to the elapsed clock (pi passes the theme's dim color). */
	dim?: (text: string) => string;
	/** Applied to the top rule (pi passes the theme's muted border color). */
	border?: (text: string) => string;
	/** Applied to the state marks; pi passes an extra-faint version of dim so
	 * the letters sit quieter than the clock. Falls back to `dim`. */
	slot?: (text: string) => string;
}

export interface WidgetRow {
	/** Display name — the `name` the model chose at spawn time. */
	name: string;
	/** Agent type ("worker", "scout", …). Missing only when a resume found no
	 * `.meta` launch metadata (a session not launched by this extension). */
	agent?: string;
	elapsedSeconds: number;
	/** True when the child's conversation was forked from the parent's. */
	forked?: boolean;
	/** True when the child runs in its own git worktree. */
	worktree?: boolean;
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
	const slotStyle = style.slot ?? dim;

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
		// The four-column grid: padded tag, one space, the two-column state
		// slot (blank columns when a state doesn't apply), one padding space,
		// then the name.
		const prefix = ` ${tag} `;
		const slot = (row.forked ? FORK_MARK : " ") + (row.worktree ? WORKTREE_MARK : " ");
		const name = stripAgentPrefix(row.name, row.agent);

		// Right-anchor the clock one space off the edge. The flex gap absorbs
		// the width; when space runs out the NAME gives way (ellipsis) — the
		// tag, the state slot, and the clock are the identity and the anchor;
		// prose is sacrificial. Layout is computed on plain text; the dim
		// wrappers are applied last so ANSI codes never enter the width math.
		const maxName = width - prefix.length - slot.length - 1 - elapsed.length - 3;
		const clippedName = name.length > maxName ? name.slice(0, Math.max(1, maxName - 1)) + "…" : name;
		const gap = Math.max(2, width - prefix.length - slot.length - 1 - clippedName.length - elapsed.length - 1);
		lines.push(prefix + slotStyle(slot) + " " + clippedName + " ".repeat(gap) + dim(elapsed) + " ");
	}
	return lines;
}
