import { createWorktree, finishWorktree, isWorktreeDirty, lastNonEmptyLine, removeWorktree } from "../worktree.ts";
import { DEFAULT_WORKTREE_CLEANUP_COMMAND, DEFAULT_WORKTREE_CREATE_COMMAND } from "../config.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown) {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}: got ${g}, want ${w}`); }
}
function ok(label: string, cond: boolean) {
	if (cond) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}`); }
}
async function rejects(label: string, fn: () => Promise<unknown>, contains: string[]) {
	try { await fn(); fail++; console.log(`  FAIL ${label}: expected rejection`); }
	catch (e) {
		const msg = String(e);
		const missing = contains.filter((c) => !msg.includes(c));
		if (missing.length === 0) { pass++; console.log(`  ok  ${label}`); }
		else { fail++; console.log(`  FAIL ${label}: message missing ${JSON.stringify(missing)}\n    ${msg}`); }
	}
}

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

// ── lastNonEmptyLine parsing ───────────────────────────────────────────────

eq("last line: simple", lastNonEmptyLine("/a/b\n"), "/a/b");
eq("last line: picks the LAST of several", lastNonEmptyLine("chatter\n/the/dir\n"), "/the/dir");
eq("last line: skips trailing blank lines", lastNonEmptyLine("/the/dir\n\n   \n"), "/the/dir");
eq("last line: trims surrounding whitespace", lastNonEmptyLine("  /the/dir  \n"), "/the/dir");
eq("last line: handles CRLF output", lastNonEmptyLine("chatter\r\n/the/dir\r\n"), "/the/dir");
eq("last line: empty stdout is null", lastNonEmptyLine(""), null);
eq("last line: whitespace-only stdout is null", lastNonEmptyLine("\n  \n"), null);

// ── default-command creation ───────────────────────────────────────────────

{
	const repo = makeRepo();
	const base = git(repo, ["rev-parse", "HEAD"]);
	const info = await create(repo, "worker-abc123");
	eq("create: dir is <repo>/.pi/worktrees/<name>", info.dir, join(repo, ".pi", "worktrees", "worker-abc123"));
	eq("create: branch is pi/<name>", info.branch, "pi/worker-abc123");
	eq("create: baseCommit is parent HEAD", info.baseCommit, base);
	eq("create: parentCwd recorded", info.parentCwd, repo);
	ok("create: worktree directory exists", statSync(info.dir).isDirectory());
	// The `*` gitignore makes .pi/worktrees/ self-ignoring — the parent repo
	// must not see the new directory as untracked noise.
	eq("create: parent repo status stays clean", git(repo, ["status", "--porcelain"]), "");
}

// A relative path on stdout resolves against the parent cwd.
{
	const repo = makeRepo();
	const cmd = `mkdir -p .pi/worktrees && git worktree add -b pi/rel .pi/worktrees/rel >&2 && echo .pi/worktrees/rel`;
	const info = await createWorktree({ name: "rel", parentCwd: repo, command: cmd });
	eq("create: relative stdout path resolves against parent cwd", info.dir, join(repo, ".pi", "worktrees", "rel"));
}

// ── creation failure shapes ────────────────────────────────────────────────

{
	const repo = makeRepo();
	// non-zero exit: the exit code AND the command's stderr must surface
	await rejects("fail: non-zero exit surfaces code + stderr",
		() => createWorktree({ name: "x", parentCwd: repo, command: `echo boom >&2; exit 3` }),
		["exit code 3", "boom"]);
	// exit 0 but the printed path doesn't exist
	await rejects("fail: nonexistent path",
		() => createWorktree({ name: "x", parentCwd: repo, command: `echo /definitely/not/a/real/dir` }),
		["does not exist"]);
	// exit 0, directory exists, but it's not a git work tree — it must live
	// OUTSIDE the fixture repo, or git would just walk up and find the repo
	const plain = tempDir("subagents-plain-");
	await rejects("fail: non-git directory returned",
		() => createWorktree({ name: "x", parentCwd: repo, command: `echo "${plain}"` }),
		["not a git work tree"]);
	// exit 0 but nothing on stdout at all
	await rejects("fail: no stdout",
		() => createWorktree({ name: "x", parentCwd: repo, command: `true` }),
		["printed no directory"]);
}

// Parent cwd isn't a git repo: the DEFAULT command's own `git rev-parse`
// fails, and git's stderr is the error the user sees.
await rejects("fail: non-git parent cwd",
	() => create(tempDir("subagents-nongit-"), "x"),
	["not a git repository"]);

// ── dirty detection ────────────────────────────────────────────────────────

{
	const repo = makeRepo();

	// pristine: nothing touched since creation
	const pristine = await create(repo, "pristine");
	eq("dirty: pristine worktree is clean", await isWorktreeDirty(pristine), false);

	// untracked file
	const untracked = await create(repo, "untracked");
	writeFileSync(join(untracked.dir, "new.txt"), "hi\n");
	eq("dirty: untracked file", await isWorktreeDirty(untracked), true);

	// modified tracked file
	const modified = await create(repo, "modified");
	writeFileSync(join(modified.dir, "README.md"), "changed\n");
	eq("dirty: modified tracked file", await isWorktreeDirty(modified), true);

	// committed work: status is clean but HEAD moved off baseCommit —
	// the critical case, since removal would delete the branch and the work
	const committed = await create(repo, "committed");
	writeFileSync(join(committed.dir, "work.txt"), "done\n");
	git(committed.dir, ["add", "."]);
	git(committed.dir, ["commit", "-q", "-m", "work"]);
	eq("dirty: committed work (clean status, moved HEAD)", await isWorktreeDirty(committed), true);

	// git can't answer (directory gone) -> THROWS; finishWorktree owns turning
	// that into an honest "kept" outcome (tested below), never a false "dirty"
	const gone = { ...pristine, dir: join(repo, "no-such-dir") };
	await rejects("dirty: git error throws", () => isWorktreeDirty(gone), ["no-such-dir"]);
}

// ── finishWorktree outcomes ────────────────────────────────────────────────

{
	const repo = makeRepo();
	const cleanup = DEFAULT_WORKTREE_CLEANUP_COMMAND;

	// auto + clean + succeeded -> removed, and BOTH the directory and the
	// branch are actually gone afterwards
	const removed = await create(repo, "will-remove");
	eq("finish: auto+clean+succeeded removes",
		await finishWorktree({ info: removed, mode: "auto", command: cleanup, childSucceeded: true }),
		{ status: "removed" });
	ok("finish: removed directory is gone", !existsSync(removed.dir));
	eq("finish: removed branch is gone", git(repo, ["branch", "--list", "pi/will-remove"]), "");

	// dirty -> kept, worktree untouched
	const dirty = await create(repo, "dirty");
	writeFileSync(join(dirty.dir, "wip.txt"), "wip\n");
	eq("finish: dirty is kept",
		await finishWorktree({ info: dirty, mode: "auto", command: cleanup, childSucceeded: true }),
		{ status: "kept", code: "dirty", reason: "it has changes" });
	ok("finish: dirty worktree still exists", existsSync(dirty.dir));

	// mode "never" -> kept even though clean + succeeded
	const never = await create(repo, "never");
	eq("finish: mode never is kept",
		await finishWorktree({ info: never, mode: "never", command: cleanup, childSucceeded: true }),
		{ status: "kept", code: "mode-never", reason: 'worktreeCleanupMode is "never"' });
	ok("finish: never-mode worktree still exists", existsSync(never.dir));

	// failed child -> kept (even clean), so subagent_resume still works
	const failed = await create(repo, "failed");
	eq("finish: failed child is kept",
		await finishWorktree({ info: failed, mode: "auto", command: cleanup, childSucceeded: false }),
		{ status: "kept", code: "child-failed", reason: "the sub-agent did not finish successfully" });
	ok("finish: failed-child worktree still exists", existsSync(failed.dir));

	// cleanup command itself fails -> cleanup-failed with the error, and the
	// worktree is left intact for manual removal
	const stuck = await create(repo, "stuck");
	const outcome = await finishWorktree({
		info: stuck, mode: "auto", command: `echo nope >&2; exit 1`, childSucceeded: true,
	});
	eq("finish: failing cleanup reports cleanup-failed", outcome.status, "cleanup-failed");
	ok("finish: cleanup-failed error carries stderr",
		outcome.status === "cleanup-failed" && outcome.error.includes("exit code 1") && outcome.error.includes("nope"));
	ok("finish: cleanup-failed worktree still exists", existsSync(stuck.dir));

	// directory already vanished -> kept, and the cleanup command never runs
	const vanished = await create(repo, "vanished");
	git(repo, ["worktree", "remove", "--force", vanished.dir]);
	eq("finish: vanished directory is kept without running cleanup",
		await finishWorktree({ info: vanished, mode: "auto", command: `exit 1`, childSucceeded: true }),
		{ status: "kept", code: "vanished", reason: "its directory no longer exists" });

	// directory exists but is NOT a git work tree -> state can't be verified ->
	// kept with an honest reason (we never remove what we can't prove clean)
	const swapped = { dir: tempDir("subagents-opaque-"), branch: "b", baseCommit: "x", parentCwd: repo };
	const unverified = await finishWorktree({ info: swapped, mode: "auto", command: `exit 1`, childSucceeded: true });
	ok("finish: unverifiable state is kept with reason",
		unverified.status === "kept" && unverified.code === "unverified" &&
			unverified.reason.includes("could not be verified"));
}

// ── detached HEAD: create + cleanup ────────────────────────────────────────

{
	const repo = makeRepo();
	// A create command that checks out a DETACHED worktree (no branch).
	const cmd = `mkdir -p .pi/worktrees && printf '*\\n' >.pi/worktrees/.gitignore && ` +
		`git worktree add --detach ".pi/worktrees/$PI_SUBAGENT_WORKTREE_NAME" >&2 && ` +
		`echo ".pi/worktrees/$PI_SUBAGENT_WORKTREE_NAME"`;
	const info = await createWorktree({ name: "detached", parentCwd: repo, command: cmd });
	eq("detached: branch snapshots as literal HEAD", info.branch, "HEAD");
	eq("detached: baseCommit is parent HEAD", info.baseCommit, git(repo, ["rev-parse", "HEAD"]));
	eq("detached: fresh worktree is clean", await isWorktreeDirty(info), false);

	// The default cleanup gets PI_SUBAGENT_WORKTREE_BRANCH="" here, and its
	// `[ -n ]` guard must skip branch deletion instead of erroring.
	eq("detached: default cleanup removes it",
		await finishWorktree({
			info, mode: "auto", command: DEFAULT_WORKTREE_CLEANUP_COMMAND, childSucceeded: true,
		}),
		{ status: "removed" });
	ok("detached: directory is gone", !existsSync(info.dir));
}

// ── parent cwd is itself a linked worktree ─────────────────────────────────

// This repo's own layout: the pi session runs inside a linked worktree, not
// the main checkout. `--show-toplevel` and `worktree add` must still work,
// nesting the new worktree under the LINKED root.
{
	const repo = makeRepo();
	const linked = join(tempDir("subagents-linkbase-"), "linked");
	git(repo, ["worktree", "add", "-q", "-b", "side", linked]);

	const info = await create(linked, "from-linked");
	eq("linked: dir nests under the linked root", info.dir, join(linked, ".pi", "worktrees", "from-linked"));
	eq("linked: branch is pi/<name>", info.branch, "pi/from-linked");
	eq("linked: linked parent status stays clean", git(linked, ["status", "--porcelain"]), "");

	// removeWorktree is the unconditional path (spawn rollback uses it) —
	// exercise it directly from the linked parent.
	eq("linked: removeWorktree removes it",
		await removeWorktree(info, DEFAULT_WORKTREE_CLEANUP_COMMAND),
		{ status: "removed" });
	ok("linked: directory is gone", !existsSync(info.dir));
	eq("linked: branch is gone", git(repo, ["branch", "--list", "pi/from-linked"]), "");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
