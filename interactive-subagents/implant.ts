/**
 * implant.ts — the extension that rides INSIDE every subagent.
 *
 * The parent launches children with `pi … -e <this file>`, so these tools
 * exist only in subagent sessions, never in normal ones. The implant's whole
 * identity comes from env vars the parent baked into the launch command:
 *
 *   PI_SUBAGENT_SESSION    where to write the `.exit` sidecar (required)
 *   PI_SUBAGENT_NAME       display name, echoed in ping messages
 *   PI_SUBAGENT_AUTO_EXIT  "1" = exit automatically when a turn completes
 *
 * If PI_SUBAGENT_SESSION is missing we register nothing at all, so this file
 * is harmless if it ever gets loaded into a regular session.
 *
 * The `.exit` sidecar is the child's typed last word — done / ping / error —
 * written next to the session file and consumed (deleted) by the parent's
 * poller. The result summary itself never travels through the sidecar: it is
 * the child's last assistant message, already durable in the session .jsonl.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { writeFileSync } from "node:fs";

export default function (pi: ExtensionAPI) {
	const sessionFile = process.env.PI_SUBAGENT_SESSION;
	const subagentName = process.env.PI_SUBAGENT_NAME ?? "subagent";
	const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";

	// Not launched as a subagent — do nothing.
	if (!sessionFile) return;

	/** Write the one-shot `.exit` sidecar. Best effort: if the write fails,
	 * the parent still detects our exit via the screen sentinel. */
	function writeExitSidecar(data: Record<string, unknown>): void {
		try {
			writeFileSync(`${sessionFile}.exit`, JSON.stringify(data));
		} catch {
			// fall back to sentinel-based detection
		}
	}

	// ── subagent_done: explicit completion ─────────────────────────────────
	// Used by agents that are NOT auto-exit (interactive ones a human drives).
	pi.registerTool({
		name: "subagent_done",
		label: "Subagent Done",
		description:
			"Call this when you have completed your task. It closes this session and " +
			"reports back to the parent session. Your LAST assistant message before " +
			"calling this becomes the summary the parent receives — write it first.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			writeExitSidecar({ type: "done" });
			ctx.shutdown();
			return {
				content: [{ type: "text", text: "Shutting down subagent session." }],
				details: {},
			};
		},
	});

	// ── caller_ping: ask the parent for help (and exit) ────────────────────
	// Help is exit-based, not wait-based: we write the question into the
	// sidecar and shut down. The pane closes, nothing sits blocked. The parent
	// answers by RESUMING this same session file later — the conversation
	// context survives because the .jsonl file IS the context.
	pi.registerTool({
		name: "caller_ping",
		label: "Ask Parent for Help",
		description:
			"Ask the parent agent for help and exit this session. The parent is " +
			"notified with your message and can resume this session with an answer. " +
			"Use when you are stuck, blocked, or need a decision you cannot make.",
		parameters: Type.Object({
			message: Type.String({ description: "What you need help with" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			writeExitSidecar({ type: "ping", name: subagentName, message: params.message });
			ctx.shutdown();
			return {
				content: [{ type: "text", text: "Help request sent. Session will exit." }],
				details: {},
			};
		},
	});

	// ── auto-exit: autonomous agents close themselves ──────────────────────
	// When PI_SUBAGENT_AUTO_EXIT=1, the session shuts down as soon as an agent
	// turn completes. The decision is based on HOW the turn ended:
	//
	//   stopReason "aborted"  → user pressed Escape: stay open so they can
	//                           inspect or redirect the child.
	//   stopReason "error"    → provider failure after pi exhausted retries:
	//                           write an `error` sidecar first, so the parent
	//                           reports a real failure instead of mistaking
	//                           exit-code 0 + a stale message for success.
	//   anything else         → clean completion: write a `done` sidecar.
	if (autoExit) {
		pi.on("agent_end", (event, ctx) => {
			// Find the last assistant message of the turn that just ended.
			const messages = (event as { messages?: Array<Record<string, unknown>> }).messages;
			let lastAssistant: Record<string, unknown> | null = null;
			if (messages) {
				for (let i = messages.length - 1; i >= 0; i--) {
					if (messages[i]?.role === "assistant") {
						lastAssistant = messages[i];
						break;
					}
				}
			}

			if (lastAssistant?.stopReason === "aborted") return; // Escape — stay open

			if (lastAssistant?.stopReason === "error") {
				const errorMessage =
					typeof lastAssistant.errorMessage === "string" && lastAssistant.errorMessage.trim()
						? lastAssistant.errorMessage
						: "Subagent turn ended with an error and no error message.";
				writeExitSidecar({ type: "error", errorMessage });
			} else {
				writeExitSidecar({ type: "done" });
			}

			ctx.shutdown();
		});
	}
}
