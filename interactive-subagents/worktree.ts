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

import { execFile, execFileSync } from "node:child_process";
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
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

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
		const e = error as { code?: unknown; killed?: boolean; signal?: string; stderr?: string };
		const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
		const detail = stderr === "" ? "" : `: ${stderr}`;
		// A timeout shows up as the child being killed by a signal, not as an
		// exit code — report it as what it is so the user tunes their command.
		if (e.killed || e.signal) {
			throw new Error(`${what} timed out after ${opts.timeoutMs / 1000}s${detail}`);
		}
		throw new Error(`${what} failed (exit code ${typeof e.code === "number" ? e.code : "unknown"})${detail}`);
	}
}

// Local git reads (status, rev-parse) are milliseconds, so sync is fine here
// — only the user-pluggable commands above need to be async. stderr is piped
// (not inherited) so git's chatter never leaks into pi's TUI.
function gitOutput(dir: string, args: string[]): string {
	return execFileSync("git", ["-C", dir, ...args], {
		encoding: "utf8",
		timeout: 10_000,
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
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
		branch = gitOutput(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
		baseCommit = gitOutput(dir, ["rev-parse", "HEAD"]);
	} catch {
		throw new Error(`worktree create command returned a directory that is not a git work tree: ${dir}`);
	}

	return { dir, branch, baseCommit, parentCwd: opts.parentCwd };
}

// ── cleanup ────────────────────────────────────────────────────────────────

/**
 * "Dirty" means the subagent left work behind, in any form: uncommitted or
 * untracked files (`git status --porcelain` non-empty) OR a HEAD that moved
 * off the creation-time base commit — a subagent that COMMITTED its work has
 * a clean status, and auto-removing the worktree + branch would destroy it.
 * If git errors (directory deleted, corrupted, ...) we can't prove it's
 * clean, so answer dirty — the failure mode is a leftover directory, never
 * lost work.
 */
export function isWorktreeDirty(info: WorktreeInfo): boolean {
	try {
		if (gitOutput(info.dir, ["status", "--porcelain"]) !== "") return true;
		return gitOutput(info.dir, ["rev-parse", "HEAD"]) !== info.baseCommit;
	} catch {
		return true;
	}
}

export type WorktreeOutcome =
	| { status: "removed" }
	| { status: "kept"; reason: string }
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
	if (!existsSync(opts.info.dir)) return { status: "kept", reason: "directory no longer exists" };
	if (opts.mode === "never") return { status: "kept", reason: 'worktreeCleanupMode is "never"' };
	if (!opts.childSucceeded) return { status: "kept", reason: "the sub-agent did not finish successfully" };
	if (isWorktreeDirty(opts.info)) return { status: "kept", reason: "it has changes" };
	return removeWorktree(opts.info, opts.command);
}
