/**
 * widget.ts — rendering the running-subagents widget.
 *
 * Each row starts with an unbracketed agent identifier, padded to the widest
 * visible identifier, followed by only the marker columns used by visible
 * rows. Markers are `e` external harness, `f` forked, `i` interactive, and
 * `w` worktree. Blank cells preserve alignment within active columns;
 * when none apply, the marker group and its separator disappear. The
 * task-focused display name follows, while status telemetry and elapsed time
 * stay anchored at the right edge.
 *
 *   ──────────────────────────────────────────────────────────────────
 *   scout  fw Auth                    bash 7m · active ·  84k · 03:12
 *   worker    quick fix                        waiting ·   6k · 00:41
 *   judge   w API review                              stalled         · 01:12
 *
 * The optional tool drops before the task name truncates, while identity,
 * active markers, required status, known context, and the clock take priority.
 *
 * A faded rule tops the block to separate it from the transcript, the clock
 * sits one space off the edge and renders dim. Styling is injected as plain
 * string-wrapping functions (theme colors in pi, identity in tests), so this
 * module stays dependency-free and unit-testable.
 */

import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { AGENT_IDENTIFIER_MAX_COLUMNS } from "./agent-identifier.ts";
import { sanitizeDisplayText } from "./display-text.ts";

// ── the state marks ──────────────────────────────────────────────────────
// Plain letters, so they render identically in every font and terminal.

/** Marks a child whose conversation is a fork of the parent's. */
export const FORK_MARK = "f";
/** Marks a child that stays open for a human instead of exiting automatically. */
export const INTERACTIVE_MARK = "i";
/** Marks a child running in its own git worktree. */
export const WORKTREE_MARK = "w";
/** Marks a child running through an external harness. */
export const EXTERNAL_MARK = "e";

/** Optional styling hooks; identity (no styling) when omitted. */
export interface WidgetStyle {
	/** Applied to the elapsed clock (pi passes the theme's dim color). */
	dim?: (text: string) => string;
	/** Applied to the top rule (pi passes the theme's muted border color). */
	border?: (text: string) => string;
	/** Applied to task names when a specialized surface needs emphasis. */
	name?: (text: string) => string;
	/** Applied to the selected-row arrow; the picker passes the accent color. */
	selected?: (text: string) => string;
	/** Applied to agent identifiers; pi passes the theme's muted color. */
	agent?: (text: string) => string;
	/** Applied to marker letters; pi passes the theme's muted color. */
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
	/** True when the pane stays open for a human instead of auto-exiting. */
	interactive?: boolean;
	/** True when the child runs in its own git worktree. */
	worktree?: boolean;
	/** True when a non-pi harness runs the child. */
	external?: boolean;
	/** Live status computed by the parent's watcher. All four segment fields
	 * are optional; without a status the row uses only identity, task, markers,
	 * and elapsed time. Two states never come from computeStatus: "delivering" (exit lifecycle
	 * — the child has exited and its result message is still queued for the
	 * parent) and "queued" (pre-launch — the child is waiting for a
	 * concurrency slot, see capacity.ts). The controller passes no tool/token
	 * telemetry with either. Stopped deliveries use "stopped" for human
	 * surfaces while remaining model-facing "delivering" lifecycle entries. */
	status?: "starting" | "active" | "waiting" | "stalled" | "delivering" | "stopped" | "queued";
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

export interface MarkerColumn {
	mark: string;
	applies: (row: WidgetRow) => boolean;
}

const MARKER_COLUMNS: readonly MarkerColumn[] = [
	{ mark: EXTERNAL_MARK, applies: (row) => Boolean(row.external) },
	{ mark: FORK_MARK, applies: (row) => Boolean(row.forked) },
	{ mark: INTERACTIVE_MARK, applies: (row) => Boolean(row.interactive) },
	{ mark: WORKTREE_MARK, applies: (row) => Boolean(row.worktree) },
];

export function activeMarkerColumns(rows: readonly WidgetRow[]): MarkerColumn[] {
	return MARKER_COLUMNS.filter((column) => rows.some(column.applies));
}

export function formatMarkerCells(row: WidgetRow, columns: readonly MarkerColumn[]): string {
	return columns.map((column) => column.applies(row) ? column.mark : " ").join("");
}

export interface WidgetSummary {
	hiddenRows: number;
	stalledRows: number;
	waitingRows: number;
	queuedRows: number;
}

export interface LifecycleRowRenderOptions {
	/** Adds a native selection gutter and points at this row when present. */
	selectedIndex?: number;
}

export interface WidgetRenderOptions {
	summary?: WidgetSummary;
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

/** Dollar prose for result envelopes and subagent_status. Sub-cent spend
 * shows as a floor rather than rounding to $0.00, so a cheap-but-real run
 * never looks free. */
export function formatCost(costUsd: number): string {
	if (costUsd > 0 && costUsd < 0.005) return "< $0.01";
	return `$${costUsd.toFixed(2)}`;
}

/**
 * The agent column states the agent type, so a name that repeats it
 * ("Scout: Auth" next to scout) is redundant — strip the exact type prefix
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
 * Exported for subagent_status, which shows the same clamped name in prose. */
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

export function formatLifecycleRowLines(
	rows: readonly WidgetRow[],
	width: number,
	style: WidgetStyle = {},
	options: LifecycleRowRenderOptions = {},
): string[] {
	const plain = (text: string): string => text;
	const dim = style.dim ?? plain;
	const nameStyle = style.name ?? plain;
	const selectedStyle = style.selected ?? plain;
	const agentStyle = style.agent ?? dim;
	const slotStyle = style.slot ?? dim;
	const warn = style.warn ?? dim;

	const safeRows = rows.map((row) => ({
		...row,
		name: singleLine(sanitizeDisplayText(row.name)),
		agent: row.agent === undefined ? undefined : singleLine(sanitizeDisplayText(row.agent)),
	}));
	const agents = safeRows.map((row) =>
		row.agent ? truncateToColumns(row.agent, AGENT_IDENTIFIER_MAX_COLUMNS) : "",
	);
	const agentWidth = Math.max(...agents.map(displayColumns), 0);
	const elapsedValues = safeRows.map((row) => formatElapsed(row.elapsedSeconds));
	const elapsedWidth = Math.max(...elapsedValues.map(displayColumns), 0);
	const markerColumns = activeMarkerColumns(safeRows);
	const safeWidth = Math.max(0, width);
	const lines: string[] = [];

	for (let i = 0; i < safeRows.length; i++) {
		const row = safeRows[i];
		const agent = padToColumns(agents[i], agentWidth);
		const elapsed = elapsedValues[i].padStart(elapsedWidth, " ");
		const selected = options.selectedIndex === i;
		const selectionPointer = selected ? "→" : " ";
		const leading = options.selectedIndex === undefined ? " " : `${selectionPointer} `;
		const styledLeading = selected ? selectedStyle(selectionPointer) + " " : leading;
		const prefix = `${leading}${agentWidth > 0 ? `${agent} ` : ""}`;
		const styledAgent = agents[i] === ""
			? agent
			: agentStyle(agents[i]) + " ".repeat(Math.max(0, agentWidth - displayColumns(agents[i])));
		const styledPrefix = `${styledLeading}${agentWidth > 0 ? `${styledAgent} ` : ""}`;
		const markerCells = formatMarkerCells(row, markerColumns);
		const markerPadding = markerColumns.length > 0 ? " " : "";
		const name = stripAgentPrefix(row.name, row.agent);

		// Right-anchor the clock one space off the edge. The optional tool gives
		// way first, then the task name truncates around the required telemetry.
		const baseWidth = displayColumns(prefix) + displayColumns(markerCells) + displayColumns(markerPadding)
			+ displayColumns(elapsed) + 1;
		const segment = chooseSegment(row, width - baseWidth, displayColumns(name));
		const segmentWidth = segment === "" ? 0 : displayColumns(segment) + CLOCK_SEPARATOR_WIDTH;
		const fixedWidth = baseWidth + segmentWidth;
		const maxName = width - fixedWidth - 2;
		const clippedName = truncateToColumns(name, maxName);
		const gap = Math.max(0, width - fixedWidth - displayColumns(clippedName));
		const segmentStyle = row.status === "stalled" ? warn : dim;
		const plainLine = prefix + markerCells + markerPadding + clippedName + " ".repeat(gap)
			+ (segment !== "" ? segment + CLOCK_SEPARATOR : "") + elapsed + " ";
		lines.push(
			displayColumns(plainLine) <= width
				? styledPrefix + (markerCells === "" ? "" : slotStyle(markerCells)) + markerPadding
					+ nameStyle(clippedName) + " ".repeat(gap)
					+ (segment !== "" ? segmentStyle(segment) + dim(CLOCK_SEPARATOR) : "") + dim(elapsed) + " "
				: clampToColumns(plainLine, safeWidth),
		);
	}
	return lines;
}

export function formatRunningWidgetLines(
	rows: WidgetRow[],
	width: number,
	style: WidgetStyle = {},
	options: WidgetRenderOptions = {},
): string[] {
	const dim = style.dim ?? ((text: string) => text);
	const border = style.border ?? ((text: string) => text);
	const safeWidth = Math.max(0, width);
	const lines = [border("─".repeat(safeWidth)), ...formatLifecycleRowLines(rows, width, style)];
	if (options.summary && options.summary.hiddenRows > 0) {
		const summaryParts = [`+${options.summary.hiddenRows} more`];
		if (options.summary.stalledRows > 0) summaryParts.push(`${options.summary.stalledRows} stalled`);
		if (options.summary.waitingRows > 0) summaryParts.push(`${options.summary.waitingRows} waiting`);
		if (options.summary.queuedRows > 0) summaryParts.push(`${options.summary.queuedRows} queued`);
		summaryParts.push("/subagent-status");
		lines.push(dim(truncateToColumns(` ${summaryParts.join(" · ")}`, safeWidth)));
	}
	return lines;
}
