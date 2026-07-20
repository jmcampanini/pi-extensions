import type { TruncationResult } from "@earendil-works/pi-coding-agent";

export type BlockKind = "user" | "assistant" | "tool" | "bash" | "custom" | "summary";

export interface FileReference {
	path: string;
	line?: number;
}

export interface BlockTruncation {
	truncated: true;
	metadata?: Partial<TruncationResult>;
	fullOutputPath?: string;
}

export interface Block {
	id: string;
	kind: BlockKind;
	entryId: string;
	entryIds: string[];
	timestamp: string;
	fields: string;
	body: string;
	title: string;
	subtitle?: string;
	canonicalText: string;
	canonicalBodyOffset?: number;
	toolName?: string;
	toolCallId?: string;
	fileReference?: FileReference;
	truncation?: BlockTruncation;
	label?: string;
	isError?: boolean;
}

export interface QueryOperator {
	key: "is" | "tool";
	value: string;
}

export interface ParsedQuery {
	tokens: string[];
	operators: QueryOperator[];
}

export interface HighlightSpan {
	zone: "fields" | "body";
	start: number;
	end: number;
}

export interface BlockMatch {
	matches: boolean;
	score: number;
	highlightSpans: HighlightSpan[];
}

export type ListOrder = "chronological" | "reverse-chronological" | "relevance";

export interface SearchResult {
	block: Block;
	match: BlockMatch;
}
