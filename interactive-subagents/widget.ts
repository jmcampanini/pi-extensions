/**
 * widget.ts — rendering the running-subagents widget.
 *
 * The style ("5c"): a bracketed agent-type tag, the task-focused display
 * name, and a right-anchored elapsed clock. Nothing else — no colors, no
 * borders, no status column, no header/footer. A row EXISTING means that
 * child is running, and the right edge is reserved for v2's live activity
 * states (`· bash 7m`).
 *
 *   [scout]   Auth                                      00:23
 *   [worker]  quick fix                                 00:04
 *
 * Pure string-building with no pi imports, so it unit-tests with plain data.
 */

export interface WidgetRow {
	/** Display name — the `name` the model chose at spawn time. */
	name: string;
	/** Agent type ("worker", "scout", …). Missing only for pre-worker resumes. */
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
	if (!agent) return name;
	const match = name.match(/^(\S+)\s*[:\-–—]\s*(.+)$/);
	if (match && match[1].toLowerCase() === agent.toLowerCase() && match[2].trim() !== "") {
		return match[2].trim();
	}
	return name;
}

export function formatRunningWidgetLines(rows: WidgetRow[], width: number): string[] {
	// Tag column: "[scout]" padded so names align across rows. A row with no
	// agent type gets blank padding — absence communicates absence.
	const tags = rows.map((row) => (row.agent ? `[${row.agent}]` : ""));
	const tagWidth = Math.max(...tags.map((tag) => tag.length), 0);

	return rows.map((row, i) => {
		const tag = tags[i].padEnd(tagWidth);
		const elapsed = formatElapsed(row.elapsedSeconds);
		const left = ` ${tag}  ${stripAgentPrefix(row.name, row.agent)}`;

		// Right-anchor the clock: the flex gap absorbs the width. When space
		// runs out, the NAME gives way (ellipsis) — the tag and the clock are
		// the identity and the anchor; prose is sacrificial.
		const maxLeft = width - elapsed.length - 2;
		const clippedLeft = left.length > maxLeft ? left.slice(0, Math.max(tagWidth + 3, maxLeft - 1)) + "…" : left;
		const gap = Math.max(2, width - clippedLeft.length - elapsed.length);
		return clippedLeft + " ".repeat(gap) + elapsed;
	});
}
