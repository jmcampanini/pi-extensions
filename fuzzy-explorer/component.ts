import { existsSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Markdown,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
	type Component,
	type Focusable,
	type MarkdownTheme,
	type TUI,
} from "@earendil-works/pi-tui";
import { describeSmartOpenSync, formatSmartOpenHint } from "./actions.ts";
import {
	computeTagWidth,
	formatBorderLine,
	formatDetailIdentity,
	formatDetailLines,
	formatFrameLine,
	formatHintBorder,
	formatPreviewIdentity,
	formatPreviewLines,
	formatResultRow,
	formatSubagentTable,
	formatTruncationMarker,
	PLAIN_MARKDOWN_THEME,
	rendersMarkdownByDefault,
	sanitizeTerminalText,
	tailAwareTruncate,
	type RenderStyles,
} from "./render.ts";
import { ExplorerState } from "./state.ts";
import { subagentView } from "./subagent.ts";
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
	markdownTheme?: MarkdownTheme;
}

function openHint(block: Block | undefined): string {
	const hint = block ? formatSmartOpenHint(describeSmartOpenSync(block, existsSync)) : "smart open";
	// Keep the hint short so it survives the bottom border's width degradation.
	return stripVTControlCharacters(tailAwareTruncate(hint, 32));
}

/**
 * Stateful keyboard controller that renders the whole overlay as one bordered
 * frame: all chrome lives in the border, interior lines are content only. All
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
	private readonly markdown: Markdown;
	private readonly refreshTimer: ReturnType<typeof setInterval>;
	private lastBlocks: readonly Block[] | undefined;
	private lastMarkdownText: string | undefined;
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
		this.markdown = new Markdown("", 0, 0, options.markdownTheme ?? PLAIN_MARKDOWN_THEME);
		this.input.setValue(this.state.query);
		this.refreshTimer = setInterval(() => {
			if (!this.syncBlocks()) return;
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
		this.lastWidth = Math.max(1, Math.floor(width));
		const maxHeight = Math.max(3, Math.floor(this.tui.terminal.rows * 0.9));
		return this.state.mode === "detail"
			? this.renderDetail(this.lastWidth, maxHeight)
			: this.renderList(this.lastWidth, maxHeight);
	}

	handleInput(data: string): void {
		this.syncBlocks();
		if (this.state.mode === "detail") this.handleDetailInput(data);
		else if (this.state.mode === "filter") this.handleFilterInput(data);
		else this.handleListInput(data);
	}

	invalidate(): void {
		this.input.invalidate();
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

	private hints(): string[] {
		if (this.state.mode === "filter") {
			return ["enter detail", "esc list", "↑/↓ move", "ctrl+u clear", "is: tool: any:"];
		}
		if (this.state.mode === "detail") {
			return [
				"j/k scroll",
				"u/d page",
				"J/K blocks",
				"h/q/esc list",
				`m ${this.detailMarkdown() ? "raw" : "md"}`,
				"y copy",
				`o ${openHint(this.state.selected?.block)}`,
			];
		}
		return [
			"l/enter detail",
			"/ filter",
			"q/esc quit",
			"j/k move",
			"u/d page",
			"g/G ends",
			"y copy",
			`o ${openHint(this.state.selected?.block)}`,
			"is: tool: any:",
		];
	}

	private inputLine(innerWidth: number): string {
		const prefix = this.theme.fg("muted", "› ");
		if (this.state.mode === "filter") {
			this.input.focused = this.focused;
			// Input renders its own hardcoded "> " prompt; swap it for our prefix.
			const [line = ""] = this.input.render(Math.max(3, innerWidth));
			return `${prefix}${line.startsWith("> ") ? line.slice(2) : line}`;
		}
		const query = this.state.query === ""
			? this.theme.fg("dim", "/ to filter")
			: this.theme.fg("accent", sanitizeTerminalText(this.state.query));
		return `${prefix}${query}`;
	}

	private renderList(width: number, height: number): string[] {
		const styles = this.styles();
		const border = styles.border;
		const innerWidth = Math.max(1, width - 4);

		// 35/65 list/preview split around six fixed chrome lines; tight heights
		// drop the preview section first, then the rule and rows, so the frame
		// always closes with its bottom border.
		const showRule = height >= 4;
		let listRows: number;
		let previewRows: number;
		if (height >= 8) {
			const available = height - 6;
			listRows = Math.max(1, Math.floor(available * 0.35));
			previewRows = Math.max(1, available - listRows);
		} else {
			listRows = Math.max(0, height - 3 - (showRule ? 1 : 0));
			previewRows = 0;
		}
		this.state.setListPageSize(Math.max(1, listRows));

		const lines: string[] = [
			formatBorderLine(
				width,
				["┌", "┐"],
				styles.title("fuzzy"),
				styles.muted(`${this.state.results.length}/${this.state.totalBlocks}`),
				border,
			),
			formatFrameLine(width, this.inputLine(innerWidth), border),
		];
		if (showRule) lines.push(formatBorderLine(width, ["├", "┤"], "", "", border));

		const visible = this.state.results.slice(this.state.listViewport, this.state.listViewport + listRows);
		const tagWidth = computeTagWidth(visible);
		for (let index = 0; index < listRows; index++) {
			const result = visible[index];
			lines.push(formatFrameLine(
				width,
				result === undefined
					? ""
					: formatResultRow(
						result,
						this.state.listViewport + index === this.state.selectedIndex,
						innerWidth,
						tagWidth,
						styles,
					),
				border,
			));
		}

		if (previewRows > 0) {
			const selected = this.state.selected;
			lines.push(formatFrameLine(width, "", border));
			lines.push(formatBorderLine(
				width,
				["├", "┤"],
				selected === undefined ? "" : styles.accent(formatPreviewIdentity(selected.block)),
				"",
				border,
			));
			const preview = selected === undefined
				? [styles.dim("no matching transcript blocks")]
				: formatPreviewLines(selected, innerWidth, previewRows, styles, existsSync);
			for (let index = 0; index < previewRows; index++) {
				lines.push(formatFrameLine(width, preview[index] ?? "", border));
			}
		}

		lines.push(formatHintBorder(width, this.hints(), styles));
		return lines;
	}

	/** Whether the current detail view shows rendered markdown (`m` overrides the policy). */
	private detailMarkdown(): boolean {
		const block = this.state.selected?.block;
		if (!block) return false;
		if (block.body === "" && subagentView(block) === undefined) return false;
		return this.state.detailMarkdownOverride ?? rendersMarkdownByDefault(block);
	}

	private detailLines(width = this.lastWidth): string[] {
		const selected = this.state.selected;
		if (!selected) return [];
		const innerWidth = Math.max(1, width - 4);
		if (!this.detailMarkdown()) {
			return formatDetailLines(selected, innerWidth, this.styles(), existsSync);
		}

		// Rendered markdown shows parsed content only; copy and open keep the raw text.
		const styles = this.styles();
		const view = subagentView(selected.block);
		const text = sanitizeTerminalText(view === undefined ? selected.block.body : view.content);
		const lines: string[] = [];
		const appendFields = (): void => {
			if (view?.result) {
				for (const line of formatSubagentTable(view).split("\n")) {
					lines.push(...wrapTextWithAnsi(sanitizeTerminalText(line), innerWidth).map(styles.muted));
				}
				return;
			}
			for (const field of view?.fields ?? []) {
				lines.push(truncateToWidth(styles.muted(sanitizeTerminalText(`${field.key}=${field.value}`)), innerWidth, ""));
			}
		};
		if (!view?.result) appendFields();
		if (lines.length > 0 && text !== "") lines.push("");
		if (text !== "") {
			if (text !== this.lastMarkdownText) {
				this.markdown.setText(text);
				this.lastMarkdownText = text;
			}
			lines.push(...this.markdown.render(innerWidth).map((line) => truncateToWidth(line, innerWidth, "")));
		}
		if (view?.result && view.fields.length > 0) {
			if (text !== "") lines.push("");
			appendFields();
		}
		const marker = formatTruncationMarker(selected.block.truncation, existsSync);
		if (marker !== undefined) lines.push(truncateToWidth(styles.dim(marker), innerWidth, ""));
		return lines;
	}

	private renderDetail(width: number, height: number): string[] {
		const styles = this.styles();
		const contentRows = Math.max(1, height - 2);
		this.state.setDetailPageSize(contentRows);
		const selected = this.state.selected;
		const allLines = this.detailLines(width);
		this.state.scrollDetail(0, allLines.length);
		const position = this.state.results.length === 0
			? "0/0"
			: `${this.state.selectedIndex + 1}/${this.state.results.length}`;

		const lines: string[] = [
			formatBorderLine(
				width,
				["┌", "┐"],
				selected === undefined ? styles.title("fuzzy") : styles.accent(formatDetailIdentity(selected.block)),
				styles.muted(position),
				styles.border,
			),
		];
		const shown = allLines.slice(this.state.detailOffset, this.state.detailOffset + contentRows);
		for (let index = 0; index < contentRows; index++) {
			lines.push(formatFrameLine(width, shown[index] ?? "", styles.border));
		}
		lines.push(formatHintBorder(width, this.hints(), styles));
		return lines;
	}

	private handleListInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
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
		else if (matchesKey(data, "enter") || matchesKey(data, "return") || matchesKey(data, "l")) this.state.enterDetail();
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
		if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "h")) this.state.escape();
		else if (matchesKey(data, "up") || matchesKey(data, "k")) this.state.scrollDetail(-1, detailLineCount);
		else if (matchesKey(data, "down") || matchesKey(data, "j")) this.state.scrollDetail(1, detailLineCount);
		else if (matchesKey(data, "u")) this.state.pageDetail(-1, detailLineCount);
		else if (matchesKey(data, "d")) this.state.pageDetail(1, detailLineCount);
		else if (matchesKey(data, "shift+j")) this.state.jumpDetail(1);
		else if (matchesKey(data, "shift+k")) this.state.jumpDetail(-1);
		else if (matchesKey(data, "m")) this.toggleDetailMarkdown();
		else if (matchesKey(data, "y")) this.runCopy();
		else if (matchesKey(data, "o")) this.runOpen();
		else return;
		this.tui.requestRender();
	}

	private toggleDetailMarkdown(): void {
		const block = this.state.selected?.block;
		if (!block) return;
		this.state.toggleDetailMarkdown(rendersMarkdownByDefault(block));
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
