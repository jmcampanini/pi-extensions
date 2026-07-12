/**
 * widget.ts — rendering the running-subagents widget.
 *
 * The style: a bracketed agent-type tag, the task-focused display name, and
 * a right-anchored elapsed clock — no counts or hints. A row EXISTING means
 * that child is running, or has exited with its result message still queued
 * for the parent (status `delivering`, frozen clock); the right edge carries
 * the live status segment.
 *
 * Each row is a fixed four-column grid: the bracketed agent-type tag
 * (padded to the widest tag), one space, a two-column state slot (`f` when
 * the conversation is forked, `w` when the child runs in a worktree, blank
 * when a state doesn't apply), one padding space, then the name. The marks
 * render extra-faint — quieter than the clock — so they read as texture.
 * When the controller supplies a live status, a telemetry segment sits
 * immediately left of the clock, joined by a middle-dot separator:
 *
 *   ──────────────────────────────────────────────────────────────────
 *   [scout]  fw Auth                  bash 7m · active ·  84k · 03:12
 *   [worker]    quick fix                      waiting ·   6k · 00:41
 *   [judge]   w API review                            stalled         · 01:12
 *
 * The optional tool sits at the segment's variable left edge. It drops
 * before the name truncates, while state and known context stay visible.
 * A row WITHOUT a status renders byte-identical to the v1 row, which the
 * v1 exact-string tests pin.
 *
 * A faded rule tops the block to separate it from the transcript, the clock
 * sits one space off the edge and renders dim. Styling is injected as plain
 * string-wrapping functions (theme colors in pi, identity in tests), so this
 * module stays dependency-free and unit-testable.
 */

import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeDisplayText } from "./display-text.ts";

// ── the state marks ──────────────────────────────────────────────────────
// Plain letters, so they render identically in every font and terminal.

/** Marks a child whose conversation is a fork of the parent's. */
export const FORK_MARK = "f";
/** Marks a child running in its own git worktree. */
export const WORKTREE_MARK = "w";

const AGENT_TAG_MAX_COLUMNS = 12;

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
	 * row, so the segment machinery only engages when the controller opts in.
	 * "delivering" is the one exit-lifecycle state, supplied by the controller
	 * from the delivering map and never produced by computeStatus - the child
	 * has exited and its result message is still queued for the parent; the
	 * controller passes no tool/token telemetry with it. */
	status?: "starting" | "active" | "waiting" | "stalled" | "delivering";
	/** Longest-running tool call's name. Child-written and therefore hostile:
	 * re-sanitized inside the renderer, never trusted. Shown only while
	 * status is "active". */
	toolName?: string;
	/** How long that tool has been running (skew-free parent-side estimate). */
	toolElapsedSeconds?: number;
	/** Pi's own context-token count, pre-computed by the controller.
	 * Absent (or non-finite) context reserves a blank fixed-width cell rather
	 * than rendering "?"; the number returns on the next turn_end. */
	contextTokens?: number;
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
// Layout uses terminal display columns rather than UTF-16 length so wide
// names and tags cannot consume the fixed right-side telemetry budget.

/** Terminal columns using the exact metric enforced by pi-tui. */
export function displayColumns(text: string): number {
	return visibleWidth(text);
}

/** Grapheme-safe clamp using pi-tui's own column slicing semantics. */
function clampToColumns(text: string, maxColumns: number): string {
	return sliceByColumn(text, 0, Math.max(0, maxColumns), true);
}

function padToColumns(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - displayColumns(text)));
}

function truncateToColumns(text: string, width: number): string {
	if (displayColumns(text) <= width) return text;
	if (width < 1) return "";
	return clampToColumns(text, width - 1) + "…";
}

/** \t/\n/\r each become one space: this renderer emits exactly one terminal
 * row per child, so the shared sanitizer's multi-line whitelist does not
 * apply here (it stays multi-line-friendly for the surfaces that do wrap).
 * A surviving tab occupies 3 columns in pi-tui, and a raw newline/CR
 * corrupts the TUI's row accounting. */
function singleLine(text: string): string {
	return text.replace(/[\t\n\r]/g, " ");
}

/** A .slice() by code units can cut a surrogate pair in half; never emit the
 * dangling high surrogate because it renders as mojibake. */
function stripTrailingLoneSurrogate(text: string): string {
	const last = text.charCodeAt(text.length - 1);
	return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

// ── the status segment ───────────────────────────────────────────────────
// Grammar: `[<tool> <elapsed> · ]<status><context>`. Context is a fixed
// seven-column suffix: ` · ` plus three right-aligned digits and `k`, or seven
// blank columns when unknown. A ` · ` separator joins the segment to the clock.

/** Tool names come out of the child's own activity writes — hostile by
 * definition — so they are sanitized AGAIN here regardless of what the
 * controller did, and clamped so one long MCP tool name cannot eat the row.
 * Exported for subagents_list, which shows the same clamped name in prose. */
export function clampToolName(rawName: string): string {
	const safe = singleLine(sanitizeDisplayText(rawName));
	return safe.length > 12 ? stripTrailingLoneSurrogate(safe.slice(0, 12)) + "…" : safe;
}

const CONTEXT_DIGITS = 3;
const CONTEXT_CELL_WIDTH = CONTEXT_DIGITS + 1;
const CONTEXT_SUFFIX_WIDTH = 3 + CONTEXT_CELL_WIDTH;
const CLOCK_SEPARATOR = " · ";
const CLOCK_SEPARATOR_WIDTH = 3;

/** Widget-only context formatter: three right-aligned whole-thousands digits
 * plus `k`. Saturating at 999 keeps the display contract fixed even if a
 * future context window exceeds the widget's stated three-digit range. */
export function formatWidgetContextTokens(count: number): string {
	const thousands = Math.max(0, Math.min(999, Math.round(count / 1000)));
	return `${String(thousands).padStart(CONTEXT_DIGITS, " ")}k`;
}

/** Build the required state/context core and optional tool prefix. */
function buildSegments(row: WidgetRow): { core: string; full?: string } | undefined {
	if (row.status === undefined) return undefined;
	const contextTokens = row.contextTokens;
	const contextPart = contextTokens !== undefined && Number.isFinite(contextTokens)
		? ` · ${formatWidgetContextTokens(contextTokens)}`
		: " ".repeat(CONTEXT_SUFFIX_WIDTH);
	const core = row.status + contextPart;
	if (row.status !== "active" || row.toolName === undefined) return { core };

	const tool = clampToolName(row.toolName);
	return tool === ""
		? { core }
		: { core, full: `${tool} ${formatToolElapsed(row.toolElapsedSeconds ?? 0)} · ${core}` };
}

/** Keep the optional tool only when the complete name still fits. Keep the
 * core whenever it fits, allowing the name to truncate around it. */
function chooseSegment(row: WidgetRow, availableWidth: number, nameWidth: number): string {
	const segments = buildSegments(row);
	if (segments === undefined) return "";
	if (segments.full !== undefined) {
		const fullWidth = displayColumns(segments.full) + CLOCK_SEPARATOR_WIDTH;
		if (fullWidth + nameWidth + 2 <= availableWidth) return segments.full;
	}
	return displayColumns(segments.core) + CLOCK_SEPARATOR_WIDTH <= availableWidth ? segments.core : "";
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

	// Tag column: "[scout]" padded so names align across rows. Clamp only the
	// rendered identifier; the full row.agent remains available for prefix
	// de-duplication and every non-widget use. A row with no agent type gets
	// blank padding — absence communicates absence.
	const tags = safeRows.map((row) =>
		row.agent ? `[${truncateToColumns(row.agent, AGENT_TAG_MAX_COLUMNS)}]` : "",
	);
	const tagWidth = Math.max(...tags.map(displayColumns), 0);
	const elapsedValues = safeRows.map((row) => formatElapsed(row.elapsedSeconds));
	const elapsedWidth = Math.max(...elapsedValues.map(displayColumns), 0);

	// Guard the two places that would misbehave on a negative width
	// (repeat throws, slice counts from the end).
	const safeWidth = Math.max(0, width);

	// A single faded rule separates the widget from the transcript above it.
	const lines = [border("─".repeat(safeWidth))];

	for (let i = 0; i < safeRows.length; i++) {
		const row = safeRows[i];
		const tag = padToColumns(tags[i], tagWidth);
		const elapsed = elapsedValues[i].padStart(elapsedWidth, " ");
		// The four-column grid: padded tag, one space, the two-column state
		// slot (blank columns when a state doesn't apply), one padding space,
		// then the name.
		const prefix = ` ${tag} `;
		const slot = (row.forked ? FORK_MARK : " ") + (row.worktree ? WORKTREE_MARK : " ");
		const name = stripAgentPrefix(row.name, row.agent);

		// Right-anchor the clock one space off the edge. The flex gap absorbs
		// the width; when space runs out the optional tool gives way first,
		// then the NAME truncates (ellipsis, then nothing). The tag, state slot,
		// telemetry core, and clock are the identity and anchors; prose is
		// sacrificial. Layout is computed on plain text; the dim wrappers are
		// applied last so ANSI codes never enter
		// the width math.
		// The segment is chosen BEFORE the width math so its display width
		// participates in fixedWidth. A line wider than the terminal is
		// FATAL upstream, so the segment can never be bolted on afterwards.
		// Everything except the name and the flex gap has a fixed width: the
		// prefix, the slot, its padding space, the segment plus its separator,
		// the clock, and its trailing space.
		const baseWidth = displayColumns(prefix) + displayColumns(slot) + 1
			+ displayColumns(elapsed) + 1;
		const segment = chooseSegment(row, width - baseWidth, displayColumns(name));
		const segmentWidth = segment === "" ? 0 : displayColumns(segment) + CLOCK_SEPARATOR_WIDTH;
		const fixedWidth = baseWidth + segmentWidth;
		const maxName = width - fixedWidth - 2; // reserve a 2-column minimum gap
		const clippedName = truncateToColumns(name, maxName);
		const gap = Math.max(0, width - fixedWidth - displayColumns(clippedName));

		// A line wider than the terminal is FATAL upstream: pi's TUI treats an
		// overflowing widget line as a crash. At every width the grid fits
		// in, the styled line below is exact; at widths narrower than the
		// fixed grid, clamp the plain text instead and skip styling the row.
		// The segment renders dim in every state except stalled, which gets
		// the warn hook.
		//
		// The final clamp handles terminals narrower than the immutable identity
		// and clock fields. Under normal widths the column-aware budget keeps the
		// styled line exact without sacrificing the right-side suffix.
		const segmentStyle = row.status === "stalled" ? warn : dim;
		const plainLine = prefix + slot + " " + clippedName + " ".repeat(gap)
			+ (segment !== "" ? segment + CLOCK_SEPARATOR : "") + elapsed + " ";
		lines.push(
			displayColumns(plainLine) <= width
				? prefix + slotStyle(slot) + " " + clippedName + " ".repeat(gap)
					+ (segment !== "" ? segmentStyle(segment) + dim(CLOCK_SEPARATOR) : "") + dim(elapsed) + " "
				: clampToColumns(plainLine, safeWidth),
		);
	}
	return lines;
}
