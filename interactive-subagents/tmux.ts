/**
 * tmux.ts — the terminal layer.
 *
 * Everything the orchestrator needs from tmux: create a pane, type a command
 * into it, read its screen, close it, and poll for the child's exit.
 *
 * Design notes carried over from the reference implementation:
 * - Long commands are NEVER typed directly into a pane. Typing text that is
 *   wider than the pane wraps and corrupts the command, and the user's login
 *   shell (fish/zsh/bash) has different quoting rules. Instead we write a
 *   `#!/bin/bash` script to disk and type only `bash '<path>'`.
 * - Panes are created with `-d` so tmux never steals the user's focus, and
 *   they are anchored to the parent pi's own pane (`$TMUX_PANE`) so splits
 *   appear next to the agent rather than wherever the user happens to be.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// ── running tmux ─────────────────────────────────────────────────────────

/** Run a tmux command synchronously and return its stdout. Throws on failure. */
function tmux(args: string[]): string {
	return execFileSync("tmux", args, { encoding: "utf8" });
}

/**
 * We can only create panes if the parent pi is itself running inside tmux
 * ($TMUX is set) AND the tmux binary is on PATH. Having tmux installed but
 * running pi outside of it is not enough — there is no session to split.
 */
export function isTmuxAvailable(): boolean {
	if (!process.env.TMUX) return false;
	try {
		execFileSync("tmux", ["-V"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

// ── shell quoting ────────────────────────────────────────────────────────

/**
 * Classic POSIX single-quote escaping: wrap in single quotes, and replace any
 * embedded single quote with '\'' (close quote, escaped quote, reopen quote).
 * Safe for any string because nothing is interpreted inside single quotes.
 */
export function shellQuote(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

// ── panes ────────────────────────────────────────────────────────────────

/**
 * Create a new pane for a subagent and return its tmux pane id (e.g. "%12").
 *
 * -d  = don't focus the new pane (never steal the user's keyboard)
 * -h  = horizontal split (side by side)
 * -t  = split the parent pi's own pane, not the currently focused one
 * -P -F '#{pane_id}' = print the new pane's id so we can target it later
 */
export function createPane(title: string): string {
	const args = ["split-window", "-d", "-h"];
	if (process.env.TMUX_PANE) {
		args.push("-t", process.env.TMUX_PANE);
	}
	args.push("-P", "-F", "#{pane_id}");

	const paneId = tmux(args).trim();
	if (!paneId.startsWith("%")) {
		throw new Error(`tmux split-window returned an unexpected pane id: "${paneId}"`);
	}

	// Give the pane a title so `tmux display-panes` / status lines can show
	// which subagent lives where. Cosmetic only — ignore failures.
	try {
		tmux(["select-pane", "-t", paneId, "-T", title]);
	} catch {
		// best effort
	}

	return paneId;
}

/** Kill a pane. Ignores failures (the pane may already be gone). */
export function closePane(paneId: string): void {
	try {
		tmux(["kill-pane", "-t", paneId]);
	} catch {
		// already closed — fine
	}
}

// ── typing into panes ────────────────────────────────────────────────────

/**
 * Type a (short!) command into a pane and press Enter.
 * `-l` sends the text literally so tmux doesn't interpret key names in it.
 */
export function sendCommand(paneId: string, command: string): void {
	tmux(["send-keys", "-t", paneId, "-l", command]);
	tmux(["send-keys", "-t", paneId, "Enter"]);
}

/**
 * Run a long/multi-line command in a pane by staging it as a bash script.
 *
 * The script is kept on disk (under the session's artifacts) so you can
 * inspect exactly what was launched, or re-run it by hand when debugging.
 */
export function sendLongCommand(paneId: string, command: string, scriptPath: string): void {
	mkdirSync(dirname(scriptPath), { recursive: true });
	writeFileSync(scriptPath, "#!/bin/bash\n" + command + "\n", { mode: 0o755 });
	sendCommand(paneId, `bash ${shellQuote(scriptPath)}`);
}

// ── reading screens ──────────────────────────────────────────────────────

/**
 * Read the last `lines` lines of a pane's screen (including scrollback).
 * Throws if the pane no longer exists — callers use that as a signal.
 */
export function readScreen(paneId: string, lines = 50): string {
	return tmux(["capture-pane", "-p", "-t", paneId, "-S", `-${lines}`]);
}

// ── exit detection ───────────────────────────────────────────────────────

/** What pollForExit reports back to the watcher. */
export interface ExitResult {
	reason: "done" | "ping" | "error" | "exited" | "pane-closed" | "aborted";
	exitCode: number;
	/** Set when reason is "ping": what the child needs help with. */
	pingMessage?: string;
	pingName?: string;
	/** Set when reason is "error": the provider/agent error from the child. */
	errorMessage?: string;
}

/**
 * The sentinel string the launch script echoes after pi exits, carrying the
 * shell exit code. In the launch command it is written quote-split
 * (`'__SUBAGENT_DONE_'$?'__'`) so the *typed command line* on screen can
 * never match this digits-only regex — only the real output after exit can.
 */
const SENTINEL_REGEX = /__SUBAGENT_DONE_(\d+)__/;

/**
 * If the pane disappears (user closed it, tmux died) and no sidecar shows up,
 * we wait this many extra polls before declaring the child dead. This fixes a
 * reference-implementation gotcha where a killed pane made the watcher loop
 * forever.
 */
const PANE_GONE_GRACE_TICKS = 5;

/**
 * Wait for a child to finish, checking once per second, in priority order:
 *
 *   1. The `.exit` sidecar file — the child's typed last word
 *      ({type: "done" | "ping" | "error"}). Most precise; deleted on read.
 *   2. The screen sentinel `__SUBAGENT_DONE_<code>__` — catches crashes and
 *      any exit where the child never ran our extension code.
 *   3. Pane gone + grace period expired — the child was killed externally.
 *
 * `onTick` fires once per loop. v1 passes nothing; v2 attaches liveness
 * snapshot observation here — this parameter is the designed seam.
 */
export async function pollForExit(options: {
	paneId: string;
	sessionFile: string;
	signal: AbortSignal;
	onTick?: (elapsedSeconds: number) => void;
}): Promise<ExitResult> {
	const { paneId, sessionFile, signal, onTick } = options;
	const sidecarPath = `${sessionFile}.exit`;
	const startedAt = Date.now();
	let ticksSincePaneGone = 0;

	while (true) {
		// Parent session is shutting down / reloading — stop watching.
		if (signal.aborted) {
			return { reason: "aborted", exitCode: 0 };
		}

		// 1. Sidecar fast path. Read it, delete it (one-shot signal), interpret.
		const sidecar = readSidecar(sidecarPath);
		if (sidecar) return sidecar;

		// 2. Screen sentinel: scan only the last few lines for the exit marker.
		try {
			const screen = readScreen(paneId, 5);
			const match = screen.match(SENTINEL_REGEX);
			if (match) {
				return { reason: "exited", exitCode: Number.parseInt(match[1], 10) };
			}
			ticksSincePaneGone = 0;
		} catch {
			// 3. The pane is gone. The child may have JUST written its sidecar
			// before the pane closed, so re-check it for a few more ticks
			// before giving up.
			const lateSidecar = readSidecar(sidecarPath);
			if (lateSidecar) return lateSidecar;

			ticksSincePaneGone += 1;
			if (ticksSincePaneGone >= PANE_GONE_GRACE_TICKS) {
				return {
					reason: "pane-closed",
					exitCode: 1,
					errorMessage: "The subagent's pane closed without reporting a result.",
				};
			}
		}

		onTick?.(Math.round((Date.now() - startedAt) / 1000));
		await sleep(1000);
	}
}

/** Read + delete + interpret the `.exit` sidecar. Returns null if absent/unreadable. */
function readSidecar(sidecarPath: string): ExitResult | null {
	if (!existsSync(sidecarPath)) return null;
	try {
		const data = JSON.parse(readFileSync(sidecarPath, "utf8"));
		rmSync(sidecarPath, { force: true });

		if (data.type === "ping") {
			return {
				reason: "ping",
				exitCode: 0,
				pingMessage: typeof data.message === "string" ? data.message : "(no message)",
				pingName: typeof data.name === "string" ? data.name : undefined,
			};
		}
		if (data.type === "error") {
			return {
				reason: "error",
				exitCode: 1,
				errorMessage:
					typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
						? data.errorMessage
						: "Subagent reported an error without a message.",
			};
		}
		// Anything else (normally {type: "done"}) counts as a clean completion.
		return { reason: "done", exitCode: 0 };
	} catch {
		// Corrupt/half-written sidecar: ignore it this tick and try again.
		return null;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
