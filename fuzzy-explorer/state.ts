import { searchBlocks } from "./search.ts";
import type { Block, ListOrder, SearchResult } from "./types.ts";

export type ExplorerMode = "list" | "filter" | "detail";

/**
 * UI state is independent from terminal rendering. Selection is stored as a
 * block id so re-filtering, live appends, and resize do not move a surviving
 * selection.
 */
export class ExplorerState {
	mode: ExplorerMode;
	query = "";
	results: SearchResult[] = [];
	selectedId: string | undefined;
	listViewport = 0;
	detailOffset = 0;
	listPageSize = 1;
	detailPageSize = 1;

	private blocks: readonly Block[] = [];
	private fallbackIndex = 0;
	private initialized = false;
	private readonly listOrder: ListOrder;

	constructor(openMode: "list" | "filter", listOrder: ListOrder) {
		this.mode = openMode;
		this.listOrder = listOrder;
	}

	get selectedIndex(): number {
		if (this.results.length === 0) return 0;
		const index = this.selectedId === undefined
			? -1
			: this.results.findIndex((result) => result.block.id === this.selectedId);
		return index < 0 ? Math.min(this.fallbackIndex, this.results.length - 1) : index;
	}

	get selected(): SearchResult | undefined {
		return this.results[this.selectedIndex];
	}

	syncBlocks(blocks: readonly Block[]): void {
		this.blocks = blocks;
		this.refreshResults(!this.initialized);
		this.initialized = true;
	}

	setQuery(query: string): void {
		this.query = query;
		this.refreshResults(false);
	}

	setListPageSize(size: number): void {
		this.listPageSize = Math.max(1, Math.floor(size));
		this.ensureSelectionVisible();
	}

	setDetailPageSize(size: number): void {
		this.detailPageSize = Math.max(1, Math.floor(size));
	}

	moveSelection(delta: number): void {
		if (this.results.length === 0) return;
		this.selectIndex(Math.max(0, Math.min(this.results.length - 1, this.selectedIndex + delta)));
	}

	pageSelection(direction: -1 | 1): void {
		this.moveSelection(direction * this.listPageSize);
	}

	selectFirst(): void {
		if (this.results.length > 0) this.selectIndex(0);
	}

	selectLast(): void {
		if (this.results.length > 0) this.selectIndex(this.results.length - 1);
	}

	enterFilter(): void {
		this.mode = "filter";
	}

	enterDetail(): void {
		if (!this.selected) return;
		this.mode = "detail";
		this.detailOffset = 0;
	}

	jumpDetail(direction: -1 | 1): void {
		if (this.results.length === 0) return;
		const target = Math.max(0, Math.min(this.results.length - 1, this.selectedIndex + direction));
		if (target === this.selectedIndex) return;
		this.selectIndex(target);
		this.detailOffset = 0;
	}

	scrollDetail(delta: number, lineCount: number): void {
		const maxOffset = Math.max(0, lineCount - this.detailPageSize);
		this.detailOffset = Math.max(0, Math.min(maxOffset, this.detailOffset + delta));
	}

	pageDetail(direction: -1 | 1, lineCount: number): void {
		this.scrollDetail(direction * this.detailPageSize, lineCount);
	}

	/** Return true only when Escape should close the overlay. */
	escape(): boolean {
		if (this.mode === "detail") {
			this.mode = "list";
			this.ensureSelectionVisible();
			return false;
		}
		if (this.mode === "filter") {
			this.mode = "list";
			return false;
		}
		return true;
	}

	private selectIndex(index: number): void {
		const result = this.results[index];
		if (!result) return;
		this.selectedId = result.block.id;
		this.fallbackIndex = index;
		this.ensureSelectionVisible();
	}

	private refreshResults(firstLoad: boolean): void {
		const previousId = this.selectedId;
		const previousIndex = this.selectedIndex;
		this.results = searchBlocks(this.blocks, this.query, this.listOrder);

		if (this.results.length === 0) {
			this.selectedId = undefined;
			this.fallbackIndex = 0;
			this.listViewport = 0;
			return;
		}

		const survivingIndex = previousId === undefined
			? -1
			: this.results.findIndex((result) => result.block.id === previousId);
		if (survivingIndex >= 0) {
			this.selectedId = previousId;
			this.fallbackIndex = survivingIndex;
		} else if (firstLoad || previousId === undefined) {
			const resultIds = new Set(this.results.map((result) => result.block.id));
			const newestId = [...this.blocks].reverse().find((block) => resultIds.has(block.id))?.id;
			const newestIndex = newestId === undefined
				? this.results.length - 1
				: this.results.findIndex((result) => result.block.id === newestId);
			this.selectIndex(newestIndex < 0 ? this.results.length - 1 : newestIndex);
		} else {
			this.selectIndex(Math.min(previousIndex, this.results.length - 1));
		}
		this.ensureSelectionVisible();
	}

	private ensureSelectionVisible(): void {
		if (this.results.length === 0) {
			this.listViewport = 0;
			return;
		}
		const index = this.selectedIndex;
		if (index < this.listViewport) this.listViewport = index;
		if (index >= this.listViewport + this.listPageSize) {
			this.listViewport = index - this.listPageSize + 1;
		}
		this.listViewport = Math.max(0, Math.min(this.listViewport, Math.max(0, this.results.length - this.listPageSize)));
	}
}
