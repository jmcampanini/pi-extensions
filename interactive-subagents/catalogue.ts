/**
 * catalogue.ts - getting the agent catalogue in front of the parent MODEL.
 *
 * The parent should be able to match work to an agent, and name a model for
 * it, without a subagent_available round trip, so a compact routing block
 * (agents.ts formatAgentCatalogue: the agents, then the usable model ids) is
 * appended to the parent's system prompt on every prompted turn. It is a
 * SNAPSHOT, deliberately: computed at session_start (which also fires on
 * /reload, /new, /resume, and fork) and refreshed whenever subagent_available
 * or /subagent-available computes a fresh inventory anyway. Nothing re-reads
 * the definition files per turn - a snapshot that lags a mid-session file
 * edit costs nothing, because subagent_spawn loads the definition from disk
 * at call time and subagent_available is always live.
 *
 * The waiting contract rides along as a static trailer: tool descriptions are
 * read once at spawn time and their guidance decays over a long wait, but the
 * system prompt is re-read every turn, so the contract stays in force exactly
 * when a parent is tempted to fill time instead of ending its turn.
 *
 * pi API in play: the `before_agent_start` event fires after the user
 * submits a prompt and before the agent loop; returning `systemPrompt`
 * replaces the system prompt for that turn. The block is appended at the
 * very END of the prompt and its text only changes when the inventory
 * does, so prompt caching is disturbed as little as possible. The parent's
 * CURRENT model is deliberately absent from the block: a /model switch
 * would rewrite it, and subagent_available reports it live instead.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { collectAgentInventory, formatAgentCatalogue, type AgentInfo } from "./agents.ts";
import { listUsableModels, type UsableModels } from "./models.ts";

/** How sub-agent results reach the parent, stated as what to do. Static by
 * design: byte-identical every turn, so it never disturbs prompt caching. */
export const WAITING_CONTRACT =
	"Sub-agent results arrive on their own: when a child finishes, its result is " +
	"steered into this conversation and starts a new turn for you. Ending your " +
	"turn is how you wait - delivery wakes you, and the work continues from " +
	"there. While children run, work only on tasks that need nothing from them; " +
	"when your next step depends on a result, tell the user in one line what you " +
	"are waiting on and end your turn.";

/** The current snapshot; undefined = no agents, inject nothing. */
let catalogueBlock: string | undefined;

/** Re-render the snapshot from an inventory and model list the caller already computed. */
export function updateCatalogue(inventory: AgentInfo[], usableModelIds: readonly string[]): void {
	catalogueBlock = formatAgentCatalogue(inventory, usableModelIds);
}

export interface InventorySnapshot {
	inventory: AgentInfo[];
	models: UsableModels;
}

/** Compute a fresh inventory and model list, and make it the injected snapshot. */
export function snapshotInventory(
	ctx: Pick<ExtensionContext, "cwd" | "modelRegistry" | "scopedModels" | "model">,
): InventorySnapshot {
	const models = listUsableModels(ctx);
	const inventory = collectAgentInventory(ctx.modelRegistry, ctx.cwd, models.ids);

	updateCatalogue(inventory, models.ids);
	return { inventory, models };
}

export function registerCatalogue(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		snapshotInventory(ctx);
	});

	// Guarded on the spawn tool being active: advertising agents the model
	// cannot spawn would only invite tool calls that must fail.
	pi.on("before_agent_start", (event) => {
		if (catalogueBlock === undefined) return;
		if (!pi.getActiveTools().includes("subagent_spawn")) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${catalogueBlock}\n\n${WAITING_CONTRACT}` };
	});
}
