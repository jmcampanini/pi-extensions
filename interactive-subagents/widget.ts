/**
 * widget.ts — rendering the running-subagents widget.
 *
 * The style: a bracketed agent-type tag, the task-focused display name, and
 * a right-anchored elapsed clock — no counts or hints. A row EXISTING means
 * that child is running; the right edge carries the live status segment.
 *
 * Each row is a fixed four-column grid: the bracketed agent-type tag
 * (padded to the widest tag), one space, a two-column state slot (`f` when
 * the conversation is forked, `w` when the child runs in a worktree, blank
 * when a state doesn't apply), one padding space, then the name. The marks
 * render extra-faint — quieter than the clock — so they read as texture.
 * When the controller supplies a live status, a telemetry segment sits
 * immediately left of the clock, joined to it by two spaces:
 *
 *   ──────────────────────────────────────────────────────────────────
 *   [scout]  fw Auth                    active · bash 7m · 42%  03:12
 *   [worker]    quick fix                         waiting · 6%  00:41
 *   [judge]   w API review                             stalled  01:12
 *
 * The segment degrades before the name does (tool part first, then the
 * percent, then the whole segment — see the ladder at chooseSegment), and
 * a row WITHOUT a status renders byte-identical to the v1 row, which the
 * v1 exact-string tests pin.
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
	/** Applied to the status segment when status is "stalled" (pi passes the
	 * theme's warning color, same precedent as the implant banner). Falls
	 * back to `dim` — one visual voice for telemetry; stalled is the only
	 * state that should pop. */
	warn?: (text: string) => string;
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
	/** Live status computed by the parent's watcher. All four segment fields
	 * are optional: a row without a status renders byte-identical to the v1
	 * row, so the segment machinery only engages when the controller opts in. */
	status?: "starting" | "active" | "waiting" | "stalled";
	/** Longest-running tool call's name. Child-written and therefore hostile:
	 * re-sanitized inside the renderer, never trusted. Shown only while
	 * status is "active". */
	toolName?: string;
	/** How long that tool has been running (skew-free parent-side estimate). */
	toolElapsedSeconds?: number;
	/** Pi's own unrounded context percent, pre-computed by the controller.
	 * Absent (or non-finite) context renders as absence, not "?" — quieter,
	 * and the number returns on the next turn_end. */
	contextPercent?: number;
}

/** Zero-padded MM:SS, growing to H:MM:SS past an hour. */
export function formatElapsed(totalSeconds: number): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** Coarse tool-run duration for the status segment: `42s` / `7m` / `1h3m`.
 * Deliberately coarser than the row clock — the segment is telemetry, and
 * a bounded width keeps the layout ladder's worst case predictable. */
export function formatToolElapsed(totalSeconds: number): string {
	// Clamp and floor: the input is a parent-side estimate that can be
	// fractional or (on clock weirdness) slightly negative.
	const seconds = Math.max(0, Math.floor(totalSeconds));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m`;
}

/** Compact token counts. The tiers are copied EXACTLY from pi's own footer
 * (pi-coding-agent dist/modes/interactive/components/footer.js), not
 * hand-rolled, so a child's numbers read like the numbers the human sees in
 * their own footer — decimal below 10k, which is where small children live. */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** The slice of an activity snapshot the result line needs. Structural on
 * purpose: the real ActivitySnapshot (activity.ts) is assignable as-is, but
 * naming only these fields keeps widget.ts a pure display leaf. */
export interface ResultContextSource {
	context: { tokens: number | null; window: number; percent: number | null } | null;
	costUsd: number;
}

/** Dollar prose for the result line and subagents_list. Sub-cent spend shows
 * as a floor rather than rounding to $0.00, so a cheap-but-real run never
 * looks free. */
export function formatCost(costUsd: number): string {
	if (costUsd > 0 && costUsd < 0.005) return "< $0.01";
	return `$${costUsd.toFixed(2)}`;
}

/** The one-line economics summary appended to a finished child's result
 * message — it exists so the model can decide whether a child is too full
 * to keep resuming, at the exact moment it decides. Returns undefined when
 * there is no snapshot: the line is omitted, never guessed. Null tokens
 * mean pi just compacted and has not yet seen the next assistant reply, so
 * the line says that instead of showing a stale number. */
export function formatResultContextLine(snapshot: ResultContextSource | undefined): string | undefined {
	if (snapshot === undefined) return undefined;
	const cost = `cost this run ${formatCost(snapshot.costUsd)}`;
	const context = snapshot.context;
	if (context === null) return `Context: unknown · ${cost}`;
	if (context.tokens === null || context.percent === null) {
		return `Context: unknown (just compacted) · ${cost}`;
	}
	const share = `${formatTokens(context.tokens)}/${formatTokens(context.window)} tokens (${Math.round(context.percent)}%)`;
	return `Context: ${share} · ${cost}`;
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

// ── display safety: columns, single lines, surrogate pairs ───────────────
// All layout math in this file measures UTF-16 .length, which undercounts
// East-Asian-wide and emoji glyphs (2 terminal columns each). pi-tui's fatal
// overflow check measures DISPLAY COLUMNS, so a .length-exact line holding
// wide glyphs can overflow the terminal and crash the whole parent TUI.
// Deliberately NOT fixed by making the layout ladder column-aware (that is
// a separately parked project); these helpers back a final per-row guard
// that converts a possible crash into a cosmetically-rough-but-safe row.

/** The standard East-Asian-wide ranges plus emoji/astral pictographs, all
 * counted 2 columns; everything else 1. A small conservative table, not a
 * full Unicode width database — it only needs to agree with pi-tui about
 * which glyphs are wide enough to overflow. */
function isWideCodePoint(code: number): boolean {
	return (
		(code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
		(code >= 0x2e80 && code <= 0xa4cf) || // CJK radicals … Yi syllables
		(code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
		(code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
		(code >= 0xfe30 && code <= 0xfe4f) || // CJK compatibility forms
		(code >= 0xff00 && code <= 0xff60) || // fullwidth forms
		(code >= 0xffe0 && code <= 0xffe6) || // fullwidth signs
		(code >= 0x1f300 && code <= 0x1f9ff) || // emoji & pictographs
		(code >= 0x1fa00 && code <= 0x1faff) || // more astral pictographs
		code >= 0x20000 // CJK ideograph extensions B and beyond
	);
}

/** Terminal columns a plain-text string occupies (ASCII fast path: one
 * column per char). Exported so the tests can use it as the sweep oracle. */
export function displayColumns(text: string): number {
	let ascii = true;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) > 0x7f) {
			ascii = false;
			break;
		}
	}
	if (ascii) return text.length;
	let columns = 0;
	for (const char of text) {
		columns += isWideCodePoint(char.codePointAt(0) ?? 0) ? 2 : 1;
	}
	return columns;
}

/** Column-aware clamp for the fallback row: walk code points accumulating
 * displayColumns until the width budget is hit. */
function clampToColumns(text: string, maxColumns: number): string {
	let columns = 0;
	let out = "";
	for (const char of text) {
		const width = isWideCodePoint(char.codePointAt(0) ?? 0) ? 2 : 1;
		if (columns + width > maxColumns) break;
		columns += width;
		out += char;
	}
	return out;
}

/** \t/\n/\r each become one space: this renderer emits exactly one terminal
 * row per child, so the shared sanitizer's multi-line whitelist does not
 * apply here (it stays multi-line-friendly for the surfaces that do wrap).
 * A surviving tab counts 1 in the .length math but 3 columns in pi-tui —
 * fatal overflow — and a raw newline/CR corrupts the TUI's row accounting. */
function singleLine(text: string): string {
	return text.replace(/[\t\n\r]/g, " ");
}

/** A .slice() by code units can cut a surrogate pair in half; never emit the
 * dangling high surrogate (it renders as mojibake). The result only ever
 * gets shorter, so the callers' .length budget arithmetic still holds. */
function stripTrailingLoneSurrogate(text: string): string {
	const last = text.charCodeAt(text.length - 1);
	return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

// ── the status segment ───────────────────────────────────────────────────
// Grammar: `<status>[ · <tool> <elapsed>][ · <pct>%]`, parts omitted (with
// their separators) when absent. The segment sits immediately left of the
// clock, joined to it by two spaces.

/** Tool names come out of the child's own activity writes — hostile by
 * definition — so they are sanitized AGAIN here regardless of what the
 * controller did, and clamped so one long MCP tool name cannot eat the row.
 * Exported for subagents_list, which shows the same clamped name in prose. */
export function clampToolName(rawName: string): string {
	const safe = singleLine(sanitizeDisplayText(rawName));
	return safe.length > 12 ? stripTrailingLoneSurrogate(safe.slice(0, 12)) + "…" : safe;
}

/** Candidate segments, widest first — the degradation ladder. The tool part
 * drops before the percent (most volatile, least identifying; the context
 * share is the segment's stated purpose), the percent before the status
 * word, and the whole segment before the name. */
function segmentCandidates(row: WidgetRow): string[] {
	if (row.status === undefined) return [];
	// Tool part: only while active, and only when a name survives sanitizing.
	let toolPart = "";
	if (row.status === "active" && row.toolName !== undefined) {
		const tool = clampToolName(row.toolName);
		if (tool !== "") toolPart = ` · ${tool} ${formatToolElapsed(row.toolElapsedSeconds ?? 0)}`;
	}
	// Percent part: unknown context renders as absence, not "?".
	let pctPart = "";
	if (row.contextPercent !== undefined && Number.isFinite(row.contextPercent)) {
		pctPart = ` · ${Math.min(999, Math.max(0, Math.round(row.contextPercent)))}%`;
	}
	return [row.status + toolPart + pctPart, row.status + pctPart, row.status];
}

/** Pick the widest candidate that leaves the name at least 10 columns
 * (a truncated-but-meaningful name; a shorter name only demands its own
 * length, so it is never truncated to make room for a segment). The check
 * reuses the row's exact fixed-width formula — the candidate plus its
 * two-space joint to the clock, plus the same 2-column minimum-gap reserve
 * as the maxName math below — so a chosen segment can never overflow.
 * Returns "" when nothing fits: the row is then geometrically the exact
 * v1 row and the v1 name ladder takes over. */
function chooseSegment(row: WidgetRow, width: number, prefix: string, slot: string, elapsed: string, name: string): string {
	for (const candidate of segmentCandidates(row)) {
		const fixedWidth = prefix.length + slot.length + 1 + candidate.length + 2 + elapsed.length + 1;
		const candidateMaxName = width - fixedWidth - 2;
		if (candidateMaxName >= Math.min(name.length, 10)) return candidate;
	}
	return "";
}

export function formatRunningWidgetLines(rows: WidgetRow[], width: number, style: WidgetStyle = {}): string[] {
	const dim = style.dim ?? ((text: string) => text);
	const border = style.border ?? ((text: string) => text);
	const slotStyle = style.slot ?? dim;
	const warn = style.warn ?? dim;

	// Sanitize AND single-line: names and agent tags are one-row surfaces
	// here, so surviving tabs/newlines become plain spaces (see singleLine).
	const safeRows = rows.map((row) => ({
		...row,
		name: singleLine(sanitizeDisplayText(row.name)),
		agent: row.agent === undefined ? undefined : singleLine(sanitizeDisplayText(row.agent)),
	}));

	// Tag column: "[scout]" padded so names align across rows. A row with no
	// agent type gets blank padding — absence communicates absence.
	const tags = safeRows.map((row) => (row.agent ? `[${row.agent}]` : ""));
	const tagWidth = Math.max(...tags.map((tag) => tag.length), 0);

	// Guard the two places that would misbehave on a negative width
	// (repeat throws, slice counts from the end).
	const safeWidth = Math.max(0, width);

	// A single faded rule separates the widget from the transcript above it.
	const lines = [border("─".repeat(safeWidth))];

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
		// the width; when space runs out the status detail gives way first
		// (the ladder in chooseSegment), then the NAME (ellipsis, then
		// nothing) — the tag, the state slot, and the clock are the identity
		// and the anchor; prose is sacrificial. Layout is computed on plain
		// text; the dim wrappers are applied last so ANSI codes never enter
		// the width math.
		// The segment is chosen BEFORE the width math so its plain length
		// participates in fixedWidth — a line wider than the terminal is
		// FATAL upstream, so the segment can never be bolted on afterwards.
		// Everything except the name and the flex gap has a fixed width: the
		// prefix, the slot, its padding space, the segment plus its two-space
		// joint to the clock, the clock, its trailing space.
		const segment = chooseSegment(row, width, prefix, slot, elapsed, name);
		const segmentWidth = segment === "" ? 0 : segment.length + 2;
		const fixedWidth = prefix.length + slot.length + 1 + segmentWidth + elapsed.length + 1;
		const maxName = width - fixedWidth - 2; // reserve a 2-column minimum gap
		// Clip the name to fit: ellipsis-terminated while at least one column
		// remains (a single column shows a bare "…"), empty below that.
		let clippedName = name;
		if (name.length > maxName) {
			// The surrogate strip only ever shortens the clip, so the gap math
			// below (which measures clippedName.length) still lands the clock
			// exactly on the right edge.
			clippedName = maxName >= 1 ? stripTrailingLoneSurrogate(name.slice(0, maxName - 1)) + "…" : "";
		}
		const gap = Math.max(0, width - fixedWidth - clippedName.length);

		// A line wider than the terminal is FATAL upstream: pi's TUI treats an
		// overflowing widget line as a crash. At every width the grid fits
		// in, the styled line below is exact; at widths narrower than the
		// fixed grid, clamp the plain text instead and skip styling the row.
		// The segment renders dim in every state except stalled, which gets
		// the warn hook — and it appears in BOTH branches so the plain-length
		// exact-fit check keeps holding.
		//
		// The exact-fit check measures BOTH units: pi-tui's fatal overflow
		// check counts display columns, and the .length math above undercounts
		// wide (CJK/emoji) glyphs, so a .length-exact line can still overflow
		// and kill the parent TUI. Rows holding wide glyphs take the unstyled
		// column-clamped fallback instead — cosmetically rough (clock off the
		// right edge), but never a crash.
		const segmentStyle = row.status === "stalled" ? warn : dim;
		const plainLine = prefix + slot + " " + clippedName + " ".repeat(gap)
			+ (segment !== "" ? segment + "  " : "") + elapsed + " ";
		lines.push(
			plainLine.length <= width && displayColumns(plainLine) <= width
				? prefix + slotStyle(slot) + " " + clippedName + " ".repeat(gap)
					+ (segment !== "" ? segmentStyle(segment) + "  " : "") + dim(elapsed) + " "
				: clampToColumns(plainLine, safeWidth),
		);
	}
	return lines;
}
