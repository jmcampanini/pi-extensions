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
	/** Structured metadata blob (ids, timestamps, args); searched only through `any:`. */
	fields: string;
	/** Short curated identity (kind + tool name + title/subtitle) that free tokens fuzzy-match. */
	searchKey: string;
	body: string;
	/** Separator-stripped body copy backing the substring-match fallback. */
	strippedBody: string;
	/** Complete `any:` haystack: fields blob plus canonical text. */
	anyText: string;
	/** Separator-stripped `any:` haystack copy. */
	strippedAnyText: string;
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
	key: "is" | "tool" | "any";
	value: string;
}

export interface ParsedQuery {
	tokens: string[];
	operators: QueryOperator[];
}

export interface BlockMatch {
	matches: boolean;
	score: number;
	/** Token forms (raw or separator-stripped) that matched the search key. */
	keyTokens: string[];
	/** Token forms (raw or separator-stripped) that matched the body. */
	bodyTokens: string[];
}

export interface SearchResult {
	block: Block;
	match: BlockMatch;
}
