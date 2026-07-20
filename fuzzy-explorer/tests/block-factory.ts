import { stripSeparators } from "../search.ts";
import type { Block } from "../types.ts";

let blockNumber = 0;

/** Build a Block with the derived search-text fields kept consistent unless overridden. */
export function makeBlock(overrides: Partial<Block> = {}): Block {
	blockNumber++;
	const kind = overrides.kind ?? "assistant";
	const title = overrides.title
		?? (kind === "user" ? "User" : kind === "assistant" ? "Assistant" : kind);
	const body = overrides.body ?? "";
	const canonicalText = overrides.canonicalText ?? body;
	const fields = overrides.fields ?? `role:${kind} type:${kind}`;

	const keyParts: string[] = [kind];
	for (const candidate of [overrides.toolName, title, overrides.subtitle]) {
		if (candidate === undefined || candidate === "") continue;
		if (keyParts.some((part) => part.toLowerCase() === candidate.toLowerCase())) continue;
		keyParts.push(candidate);
	}
	const searchKey = overrides.searchKey ?? keyParts.join(" ");
	const anyText = overrides.anyText ?? (canonicalText === "" ? fields : `${fields}\n${canonicalText}`);

	return {
		id: `block-${blockNumber}`,
		entryId: `entry-${blockNumber}`,
		entryIds: [`entry-${blockNumber}`],
		timestamp: new Date(blockNumber * 1_000).toISOString(),
		...overrides,
		kind,
		title,
		body,
		canonicalText,
		fields,
		searchKey,
		anyText,
		strippedBody: overrides.strippedBody ?? stripSeparators(body),
		strippedAnyText: overrides.strippedAnyText ?? stripSeparators(anyText),
	};
}
