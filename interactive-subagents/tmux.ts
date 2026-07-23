/**
 * tmux.ts — the terminal layer.
 *
 * Everything the orchestrator needs from tmux: stage a launch script, create
 * a pane that runs it, close it, and poll for the child's exit.
 *
 * Design notes:
 * - Launch commands are staged as bash scripts under the session artifacts,
 *   then passed to tmux as the two arguments `bash <path>`. They are never
 *   typed into a shell or handed to tmux as a single shell-parsed string.
 * - Panes are created with `-d` so tmux never steals the user's focus, and
 *   they are anchored to the parent pi's own pane (`$TMUX_PANE`) so splits
 *   appear next to the agent rather than wherever the user happens to be.
 */

import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { config } from "./config.ts";

// ── running tmux ─────────────────────────────────────────────────────────

/** Run a tmux command synchronously and return its stdout. Throws on failure. */
function tmux(args: string[]): string {
	return execFileSync("tmux", args, { encoding: "utf8" });
}

/** Resolve the same tmux executable the parent reaches through PATH. */
function tmuxBinaryPath(): string {
	for (const entry of (process.env.PATH ?? "").split(delimiter)) {
		const candidate = resolve(entry || ".", "tmux");
		try {
			if (!statSync(candidate).isFile()) continue;
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {}
	}
	throw new Error("tmux is not on PATH");
}

/**
 * We can only create panes if the parent pi is itself running inside tmux
 * ($TMUX is set), tmux is on PATH, and it supports pane environments/options
 * (3.0a+). Having tmux installed outside a session is not enough.
 */
export function supportsRequiredTmuxVersion(version: string): boolean {
	const match = /^(\d+)\.(\d+)([a-z])?/.exec(version.trim());
	if (!match) return false;
	const major = Number.parseInt(match[1], 10);
	const minor = Number.parseInt(match[2], 10);
	return major > 3 || (major === 3 && (minor > 0 || (minor === 0 && match[3] !== undefined)));
}

export function isTmuxAvailable(): boolean {
	if (!process.env.TMUX) return false;
	try {
		return supportsRequiredTmuxVersion(tmux(["display-message", "-p", "#{version}"]));
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

/** Create a pane with direct `bash <scriptPath>` argv and return its tmux id. */
function createTmuxPane(
	command: "new-window" | "split-window",
	args: string[],
	launchScriptPath: string,
): string {
	const paneId = tmux([
		command,
		...args,
		"-e",
		"PI_SUBAGENT_LAUNCH=1",
		"--",
		"bash",
		launchScriptPath,
	]).trim();
	if (!paneId.startsWith("%")) {
		throw new Error(`tmux ${command} returned an unexpected pane id: "${paneId}"`);
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
function createAgentsWindow(title: string, launchScriptPath: string): string {
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
	const args = ["-d", "-P", "-F", "#{pane_id}"];
	if (parentWindow) args.push("-a", "-t", parentWindow);
	args.push("-n", `${base}-subagents`);

	const paneId = createTmuxPane("new-window", args, launchScriptPath);

	try {
		const windowId = tmux(["display-message", "-p", "-t", paneId, "#{window_id}"]).trim();
		rememberAgentsWindow(windowId);
		tmux(["set-window-option", "-t", windowId, "automatic-rename", "off"]);
		tmux(["set-window-option", "-t", windowId, "allow-rename", "off"]);
	} catch {
		// Window bookkeeping is cosmetic; the child pane already exists.
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
export function createPane(title: string, launchScriptPath: string): string {
	// "window": all subagents live in one dedicated, tiled sibling window.
	if (config.layout === "window") {
		const existing = agentsWindow();
		if (!existing) {
			// First subagent: create the window and use its initial pane.
			return createAgentsWindow(title, launchScriptPath);
		}
		// Subsequent: add a pane to that window and re-tile.
		const paneId = createTmuxPane(
			"split-window",
			["-d", "-t", existing, "-P", "-F", "#{pane_id}"],
			launchScriptPath,
		);
		tileAgentsWindow(existing);
		titlePane(paneId, title);
		return paneId;
	}

	// "off" and "main" split a new pane off the parent pi's pane, in place.
	const args = ["-d", "-h"];
	if (process.env.TMUX_PANE) {
		args.push("-t", process.env.TMUX_PANE);
	}
	args.push("-P", "-F", "#{pane_id}");

	const paneId = createTmuxPane("split-window", args, launchScriptPath);

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

// ── staging launch scripts ───────────────────────────────────────────────

/**
 * Stage a bash launch script under the session artifacts for inspection and
 * hand re-runs. The guarded first line parks a launch-created pane even when
 * the child command fails immediately, which preserves tmux's exit status for
 * the poller without changing a developer's pane.
 */
export function stageLaunchScript(command: string, scriptPath: string): void {
	mkdirSync(dirname(scriptPath), { recursive: true });
	const remainOnExit =
		`if [ "$PI_SUBAGENT_LAUNCH" = "1" ]; then ${shellQuote(tmuxBinaryPath())} ` +
		`set-option -p -t "$TMUX_PANE" remain-on-exit on; fi`;
	writeFileSync(scriptPath, `${remainOnExit}\n${command}\n`, { mode: 0o755 });
}

// ── exit detection ───────────────────────────────────────────────────────

/** What pollForExit reports back to the watcher. */
export type ExitResult =
	| { reason: "done" | "exited" | "aborted"; exitCode: number }
	| { reason: "ping"; exitCode: number; pingMessage: string; pingName?: string }
	| { reason: "error" | "pane-closed" | "killed"; exitCode: number; errorMessage: string };

type PaneDeadState =
	| { state: "alive" }
	| { state: "dead"; exitCode: number | null }
	| { state: "gone" };

/** Read tmux's retained process state for a pane in one query. */
function queryPaneDeadState(paneId: string): PaneDeadState {
	let output: string;
	try {
		output = tmux(["display-message", "-p", "-t", paneId, "#{pane_dead},#{pane_dead_status}"]).trimEnd();
	} catch {
		return { state: "gone" };
	}

	const comma = output.indexOf(",");
	if (comma === -1) return { state: "gone" };
	const dead = output.slice(0, comma);
	const status = output.slice(comma + 1);
	if (dead === "0") return { state: "alive" };
	if (dead !== "1") return { state: "gone" };

	return {
		state: "dead",
		exitCode: /^\d+$/.test(status) ? Number.parseInt(status, 10) : null,
	};
}

/**
 * If the pane disappears (user closed it, tmux died) and no sidecar shows up,
 * we wait this many extra polls before declaring the child dead. Without this
 * grace period, a pane killed externally at just the wrong moment could make
 * the watcher give up before the child's sidecar hits the disk.
 */
const PANE_GONE_GRACE_TICKS = 5;

/** Some tmux versions expose pane death before its numeric status. Confirm an
 * empty status on a second poll before classifying it as signal death. */
const DEAD_WITHOUT_STATUS_GRACE_TICKS = 2;

/**
 * Wait for a child to finish, checking once per second by default, in
 * priority order:
 *
 *   1. The `.exit` sidecar file — the child's typed last word
 *      ({type: "done" | "ping" | "error"}). Most precise; deleted on read.
 *   2. A dead pane's tmux-recorded exit status — the crash net for a child
 *      that exits without running our extension code. The sidecar is checked
 *      once more on the death tick so a simultaneous precise result wins.
 *      An empty status is confirmed on the next tick before signal death is
 *      reported distinctly because some tmux versions publish status late.
 *   3. Pane gone + grace period expired — the child vanished before tmux
 *      could retain its status, with late sidecars checked during the grace.
 *
 * `onTick` fires once per loop. v1 passes nothing; v2 attaches liveness
 * snapshot observation here — this parameter is the designed seam.
 */
export async function pollForExit(options: {
	paneId: string;
	sessionFile: string;
	signal: AbortSignal;
	onTick?: (elapsedSeconds: number) => void;
	tickMs?: number;
}): Promise<ExitResult> {
	const { paneId, sessionFile, signal, onTick, tickMs = 1000 } = options;
	const sidecarPath = `${sessionFile}.exit`;
	const startedAt = Date.now();
	let ticksSincePaneGone = 0;
	let ticksSinceDeadWithoutStatus = 0;

	while (true) {
		// Parent session is shutting down / reloading — stop watching.
		if (signal.aborted) {
			return { reason: "aborted", exitCode: 0 };
		}

		// 1. Sidecar fast path. Read it, delete it (one-shot signal), interpret.
		const sidecar = readSidecar(sidecarPath);
		if (sidecar) return sidecar;

		const pane = queryPaneDeadState(paneId);
		if (pane.state !== "alive") {
			const lateSidecar = readSidecar(sidecarPath);
			if (lateSidecar) return lateSidecar;
		}

		switch (pane.state) {
			case "alive":
				ticksSincePaneGone = 0;
				ticksSinceDeadWithoutStatus = 0;
				break;
			case "dead":
				if (pane.exitCode !== null) {
					return { reason: "exited", exitCode: pane.exitCode };
				}
				ticksSinceDeadWithoutStatus += 1;
				if (ticksSinceDeadWithoutStatus >= DEAD_WITHOUT_STATUS_GRACE_TICKS) {
					return {
						reason: "killed",
						exitCode: 1,
						errorMessage: "The subagent's process died without reporting an exit status (killed by a signal or the system).",
					};
				}
				break;
			case "gone":
				ticksSinceDeadWithoutStatus = 0;
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
		await sleep(tickMs);
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

/** Promise-flavored setTimeout used by the poller. */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
