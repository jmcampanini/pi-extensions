/**
 * command-status.ts — /subagent-status live lifecycle picker.
 *
 * The compact widget is capped; this bounded-height view refreshes the full
 * delivering, running-state, starting, and queued projection while open. It
 * reuses the widget's row geometry and adds selection, viewport, exact harness
 * detail, and lifecycle-specific actions. Selection follows a child id as
 * priority changes move rows.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { requestCancel } from "./cancel.ts";
import { sanitizeDisplayText } from "./display-text.ts";
import { clampStyled, fitText } from "./text-fit.ts";
import {
	collectLifecycleWidgetRows,
	type LifecycleWidgetRow,
	suspendRunningWidget,
	updateRunningWidget,
} from "./running-widget.ts";
import { running } from "./state.ts";
import { focusPane } from "./tmux.ts";
import { formatLifecycleRowLines } from "./widget.ts";

export const STATUS_PICKER_MAX_ROWS = 10;

type PickerAction = "goto" | "zoom" | "cancel";

type PickerChoice = { row: LifecycleWidgetRow; action: PickerAction };

const plainText = (text: string): string => text;

export interface StatusPickerStyle {
	border?: (text: string) => string;
	selected?: (text: string) => string;
	name?: (text: string) => string;
	agent?: (text: string) => string;
	marker?: (text: string) => string;
	meta?: (text: string) => string;
	dim?: (text: string) => string;
	warn?: (text: string) => string;
}

function actionHint(row: LifecycleWidgetRow): string {
	if (row.lifecycle === "running") return "enter: visit · z: visit + zoom · x: stop";
	if (row.lifecycle === "queued") return "x: cancel queued launch";
	if (row.lifecycle === "pending") return "x: cancel launch";
	return row.status === "stopped"
		? "stopped; its stopped notice is on its way"
		: "finished; result is on its way";
}

export function formatStatusPickerLines(
	rows: readonly LifecycleWidgetRow[],
	cursor: number,
	viewportStart: number,
	width: number,
	style: StatusPickerStyle = {},
	maxRows = STATUS_PICKER_MAX_ROWS,
): string[] {
	const safeWidth = Math.max(0, width);
	const border = style.border ?? plainText;
	const selected = style.selected ?? plainText;
	const nameStyle = style.name ?? plainText;
	const agentStyle = style.agent ?? plainText;
	const markerStyle = style.marker ?? plainText;
	const meta = style.meta ?? plainText;
	const dim = style.dim ?? plainText;
	const warn = style.warn ?? dim;
	const limit = Math.max(1, Math.floor(maxRows));
	const start = Math.max(0, Math.min(viewportStart, Math.max(0, rows.length - limit)));
	const end = Math.min(rows.length, start + limit);
	const visibleRows = rows.slice(start, end);
	const lines = [border("─".repeat(safeWidth))];
	lines.push(...formatLifecycleRowLines(visibleRows, width, {
		dim,
		name: nameStyle,
		selected,
		agent: agentStyle,
		slot: markerStyle,
		warn,
	}, { selectedIndex: cursor - start }));

	if (rows.length === 0) lines.push(dim(fitText(" No unresolved sub-agents", safeWidth)));
	if (rows.length > limit) {
		lines.push(dim(fitText(` ${start + 1}–${end} of ${rows.length}`, safeWidth)));
	}
	const selectedRow = rows[Math.max(0, Math.min(cursor, rows.length - 1))];
	if (selectedRow) {
		lines.push("");
		const controls = `${actionHint(selectedRow)} · ↑/↓ or j/k: select · esc: close`;
		const harnessName = selectedRow.harness ? sanitizeDisplayText(selectedRow.harness) : undefined;
		const showHarness = harnessName !== undefined
			&& visibleWidth(` harness ${harnessName} · ${controls}`) <= safeWidth;
		const harness = showHarness ? meta(` harness ${harnessName}`) + dim(" · ") : "";
		lines.push(clampStyled(harness + dim(`${showHarness ? "" : " "}${controls}`), safeWidth));
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

export function registerSubagentStatusCommand(
	pi: ExtensionAPI,
	focus: typeof focusPane = focusPane,
): void {
	pi.registerCommand("subagent-status", {
		description: "Show every sub-agent lifecycle state and visit, zoom, stop, or cancel where available",
		handler: async (_args, ctx) => {
			const initialRows = collectLifecycleWidgetRows();
			if (initialRows.length === 0) {
				ctx.ui.notify("No unresolved sub-agents.", "info");
				return;
			}

			let refreshTimer: ReturnType<typeof setInterval> | undefined;
			let choice: PickerChoice | undefined;
			const restoreRunningWidget = suspendRunningWidget(ctx);
			try {
				choice = await ctx.ui.custom<PickerChoice | undefined>(
					(tui, theme, _keybindings, done) => {
					refreshTimer = setInterval(() => tui.requestRender(), 1000);
					const close = (value: PickerChoice | undefined): void => {
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
						viewportStart = nextViewport(cursor, viewportStart, rows.length, STATUS_PICKER_MAX_ROWS);
						return { rows, cursor };
					};
					const selectRow = (rows: LifecycleWidgetRow[], cursor: number): void => {
						selectedId = rows[cursor].id;
						fallbackIndex = cursor;
						viewportStart = nextViewport(cursor, viewportStart, rows.length, STATUS_PICKER_MAX_ROWS);
						tui.requestRender();
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
								selectRow(current.rows, (current.cursor - 1 + current.rows.length) % current.rows.length);
								return;
							}
							if (matchesKey(data, "down") || data === "j") {
								selectRow(current.rows, (current.cursor + 1) % current.rows.length);
								return;
							}
							const row = current.rows[current.cursor];
							if ((matchesKey(data, "enter") || matchesKey(data, "return")) && row.lifecycle === "running") {
								close({ row, action: "goto" });
							} else if (data === "z" && row.lifecycle === "running") {
								close({ row, action: "zoom" });
							} else if (data === "x" && (
								row.lifecycle === "running" || row.lifecycle === "queued" || row.lifecycle === "pending"
							)) {
								close({ row, action: "cancel" });
							}
						},
						invalidate(): void {},
						render(width: number): string[] {
							const current = currentSelection();
							return formatStatusPickerLines(current.rows, current.cursor, viewportStart, width, {
								border: (text) => theme.fg("borderMuted", text),
								selected: (text) => theme.fg("accent", text),
								agent: (text) => theme.fg("muted", text),
								marker: (text) => theme.fg("muted", text),
								meta: (text) => theme.fg("muted", text),
								dim: (text) => theme.fg("dim", text),
								warn: (text) => theme.fg("warning", text),
							});
						},
					};
				},
				);
			} finally {
				if (refreshTimer) clearInterval(refreshTimer);
				restoreRunningWidget();
			}

			if (!choice) return;
			if (choice.action === "cancel") {
				const outcome = requestCancel(pi, choice.row.id, "user");
				updateRunningWidget();
				const name = `"${sanitizeDisplayText(choice.row.name)}"`;
				if (outcome.kind === "already-stopping") {
					ctx.ui.notify(`${name} is already stopping; its stopped notice is on its way.`, "info");
				} else if (outcome.kind === "delivering") {
					ctx.ui.notify(
						outcome.stopped
							? `${name} already stopped; its stopped notice is on its way.`
							: `${name} already finished; its result is on its way.`,
						"info",
					);
				} else if (outcome.kind === "already-cancelled") {
					ctx.ui.notify(`${name} was already cancelled.`, "info");
				} else if (outcome.kind === "completed" || outcome.kind === "unknown") {
					ctx.ui.notify(`${name} is already finished.`, "info");
				}
				return;
			}

			const child = running.get(choice.row.id);
			if (!child) {
				ctx.ui.notify(`"${sanitizeDisplayText(choice.row.name)}" is no longer running.`, "info");
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
