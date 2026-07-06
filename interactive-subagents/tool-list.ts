/**
 * tool-list.ts — the `subagents_list` tool: the MODEL's view of the agents.
 *
 * Terse on purpose: the model only needs enough to CHOOSE an agent (name +
 * description), plus whether the result comes back on its own (interactive
 * agents wait for a human), plus a warning when a spawn would fail. The
 * full details — tools, model, file paths — live in the human-facing
 * /subagents-available command instead; both are views over the same
 * inventory (agents.ts).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { agentDefsDir, collectAgentInventory, projectDefsDir } from "./agents.ts";

export function registerSubagentsListTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "subagents_list",
		label: "List Subagent Definitions",
		description:
			"List the available agent definitions (<name>.md files from the project's .pi/subagents/ or the global subagents dir; project shadows global) usable as the `agent` parameter of the subagent tool.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const inventory = collectAgentInventory(ctx.modelRegistry, ctx.cwd);
			if (inventory.length === 0) {
				return {
					content: [
						{
							type: "text",
							text:
								`No agent definitions found in ${agentDefsDir()} or ${projectDefsDir(ctx.cwd)}. ` +
								"The subagent tool defaults to the 'worker' agent, so create worker.md in one of those directories before spawning.",
						},
					],
					details: {},
				};
			}
			const lines = inventory.map((agent) => {
				const interactive = agent.autoExit ? "" : " (interactive — a human drives it)";
				const warning = agent.problems.length > 0 ? ` [⚠ not spawnable: ${agent.problems.join("; ")}]` : "";
				const isDefault = agent.name === "worker" ? " (default)" : "";
				const source = agent.source === "project" ? " (project)" : "";
				return `• ${agent.name}${isDefault}${source}${interactive}${warning} — ${agent.description ?? "(no description)"}`;
			});
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { count: inventory.length },
			};
		},
	});
}
