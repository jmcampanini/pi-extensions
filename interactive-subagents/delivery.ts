/**
 * delivery.ts - observing our own result messages landing in the parent
 * transcript, so the widget can stop showing a finished child.
 *
 * Why this exists: pi delivers steered messages one at a time, only at the
 * parent's next turn boundary. When the parent is mid-turn, a child's result
 * can sit queued for minutes after its pane closed. The watcher parks exited
 * children in state.ts's delivering map instead of deleting their widget
 * row; this listener removes the row only when the message ACTUALLY lands.
 * When the parent is idle the whole cycle takes microseconds and the state
 * just flashes.
 *
 * pi API in play: pi.on("message_end", handler) fires for every message
 * appended to the agent transcript - including this extension's own
 * pi.sendMessage sends. It fires ONLY for messages that travel the agent
 * event stream, which is exactly what the watcher's
 * { triggerTurn: true, deliverAs: "steer" } options guarantee; a send
 * without them would deliver invisibly and strand its row forever.
 *
 * The deliberate gap: if the human presses Escape while the parent streams,
 * pi drops the queued steer silently - no event ever fires, nothing can be
 * polled - and the row sticks. That stuck "delivering" row is the one honest
 * signal that a result was lost (/reload clears it; re-sending is out of
 * scope by design).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { delivering } from "./state.ts";
import { updateRunningWidget } from "./running-widget.ts";

/**
 * Pure matcher: the delivering-map key confirmed by a landed message, or
 * undefined. Only the EXIT customTypes match: subagent_stalled and
 * subagent_recovered carry the same details.id shape but are sent for
 * STILL-RUNNING children, and one can land AFTER the child exits (it was
 * queued behind the same turn boundary) - matching on the id alone would
 * clear a row whose real result is still queued. The message is typed
 * unknown and narrowed one step at a time: pi types details as unknown, and
 * an earlier-loaded extension may have replaced the message entirely - a
 * mismatch must mean "the row stays", never a crash. Exported for the tests.
 */
export function deliveredChildId(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const msg = message as { role?: unknown; customType?: unknown; details?: unknown };
	if (msg.role !== "custom") return undefined;
	if (msg.customType !== "subagent_result" && msg.customType !== "subagent_ping") return undefined;
	if (typeof msg.details !== "object" || msg.details === null) return undefined;
	const id = (msg.details as { id?: unknown }).id;
	return typeof id === "string" ? id : undefined;
}

/**
 * Registered once at activation (parent mode only, index.ts), BEFORE any
 * child can exist: on an idle parent, message_end for a result fires within
 * microtasks of the watcher's pi.sendMessage call, so late registration
 * would miss it. The body stays trivial on purpose - pi survives a throwing
 * handler but the row would be stranded. Unknown ids are normal (results
 * queued before a /reload) and Map.delete is idempotent, so redelivery is
 * harmless too.
 */
export function registerDeliveryListener(pi: ExtensionAPI): void {
	pi.on("message_end", (event) => {
		const id = deliveredChildId(event.message);
		if (id === undefined) return;
		if (delivering.delete(id)) updateRunningWidget();
	});
}
