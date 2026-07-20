import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { buildSubagentResultEnvelope } from "../../interactive-subagents/result-content.ts";
import { ExplorerComponent } from "../component.ts";
import { formatPreviewLines, formatResultRow } from "../render.ts";
import { ExplorerState } from "../state.ts";
import { subagentView } from "../subagent.ts";
import { makeBlock } from "./block-factory.ts";

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown): void {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}: got ${g}, want ${w}`); }
}
function ok(label: string, value: boolean): void {
	if (value) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}`); }
}

// Fixture blocks built the way extract.ts builds them from real entries.

const spawnArguments = {
	name: "Message type recon",
	task: "## Goal\n\nFind **everything** relevant to message types.",
	agent: "scout",
	context: "fresh",
};
const spawnAck = 'Sub-agent "Message type recon" started (id c853bdcf, fresh context). One concise report is delivered when it exits; end your turn.';
const spawnInvocation = `subagent_spawn ${JSON.stringify(spawnArguments, null, 2)}`;
const spawnCanonical = `${spawnInvocation}\n\n${spawnAck}`;
const spawnBlock = makeBlock({
	id: "spawn-1",
	kind: "tool",
	toolName: "subagent_spawn",
	title: "subagent_spawn",
	subtitle: "name=Message type recon task=## Goal Find **everything** relevant to message types. agent=scout context=fresh",
	body: spawnAck,
	canonicalText: spawnCanonical,
	canonicalBodyOffset: spawnCanonical.length - spawnAck.length,
});
const pendingSpawnBlock = makeBlock({
	id: "spawn-2",
	kind: "tool",
	toolName: "subagent_spawn",
	title: "subagent_spawn",
	body: "",
	canonicalText: spawnInvocation,
});
const envelope = buildSubagentResultEnvelope({
	status: "completed",
	name: "Message type recon",
	agent: "scout",
	id: "c853bdcf",
	elapsed: "45s",
	contextTokens: 66_000,
	resultTokens: 951,
	costUsd: 0.13,
	response: "## Relevant Files\n\n- `render.ts` — **tag** logic",
	action: "Resume",
	actionMessage: "...",
	sessionFile: "/sessions/child.jsonl",
});
const resultBlock = makeBlock({
	id: "result-1",
	kind: "custom",
	title: "subagent_result",
	body: envelope.content,
});

// View mapping

const spawnView = subagentView(spawnBlock);
eq("spawn arguments split into prioritized metadata and prose",
	spawnView?.fields, [
		{ key: "name", value: "Message type recon" },
		{ key: "agent", value: "scout" },
		{ key: "context", value: "fresh" },
	]);
ok("spawn content is the task prompt followed by the ack",
	spawnView?.content.startsWith("## Goal") === true && spawnView?.content.endsWith("end your turn.") === true);
ok("pending spawn without a result still exposes the prompt",
	subagentView(pendingSpawnBlock)?.content.startsWith("## Goal") === true);
const resultView = subagentView(resultBlock);
eq("result metadata leads with name, agent, and status",
	resultView?.fields.slice(0, 3).map((field) => field.key), ["name", "agent", "status"]);
ok("result content is the unwrapped response",
	resultView?.content.startsWith("## Relevant Files") === true && resultView?.content.includes("<result>") === false);
eq("non-subagent blocks have no view", [
	subagentView(makeBlock({ kind: "tool", toolName: "read", title: "read" })),
	subagentView(makeBlock({ kind: "custom", title: "fixture-card", body: "plain card" })),
], [undefined, undefined]);

// Rows show the metadata like bash shows command=…

const spawnRow = stripVTControlCharacters(formatResultRow(spawnBlock, false, 120, 16));
ok("spawn rows show metadata fields without the prompt",
	spawnRow.includes("name=Message type recon agent=scout context=fresh") && !spawnRow.includes("task="));
const resultRow = stripVTControlCharacters(formatResultRow(resultBlock, false, 120, 16));
ok("result rows lead with name, agent, and status fields",
	resultRow.includes("name=Message type recon agent=scout status=completed"));

// Preview shows fields plus parsed content instead of the raw envelope.

const spawnPreview = formatPreviewLines(spawnBlock, 120, 12).join("\n");
ok("spawn preview shows the prompt", spawnPreview.includes("## Goal") && spawnPreview.includes("Find **everything**"));
const resultPreview = formatPreviewLines(resultBlock, 120, 14).join("\n");
ok("result preview shows fields and response without envelope markers",
	resultPreview.includes("name=Message type recon") && resultPreview.includes("## Relevant Files")
	&& !resultPreview.includes("<result>"));
const highlightedPreview = formatPreviewLines(
	{ block: resultBlock, match: { matches: true, score: 0, keyTokens: [], bodyTokens: ["Relevant"] } },
	120,
	14,
	{ highlight: (text) => `⟦${text}⟧` },
).join("\n");
ok("preview highlights re-derive against the parsed content", highlightedPreview.includes("⟦Relevant⟧"));

// Detail renders metadata fields above markdown content.

const tui = { terminal: { rows: 30 }, requestRender(): void {} } as unknown as TUI;
const theme = {
	fg: (_token: string, text: string) => text,
	bg: (_token: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;
const state = new ExplorerState("list");
const blocks = [spawnBlock, resultBlock];
const component = new ExplorerComponent({
	tui,
	theme,
	state,
	getBlocks: () => blocks,
	actions: {
		async copy(): Promise<void> {},
		async open(): Promise<number | null> { return 0; },
	},
	notify: () => {},
	done: () => {},
	refreshIntervalMs: 60_000,
});
component.focused = true;
component.render(90);
component.handleInput("\r");
const resultDetail = component.render(90);
const resultDetailText = resultDetail.join("\n");
ok("result detail leads with metadata fields", resultDetail[1]?.startsWith("│ name=Message type recon") === true);
ok("result detail renders the response as markdown",
	resultDetailText.includes("Relevant Files") && !resultDetailText.includes("## Relevant Files")
	&& !resultDetailText.includes("<result>"));
component.handleInput("K");
const spawnDetail = component.render(90);
const spawnDetailText = spawnDetail.join("\n");
ok("spawn detail leads with metadata fields", spawnDetail[1]?.startsWith("│ name=Message type recon") === true);
ok("spawn detail renders the prompt as markdown",
	spawnDetailText.includes("Goal") && !spawnDetailText.includes("## Goal")
	&& spawnDetailText.includes("Find everything relevant to message types."));
ok("spawn detail keeps the ack", spawnDetailText.includes("end your turn."));
component.handleInput("m");
const rawSpawnDetail = component.render(90).join("\n");
ok("m still reveals the raw canonical text", rawSpawnDetail.includes("subagent_spawn {") && rawSpawnDetail.includes("task"));
component.dispose();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
