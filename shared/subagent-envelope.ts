// Format contract for subagent traffic, shared by the writer
// (interactive-subagents) and presenters (fuzzy-explorer): the customType
// results arrive under, which tool arguments are prose rather than metadata,
// and a parser that inverts buildSubagentResultEnvelope so presenters cannot
// drift from the writer.

export const SUBAGENT_RESULT_CUSTOM_TYPE = "subagent_result";
export const SUBAGENT_TOOL_NAME_PREFIX = "subagent_";
export const SUBAGENT_PROSE_ARGUMENT_KEYS: ReadonlySet<string> = new Set(["task", "prompt", "message"]);
export const SUBAGENT_ENVELOPE_TITLE = "Subagent result";

export interface SubagentEnvelopeField {
	key: string;
	value: string;
}

export interface ParsedSubagentResultEnvelope {
	/** Metadata lines (head and tail) as lowercase key/value pairs, in envelope order. */
	fields: SubagentEnvelopeField[];
	/** The delivered response text, unwrapped from its <result> markers. */
	response: string;
}

const ENVELOPE_FIELD_LINE = /^([A-Za-z][A-Za-z ]{0,24}): (.*)$/;

/** Invert buildSubagentResultEnvelope; undefined when content is not an envelope. */
export function parseSubagentResultEnvelope(content: string): ParsedSubagentResultEnvelope | undefined {
	const lines = content.split("\n");
	const fields: SubagentEnvelopeField[] = [];
	let index = lines[0]?.trim() === SUBAGENT_ENVELOPE_TITLE ? 1 : 0;
	for (; index < lines.length; index++) {
		const line = lines[index]!;
		if (line.trim() === "") break;
		const match = ENVELOPE_FIELD_LINE.exec(line);
		if (match === null) break;
		fields.push({ key: match[1]!.toLowerCase(), value: match[2]! });
	}
	if (fields.length === 0) return undefined;

	const rest = lines.slice(index).join("\n").trim();
	const open = rest.indexOf("<result>");
	const close = rest.lastIndexOf("</result>");
	let response = "";
	let tail = rest;
	if (open !== -1 && close > open) {
		response = rest.slice(open + "<result>".length, close).trim();
		tail = `${rest.slice(0, open)}\n${rest.slice(close + "</result>".length)}`;
	}

	// The action/session tail lines are metadata too; anything unshaped joins the response.
	const leftover: string[] = [];
	for (const line of tail.split("\n")) {
		if (line.trim() === "") continue;
		const match = ENVELOPE_FIELD_LINE.exec(line);
		if (match !== null) fields.push({ key: match[1]!.toLowerCase(), value: match[2]! });
		else leftover.push(line);
	}
	if (leftover.length > 0) {
		response = [response, leftover.join("\n")].filter((text) => text !== "").join("\n\n");
	}
	return { fields, response };
}
