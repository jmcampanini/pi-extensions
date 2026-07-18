/**
 * catalogue.ts - getting the agent catalogue in front of the parent MODEL.
 *
 * The parent should be able to match work to an agent without a
 * subagent_list round trip, so a compact routing block (agents.ts
 * formatAgentCatalogue) is appended to the parent's system prompt on every
 * prompted turn. It is a SNAPSHOT, deliberately: computed at session_start (which
 * also fires on /reload, /new, /resume, and fork) and refreshed whenever
 * subagent_list or /subagent-available computes a fresh inventory anyway.
 * Nothing re-reads the definition files per turn - a snapshot that lags a
 * mid-session file edit costs nothing, because subagent_spawn loads the
 * definition from disk at call time and subagent_list is always live.
 *
 * pi API in play: the `before_agent_start` event fires after the user
 * submits a prompt and before the agent loop; returning `systemPrompt`
 * replaces the system prompt for that turn. The block is appended at the
 * very END of the prompt and its text only changes when the inventory
 * does, so prompt caching is disturbed as little as possible.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { collectAgentInventory, formatAgentCatalogue, type AgentInfo } from "./agents.ts";

/** The current snapshot; undefined = no agents, inject nothing. */
let catalogueBlock: string | undefined;

/** Re-render the snapshot from an inventory the caller already computed. */
export function updateCatalogue(inventory: AgentInfo[]): void {
	catalogueBlock = formatAgentCatalogue(inventory);
}

export function registerCatalogue(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		updateCatalogue(collectAgentInventory(ctx.modelRegistry, ctx.cwd));
	});

	// Guarded on the spawn tool being active: advertising agents the model
	// cannot spawn would only invite tool calls that must fail.
	pi.on("before_agent_start", (event) => {
		if (catalogueBlock === undefined) return;
		if (!pi.getActiveTools().includes("subagent_spawn")) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${catalogueBlock}` };
	});
}
