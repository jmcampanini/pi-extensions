import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { ExplorerComponent } from "../component.ts";
import { formatPreviewLines, formatResultRow } from "../render.ts";
import { ExplorerState } from "../state.ts";
import { subagentView } from "../subagent.ts";
import { makeBlock } from "./block-factory.ts";

// Fixture blocks built the way extract.ts builds them from real entries.

const spawnArguments = {
	name: "Message type recon",
	task: "## Goal\n\nFind **everything** relevant to message types.",
	agent: "scout",
	context: "new",
};
const spawnAck = 'Sub-agent "Message type recon" started (id c853bdcf, new context). One concise report is delivered when it exits; end your turn.';
const spawnInvocation = `subagent_spawn ${JSON.stringify(spawnArguments, null, 2)}`;
const spawnCanonical = `${spawnInvocation}\n\n${spawnAck}`;
const spawnBlock = makeBlock({
	id: "spawn-1",
	kind: "tool",
	toolName: "subagent_spawn",
	title: "subagent_spawn",
	subtitle: "name=Message type recon task=## Goal Find **everything** relevant to message types. agent=scout context=new",
	body: spawnAck,
	canonicalText: spawnCanonical,
	canonicalBodyOffset: spawnCanonical.length - spawnAck.length,
	toolArguments: spawnArguments,
});
const pendingSpawnBlock = makeBlock({
	id: "spawn-2",
	kind: "tool",
	toolName: "subagent_spawn",
	title: "subagent_spawn",
	body: "",
	canonicalText: spawnInvocation,
	toolArguments: spawnArguments,
});
// A static instance of the shared envelope format (shared/subagent-envelope.ts);
// the writer's build→parse round-trip is pinned in interactive-subagents' tests.
const envelopeContent = `Subagent result
Status: completed
Name: Message type recon
Agent: scout
ID: c853bdcf
Model: claude-sonnet-5
Effort: high
Mode: forked · interactive · worktree
Tools: read,edit,bash
Elapsed: 45s
Context: 66k tokens
Result: ~951 tokens
Cost: $0.13

<result>
## Relevant Files

- \`render.ts\` - **tag** logic
</result>

Resume: subagent_resume({ id: "c853bdcf", message: "..." })
Session: /sessions/child.jsonl
Worktree: kept at /repo/worktree on branch pi/message-types.`;
const resultBlock = makeBlock({
	id: "result-1",
	kind: "custom",
	title: "subagent_result",
	body: envelopeContent,
});

describe("subagentView", () => {
	const spawnView = subagentView(spawnBlock);
	const resultView = subagentView(resultBlock);

	it("spawn arguments split into prioritized metadata and prose", () => {
		assert.deepStrictEqual(spawnView?.fields, [
			{ key: "name", value: "Message type recon" },
			{ key: "agent", value: "scout" },
			{ key: "context", value: "new" },
		]);
	});

	it("spawn content is the task prompt followed by the ack", () => {
		assert.ok(spawnView?.content.startsWith("## Goal") === true
			&& spawnView?.content.endsWith("end your turn.") === true);
	});

	it("pending spawn without a result still exposes the prompt", () => {
		assert.ok(subagentView(pendingSpawnBlock)?.content.startsWith("## Goal") === true);
	});

	it("result fields retain canonical parsed order", () => {
		assert.deepStrictEqual(resultView?.fields.map((field) => field.key), [
			"status", "name", "agent", "id", "model", "effort", "mode", "tools", "elapsed",
			"context", "result", "cost", "resume", "session", "worktree",
		]);
	});

	it("result content is the unwrapped response", () => {
		assert.ok(resultView?.content.startsWith("## Relevant Files") === true
			&& resultView?.content.includes("<result>") === false);
	});

	it("non-subagent blocks have no view", () => {
		assert.deepStrictEqual([
			subagentView(makeBlock({ kind: "tool", toolName: "read", title: "read" })),
			subagentView(makeBlock({ kind: "custom", title: "fixture-card", body: "plain card" })),
		], [undefined, undefined]);
	});
});

describe("formatResultRow", () => {
	it("spawn rows show metadata fields without the prompt", () => {
		const spawnRow = stripVTControlCharacters(formatResultRow(spawnBlock, false, 120, 16));
		assert.ok(spawnRow.includes("name=Message type recon agent=scout context=new") && !spawnRow.includes("task="));
	});

	it("result rows lead with identity then retain canonical remaining fields", () => {
		const resultRow = stripVTControlCharacters(formatResultRow(resultBlock, false, 500, 16));
		assert.ok(resultRow.includes("name=Message type recon agent=scout status=completed id=c853bdcf "
			+ "model=claude-sonnet-5 effort=high mode=forked · interactive · worktree tools=read,edit,bash"));
	});
});

describe("formatPreviewLines", () => {
	it("spawn preview shows the prompt", () => {
		const spawnPreview = formatPreviewLines(spawnBlock, 120, 12).join("\n");
		assert.ok(spawnPreview.includes("## Goal") && spawnPreview.includes("Find **everything**"));
	});

	it("result preview separates the response and aligned table with a labeled rule", () => {
		const resultPreview = formatPreviewLines(resultBlock, 120, 20).join("\n");
		assert.ok(resultPreview.includes("**tag** logic\n\n─ result details ─")
			&& resultPreview.includes("\n\nstatus    completed")
			&& resultPreview.includes("name      Message type recon") && !resultPreview.includes("<result>"));
	});

	it("preview highlights re-derive against the parsed content", () => {
		const highlightedPreview = formatPreviewLines(
			{ block: resultBlock, match: { matches: true, score: 0, keyTokens: [], bodyTokens: ["Relevant"] } },
			120,
			14,
			{ highlight: (text) => `⟦${text}⟧` },
		).join("\n");
		assert.ok(highlightedPreview.includes("⟦Relevant⟧"));
	});
});

describe("ExplorerComponent subagent detail", () => {
	it("renders spawn and result details with markdown content above the canonical table", (t) => {
		const tui = { terminal: { rows: 60 }, requestRender(): void {} } as unknown as TUI;
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
		t.after(() => component.dispose());
		component.focused = true;
		component.render(90);
		component.handleInput("\r");
		const resultDetail = component.render(90);
		const resultDetailText = resultDetail.join("\n");
		assert.ok(resultDetailText.indexOf("Relevant Files") < resultDetailText.indexOf("─ result details ─")
			&& resultDetailText.indexOf("─ result details ─") < resultDetailText.indexOf("status    completed")
			&& resultDetailText.indexOf("status    completed") < resultDetailText.indexOf("model     claude-sonnet-5")
			&& resultDetailText.indexOf("model     claude-sonnet-5") < resultDetailText.indexOf("resume    subagent_resume")
			&& resultDetailText.indexOf("resume    subagent_resume") < resultDetailText.indexOf("session   /sessions/child.jsonl")
			&& resultDetailText.indexOf("session   /sessions/child.jsonl")
				< resultDetailText.indexOf("worktree  kept at /repo/worktree"),
			"result detail separates the response and complete canonical table with a labeled rule");
		assert.ok(resultDetailText.includes("Relevant Files") && !resultDetailText.includes("## Relevant Files")
			&& !resultDetailText.includes("<result>"),
			"result detail renders the response as markdown");
		component.handleInput("m");
		const rawResultDetail = component.render(90).join("\n");
		assert.ok(rawResultDetail.includes("Subagent result")
			&& rawResultDetail.includes("<result>") && rawResultDetail.includes("Status: completed")
			&& !rawResultDetail.includes("result details"),
			"m still reveals the raw result envelope without the rendered divider");
		component.handleInput("m");
		component.handleInput("K");
		const spawnDetail = component.render(90);
		const spawnDetailText = spawnDetail.join("\n");
		assert.ok(spawnDetail[1]?.startsWith("│ name=Message type recon") === true,
			"spawn detail leads with metadata fields");
		assert.ok(spawnDetailText.includes("Goal") && !spawnDetailText.includes("## Goal")
			&& spawnDetailText.includes("Find everything relevant to message types."),
			"spawn detail renders the prompt as markdown");
		assert.ok(spawnDetailText.includes("end your turn."), "spawn detail keeps the ack");
		component.handleInput("m");
		const rawSpawnDetail = component.render(90).join("\n");
		assert.ok(rawSpawnDetail.includes("subagent_spawn {") && rawSpawnDetail.includes("task"),
			"m still reveals the raw canonical text");
	});
});
