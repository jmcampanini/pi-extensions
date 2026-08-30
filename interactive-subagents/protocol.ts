/**
 * protocol.ts - the parent ↔ child contract, all in one file.
 *
 * The parent and the child are separate pi processes; they never share
 * memory. Everything they say to each other travels over two channels,
 * and this file defines the shape of each one:
 *
 *   1. ENV VARS (parent → child, at launch): `ChildEnvVars`, prefixed onto
 *      the launch command line because a pane inherits the tmux server's
 *      environment rather than the parent process's current environment.
 *   2. THE `.exit` SIDECAR (child → parent, at exit): `ExitSidecar`, a tiny
 *      JSON file the child's implant writes next to its session file. It is
 *      the child's typed last word - done / ping / error - and the parent's
 *      poller deletes it on read (a one-shot signal).
 *
 * If you change anything here, both sides change together - that is the
 * point of keeping the contract in one file.
 */

// ── channel 1: env vars (parent → child) ─────────────────────────────────
// Read by implant.ts inside the child. PI_SUBAGENT_SESSION doubles as the
// "am I a subagent?" detector: index.ts sees it and registers no spawn tools
// inside children (no recursion), and implant.ts sees it and comes alive.

export interface ChildEnvVars {
	/** The child's session file - also where the implant writes `.exit`. */
	PI_SUBAGENT_SESSION: string;
	/** Display name, echoed back in ping messages. */
	PI_SUBAGENT_NAME: string;
	/** 8-char run id minted by the parent for THIS launch - stamps ownership
	 * of the liveness snapshot (the full contract lives in activity.ts).
	 * Required, not optional, on purpose: both launch sites construct this
	 * object with explicit keys, so a required field makes tsc force spawn
	 * AND resume in the same diff instead of letting one silently omit it. */
	PI_SUBAGENT_ID: string;
	/** Absolute path of the liveness snapshot file (see activity.ts). */
	PI_SUBAGENT_ACTIVITY_FILE: string;
	/** Agent-definition name ("scout", "worker") for the child's identity banner. */
	PI_SUBAGENT_AGENT?: string;
	/** "1" = exit automatically when a turn completes; absent = stay open. */
	PI_SUBAGENT_AUTO_EXIT?: "1";
}

// ── channel 2: the `.exit` sidecar (child → parent) ──────────────────────
// Written by implant.ts to `<session>.jsonl.exit`; read AND DELETED by the
// parent's poller (tmux.ts). The result text itself never travels through
// the sidecar - it is the child's last assistant message, already durable
// in the session .jsonl. The sidecar only carries the exit INTENT.

export type ExitSidecar =
	| { type: "done" }
	| { type: "ping"; name?: string; message: string }
	| { type: "error"; errorMessage: string };
