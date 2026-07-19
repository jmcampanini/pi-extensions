/**
 * command-running.ts — /subagent-running live lifecycle picker.
 *
 * The compact widget is capped; this bounded-height view refreshes the full
 * delivering, running-state, starting, and queued projection while open.
 * Selection follows a child id as priority changes move rows.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { AGENT_IDENTIFIER_MAX_COLUMNS } from "./agent-identifier.ts";
import { cancelQueued, notifyQueueCancelled } from "./capacity.ts";
import { sanitizeDisplayText } from "./display-text.ts";
import {
	collectLifecycleWidgetRows,
	type LifecycleWidgetRow,
	updateRunningWidget,
} from "./running-widget.ts";
import { running } from "./state.ts";
import { focusPane } from "./tmux.ts";
import { activeMarkerColumns, formatElapsed, formatMarkerCells } from "./widget.ts";

export const RUNNING_PICKER_MAX_ROWS = 10;

type PickerAction = "goto" | "zoom" | "stop";

export interface RunningPickerStyle {
	border?: (text: string) => string;
	title?: (text: string) => string;
	selected?: (text: string) => string;
	name?: (text: string) => string;
	agent?: (text: string) => string;
	marker?: (text: string) => string;
	meta?: (text: string) => string;
	dim?: (text: string) => string;
}

function actionHint(row: LifecycleWidgetRow): string {
	if (row.lifecycle === "running") return "enter: visit · z: visit + zoom · x: stop";
	if (row.lifecycle === "queued") return "x: cancel queued launch";
	if (row.lifecycle === "pending") return "starting; controls available after start";
	return "finished; result is on its way";
}

function clampAgentIdentifier(agent: string): string {
	return truncateToWidth(agent, AGENT_IDENTIFIER_MAX_COLUMNS, "…");
}

function padToWidth(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

export function formatRunningPickerLines(
	rows: readonly LifecycleWidgetRow[],
	cursor: number,
	viewportStart: number,
	width: number,
	style: RunningPickerStyle = {},
	maxRows = RUNNING_PICKER_MAX_ROWS,
): string[] {
	const safeWidth = Math.max(0, width);
	const border = style.border ?? ((text: string) => text);
	const title = style.title ?? ((text: string) => text);
	const selected = style.selected ?? ((text: string) => text);
	const nameStyle = style.name ?? ((text: string) => text);
	const agentStyle = style.agent ?? ((text: string) => text);
	const markerStyle = style.marker ?? ((text: string) => text);
	const meta = style.meta ?? ((text: string) => text);
	const dim = style.dim ?? ((text: string) => text);
	const limit = Math.max(1, Math.floor(maxRows));
	const start = Math.max(0, Math.min(viewportStart, Math.max(0, rows.length - limit)));
	const end = Math.min(rows.length, start + limit);
	const visibleRows = rows.slice(start, end);
	const safeAgents = visibleRows.map((row) =>
		row.agent ? clampAgentIdentifier(sanitizeDisplayText(row.agent)) : "",
	);
	const agentWidth = Math.max(...safeAgents.map(visibleWidth), 0);
	const elapsedValues = visibleRows.map((row) => formatElapsed(row.elapsedSeconds));
	const elapsedWidth = Math.max(...elapsedValues.map(visibleWidth), 0);
	const markerColumns = activeMarkerColumns(visibleRows);
	const lines = [border("─".repeat(safeWidth))];
	lines.push(truncateToWidth(title(` Sub-agents (${rows.length})`), safeWidth));

	for (let visibleIndex = 0; visibleIndex < visibleRows.length; visibleIndex++) {
		const index = start + visibleIndex;
		const row = visibleRows[visibleIndex];
		const isSelected = index === cursor;
		const pointer = isSelected ? selected("→") : " ";
		const elapsed = meta(padToWidth(elapsedValues[visibleIndex], elapsedWidth));
		const agentText = safeAgents[visibleIndex];
		const agentPadding = " ".repeat(Math.max(0, agentWidth - visibleWidth(agentText)));
		const agent = agentWidth > 0
			? ` ${agentText === "" ? " ".repeat(agentWidth) : agentStyle(agentText) + agentPadding}`
			: "";
		const markerCells = formatMarkerCells(row, markerColumns);
		const markers = markerCells === "" ? "" : ` ${markerStyle(markerCells)}`;
		const name = nameStyle(` ${sanitizeDisplayText(row.name)}`);
		const status = meta(` · ${row.status ?? "starting"}`);
		const harness = row.harness ? meta(` · harness ${sanitizeDisplayText(row.harness)}`) : "";
		lines.push(truncateToWidth(`${pointer} ${elapsed}${agent}${markers}${name}${status}${harness}`, safeWidth));
	}

	if (rows.length === 0) lines.push(truncateToWidth(dim(" No active sub-agents"), safeWidth));
	if (rows.length > limit) {
		lines.push(truncateToWidth(dim(` ${start + 1}–${end} of ${rows.length}`), safeWidth));
	}
	const selectedRow = rows[Math.max(0, Math.min(cursor, rows.length - 1))];
	if (selectedRow) {
		lines.push(
			truncateToWidth(
				dim(` ↑/↓ or j/k · ${actionHint(selectedRow)} · esc: close`),
				safeWidth,
			),
		);
	}
	lines.push(border("─".repeat(safeWidth)));
	return lines;
}

function nextViewport(cursor: number, viewportStart: number, rowCount: number, maxRows: number): number {
	const limit = Math.max(1, Math.floor(maxRows));
	const maxStart = Math.max(0, rowCount - limit);
	if (cursor < viewportStart) return cursor;
	if (cursor >= viewportStart + limit) return cursor - limit + 1;
	return Math.min(viewportStart, maxStart);
}

export function registerSubagentRunningCommand(
	pi: ExtensionAPI,
	focus: typeof focusPane = focusPane,
): void {
	pi.registerCommand("subagent-running", {
		description: "Show every sub-agent lifecycle state and visit, zoom, stop, or cancel where available",
		handler: async (_args, ctx) => {
			const initialRows = collectLifecycleWidgetRows();
			if (initialRows.length === 0) {
				ctx.ui.notify("No active sub-agents.", "info");
				return;
			}

			let refreshTimer: ReturnType<typeof setInterval> | undefined;
			let choice: { row: LifecycleWidgetRow; action: PickerAction } | undefined;
			try {
				choice = await ctx.ui.custom<{ row: LifecycleWidgetRow; action: PickerAction } | undefined>(
					(tui, theme, _keybindings, done) => {
					refreshTimer = setInterval(() => tui.requestRender(), 1000);
					const close = (value: { row: LifecycleWidgetRow; action: PickerAction } | undefined): void => {
						if (refreshTimer) clearInterval(refreshTimer);
						refreshTimer = undefined;
						done(value);
					};
					let selectedId: string | undefined = initialRows[0]?.id;
					let fallbackIndex = 0;
					let viewportStart = 0;

					const currentSelection = (): { rows: LifecycleWidgetRow[]; cursor: number } => {
						const rows = collectLifecycleWidgetRows();
						if (rows.length === 0) {
							selectedId = undefined;
							fallbackIndex = 0;
							viewportStart = 0;
							return { rows, cursor: 0 };
						}
						let cursor = selectedId === undefined ? -1 : rows.findIndex((row) => row.id === selectedId);
						if (cursor < 0) {
							cursor = Math.min(fallbackIndex, rows.length - 1);
							selectedId = rows[cursor].id;
						}
						fallbackIndex = cursor;
						viewportStart = nextViewport(cursor, viewportStart, rows.length, RUNNING_PICKER_MAX_ROWS);
						return { rows, cursor };
					};

					return {
						handleInput(data: string): void {
							if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
								close(undefined);
								return;
							}
							const current = currentSelection();
							if (current.rows.length === 0) return;
							if (matchesKey(data, "up") || data === "k") {
								const cursor = (current.cursor - 1 + current.rows.length) % current.rows.length;
								selectedId = current.rows[cursor].id;
								fallbackIndex = cursor;
								viewportStart = nextViewport(cursor, viewportStart, current.rows.length, RUNNING_PICKER_MAX_ROWS);
								tui.requestRender();
								return;
							}
							if (matchesKey(data, "down") || data === "j") {
								const cursor = (current.cursor + 1) % current.rows.length;
								selectedId = current.rows[cursor].id;
								fallbackIndex = cursor;
								viewportStart = nextViewport(cursor, viewportStart, current.rows.length, RUNNING_PICKER_MAX_ROWS);
								tui.requestRender();
								return;
							}
							const row = current.rows[current.cursor];
							if ((matchesKey(data, "enter") || matchesKey(data, "return")) && row.lifecycle === "running") {
								close({ row, action: "goto" });
							} else if (data === "z" && row.lifecycle === "running") {
								close({ row, action: "zoom" });
							} else if (data === "x" && (row.lifecycle === "running" || row.lifecycle === "queued")) {
								close({ row, action: "stop" });
							}
						},
						invalidate(): void {},
						render(width: number): string[] {
							const current = currentSelection();
							return formatRunningPickerLines(current.rows, current.cursor, viewportStart, width, {
								border: (text) => theme.fg("borderMuted", text),
								title: (text) => theme.fg("toolTitle", theme.bold(text)),
								selected: (text) => theme.fg("accent", text),
								name: (text) => theme.fg("accent", text),
								agent: (text) => theme.fg("dim", text),
								marker: (text) => theme.fg("muted", text),
								meta: (text) => theme.fg("muted", text),
								dim: (text) => theme.fg("dim", text),
							});
						},
					};
				},
				);
			} finally {
				if (refreshTimer) clearInterval(refreshTimer);
			}

			if (!choice) return;
			if (choice.row.lifecycle === "queued") {
				const cancelled = cancelQueued(choice.row.id);
				if (!cancelled) {
					ctx.ui.notify(`"${sanitizeDisplayText(choice.row.name)}" already started.`, "info");
					return;
				}
				updateRunningWidget();
				notifyQueueCancelled(pi, cancelled.spec);
				return;
			}

			const child = running.get(choice.row.id);
			if (!child) {
				ctx.ui.notify(`"${sanitizeDisplayText(choice.row.name)}" is no longer running.`, "info");
				return;
			}
			if (choice.action === "stop") {
				child.stoppedByUser = true;
				child.abort.abort();
				return;
			}
			try {
				focus(child.paneId, { zoom: choice.action === "zoom" });
			} catch {
				ctx.ui.notify(`Pane for "${sanitizeDisplayText(child.name)}" is gone.`, "warning");
			}
		},
	});
}
