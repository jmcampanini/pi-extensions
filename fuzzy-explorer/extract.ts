import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type {
	SessionEntry,
	SessionMessageEntry,
	TruncationResult,
} from "@earendil-works/pi-coding-agent";
import type {
	Block,
	BlockKind,
	BlockTruncation,
	FileReference,
} from "./types.ts";

const IMAGE_PLACEHOLDER = "[image]";
const MAX_FLAT_ARGUMENTS = 24;
const MAX_FLAT_VALUE_LENGTH = 120;
const MAX_FLAT_ARGUMENTS_LENGTH = 600;

interface RecordValue {
	[key: string]: unknown;
}

export interface MatchedToolResult {
	entry: SessionMessageEntry;
	message: ToolResultMessage;
}

export interface MakeBlockOptions {
	idPart: string;
	kind: BlockKind;
	role: string;
	body: string;
	title: string;
	canonicalText: string;
	canonicalBodyOffset?: number;
	entryIds?: string[];
	fieldParts?: string[];
	subtitle?: string;
	toolName?: string;
	toolCallId?: string;
	fileReference?: FileReference;
	truncation?: BlockTruncation;
	isError?: boolean;
}

export interface ExtractionContext {
	entries: readonly SessionEntry[];
	getToolResult(toolCallId: string): MatchedToolResult | undefined;
	isMatchedToolResultEntry(entryId: string): boolean;
	makeBlock(entry: SessionEntry, options: MakeBlockOptions): Block;
}

export type EntryExtractor = (entry: SessionEntry, context: ExtractionContext) => Block[];
export type LabelGetter = (entryId: string) => string | undefined;

// Text and argument helpers

function asRecord(value: unknown): RecordValue | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as RecordValue
		: undefined;
}

function compactWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function compactValue(value: string, maximum = MAX_FLAT_VALUE_LENGTH): string {
	const compact = compactWhitespace(value);
	return compact.length <= maximum ? compact : `${compact.slice(0, maximum - 1)}…`;
}

function redactEmbeddedImageData(value: string): string {
	return value.replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/]+={0,2}/gi, IMAGE_PLACEHOLDER);
}

export function contentToText(content: string | readonly unknown[]): string {
	if (typeof content === "string") return redactEmbeddedImageData(content);

	const pieces: string[] = [];
	for (const value of content) {
		const part = asRecord(value);
		if (part?.type === "text" && typeof part.text === "string") {
			pieces.push(redactEmbeddedImageData(part.text));
		} else if (part?.type === "image") {
			pieces.push(IMAGE_PLACEHOLDER);
		}
	}
	return pieces.join("\n");
}

function looksLikeBase64Payload(value: string): boolean {
	return value.length >= 128 && value.length % 4 === 0 && /^[a-z0-9+/]+={0,2}$/i.test(value);
}

function isImageContainer(value: RecordValue): boolean {
	const type = typeof value.type === "string" ? value.type.toLowerCase() : "";
	const mime = typeof value.mimeType === "string"
		? value.mimeType
		: typeof value.mediaType === "string"
			? value.mediaType
			: "";
	return type === "image"
		|| (type === "base64" && mime.toLowerCase().startsWith("image/"))
		|| (mime.toLowerCase().startsWith("image/") && "data" in value);
}

function redactImageData(value: unknown, key = "", seen = new WeakSet<object>()): unknown {
	if (typeof value === "string") {
		if (/image.*(?:base64|data)|(?:base64|data).*image/i.test(key)) return IMAGE_PLACEHOLDER;
		if (/image/i.test(key) && looksLikeBase64Payload(value)) return IMAGE_PLACEHOLDER;
		return redactEmbeddedImageData(value);
	}
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) return "[circular]";
	seen.add(value);

	if (Array.isArray(value)) {
		return value.map((item) => redactImageData(item, key, seen));
	}

	const record = value as RecordValue;
	if (isImageContainer(record)) return IMAGE_PLACEHOLDER;

	const redacted: RecordValue = {};
	for (const [childKey, childValue] of Object.entries(record)) {
		redacted[childKey] = redactImageData(childValue, childKey, seen);
	}
	return redacted;
}

export function formatToolArguments(argumentsValue: unknown): string {
	const safeArguments = redactImageData(argumentsValue);
	try {
		return JSON.stringify(safeArguments, null, 2) ?? String(safeArguments);
	} catch {
		return "[unserializable arguments]";
	}
}

export function flattenArguments(argumentsValue: unknown): string {
	const flattened: string[] = [];
	const safeArguments = redactImageData(argumentsValue);

	function visit(value: unknown, path: string): void {
		if (flattened.length >= MAX_FLAT_ARGUMENTS) return;
		if (value === null || typeof value !== "object") {
			flattened.push(`${path || "value"}=${compactValue(String(value))}`);
			return;
		}
		if (Array.isArray(value)) {
			if (value.length === 0) flattened.push(`${path || "value"}=[]`);
			for (let index = 0; index < value.length; index++) {
				visit(value[index], `${path}[${index}]`);
			}
			return;
		}

		const entries = Object.entries(value as RecordValue);
		if (entries.length === 0) flattened.push(`${path || "value"}={}`);
		for (const [key, child] of entries) {
			visit(child, path ? `${path}.${key}` : key);
		}
	}

	visit(safeArguments, "");
	let result = flattened.join(" ");
	if (flattened.length >= MAX_FLAT_ARGUMENTS) result += " …";
	if (result.length > MAX_FLAT_ARGUMENTS_LENGTH) {
		result = `${result.slice(0, MAX_FLAT_ARGUMENTS_LENGTH - 1)}…`;
	}
	return result;
}

// File references and truncation

const PATH_KEYS = new Set([
	"path",
	"file",
	"filename",
	"filepath",
	"file_path",
	"targetpath",
	"target_path",
	"sourcepath",
	"source_path",
	"destinationpath",
	"destination_path",
]);
const PATH_LIST_KEYS = new Set(["paths", "files", "filepaths", "file_paths"]);
const LINE_KEYS = ["line", "linenumber", "line_number", "startline", "start_line"];

function positiveLine(value: unknown): number | undefined {
	const number = typeof value === "number"
		? value
		: typeof value === "string" && /^\+?\d+$/.test(value)
			? Number(value.replace(/^\+/, ""))
			: Number.NaN;
	return Number.isInteger(number) && number > 0 ? number : undefined;
}

function lineFromRecord(record: RecordValue, toolName: string | undefined): number | undefined {
	for (const key of LINE_KEYS) {
		const matchingKey = Object.keys(record).find((candidate) => candidate.toLowerCase() === key);
		const line = matchingKey === undefined ? undefined : positiveLine(record[matchingKey]);
		if (line !== undefined) return line;
	}
	if (toolName?.toLowerCase() === "read") return positiveLine(record.offset);
	return undefined;
}

function parsePathAndLine(rawPath: string, fallbackLine: number | undefined): FileReference | undefined {
	let path = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	if (path.length === 0) return undefined;

	let line = fallbackLine;
	const hashMatch = path.match(/^(.*)#L(\d+)$/i);
	const colonMatch = path.match(/^(.*):(\d+)(?::\d+)?$/);
	if (hashMatch?.[1]) {
		path = hashMatch[1];
		line ??= positiveLine(hashMatch[2]);
	} else if (colonMatch?.[1]) {
		path = colonMatch[1];
		line ??= positiveLine(colonMatch[2]);
	}
	return line === undefined ? { path } : { path, line };
}

export function extractFileReferences(argumentsValue: unknown, toolName?: string): FileReference[] {
	const references = new Map<string, FileReference>();

	function add(rawPath: string, line: number | undefined): void {
		const reference = parsePathAndLine(rawPath, line);
		if (!reference) return;
		const existing = references.get(reference.path);
		if (!existing || (existing.line === undefined && reference.line !== undefined)) {
			references.set(reference.path, reference);
		}
	}

	function visit(value: unknown): void {
		const record = asRecord(value);
		if (!record) {
			if (Array.isArray(value)) for (const child of value) visit(child);
			return;
		}

		const line = lineFromRecord(record, toolName);
		for (const [key, child] of Object.entries(record)) {
			const normalizedKey = key.toLowerCase();
			if (PATH_KEYS.has(normalizedKey) && typeof child === "string") {
				add(child, line);
			} else if (PATH_LIST_KEYS.has(normalizedKey) && Array.isArray(child)) {
				for (const path of child) if (typeof path === "string") add(path, line);
			}
			visit(child);
		}
	}

	visit(argumentsValue);
	return [...references.values()];
}

function truncationFromDetails(details: unknown): BlockTruncation | undefined {
	const detailRecord = asRecord(details);
	const raw = asRecord(detailRecord?.truncation);
	if (raw?.truncated !== true) return undefined;

	const metadata: Partial<TruncationResult> = { truncated: true };
	if (raw.truncatedBy === "lines" || raw.truncatedBy === "bytes" || raw.truncatedBy === null) {
		metadata.truncatedBy = raw.truncatedBy;
	}
	for (const key of [
		"totalLines",
		"totalBytes",
		"outputLines",
		"outputBytes",
		"maxLines",
		"maxBytes",
	] as const) {
		if (typeof raw[key] === "number" && Number.isFinite(raw[key])) metadata[key] = raw[key];
	}
	for (const key of ["lastLinePartial", "firstLineExceedsLimit"] as const) {
		if (typeof raw[key] === "boolean") metadata[key] = raw[key];
	}

	const fullOutputPath = typeof detailRecord?.fullOutputPath === "string"
		? detailRecord.fullOutputPath
		: undefined;
	return { truncated: true, metadata, fullOutputPath };
}

export function formatTimestamp(timestamp: string): string {
	const date = new Date(timestamp);
	if (!Number.isFinite(date.getTime())) return timestamp;
	return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

// Block construction

function makeCanonicalToolText(toolName: string, argumentsValue: unknown, resultText: string): string {
	const invocation = `${toolName} ${formatToolArguments(argumentsValue)}`;
	return resultText.length === 0 ? invocation : `${invocation}\n\n${resultText}`;
}

function makeCanonicalBashText(command: string, output: string, status: string | undefined): string {
	const sections = [command];
	if (output.length > 0) sections.push(output);
	if (status) sections.push(status);
	return sections.join("\n\n");
}

function createBlock(entry: SessionEntry, options: MakeBlockOptions): Block {
	const entryIds = [...new Set([entry.id, ...(options.entryIds ?? [])])];
	const body = redactEmbeddedImageData(options.body);
	const canonicalText = redactEmbeddedImageData(options.canonicalText);
	const inferredBodyOffset = canonicalText === body ? 0 : undefined;
	const canonicalBodyOffset = options.canonicalBodyOffset === undefined
		? inferredBodyOffset
		: redactEmbeddedImageData(options.canonicalText.slice(0, options.canonicalBodyOffset)).length;
	const fields = [
		`role:${options.role}`,
		`type:${options.kind}`,
		...(options.fieldParts ?? []),
		`timestamp:${formatTimestamp(entry.timestamp)}`,
		...entryIds.map((entryId) => `entry:${entryId}`),
	]
		.map((part) => compactWhitespace(redactEmbeddedImageData(part)))
		.filter((part) => part.length > 0)
		.join(" ");

	return {
		id: `${entry.id}:part:${options.idPart}`,
		kind: options.kind,
		entryId: entry.id,
		entryIds,
		timestamp: entry.timestamp,
		fields,
		body,
		title: redactEmbeddedImageData(options.title),
		subtitle: options.subtitle === undefined ? undefined : redactEmbeddedImageData(options.subtitle),
		canonicalText,
		canonicalBodyOffset,
		toolName: options.toolName,
		toolCallId: options.toolCallId,
		fileReference: options.fileReference,
		truncation: options.truncation,
		isError: options.isError,
	};
}

function messageTextBlock(
	entry: SessionMessageEntry,
	context: ExtractionContext,
	kind: "user" | "assistant",
	body: string,
	idPart: string,
): Block {
	const title = kind === "user" ? "User" : "Assistant";
	return context.makeBlock(entry, {
		idPart,
		kind,
		role: kind,
		body,
		title,
		canonicalText: body,
	});
}

function extractAssistant(entry: SessionMessageEntry, context: ExtractionContext): Block[] {
	if (entry.message.role !== "assistant") return [];
	const textParts = entry.message.content
		.map((part, index) => ({ part, index }))
		.filter(({ part }) => part.type === "text");
	const firstTextIndex = textParts[0]?.index;
	const combinedText = textParts
		.map(({ part }) => part.type === "text" ? part.text : "")
		.join("\n");
	const blocks: Block[] = [];

	for (let index = 0; index < entry.message.content.length; index++) {
		const part = entry.message.content[index];
		if (index === firstTextIndex) {
			blocks.push(messageTextBlock(entry, context, "assistant", combinedText, `${index}:text`));
		}
		if (part?.type !== "toolCall") continue;

		const result = context.getToolResult(part.id);
		const resultText = result ? contentToText(result.message.content) : "";
		const canonicalText = makeCanonicalToolText(part.name, part.arguments, resultText);
		const flatArguments = flattenArguments(part.arguments);
		const references = extractFileReferences(part.arguments, part.name);
		const fieldParts = [
			`tool:${part.name}`,
			`toolCallId:${part.id}`,
			`args:${flatArguments}`,
			...references.flatMap((reference) => [
				`path:${reference.path}`,
				...(reference.line === undefined ? [] : [`line:${reference.line}`]),
			]),
		];
		blocks.push(context.makeBlock(entry, {
			idPart: `${index}:tool`,
			kind: "tool",
			role: "assistant",
			body: resultText,
			title: part.name,
			subtitle: flatArguments,
			canonicalText,
			canonicalBodyOffset: resultText.length === 0 ? undefined : canonicalText.length - resultText.length,
			entryIds: result ? [result.entry.id] : undefined,
			fieldParts,
			toolName: part.name,
			toolCallId: part.id,
			fileReference: references[0],
			truncation: result ? truncationFromDetails(result.message.details) : undefined,
			isError: result?.message.isError,
		}));
	}
	return blocks;
}

function extractOrphanToolResult(entry: SessionMessageEntry, context: ExtractionContext): Block[] {
	if (entry.message.role !== "toolResult" || context.isMatchedToolResultEntry(entry.id)) return [];
	const body = contentToText(entry.message.content);
	const heading = `${entry.message.toolName} (${entry.message.toolCallId})`;
	const canonicalText = body.length === 0 ? heading : `${heading}\n\n${body}`;
	return [context.makeBlock(entry, {
		idPart: "0:result",
		kind: "tool",
		role: "toolResult",
		body,
		title: entry.message.toolName,
		subtitle: `orphan result · ${entry.message.toolCallId}`,
		canonicalText,
		canonicalBodyOffset: body.length === 0 ? undefined : canonicalText.length - body.length,
		fieldParts: [
			`tool:${entry.message.toolName}`,
			`toolCallId:${entry.message.toolCallId}`,
			"orphan:result",
		],
		toolName: entry.message.toolName,
		toolCallId: entry.message.toolCallId,
		truncation: truncationFromDetails(entry.message.details),
		isError: entry.message.isError,
	})];
}

function extractBash(entry: SessionMessageEntry, context: ExtractionContext): Block[] {
	if (entry.message.role !== "bashExecution") return [];
	const message = entry.message;
	const status = message.cancelled
		? "command cancelled"
		: message.exitCode === undefined
			? undefined
			: `exit code ${message.exitCode}`;
	const truncation: BlockTruncation | undefined = message.truncated
		? { truncated: true, fullOutputPath: message.fullOutputPath }
		: undefined;
	const canonicalText = makeCanonicalBashText(message.command, message.output, status);
	return [context.makeBlock(entry, {
		idPart: "0:bash",
		kind: "bash",
		role: "bashExecution",
		body: message.output,
		title: "Bash",
		subtitle: compactValue(message.command, 240),
		canonicalText,
		canonicalBodyOffset: message.output.length === 0 ? undefined : message.command.length + 2,
		fieldParts: [
			`command:${compactValue(message.command, 240)}`,
			...(message.exitCode === undefined ? [] : [`exit:${message.exitCode}`]),
			...(message.cancelled ? ["cancelled:true"] : []),
		],
		truncation,
		isError: message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0),
	})];
}

function extractCustomMessageRole(entry: SessionMessageEntry, context: ExtractionContext): Block[] {
	if (entry.message.role !== "custom" || !entry.message.display) return [];
	const body = contentToText(entry.message.content);
	return [context.makeBlock(entry, {
		idPart: "0:custom",
		kind: "custom",
		role: "custom",
		body,
		title: entry.message.customType,
		canonicalText: body,
		fieldParts: [`customType:${entry.message.customType}`],
	})];
}

function extractSummaryMessageRole(entry: SessionMessageEntry, context: ExtractionContext): Block[] {
	if (entry.message.role !== "branchSummary" && entry.message.role !== "compactionSummary") return [];
	const branch = entry.message.role === "branchSummary";
	const body = entry.message.summary;
	return [context.makeBlock(entry, {
		idPart: branch ? "0:branch-summary" : "0:compaction-summary",
		kind: "summary",
		role: entry.message.role,
		body,
		title: branch ? "Branch summary" : "Compaction summary",
		canonicalText: body,
		fieldParts: [`summary:${branch ? "branch" : "compaction"}`],
	})];
}

function extractMessageEntry(entry: SessionEntry, context: ExtractionContext): Block[] {
	if (entry.type !== "message") return [];
	switch (entry.message.role) {
		case "user": {
			const body = contentToText(entry.message.content);
			return [messageTextBlock(entry, context, "user", body, "0:user")];
		}
		case "assistant":
			return extractAssistant(entry, context);
		case "toolResult":
			return extractOrphanToolResult(entry, context);
		case "bashExecution":
			return extractBash(entry, context);
		case "custom":
			return extractCustomMessageRole(entry, context);
		case "branchSummary":
		case "compactionSummary":
			return extractSummaryMessageRole(entry, context);
		default:
			return [];
	}
}

function extractCustomMessageEntry(entry: SessionEntry, context: ExtractionContext): Block[] {
	if (entry.type !== "custom_message" || !entry.display) return [];
	const body = contentToText(entry.content);
	return [context.makeBlock(entry, {
		idPart: "0:custom-message",
		kind: "custom",
		role: "custom",
		body,
		title: entry.customType,
		canonicalText: body,
		fieldParts: [`customType:${entry.customType}`, "source:custom_message"],
	})];
}

function extractCompactionEntry(entry: SessionEntry, context: ExtractionContext): Block[] {
	if (entry.type !== "compaction") return [];
	return [context.makeBlock(entry, {
		idPart: "0:compaction",
		kind: "summary",
		role: "compactionSummary",
		body: entry.summary,
		title: "Compaction summary",
		canonicalText: entry.summary,
		fieldParts: ["summary:compaction", "source:compaction"],
	})];
}

function extractBranchSummaryEntry(entry: SessionEntry, context: ExtractionContext): Block[] {
	if (entry.type !== "branch_summary") return [];
	return [context.makeBlock(entry, {
		idPart: "0:branch-summary",
		kind: "summary",
		role: "branchSummary",
		body: entry.summary,
		title: "Branch summary",
		canonicalText: entry.summary,
		fieldParts: ["summary:branch", "source:branch_summary"],
	})];
}

const excludeEntry: EntryExtractor = () => [];

export const extractorRegistry: Record<string, EntryExtractor> = {
	message: extractMessageEntry,
	custom_message: extractCustomMessageEntry,
	compaction: extractCompactionEntry,
	branch_summary: extractBranchSummaryEntry,
	custom: excludeEntry,
	label: excludeEntry,
	model_change: excludeEntry,
	thinking_level_change: excludeEntry,
	session_info: excludeEntry,
};

// Branch extraction and tool-result correlation

function collectLabels(entries: readonly SessionEntry[]): Map<string, string> {
	const labels = new Map<string, string>();
	for (const entry of entries) {
		if (entry.type !== "label") continue;
		if (entry.label) labels.set(entry.targetId, entry.label);
		else labels.delete(entry.targetId);
	}
	return labels;
}

function correlateToolResults(entries: readonly SessionEntry[]): {
	results: Map<string, MatchedToolResult>;
	matchedEntryIds: Set<string>;
} {
	const toolCallIds = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const part of entry.message.content) {
			if (part.type === "toolCall") toolCallIds.add(part.id);
		}
	}

	const results = new Map<string, MatchedToolResult>();
	const matchedEntryIds = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		if (!toolCallIds.has(entry.message.toolCallId) || results.has(entry.message.toolCallId)) continue;
		results.set(entry.message.toolCallId, { entry, message: entry.message });
		matchedEntryIds.add(entry.id);
	}
	return { results, matchedEntryIds };
}

function resolvedLabel(
	entryIds: readonly string[],
	labels: ReadonlyMap<string, string>,
	getLabel: LabelGetter | undefined,
): string | undefined {
	for (const entryId of entryIds) {
		const label = getLabel?.(entryId) ?? labels.get(entryId);
		if (label) return label;
	}
	return undefined;
}

export function extractBlocks(entries: readonly SessionEntry[], getLabel?: LabelGetter): Block[] {
	const labels = collectLabels(entries);
	const { results, matchedEntryIds } = correlateToolResults(entries);
	const context: ExtractionContext = {
		entries,
		getToolResult: (toolCallId) => results.get(toolCallId),
		isMatchedToolResultEntry: (entryId) => matchedEntryIds.has(entryId),
		makeBlock: createBlock,
	};
	const blocks: Block[] = [];

	for (const entry of entries) {
		const extractor = extractorRegistry[entry.type];
		if (extractor) blocks.push(...extractor(entry, context));
	}

	return blocks.map((block) => {
		const label = resolvedLabel(block.entryIds, labels, getLabel) ?? block.label;
		if (!label) return block;
		const safeLabel = redactEmbeddedImageData(label);
		return {
			...block,
			label: safeLabel,
			fields: `${block.fields} label:${compactWhitespace(safeLabel)}`,
		};
	});
}
