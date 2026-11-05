import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, formatSize, type InputSource, truncateHead } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

export const TOOL_NAME = "web_search";
export const OUTPUT_DIR = ".codex-web-search";
export const OVERRIDE_PHRASE = "force-web";
const SEARCH_TIMEOUT_MS = 10 * 60 * 1000;

const RESEARCH_PROMPT = `Fetch web source data for another assistant to use in answering the Search query below.
Your goal is to return enough relevant data that the assistant can answer without fetching the same sources again.
Prefer primary sources. Open the relevant pages and check that they contain the requested data;
search-result snippets alone are not enough when the underlying page is available.

Return the relevant facts, excerpts, code, or configuration inline, with source URLs attached.
Preserve exact names, values, versions, dates, and caveats needed to interpret and reuse the data.
If an Extraction instruction is present, follow its requested scope and format with minimal processing.
Keep your own prose brief. Leave synthesis and recommendations to the calling assistant unless explicitly requested.
Do not omit needed source data just to shorten the response.

Before returning, check that each requested item has usable source data or an explicit gap.
Use additional sources to fill gaps or resolve contradictions. Once the requested data is covered, stop;
do not keep searching for duplicate confirmation or expand into adjacent topics.
If data is unavailable or unverified, say what is missing and distinguish it from what you fetched.

Return your answer in exactly this format:

## Answer
Fetched source data, grouped by requested item, with source URLs and any gaps. Minimal connective prose.

## Sources
- [Title](url) - relevance note
- [Title](url) - relevance note

List the sources supporting the returned data, with a brief note on what each contributed.`;

// A specific GitHub issue or pull request: an issues/pull URL with a number, owner/repo#123,
// "issue #123", or "issue 4744" (four or more digits, so "issue 404" still searches).
const GITHUB_ISSUE_OR_PR = [
	/github\.\S*\/(issues|pulls?)\/\d+/i,
	/\b[\w.-]+\/[\w.-]+#\d+\b/,
	/\b(issue|pr|pull request)s?\s*#\d+/i,
	/\b(issue|pr|pull request)s?\s+\d{4,}\b/i,
];

const PERSON_SOURCES = new Set<InputSource>(["interactive", "rpc"]);

const searchSchema = Type.Object({
	query: Type.String({
		description: "What to search for: a short, focused phrase with product names, versions, or exact error text.",
	}),
	extract: Type.Optional(Type.String({
		description:
			"Optional. What to return from what is found, only when the request asks for a specific subset or " +
			"shape (e.g. \"just the version numbers\", \"a migration checklist\"); use the user's own terms and " +
			"add nothing they did not ask for. Omit it for a plain question. Keep it out of the query.",
	})),
	effort: Type.Optional(StringEnum(["low", "medium", "high", "xhigh"] as const, {
		description: "Optional Codex reasoning effort. Leave unset (medium) unless the user asks for another.",
	})),
});

type SearchInput = Static<typeof searchSchema>;

export default function codexWebSearch(pi: ExtensionAPI) {
	let isOverridden = false;
	const extensionOverrideTexts: string[] = [];

	pi.on("input", (event) => {
		if (!PERSON_SOURCES.has(event.source) && hasOverride(event.text)) extensionOverrideTexts.push(event.text);
	});

	pi.on("message_start", (event) => {
		if (event.message.role !== "user") return;

		const { content } = event.message;
		const text = typeof content === "string"
			? content
			: content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
		const extensionIndex = extensionOverrideTexts.indexOf(text);
		if (extensionIndex !== -1) extensionOverrideTexts.splice(extensionIndex, 1);
		isOverridden = hasOverride(text) && extensionIndex === -1;
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Web Search",
		description: [
			"Fetch relevant source data from the public web, with citations, for you to use in your answer.",
			"Use it for current or public facts beyond your knowledge cutoff: docs, release notes, versions, error text, APIs.",
			"Ask for the data you need in one focused query; the tool returns the source material with minimal synthesis.",
		].join(" "),
		promptSnippet: "Fetch cited source data from the public web",
		parameters: searchSchema,

		async execute(_toolCallId, params: SearchInput, signal, _onUpdate, ctx) {
			const query = withoutOverride(params.query);
			const extract = withoutOverride(params.extract ?? "");
			if (!query) throw new Error(`${TOOL_NAME} needs a non-empty query.`);
			if (GITHUB_ISSUE_OR_PR.some((pattern) => pattern.test(query)) && !isOverridden) {
				throw new Error(
					"This query looks up a specific GitHub issue or pull request; use gh for that instead. " +
					`If the user wants a web search anyway, ask them to include ${OVERRIDE_PHRASE} in their next message. ` +
					"Only the user can add it.",
				);
			}

			const prefix = join(ctx.cwd, OUTPUT_DIR, runPrefix());
			const responsePath = `${prefix}-response.md`;
			const prompt = extract
				? `${RESEARCH_PROMPT}\n\nSearch query:\n${query}\n\nExtraction instruction:\n${extract}`
				: `${RESEARCH_PROMPT}\n\nSearch query:\n${query}`;
			await mkdir(join(ctx.cwd, OUTPUT_DIR), { recursive: true });
			await writeFile(`${prefix}-prompt.md`, `${prompt}\n`);

			const run = await pi.exec("codex", [
				"exec",
				"--model", "gpt-6-luna",
				"--config", "features.fast_mode=true",
				"--config", "service_tier=\"fast\"",
				"--sandbox", "workspace-write",
				"--config", "sandbox_workspace_write.network_access=true",
				"--config", "approval_policy=\"never\"",
				"--config", `model_reasoning_effort="${params.effort ?? "medium"}"`,
				"--skip-git-repo-check",
				"--output-last-message", responsePath,
				prompt,
			], { cwd: ctx.cwd, timeout: SEARCH_TIMEOUT_MS, ...(signal ? { signal } : {}) });
			if (run.code !== 0) {
				throw new Error(`codex exec failed (exit ${run.code}): ${run.stderr.trim().slice(-2000)}`);
			}

			const response = (await readFile(responsePath, "utf8").catch(() => "")).trim();
			if (!response) throw new Error("codex exec returned no answer.");

			const truncation = truncateHead(response);
			const note = truncation.truncated
				? `\n\n[Answer truncated to ${truncation.outputLines} of ${truncation.totalLines} lines ` +
					`(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ` +
					`Read the saved path for the rest.]`
				: "";
			return {
				content: [{ type: "text", text: `Saved path: ${responsePath}\n\n${truncation.content}${note}` }],
				details: { responsePath },
			};
		},
	});
}

const isOverrideWord = (word: string) => word.toLowerCase() === OVERRIDE_PHRASE;
const hasOverride = (text: string) => text.split(/\s+/).some(isOverrideWord);
const withoutOverride = (text: string) => text.split(/\s+/).filter((word) => word && !isOverrideWord(word)).join(" ");

// A sortable, unique file prefix like 261023195504-a3f9.
function runPrefix(): string {
	const stamp = new Date().toISOString().replace(/\D/g, "").slice(2, 14);
	return `${stamp}-${Math.random().toString(16).slice(2, 6)}`;
}
