import { existsSync } from "node:fs";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Box,
	Input,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";
import { describeSmartOpenSync, formatSmartOpenHint } from "./actions.ts";
import {
	formatDetailLines,
	formatHelpFooter,
	formatPreviewLines,
	formatResultRow,
	sanitizeTerminalText,
	type RenderStyles,
} from "./render.ts";
import { ExplorerState } from "./state.ts";
import type { Block } from "./types.ts";

export interface ExplorerActionHandlers {
	copy(block: Block): Promise<void>;
	open(block: Block): Promise<number | null>;
}

export interface ExplorerNotifications {
	(message: string, level: "info" | "warning" | "error"): void;
}

export interface ExplorerComponentOptions {
	tui: TUI;
	theme: Theme;
	state: ExplorerState;
	getBlocks: () => readonly Block[];
	actions: ExplorerActionHandlers;
	notify: ExplorerNotifications;
	done: () => void;
	refreshIntervalMs?: number;
}

function openHint(block: Block | undefined): string {
	return block ? formatSmartOpenHint(describeSmartOpenSync(block, existsSync)) : "smart open";
}

function boundHelpLines(lines: string[], maximum: number): string[] {
	if (lines.length <= maximum) return lines;
	if (maximum <= 1) return lines.slice(-1);
	return [...lines.slice(0, maximum - 1), ...lines.slice(-1)];
}

/**
 * Stateful keyboard controller wrapped in Pi's standard one-cell Box. All
 * transcript formatting stays in the pure render module.
 */
export class ExplorerComponent implements Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly state: ExplorerState;
	private readonly getBlocks: () => readonly Block[];
	private readonly actions: ExplorerActionHandlers;
	private readonly notify: ExplorerNotifications;
	private readonly done: () => void;
	private readonly input = new Input();
	private readonly box: Box;
	private readonly contentComponent: Component;
	private readonly refreshTimer: ReturnType<typeof setInterval>;
	private lastBlocks: readonly Block[] | undefined;
	private lastWidth = 80;
	private actionRunning = false;
	private _focused = false;

	constructor(options: ExplorerComponentOptions) {
		this.tui = options.tui;
		this.theme = options.theme;
		this.state = options.state;
		this.getBlocks = options.getBlocks;
		this.actions = options.actions;
		this.notify = options.notify;
		this.done = options.done;
		this.input.setValue(this.state.query);
		this.contentComponent = {
			render: (width) => this.renderContent(width),
			handleInput: (data) => this.handleInput(data),
			invalidate: () => {},
		};
		this.box = new Box(1, 1, (text) => this.theme.bg("toolPendingBg", text));
		this.box.addChild(this.contentComponent);
		this.refreshTimer = setInterval(() => {
			if (!this.syncBlocks()) return;
			this.box.invalidate();
			this.tui.requestRender();
		}, options.refreshIntervalMs ?? 200);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value && this.state.mode === "filter";
	}

	render(width: number): string[] {
		this.syncBlocks();
		return this.box.render(Math.max(1, Math.floor(width)));
	}

	handleInput(data: string): void {
		this.syncBlocks();
		if (this.state.mode === "detail") this.handleDetailInput(data);
		else if (this.state.mode === "filter") this.handleFilterInput(data);
		else this.handleListInput(data);
	}

	invalidate(): void {
		this.box.invalidate();
	}

	dispose(): void {
		clearInterval(this.refreshTimer);
	}

	private styles(): RenderStyles {
		return {
			title: (text) => this.theme.fg("toolTitle", this.theme.bold(text)),
			accent: (text) => this.theme.fg("accent", text),
			muted: (text) => this.theme.fg("muted", text),
			dim: (text) => this.theme.fg("dim", text),
			body: (text) => this.theme.fg("toolOutput", text),
			selected: (text) => this.theme.bg("selectedBg", text),
			highlight: (text) => this.theme.fg("accent", this.theme.bold(text)),
			border: (text) => this.theme.fg("borderMuted", text),
		};
	}

	private syncBlocks(): boolean {
		const blocks = this.getBlocks();
		if (blocks === this.lastBlocks) return false;
		this.lastBlocks = blocks;
		this.state.syncBlocks(blocks);
		return true;
	}

	private renderContent(width: number): string[] {
		this.syncBlocks();
		this.lastWidth = Math.max(1, Math.floor(width));
		const maxHeight = Math.max(1, Math.floor(this.tui.terminal.rows * 0.9) - 2);
		return this.state.mode === "detail"
			? this.renderDetail(this.lastWidth, maxHeight)
			: this.renderList(this.lastWidth, maxHeight);
	}

	private titleLine(width: number): string {
		const title = this.theme.fg("toolTitle", this.theme.bold("fuzzy-explorer"));
		const metadata = this.theme.fg("muted", ` · ${this.state.results.length} blocks · ${this.state.mode}`);
		return truncateToWidth(`${title}${metadata}`, width, "");
	}

	private queryLine(width: number): string {
		const label = this.theme.fg("toolTitle", this.theme.bold(this.state.mode === "filter" ? "filter" : "query"));
		const prefix = `${label}${this.theme.fg("muted", " › ")}`;
		if (this.state.mode === "filter") {
			this.input.focused = this.focused;
			const [line = ""] = this.input.render(Math.max(1, width - visibleWidth(prefix)));
			return truncateToWidth(`${prefix}${line}`, width, "");
		}
		const query = this.state.query === "" ? this.theme.fg("dim", "(none; / to filter)") : this.theme.fg("accent", sanitizeTerminalText(this.state.query));
		return truncateToWidth(`${prefix}${query}`, width, "");
	}

	private renderList(width: number, maxHeight: number): string[] {
		const styles = this.styles();
		const allHelp = formatHelpFooter(width, openHint(this.state.selected?.block), styles, this.state.mode);
		if (maxHeight < 5) return boundHelpLines(allHelp, maxHeight);
		const help = boundHelpLines(allHelp, Math.max(1, maxHeight - 4));
		let available = maxHeight - help.length - 2;
		const showTitle = available >= 3;
		if (showTitle) available--;
		const showRange = available >= 3;
		if (showRange) available--;
		const listRows = Math.max(1, Math.floor(available * 0.55));
		const previewRows = Math.max(1, available - listRows);
		this.state.setListPageSize(listRows);

		const lines: string[] = [];
		if (showTitle) lines.push(this.titleLine(width));
		lines.push(this.queryLine(width));
		if (showRange) {
			lines.push(truncateToWidth(this.theme.fg("muted", ` ${this.state.listViewport + (this.state.results.length === 0 ? 0 : 1)}–${Math.min(this.state.results.length, this.state.listViewport + listRows)} of ${this.state.results.length}`), width, ""));
		}
		const visible = this.state.results.slice(this.state.listViewport, this.state.listViewport + listRows);
		for (let index = 0; index < listRows; index++) {
			const result = visible[index];
			lines.push(result
				? formatResultRow(result, result.block.id === this.state.selectedId, width, styles)
				: "");
		}
		lines.push(truncateToWidth(this.theme.fg("borderMuted", "─".repeat(width)), width, ""));

		const selected = this.state.selected;
		const preview = selected
			? formatPreviewLines(selected, width, previewRows, styles, existsSync)
			: [truncateToWidth(this.theme.fg("dim", "No matching transcript blocks"), width, "")];
		lines.push(...preview.slice(0, previewRows));
		const contentLineTarget = (showTitle ? 1 : 0) + 1 + (showRange ? 1 : 0) + listRows + 1 + previewRows;
		while (lines.length < contentLineTarget) lines.push("");
		lines.push(...help);
		return lines.slice(0, maxHeight).map((line) => truncateToWidth(line, width, ""));
	}

	private detailLines(width = this.lastWidth): string[] {
		const selected = this.state.selected;
		return selected ? formatDetailLines(selected, width, this.styles(), existsSync) : [];
	}

	private renderDetail(width: number, maxHeight: number): string[] {
		const styles = this.styles();
		const allHelp = formatHelpFooter(width, openHint(this.state.selected?.block), styles, this.state.mode);
		if (maxHeight < 3) return boundHelpLines(allHelp, maxHeight);
		const help = boundHelpLines(allHelp, Math.max(1, maxHeight - 2));
		let detailRows = Math.max(1, maxHeight - help.length - 1);
		const showTitle = detailRows >= 2;
		if (showTitle) detailRows--;
		this.state.setDetailPageSize(detailRows);
		const allDetailLines = this.detailLines(width);
		this.state.scrollDetail(0, allDetailLines.length);
		const selectedIndex = this.state.results.length === 0 ? 0 : this.state.selectedIndex + 1;
		const status = truncateToWidth(
			this.theme.fg("muted", `Detail ${selectedIndex}/${this.state.results.length} · Esc returns to list`),
			width,
			"",
		);
		const shown = allDetailLines.slice(this.state.detailOffset, this.state.detailOffset + detailRows);
		while (shown.length < detailRows) shown.push("");
		return [...(showTitle ? [this.titleLine(width)] : []), status, ...shown, ...help]
			.slice(0, maxHeight)
			.map((line) => truncateToWidth(line, width, ""));
	}

	private handleListInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.done();
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) this.state.moveSelection(-1);
		else if (matchesKey(data, "down") || matchesKey(data, "j")) this.state.moveSelection(1);
		else if (matchesKey(data, "u")) this.state.pageSelection(-1);
		else if (matchesKey(data, "d")) this.state.pageSelection(1);
		else if (matchesKey(data, "g")) this.state.selectFirst();
		else if (matchesKey(data, "shift+g")) this.state.selectLast();
		else if (matchesKey(data, "/")) this.state.enterFilter();
		else if (matchesKey(data, "enter") || matchesKey(data, "return")) this.state.enterDetail();
		else if (matchesKey(data, "y")) this.runCopy();
		else if (matchesKey(data, "o")) this.runOpen();
		else return;
		this.input.focused = this.focused && this.state.mode === "filter";
		this.tui.requestRender();
	}

	private handleFilterInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.state.escape();
		} else if (matchesKey(data, "up")) {
			this.state.moveSelection(-1);
		} else if (matchesKey(data, "down")) {
			this.state.moveSelection(1);
		} else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			this.state.enterDetail();
		} else if (matchesKey(data, "ctrl+u")) {
			this.input.setValue("");
			this.state.setQuery("");
		} else {
			this.input.handleInput(data);
			this.state.setQuery(this.input.getValue());
		}
		this.input.focused = this.focused && this.state.mode === "filter";
		this.tui.requestRender();
	}

	private handleDetailInput(data: string): void {
		const detailLineCount = this.detailLines().length;
		if (matchesKey(data, "escape")) this.state.escape();
		else if (matchesKey(data, "up") || matchesKey(data, "k")) this.state.scrollDetail(-1, detailLineCount);
		else if (matchesKey(data, "down") || matchesKey(data, "j")) this.state.scrollDetail(1, detailLineCount);
		else if (matchesKey(data, "u")) this.state.pageDetail(-1, detailLineCount);
		else if (matchesKey(data, "d")) this.state.pageDetail(1, detailLineCount);
		else if (matchesKey(data, "shift+j")) this.state.jumpDetail(1);
		else if (matchesKey(data, "shift+k")) this.state.jumpDetail(-1);
		else if (matchesKey(data, "y")) this.runCopy();
		else if (matchesKey(data, "o")) this.runOpen();
		else return;
		this.tui.requestRender();
	}

	private runCopy(): void {
		const block = this.state.selected?.block;
		if (!block || this.actionRunning) return;
		this.actionRunning = true;
		void this.actions.copy(block)
			.then(() => this.notify("Copied the complete block.", "info"))
			.catch((error: unknown) => this.notify(`Copy failed: ${error instanceof Error ? error.message : String(error)}`, "error"))
			.finally(() => { this.actionRunning = false; this.tui.requestRender(); });
	}

	private runOpen(): void {
		const block = this.state.selected?.block;
		if (!block || this.actionRunning) return;
		this.actionRunning = true;
		void this.actions.open(block)
			.then((exitCode) => {
				if (exitCode !== 0 && exitCode !== null) this.notify(`External editor exited with code ${exitCode}.`, "warning");
			})
			.catch((error: unknown) => this.notify(`Open failed: ${error instanceof Error ? error.message : String(error)}`, "error"))
			.finally(() => { this.actionRunning = false; this.tui.requestRender(true); });
	}
}
