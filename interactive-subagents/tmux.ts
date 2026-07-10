/**
 * tmux.ts — the terminal layer.
 *
 * Everything the orchestrator needs from tmux: create a pane, type a command
 * into it, read its screen, close it, and poll for the child's exit.
 *
 * Design notes:
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
import { config } from "./config.ts";
import { SENTINEL_REGEX } from "./protocol.ts";

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

// ── pane layout ──────────────────────────────────────────────────────────
// How subagent panes are arranged. Naively splitting the parent's column every
// time makes each pane progressively narrower; these strategies keep things
// readable. Configured via config.ts (`layout` / `mainWidth`):
//
//   off     Split a plain pane to the right in the current window. No re-flow.
//   main    Split in the current window, then main-vertical: the parent pi
//           stays a fixed-width pane on the left, children stack on the right.
//   window  Put every subagent in a dedicated sibling window named
//           "<parent window>-subagents", kept tiled.

/**
 * Every pane-creating tmux command is run with `-P -F "#{pane_id}"` so it
 * prints the new pane's id. Validate that we really got one ("%12"-style)
 * before trusting it as a target for later commands.
 */
function paneIdFrom(raw: string, tmuxCommand: string): string {
	const paneId = raw.trim();
	if (!paneId.startsWith("%")) {
		throw new Error(`tmux ${tmuxCommand} returned an unexpected pane id: "${paneId}"`);
	}
	return paneId;
}

/** Give a pane a title (shown by `tmux display-panes` / status lines). */
function titlePane(paneId: string, title: string): void {
	try {
		tmux(["select-pane", "-t", paneId, "-T", title]);
	} catch {
		// cosmetic — best effort
	}
}

/**
 * Re-flow the window containing `anchorPane` into main-vertical: the parent pi
 * (leftmost, oldest pane) becomes the fixed-width "main" pane, everything else
 * stacks in the right column. Layout is cosmetic — never fail a spawn over it.
 */
function applyMainVertical(anchorPane: string): void {
	try {
		tmux(["setw", "-t", anchorPane, "main-pane-width", config.mainWidth]);
		tmux(["select-layout", "-t", anchorPane, "main-vertical"]);
	} catch {
		// keep the raw split if the layout command fails
	}
}

// ── the dedicated subagents window ("window" layout) ───────────────────────
// The window id is parked on globalThis (like our timers) so it survives a
// /reload: we reuse the same window across spawns instead of leaking a new one.
// The two tiny accessors below are the ONLY way this file touches that slot,
// so the untyped globalThis cast happens in exactly one place.

const AGENTS_WINDOW_KEY = Symbol.for("interactive-subagents/agents-window");
const slots = globalThis as Record<symbol, unknown>;

function rememberedAgentsWindow(): string | null {
	const id = slots[AGENTS_WINDOW_KEY];
	return typeof id === "string" ? id : null;
}

function rememberAgentsWindow(windowId: string | null): void {
	slots[AGENTS_WINDOW_KEY] = windowId;
}

/** Does a window with this id still exist anywhere in the server? */
function windowExists(windowId: string): boolean {
	try {
		return tmux(["list-windows", "-a", "-F", "#{window_id}"])
			.split("\n")
			.some((line) => line.trim() === windowId);
	} catch {
		return false;
	}
}

/** The dedicated subagents window id if it still exists, else null. */
function agentsWindow(): string | null {
	const id = rememberedAgentsWindow();
	if (id !== null && windowExists(id)) return id;
	rememberAgentsWindow(null);
	return null;
}

/**
 * Create the dedicated subagents window as a sibling right after the parent
 * pi's window, named "<parent window>-subagents", and return the pane id of
 * its initial pane (which the first subagent uses). Auto-rename is disabled so
 * the running subagents can't rename the window away from "-subagents".
 */
function createAgentsWindow(title: string): string {
	const parentPane = process.env.TMUX_PANE;

	// Base the name on the parent pi's window; fall back to "pi".
	let base = "pi";
	let parentWindow: string | undefined;
	if (parentPane) {
		try {
			base = tmux(["display-message", "-p", "-t", parentPane, "#{window_name}"]).trim() || "pi";
			parentWindow = tmux(["display-message", "-p", "-t", parentPane, "#{window_id}"]).trim();
		} catch {
			// keep defaults
		}
	}

	// -d = don't switch to it; -a -t <window> = insert right after the parent.
	const args = ["new-window", "-d", "-P", "-F", "#{pane_id}"];
	if (parentWindow) args.push("-a", "-t", parentWindow);
	args.push("-n", `${base}-subagents`);

	const paneId = paneIdFrom(tmux(args), "new-window");

	const windowId = tmux(["display-message", "-p", "-t", paneId, "#{window_id}"]).trim();
	rememberAgentsWindow(windowId);
	try {
		tmux(["set-window-option", "-t", windowId, "automatic-rename", "off"]);
		tmux(["set-window-option", "-t", windowId, "allow-rename", "off"]);
	} catch {
		// cosmetic
	}

	titlePane(paneId, title);
	return paneId;
}

/** Re-tile the dedicated subagents window (best effort). */
function tileAgentsWindow(windowId: string): void {
	try {
		tmux(["select-layout", "-t", windowId, "tiled"]);
	} catch {
		// cosmetic
	}
}

// ── panes ────────────────────────────────────────────────────────────────

/**
 * Create a new pane for a subagent and return its tmux pane id (e.g. "%12").
 * Never steals the user's focus (`-d`).
 */
export function createPane(title: string): string {
	// "window": all subagents live in one dedicated, tiled sibling window.
	if (config.layout === "window") {
		const existing = agentsWindow();
		if (!existing) {
			// First subagent: create the window and use its initial pane.
			return createAgentsWindow(title);
		}
		// Subsequent: add a pane to that window and re-tile.
		const paneId = paneIdFrom(tmux(["split-window", "-d", "-t", existing, "-P", "-F", "#{pane_id}"]), "split-window");
		tileAgentsWindow(existing);
		titlePane(paneId, title);
		return paneId;
	}

	// "off" and "main" split a new pane off the parent pi's pane, in place.
	const args = ["split-window", "-d", "-h"];
	if (process.env.TMUX_PANE) {
		args.push("-t", process.env.TMUX_PANE);
	}
	args.push("-P", "-F", "#{pane_id}");

	const paneId = paneIdFrom(tmux(args), "split-window");

	// "main" re-flows into main-vertical; "off" leaves the raw split alone.
	if (config.layout === "main") applyMainVertical(paneId);
	titlePane(paneId, title);
	return paneId;
}

/**
 * Move the user's focus to a pane — even one in another window: tmux resolves
 * a pane target to its window, so select-window brings that window to the
 * front first. `zoom` additionally toggles tmux's pane zoom (prefix+z
 * un-zooms). Throws if the pane no longer exists.
 */
export function focusPane(paneId: string, options?: { zoom?: boolean }): void {
	tmux(["select-window", "-t", paneId]);
	tmux(["select-pane", "-t", paneId]);
	if (options?.zoom) {
		tmux(["resize-pane", "-Z", "-t", paneId]);
	}
}

/** Kill a pane. Ignores failures (the pane may already be gone). */
export function closePane(paneId: string): void {
	try {
		tmux(["kill-pane", "-t", paneId]);
	} catch {
		// already closed — fine
	}
}

/**
 * Re-apply the layout after a child pane closes, so survivors reclaim the freed
 * space evenly (tmux doesn't re-flow a named layout on its own when a pane
 * dies). No-op for "off", and for "window" once the whole window is gone.
 */
export function refreshLayout(): void {
	if (config.layout === "off") return;

	if (config.layout === "window") {
		const win = agentsWindow();
		if (win) tileAgentsWindow(win);
		return;
	}

	// main — anchored on the parent pi's own pane.
	const anchor = process.env.TMUX_PANE;
	if (anchor) applyMainVertical(anchor);
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
export type ExitResult =
	| { reason: "done" | "exited" | "aborted"; exitCode: number }
	| { reason: "ping"; exitCode: number; pingMessage: string; pingName?: string }
	| { reason: "error" | "pane-closed"; exitCode: number; errorMessage: string };

/**
 * If the pane disappears (user closed it, tmux died) and no sidecar shows up,
 * we wait this many extra polls before declaring the child dead. Without this
 * grace period, a pane killed externally at just the wrong moment could make
 * the watcher give up before the child's sidecar hits the disk.
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
		// The file should be an ExitSidecar (see protocol.ts), but it comes
		// off the disk, so every field is still checked before it is trusted.
		const data = JSON.parse(readFileSync(sidecarPath, "utf8")) as Record<string, unknown>;
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

/** Promise-flavored setTimeout, shared by the poller and the launch flow. */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
