/**
 * implant.ts — the extension that rides INSIDE every subagent.
 *
 * The parent launches children with `pi … -e <this file>`, so these tools
 * exist only in subagent sessions, never in normal ones. The implant's whole
 * identity comes from the env vars the parent baked into the launch command —
 * the `ChildEnvVars` half of the contract in protocol.ts:
 *
 *   PI_SUBAGENT_SESSION        where to write the `.exit` sidecar (required)
 *   PI_SUBAGENT_NAME           display name, echoed in ping messages
 *   PI_SUBAGENT_AGENT          agent-definition name, shown in the banner
 *   PI_SUBAGENT_AUTO_EXIT      "1" = exit automatically when a turn completes
 *   PI_SUBAGENT_ID             run id stamping liveness-snapshot ownership
 *   PI_SUBAGENT_ACTIVITY_FILE  where the liveness recorder writes (activity.ts)
 *
 * If PI_SUBAGENT_SESSION is missing we register nothing at all, so this file
 * is harmless if it ever gets loaded into a regular session.
 *
 * The `.exit` sidecar (the `ExitSidecar` half of protocol.ts) is the child's
 * typed last word — done / ping / error — written next to the session file
 * and consumed (deleted) by the parent's poller. The result summary itself
 * never travels through the sidecar: it is the child's last assistant
 * message, already durable in the session .jsonl.
 *
 * The implant also pins a one-line identity banner above the editor
 * (banner.ts) so a human who opens the pane can see at a glance that this
 * is a subagent, which one, and how the session will end.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { writeFileSync } from "node:fs";
import { registerActivityRecorder } from "./activity.ts";
import { formatBannerLine } from "./banner.ts";
import type { ChildEnvVars, ExitSidecar } from "./protocol.ts";

// Sticky human-driving flag for the banner: set when a user aborts a turn
// (Escape) in an auto-exit child, and never cleared — once a human has
// touched the session, the "next completed turn exits" warning stays up.
let humanDriving = false;

export default function (pi: ExtensionAPI) {
	// The type-only cast gives the env vars the shape protocol.ts promises;
	// at runtime they are still plain (possibly missing) strings.
	const env = process.env as Partial<ChildEnvVars>;
	const sessionFile = env.PI_SUBAGENT_SESSION;
	const subagentName = env.PI_SUBAGENT_NAME ?? "subagent";
	const agentName = env.PI_SUBAGENT_AGENT;
	const autoExit = env.PI_SUBAGENT_AUTO_EXIT === "1";

	// Not launched as a subagent — do nothing.
	if (!sessionFile) return;

	// ── liveness reporting ─────────────────────────────────────────────────
	// The v2 recorder (activity.ts) overwrites one small snapshot file on
	// every recorded pi event; the parent's watcher reads it to tell starting
	// from active from stalled. When either var is missing there is no
	// fallback: the recorder never registers and the parent shows starting
	// then stalled — documented degradation, not an error.
	const runId = env.PI_SUBAGENT_ID;
	const activityFile = env.PI_SUBAGENT_ACTIVITY_FILE;
	if (runId && activityFile) registerActivityRecorder(pi, { runId, activityFile });

	// ── the identity banner ────────────────────────────────────────────────
	// banner.ts is the pure renderer; this pushes it into pi's UI. Passing a
	// COMPONENT FACTORY (not plain lines) lets the banner render at the real
	// terminal width — same pattern as running-widget.ts. render() reads
	// `humanDriving` live, and re-calling setWidget after the flag flips
	// forces the repaint.
	function showBanner(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(
			"subagent-banner",
			(_tui, theme) => ({
				invalidate(): void {},
				render(width: number): string[] {
					return [
						formatBannerLine({ name: subagentName, agent: agentName, autoExit, humanDriving }, width, {
							dim: (text) => theme.fg("dim", text),
							border: (text) => theme.fg("borderMuted", text),
							warn: (text) => theme.fg("warning", text),
						}),
					];
				},
			}),
			{ placement: "aboveEditor" },
		);
	}

	pi.on("session_start", (_event, ctx) => showBanner(ctx));

	/** True once any sidecar has been written this run. The first write is
	 * the child's verdict — nothing may overwrite it (see agent_end below). */
	let sidecarWritten = false;

	/** Write the one-shot `.exit` sidecar. Best effort: if the write fails,
	 * the parent still detects our exit via the screen sentinel. */
	function writeExitSidecar(data: ExitSidecar): void {
		sidecarWritten = true;
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
	//   stopReason "error"    → the LLM call errored. We exit on the FIRST
	//                           error and write an `error` sidecar, so the
	//                           parent reports a real failure instead of
	//                           mistaking exit-code 0 + a stale message for
	//                           success. Pi might have auto-retried a transient
	//                           error; the parent can always resume.
	//   anything else         → clean completion: write a `done` sidecar.
	if (autoExit) {
		// pi types this event as AgentEndEvent: `messages` carries the whole
		// turn, each with role and (for assistants) stopReason/errorMessage.
		pi.on("agent_end", (event, ctx) => {
			// If a tool (subagent_done / caller_ping) already wrote a sidecar,
			// the verdict is decided. pi defers our shutdown while the model is
			// still streaming, so this handler can fire again afterwards — it
			// must never overwrite a ping with a "done". Just finish exiting.
			if (sidecarWritten) {
				ctx.shutdown();
				return;
			}

			// Find the last assistant message of the turn that just ended. We
			// only read these three fields, so the local type says just that.
			const lastAssistant: { role: string; stopReason?: string; errorMessage?: string } | undefined = [
				...event.messages,
			]
				.reverse()
				.find((message) => message.role === "assistant");

			if (lastAssistant?.stopReason === "aborted") {
				// Escape — stay open, and flip the banner into its warning
				// state: a human is driving now, but auto-exit is still armed,
				// so the next completed turn WILL exit and report back.
				humanDriving = true;
				showBanner(ctx);
				return;
			}

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
