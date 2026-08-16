import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const sandbox = join(process.cwd(), ".sandbox");
mkdirSync(sandbox, { recursive: true });
const root = mkdtempSync(join(sandbox, "starting-cancel-test-"));
const configRoot = join(root, "config");
const repo = join(root, "repo");
const createdMarker = join(root, "worktree-created");
const releaseMarker = join(root, "release-create");
const failureMarker = join(root, "worktree-failure-started");
const releaseFailureMarker = join(root, "release-failure");
mkdirSync(configRoot, { recursive: true });
mkdirSync(repo, { recursive: true });

const q = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
const createCommand = [
	'case "$PI_SUBAGENT_WORKTREE_NAME" in',
	'  failure-*)',
	`    touch ${q(failureMarker)}`,
	`    while [ ! -f ${q(releaseFailureMarker)} ]; do sleep 0.01; done`,
	'    echo "intentional create failure" >&2',
	'    exit 9',
	'    ;;',
	'esac',
	'DIR="$PWD/.cancel-wt-$PI_SUBAGENT_WORKTREE_NAME"',
	'git worktree add -q -b "pi/$PI_SUBAGENT_WORKTREE_NAME" "$DIR"',
	`touch ${q(createdMarker)}`,
	`while [ ! -f ${q(releaseMarker)} ]; do sleep 0.01; done`,
	'printf "%s\\n" "$DIR"',
].join("\n");
const cleanupCommand = [
	'case "$PI_SUBAGENT_WORKTREE_BRANCH" in',
	'  pi/cleanup-failure-*) echo "intentional cleanup failure" >&2; exit 7 ;;',
	'esac',
	'git worktree remove --force "$PI_SUBAGENT_WORKTREE_DIR"',
	'if [ -n "$PI_SUBAGENT_WORKTREE_BRANCH" ]; then git branch -D "$PI_SUBAGENT_WORKTREE_BRANCH" >/dev/null; fi',
].join("\n");
writeFileSync(join(configRoot, "subagents.json"), JSON.stringify({
	maxConcurrentSubagents: 1,
	worktreeCreateCommand: createCommand,
	worktreeCleanupCommand: cleanupCommand,
}));
process.env.PI_CODING_AGENT_DIR = configRoot;

execFileSync("git", ["init", "-q"], { cwd: repo });
execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
writeFileSync(join(repo, "README.md"), "fixture\n");
execFileSync("git", ["add", "README.md"], { cwd: repo });
execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo });

const state = await import("../state.ts");
const capacity = await import("../capacity.ts");
const { requestCancel } = await import("../cancel.ts");
const { runSpawnLaunch } = await import("../tool-spawn.ts");
const { runResumeLaunch } = await import("../tool-resume.ts");
const { seedNewSession } = await import("../session.ts");
type SpawnSpec = import("../capacity.ts").SpawnSpec;
type ResumeSpec = import("../capacity.ts").ResumeSpec;

const inFlightLaunches = new Set<Promise<unknown>>();
const trackLaunch = <T>(promise: Promise<T>): Promise<T> => {
	inFlightLaunches.add(promise);
	void promise.then(
		() => inFlightLaunches.delete(promise),
		() => inFlightLaunches.delete(promise),
	);
	return promise;
};

after(async () => {
	// Release any create script still parked on a marker so a mid-test failure
	// cannot leave its shell loop spinning after the fixture is removed.
	writeFileSync(releaseMarker, "release\n");
	writeFileSync(releaseFailureMarker, "release\n");
	await Promise.allSettled([...inFlightLaunches]);
	inFlightLaunches.clear();
	capacity.clearQueueForShutdown();
	state.resetForShutdown();
	rmSync(root, { recursive: true, force: true });
});

describe("cancelling a starting launch", () => {
	it("rolls back worktrees and resolves every launch path at the requester-aware boundary", async () => {
		const pi = { sendMessage(): void {} } as unknown as ExtensionAPI;
		const spawnId = "worktr01";
		const spawnSpec: SpawnSpec = {
			kind: "spawn",
			id: spawnId,
			name: "worktree cancellation",
			task: "do not start",
			agentName: "worker",
			harness: "pi",
			agentBody: "",
			context: "new",
			autoExit: true,
			useWorktree: true,
			parentCwd: repo,
			parentSessionFile: join(root, "parent.jsonl"),
			base: join(root, "artifacts"),
			slug: "worktree-cancellation",
		};

		assert.strictEqual(capacity.admitLaunch(spawnSpec).status, "run",
			"worktree spawn claims the only slot");
		const spawnPromise = trackLaunch(runSpawnLaunch(pi, spawnSpec));
		for (let tries = 0; tries < 500 && !existsSync(createdMarker); tries++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.ok(existsSync(createdMarker), "worktree creation reaches its controllable await");
		assert.strictEqual(requestCancel(pi, spawnId, "model").kind, "cancelled-starting",
			"cancelling the parked launch resolves as starting");
		writeFileSync(releaseMarker, "release\n");
		let spawnError: unknown;
		try {
			await spawnPromise;
		} catch (error) {
			spawnError = error;
		} finally {
			capacity.releaseClaim(spawnId);
		}
		assert.ok(spawnError instanceof capacity.CancelLaunch && spawnError.requester === "model",
			"the resumed boundary throws requester-aware CancelLaunch");
		const worktreeDir = join(repo, `.cancel-wt-${spawnSpec.slug}-${spawnId}`);
		assert.ok(!existsSync(worktreeDir), "cancelled starting spawn rolls back the fresh worktree");
		assert.deepStrictEqual([
			state.running.has(spawnId),
			state.ledger.has(spawnId),
			capacity.findPendingLaunch(spawnId),
		], [false, false, undefined],
			"cancelled starting spawn registers no child, ledger entry, or claim");
		const branch = execFileSync("git", ["branch", "--list", `pi/${spawnSpec.slug}-${spawnId}`], {
			cwd: repo,
			encoding: "utf8",
		}).trim();
		assert.strictEqual(branch, "", "worktree rollback removes its fresh branch");

		capacity.clearQueueForShutdown();
		const failureId = "fail0001";
		const failureSpec: SpawnSpec = {
			...spawnSpec,
			id: failureId,
			slug: "failure",
			name: "failing worktree cancellation",
		};
		capacity.admitLaunch(failureSpec);
		const failurePromise = trackLaunch(runSpawnLaunch(pi, failureSpec));
		for (let tries = 0; tries < 500 && !existsSync(failureMarker); tries++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.ok(existsSync(failureMarker), "failing worktree creation reaches its controllable await");
		requestCancel(pi, failureId, "model");
		writeFileSync(releaseFailureMarker, "release\n");
		let failureError: unknown;
		try {
			await failurePromise;
		} catch (error) {
			failureError = error;
		} finally {
			capacity.releaseClaim(failureId);
		}
		assert.ok(failureError instanceof capacity.CancelLaunch && failureError.requester === "model",
			"a tombstone dominates an error from the awaited create step");

		capacity.clearQueueForShutdown();
		rmSync(createdMarker, { force: true });
		rmSync(releaseMarker, { force: true });
		const cleanupId = "clean001";
		const cleanupSpec: SpawnSpec = {
			...spawnSpec,
			id: cleanupId,
			slug: "cleanup-failure",
			name: "cleanup failure cancellation",
		};
		capacity.admitLaunch(cleanupSpec);
		const cleanupPromise = trackLaunch(runSpawnLaunch(pi, cleanupSpec));
		for (let tries = 0; tries < 500 && !existsSync(createdMarker); tries++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		requestCancel(pi, cleanupId, "user");
		writeFileSync(releaseMarker, "release\n");
		let cleanupError: unknown;
		try {
			await cleanupPromise;
		} catch (error) {
			cleanupError = error;
		} finally {
			capacity.releaseClaim(cleanupId);
		}
		assert.ok(
			cleanupError instanceof capacity.CancelLaunch &&
			cleanupError.cleanupFailure?.includes("intentional cleanup failure") === true &&
			cleanupError.cleanupFailure.includes("remove") === true,
			"cancellation preserves a rollback-failure warning on CancelLaunch");
		const leakedWorktree = join(repo, `.cancel-wt-${cleanupSpec.slug}-${cleanupId}`);
		assert.ok(existsSync(leakedWorktree), "the warning corresponds to the worktree left by failed cleanup");
		execFileSync("git", ["worktree", "remove", "--force", leakedWorktree], { cwd: repo });
		execFileSync("git", ["branch", "-D", `pi/${cleanupSpec.slug}-${cleanupId}`], { cwd: repo, stdio: "ignore" });

		capacity.clearQueueForShutdown();
		const resumeId = "resume01";
		const sessionPath = join(repo, "resume.jsonl");
		seedNewSession({
			parentSessionFile: join(root, "parent.jsonl"),
			childSessionFile: sessionPath,
			childCwd: repo,
			name: "resume fixture",
		});
		const originalSession = readFileSync(sessionPath, "utf8");
		const resumeSpec: ResumeSpec = {
			kind: "resume",
			id: resumeId,
			sessionPath,
			name: "resume cancellation",
			agent: "worker",
			harness: "pi",
			autoExit: true,
			message: "continue",
			context: "new",
			cwd: repo,
			cwdFromWorktree: false,
			base: join(root, "artifacts"),
			slug: "resume-cancellation",
			expectsRun: true,
		};
		capacity.admitLaunch(resumeSpec);
		capacity.recordCancellation(resumeId, "user");
		const resumePromise = trackLaunch(runResumeLaunch(pi, resumeSpec));
		let resumeError: unknown;
		try {
			await resumePromise;
		} catch (error) {
			resumeError = error;
		} finally {
			capacity.releaseClaim(resumeId);
		}
		assert.ok(resumeError instanceof capacity.CancelLaunch && resumeError.requester === "user",
			"cancelled resume reaches the same requester-aware boundary");
		assert.strictEqual(readFileSync(sessionPath, "utf8"), originalSession,
			"cancelled resume preserves the earlier session file byte-for-byte");
		assert.deepStrictEqual([state.running.has(resumeId), state.ledger.has(resumeId)], [false, false],
			"cancelled resume registers no new run");
	});
});
