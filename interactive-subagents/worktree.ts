/**
 * worktree.ts — git worktree isolation for subagents.
 *
 * A subagent can run in its own git worktree (own directory + own branch) so
 * parallel agents never trample each other's edits. Creation and cleanup are
 * both USER-PLUGGABLE shell commands (run via `bash -c`), so tools like
 * `grove` can own the whole lifecycle. The contract:
 *
 *   - Create command: gets PI_SUBAGENT_WORKTREE_NAME in its env, runs in the
 *     parent session's cwd, must exit 0 and print the worktree directory as
 *     the last non-empty stdout line (relative paths resolve against the
 *     parent cwd).
 *   - Cleanup command: gets PI_SUBAGENT_WORKTREE_DIR and
 *     PI_SUBAGENT_WORKTREE_BRANCH (empty string when detached), runs in the
 *     parent cwd, must exit 0.
 *   - Both commands must let stdout/stderr close when they exit: a background
 *     process left attached to those pipes (e.g. a daemon started without
 *     `>/dev/null 2>&1`) stalls the runner until the timeout fires.
 *
 * Cleanup is deliberately cautious: a worktree is only auto-removed when the
 * child SUCCEEDED and the worktree is provably clean — uncommitted changes,
 * untracked files, or a moved HEAD (i.e. the subagent committed work) all
 * count as "dirty", because removing the worktree AND its branch would
 * destroy that work. When git itself can't answer, we assume dirty and keep.
 *
 * Like models.ts, this is a leaf module: it does NOT import config.ts — the
 * commands and cleanup mode arrive as parameters, so it unit-tests with a
 * throwaway git repo and no config fixtures.
 */

import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Snapshot taken at creation time — everything cleanup needs later. */
export interface WorktreeInfo {
	/** Absolute path to the worktree directory (the subagent's cwd). */
	dir: string;
	/** Branch checked out in the worktree; the literal "HEAD" means detached. */
	branch: string;
	/** Commit the worktree started on — HEAD moving off it counts as changes. */
	baseCommit: string;
	/** The parent session's cwd; the cleanup command runs from here. */
	parentCwd: string;
}

// Creation may fetch from a remote (e.g. `grove create --from-remote-primary`)
// so it gets a generous timeout; cleanup is local-only and gets less.
const CREATE_TIMEOUT_MS = 120_000;
const CLEANUP_TIMEOUT_MS = 60_000;
const GIT_TIMEOUT_MS = 10_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/**
 * Turn an execFile failure into a plain Error that says what actually
 * happened. Node sets `killed` only when IT initiated the kill — i.e. our
 * timeout fired; any other signal means the command crashed or was killed
 * from outside. The trimmed stderr rides along because it is usually the
 * only real clue (e.g. git's "not a git repository"). Exported for tests —
 * the timeout branch cannot be exercised through the 120s public timeouts.
 */
export function describeExecError(error: unknown, what: string, timeoutMs: number): Error {
	const e = error as { code?: unknown; killed?: boolean; signal?: string; stderr?: string };
	const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
	const detail = stderr === "" ? "" : `: ${stderr}`;
	if (e.killed) return new Error(`${what} timed out after ${timeoutMs / 1000}s${detail}`);
	if (e.signal) return new Error(`${what} was killed by signal ${e.signal}${detail}`);
	return new Error(`${what} failed (exit code ${typeof e.code === "number" ? e.code : "unknown"})${detail}`);
}

// ── running the user's commands ────────────────────────────────────────────

// ASYNC on purpose: this module runs inside pi's TUI process, and a sync
// child call would freeze the whole interface for up to 120 seconds while a
// slow create command fetches. Failures become plain Errors that carry the
// exit code and the command's trimmed stderr — that stderr is usually the
// only clue to what went wrong (e.g. git's "not a git repository").
async function runCommand(
	what: string,
	command: string,
	opts: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<{ stdout: string; stderr: string }> {
	try {
		return await execFileAsync("bash", ["-c", command], {
			cwd: opts.cwd,
			env: { ...process.env, ...opts.env },
			timeout: opts.timeoutMs,
			maxBuffer: MAX_BUFFER_BYTES,
		});
	} catch (error) {
		throw describeExecError(error, what, opts.timeoutMs);
	}
}

// Local git reads (status, rev-parse) are ALSO async: they run inside pi's
// TUI process, and `git status` on a freshly created worktree has a cold stat
// cache — seconds on a big repo, which would freeze rendering if run sync.
// stderr is captured (not inherited) so git's chatter never leaks into the
// TUI, and failures go through the same honest classifier as the commands.
async function gitOutput(dir: string, args: string[]): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", ["-C", dir, ...args], {
			encoding: "utf8",
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: MAX_BUFFER_BYTES,
		});
		return stdout.trim();
	} catch (error) {
		throw describeExecError(error, `git ${args.join(" ")}`, GIT_TIMEOUT_MS);
	}
}

/**
 * The create command's stdout may include chatter before the directory (the
 * contract only pins the LAST non-empty line), so scan from the bottom.
 * Exported for tests. Returns null when stdout had no usable line at all.
 */
export function lastNonEmptyLine(text: string): string | null {
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim(); // trim also strips a trailing \r from CRLF output
		if (line !== "") return line;
	}
	return null;
}

// ── creation ───────────────────────────────────────────────────────────────

/**
 * Run the create command and validate what it produced: the printed path must
 * exist, be a directory, and be a git work tree (we need a branch/baseCommit
 * snapshot for the dirty check at cleanup time). Any violation throws — the
 * spawn fails fast before a pane ever opens.
 */
export async function createWorktree(opts: {
	name: string;
	parentCwd: string;
	command: string;
}): Promise<WorktreeInfo> {
	const { stdout, stderr } = await runCommand("worktree create command", opts.command, {
		cwd: opts.parentCwd,
		env: { PI_SUBAGENT_WORKTREE_NAME: opts.name },
		timeoutMs: CREATE_TIMEOUT_MS,
	});

	// The contract: last non-empty stdout line is the worktree directory.
	const line = lastNonEmptyLine(stdout);
	if (line === null) {
		throw new Error(
			`worktree create command exited 0 but printed no directory on stdout ` +
				`(the contract: last non-empty stdout line is the worktree path).\n` +
				`stdout: ${JSON.stringify(stdout)}\nstderr: ${stderr.trim()}`,
		);
	}

	// Relative paths resolve against the parent cwd (absolute ones pass through).
	const dir = resolve(opts.parentCwd, line);
	if (!existsSync(dir) || !statSync(dir).isDirectory()) {
		throw new Error(`worktree create command printed "${line}" but ${dir} does not exist or is not a directory`);
	}

	// Snapshot the branch and base commit NOW — the dirty check at cleanup
	// compares against these. `--abbrev-ref HEAD` prints the literal "HEAD"
	// when the worktree is detached.
	let branch: string;
	let baseCommit: string;
	try {
		branch = await gitOutput(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
		baseCommit = await gitOutput(dir, ["rev-parse", "HEAD"]);
	} catch (error) {
		// Keep git's own words: an unborn HEAD (e.g. `git worktree add
		// --orphan`) IS a git work tree, just unusable here — the dirty check
		// needs a base commit to compare against.
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(
			`worktree create command printed ${dir}, but snapshotting HEAD there failed — ` +
				`not a git work tree, or it has no commits yet (the dirty check needs a base commit): ${detail}`,
		);
	}

	// A misconfigured command that echoes the PARENT checkout would silently
	// defeat isolation (the child would edit the shared tree) — and cleanup
	// could later try to remove the parent's own worktree. Fail fast instead.
	// When the parent cwd is not itself in a git work tree, skip the check —
	// there is nothing to collide with.
	try {
		const parentTop = await gitOutput(opts.parentCwd, ["rev-parse", "--show-toplevel"]);
		const dirTop = await gitOutput(dir, ["rev-parse", "--show-toplevel"]);
		if (parentTop === dirTop) {
			throw new Error(
				`worktree create command printed ${dir}, which is the parent checkout itself — ` +
					`it must create a FRESH worktree (its own directory and branch), not reuse the current one`,
			);
		}
	} catch (error) {
		if (error instanceof Error && error.message.includes("parent checkout itself")) throw error;
		// parentCwd not in a git work tree: nothing to collide with.
	}

	return { dir, branch, baseCommit, parentCwd: opts.parentCwd };
}

// ── cleanup ────────────────────────────────────────────────────────────────

/**
 * "Dirty" means the subagent left work behind, in any form: uncommitted or
 * untracked files (`git status --porcelain` non-empty) OR a HEAD that moved
 * off the creation-time base commit — a subagent that COMMITTED its work has
 * a clean status, and auto-removing the worktree + branch would destroy it.
 * THROWS when git itself fails (directory deleted mid-check, corruption, a
 * timed-out status) — finishWorktree turns that into its own honest "kept"
 * reason instead of this function silently claiming "it has changes".
 */
export async function isWorktreeDirty(info: WorktreeInfo): Promise<boolean> {
	if ((await gitOutput(info.dir, ["status", "--porcelain"])) !== "") return true;
	return (await gitOutput(info.dir, ["rev-parse", "HEAD"])) !== info.baseCommit;
}

// The `code` on "kept" is machine-readable so the watcher can word its report
// per case (the human `reason` alone was easy to contradict).
export type WorktreeOutcome =
	| { status: "removed" }
	| {
			status: "kept";
			code: "vanished" | "mode-never" | "child-failed" | "unverified" | "dirty";
			reason: string;
	  }
	| { status: "cleanup-failed"; error: string };

/**
 * Run the cleanup command UNCONDITIONALLY (no dirty check — that's
 * finishWorktree's job). Also used by the spawn path to roll back a
 * seconds-old worktree when the launch fails after creation. A failing
 * command becomes a "cleanup-failed" outcome instead of a throw, so callers
 * can always report what happened.
 */
export async function removeWorktree(info: WorktreeInfo, command: string): Promise<WorktreeOutcome> {
	try {
		await runCommand("worktree cleanup command", command, {
			cwd: info.parentCwd,
			env: {
				PI_SUBAGENT_WORKTREE_DIR: info.dir,
				// Detached worktrees have no branch to delete — the contract is
				// an EMPTY string, which the default command's `[ -n ]` guard skips.
				PI_SUBAGENT_WORKTREE_BRANCH: info.branch === "HEAD" ? "" : info.branch,
			},
			timeoutMs: CLEANUP_TIMEOUT_MS,
		});
		return { status: "removed" };
	} catch (error) {
		return { status: "cleanup-failed", error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * End-of-run policy: decide whether the worktree should be removed, and do
 * it. Never throws — this runs right before the result message is delivered
 * to the parent, and cleanup problems must not block that.
 *
 * Kept (in decision order) when: the directory already vanished, the mode is
 * "never", the child did NOT succeed (a clean-but-failed child keeps its
 * worktree so subagent_resume still works), or the worktree is dirty.
 * Only a clean worktree from a successful child is removed.
 */
export async function finishWorktree(opts: {
	info: WorktreeInfo;
	mode: "auto" | "never";
	command: string;
	childSucceeded: boolean;
}): Promise<WorktreeOutcome> {
	if (!existsSync(opts.info.dir)) {
		return { status: "kept", code: "vanished", reason: "its directory no longer exists" };
	}
	if (opts.mode === "never") {
		return { status: "kept", code: "mode-never", reason: 'worktreeCleanupMode is "never"' };
	}
	if (!opts.childSucceeded) {
		return { status: "kept", code: "child-failed", reason: "the sub-agent did not finish successfully" };
	}
	let dirty: boolean;
	try {
		dirty = await isWorktreeDirty(opts.info);
	} catch (error) {
		// Can't prove it's clean → keep. The failure mode is a leftover
		// directory, never lost work.
		const detail = error instanceof Error ? error.message : String(error);
		return { status: "kept", code: "unverified", reason: `its state could not be verified (${detail})` };
	}
	if (dirty) {
		return { status: "kept", code: "dirty", reason: "it has changes" };
	}
	return removeWorktree(opts.info, opts.command);
}
