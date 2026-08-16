import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createWorktree, describeExecError, finishWorktree, isWorktreeDirty, lastNonEmptyLine, removeWorktree } from "../worktree.ts";
import { DEFAULT_WORKTREE_CLEANUP_COMMAND, DEFAULT_WORKTREE_CREATE_COMMAND } from "../config.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── fixtures ───────────────────────────────────────────────────────────────

// realpathSync because macOS's tmpdir is a symlink (/var -> /private/var) and
// `git rev-parse --show-toplevel` prints the RESOLVED path — without this the
// dir assertions would compare symlinked vs physical paths.
function tempDir(prefix: string): string {
	return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// A throwaway repo with one commit. Identity and gpgsign are pinned locally
// so the machine's global git config can't break commits in the fixture.
function makeRepo(): string {
	const repo = tempDir("subagents-worktree-");
	git(repo, ["init", "-q", "-b", "main"]);
	git(repo, ["config", "user.email", "test@example.com"]);
	git(repo, ["config", "user.name", "Test"]);
	git(repo, ["config", "commit.gpgsign", "false"]);
	writeFileSync(join(repo, "README.md"), "hello\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-q", "-m", "init"]);
	return repo;
}

// Shorthand: create a worktree in `repo` with the DEFAULT command.
function create(repo: string, name: string) {
	return createWorktree({ name, parentCwd: repo, command: DEFAULT_WORKTREE_CREATE_COMMAND });
}

function rejectsWith(fn: () => Promise<unknown>, contains: string[], message: string): Promise<void> {
	return assert.rejects(fn, (error) => contains.every((part) => String(error).includes(part)), message);
}

describe("lastNonEmptyLine", () => {
	it("last line: simple", () => {
		assert.strictEqual(lastNonEmptyLine("/a/b\n"), "/a/b");
	});

	it("last line: picks the LAST of several", () => {
		assert.strictEqual(lastNonEmptyLine("chatter\n/the/dir\n"), "/the/dir");
	});

	it("last line: skips trailing blank lines", () => {
		assert.strictEqual(lastNonEmptyLine("/the/dir\n\n   \n"), "/the/dir");
	});

	it("last line: trims surrounding whitespace", () => {
		assert.strictEqual(lastNonEmptyLine("  /the/dir  \n"), "/the/dir");
	});

	it("last line: handles CRLF output", () => {
		assert.strictEqual(lastNonEmptyLine("chatter\r\n/the/dir\r\n"), "/the/dir");
	});

	it("last line: empty stdout is null", () => {
		assert.strictEqual(lastNonEmptyLine(""), null);
	});

	it("last line: whitespace-only stdout is null", () => {
		assert.strictEqual(lastNonEmptyLine("\n  \n"), null);
	});
});

describe("createWorktree", () => {
	it("the default command creates an isolated self-ignoring worktree", async () => {
		const repo = makeRepo();
		const base = git(repo, ["rev-parse", "HEAD"]);
		const info = await create(repo, "worker-abc123");
		assert.strictEqual(info.dir, join(repo, ".pi", "worktrees", "worker-abc123"),
			"create: dir is <repo>/.pi/worktrees/<name>");
		assert.strictEqual(info.branch, "pi/worker-abc123", "create: branch is pi/<name>");
		assert.strictEqual(info.baseCommit, base, "create: baseCommit is parent HEAD");
		assert.strictEqual(info.parentCwd, repo, "create: parentCwd recorded");
		assert.ok(statSync(info.dir).isDirectory(), "create: worktree directory exists");
		// The `*` gitignore makes .pi/worktrees/ self-ignoring — the parent repo
		// must not see the new directory as untracked noise.
		assert.strictEqual(git(repo, ["status", "--porcelain"]), "", "create: parent repo status stays clean");
	});

	it("a relative stdout path resolves against the parent cwd", async () => {
		const repo = makeRepo();
		const cmd = `mkdir -p .pi/worktrees && git worktree add -b pi/rel .pi/worktrees/rel >&2 && echo .pi/worktrees/rel`;
		const info = await createWorktree({ name: "rel", parentCwd: repo, command: cmd });
		assert.strictEqual(info.dir, join(repo, ".pi", "worktrees", "rel"));
	});

	it("creation failures surface exit codes, stderr, and contract violations", async () => {
		const repo = makeRepo();
		// non-zero exit: the exit code AND the command's stderr must surface
		await rejectsWith(
			() => createWorktree({ name: "x", parentCwd: repo, command: `echo boom >&2; exit 3` }),
			["exit code 3", "boom"],
			"fail: non-zero exit surfaces code + stderr");
		// exit 0 but the printed path doesn't exist
		await rejectsWith(
			() => createWorktree({ name: "x", parentCwd: repo, command: `echo /definitely/not/a/real/dir` }),
			["does not exist"],
			"fail: nonexistent path");
		// exit 0, directory exists, but it's not a git work tree — it must live
		// OUTSIDE the fixture repo, or git would just walk up and find the repo.
		// git's own stderr must survive into the message, not just our framing.
		const plain = tempDir("subagents-plain-");
		await rejectsWith(
			() => createWorktree({ name: "x", parentCwd: repo, command: `echo "${plain}"` }),
			["not a git work tree", "not a git repository"],
			"fail: non-git directory returned");
		// exit 0 but nothing on stdout at all
		await rejectsWith(
			() => createWorktree({ name: "x", parentCwd: repo, command: `true` }),
			["printed no directory"],
			"fail: no stdout");
		// exit 0 but the printed path is the PARENT checkout — accepting it would
		// silently defeat isolation, so the contract rejects it loudly
		await rejectsWith(
			() => createWorktree({ name: "x", parentCwd: repo, command: `echo .` }),
			["parent checkout itself"],
			"fail: parent checkout returned");
		// killed by a signal (crash, OOM-kill, pkill): reported as the signal it
		// was, never as a timeout — and stderr from before the kill survives
		await rejectsWith(
			() => createWorktree({ name: "x", parentCwd: repo, command: `echo crashed >&2; kill -KILL $$` }),
			["was killed by signal SIGKILL", "crashed"],
			"fail: signal-killed is not a timeout");
	});

	// Parent cwd isn't a git repo: the DEFAULT command's own `git rev-parse`
	// fails, and git's stderr is the error the user sees.
	it("a non-git parent cwd surfaces git's stderr", async () => {
		await rejectsWith(
			() => create(tempDir("subagents-nongit-"), "x"),
			["not a git repository"],
			"fail: non-git parent cwd");
	});
});

// The classifier's timeout branch can't be reached through the 120s public
// timeouts, so it is exercised directly with Node-shaped error objects.
describe("describeExecError", () => {
	it("classify: killed=true is a timeout", () => {
		const timeout = describeExecError({ killed: true, signal: "SIGTERM" }, "worktree create command", 120_000);
		assert.ok(timeout.message.includes("timed out after 120s"));
	});

	it("classify: external signal named with stderr", () => {
		const signal = describeExecError({ killed: false, signal: "SIGSEGV", stderr: "boom\n" }, "x", 1_000);
		assert.ok(signal.message.includes("was killed by signal SIGSEGV") && signal.message.includes("boom"));
	});

	it("classify: exit code + stderr", () => {
		const exit = describeExecError({ code: 7, stderr: "nope" }, "x", 1_000);
		assert.ok(exit.message.includes("exit code 7") && exit.message.includes("nope"));
	});
});

describe("isWorktreeDirty", () => {
	it("dirty detection distinguishes pristine, changed, committed, and unverifiable worktrees", async () => {
		const repo = makeRepo();

		// pristine: nothing touched since creation
		const pristine = await create(repo, "pristine");
		assert.strictEqual(await isWorktreeDirty(pristine), false, "dirty: pristine worktree is clean");

		// untracked file
		const untracked = await create(repo, "untracked");
		writeFileSync(join(untracked.dir, "new.txt"), "hi\n");
		assert.strictEqual(await isWorktreeDirty(untracked), true, "dirty: untracked file");

		// modified tracked file
		const modified = await create(repo, "modified");
		writeFileSync(join(modified.dir, "README.md"), "changed\n");
		assert.strictEqual(await isWorktreeDirty(modified), true, "dirty: modified tracked file");

		// committed work: status is clean but HEAD moved off baseCommit —
		// the critical case, since removal would delete the branch and the work
		const committed = await create(repo, "committed");
		writeFileSync(join(committed.dir, "work.txt"), "done\n");
		git(committed.dir, ["add", "."]);
		git(committed.dir, ["commit", "-q", "-m", "work"]);
		assert.strictEqual(await isWorktreeDirty(committed), true,
			"dirty: committed work (clean status, moved HEAD)");

		// git can't answer (directory gone) -> THROWS; finishWorktree owns turning
		// that into an honest "kept" outcome (tested below), never a false "dirty"
		const gone = { ...pristine, dir: join(repo, "no-such-dir") };
		await rejectsWith(() => isWorktreeDirty(gone), ["no-such-dir"], "dirty: git error throws");
	});
});

describe("finishWorktree", () => {
	it("cleanup outcomes distinguish removed, kept, and cleanup-failed worktrees", async () => {
		const repo = makeRepo();
		const cleanup = DEFAULT_WORKTREE_CLEANUP_COMMAND;

		// auto + clean + succeeded -> removed, and BOTH the directory and the
		// branch are actually gone afterwards
		const removed = await create(repo, "will-remove");
		assert.deepStrictEqual(
			await finishWorktree({ info: removed, mode: "auto", command: cleanup, childSucceeded: true }),
			{ status: "removed" },
			"finish: auto+clean+succeeded removes");
		assert.ok(!existsSync(removed.dir), "finish: removed directory is gone");
		assert.strictEqual(git(repo, ["branch", "--list", "pi/will-remove"]), "",
			"finish: removed branch is gone");

		// dirty -> kept, worktree untouched
		const dirty = await create(repo, "dirty");
		writeFileSync(join(dirty.dir, "wip.txt"), "wip\n");
		assert.deepStrictEqual(
			await finishWorktree({ info: dirty, mode: "auto", command: cleanup, childSucceeded: true }),
			{ status: "kept", code: "dirty", reason: "it has changes" },
			"finish: dirty is kept");
		assert.ok(existsSync(dirty.dir), "finish: dirty worktree still exists");

		// mode "never" -> kept even though clean + succeeded
		const never = await create(repo, "never");
		assert.deepStrictEqual(
			await finishWorktree({ info: never, mode: "never", command: cleanup, childSucceeded: true }),
			{ status: "kept", code: "mode-never", reason: 'worktreeCleanupMode is "never"' },
			"finish: mode never is kept");
		assert.ok(existsSync(never.dir), "finish: never-mode worktree still exists");

		// failed child -> kept (even clean), so subagent_resume still works
		const failed = await create(repo, "failed");
		assert.deepStrictEqual(
			await finishWorktree({ info: failed, mode: "auto", command: cleanup, childSucceeded: false }),
			{ status: "kept", code: "child-failed", reason: "the sub-agent did not finish successfully" },
			"finish: failed child is kept");
		assert.ok(existsSync(failed.dir), "finish: failed-child worktree still exists");

		// cleanup command itself fails -> cleanup-failed with the error, and the
		// worktree is left intact for manual removal
		const stuck = await create(repo, "stuck");
		const outcome = await finishWorktree({
			info: stuck, mode: "auto", command: `echo nope >&2; exit 1`, childSucceeded: true,
		});
		assert.strictEqual(outcome.status, "cleanup-failed", "finish: failing cleanup reports cleanup-failed");
		assert.ok(
			outcome.status === "cleanup-failed" && outcome.error.includes("exit code 1") && outcome.error.includes("nope"),
			"finish: cleanup-failed error carries stderr");
		assert.ok(existsSync(stuck.dir), "finish: cleanup-failed worktree still exists");

		// directory already vanished -> kept, and the cleanup command never runs
		const vanished = await create(repo, "vanished");
		git(repo, ["worktree", "remove", "--force", vanished.dir]);
		assert.deepStrictEqual(
			await finishWorktree({ info: vanished, mode: "auto", command: `exit 1`, childSucceeded: true }),
			{ status: "kept", code: "vanished", reason: "its directory no longer exists" },
			"finish: vanished directory is kept without running cleanup");

		// directory exists but is NOT a git work tree -> state can't be verified ->
		// kept with an honest reason that carries git's actual complaint
		const swapped = { dir: tempDir("subagents-opaque-"), branch: "b", baseCommit: "x", parentCwd: repo };
		const unverified = await finishWorktree({ info: swapped, mode: "auto", command: `exit 1`, childSucceeded: true });
		assert.ok(
			unverified.status === "kept" && unverified.code === "unverified" &&
				unverified.reason.includes("could not be verified") &&
				unverified.reason.includes("not a git repository"),
			"finish: unverifiable state is kept with git's reason");
	});
});

describe("detached HEAD worktrees", () => {
	it("detached worktrees create with a literal HEAD branch and clean up without branch deletion", async () => {
		const repo = makeRepo();
		// A create command that checks out a DETACHED worktree (no branch).
		const cmd = `mkdir -p .pi/worktrees && printf '*\\n' >.pi/worktrees/.gitignore && ` +
			`git worktree add --detach ".pi/worktrees/$PI_SUBAGENT_WORKTREE_NAME" >&2 && ` +
			`echo ".pi/worktrees/$PI_SUBAGENT_WORKTREE_NAME"`;
		const info = await createWorktree({ name: "detached", parentCwd: repo, command: cmd });
		assert.strictEqual(info.branch, "HEAD", "detached: branch snapshots as literal HEAD");
		assert.strictEqual(info.baseCommit, git(repo, ["rev-parse", "HEAD"]),
			"detached: baseCommit is parent HEAD");
		assert.strictEqual(await isWorktreeDirty(info), false, "detached: fresh worktree is clean");

		// The default cleanup gets PI_SUBAGENT_WORKTREE_BRANCH="" here, and its
		// `[ -n ]` guard must skip branch deletion instead of erroring.
		assert.deepStrictEqual(
			await finishWorktree({
				info, mode: "auto", command: DEFAULT_WORKTREE_CLEANUP_COMMAND, childSucceeded: true,
			}),
			{ status: "removed" },
			"detached: default cleanup removes it");
		assert.ok(!existsSync(info.dir), "detached: directory is gone");
	});
});

describe("linked worktree parents", () => {
	// This repo's own layout: the pi session runs inside a linked worktree, not
	// the main checkout. `--show-toplevel` and `worktree add` must still work,
	// nesting the new worktree under the LINKED root.
	it("worktrees nest under a linked parent and removeWorktree removes them unconditionally", async () => {
		const repo = makeRepo();
		const linked = join(tempDir("subagents-linkbase-"), "linked");
		git(repo, ["worktree", "add", "-q", "-b", "side", linked]);

		const info = await create(linked, "from-linked");
		assert.strictEqual(info.dir, join(linked, ".pi", "worktrees", "from-linked"),
			"linked: dir nests under the linked root");
		assert.strictEqual(info.branch, "pi/from-linked", "linked: branch is pi/<name>");
		assert.strictEqual(git(linked, ["status", "--porcelain"]), "",
			"linked: linked parent status stays clean");

		// removeWorktree is the unconditional path (spawn rollback uses it) —
		// exercise it directly from the linked parent.
		assert.deepStrictEqual(
			await removeWorktree(info, DEFAULT_WORKTREE_CLEANUP_COMMAND),
			{ status: "removed" },
			"linked: removeWorktree removes it");
		assert.ok(!existsSync(info.dir), "linked: directory is gone");
		assert.strictEqual(git(repo, ["branch", "--list", "pi/from-linked"]), "", "linked: branch is gone");
	});
});
