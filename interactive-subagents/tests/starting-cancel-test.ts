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

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown): void {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}: got ${g}, want ${w}`); }
}
function ok(label: string, condition: boolean): void {
	if (condition) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}`); }
}

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

eq("worktree spawn claims the only slot", capacity.admitLaunch(spawnSpec).status, "run");
const spawnPromise = runSpawnLaunch(pi, spawnSpec);
for (let tries = 0; tries < 500 && !existsSync(createdMarker); tries++) {
	await new Promise((resolve) => setTimeout(resolve, 10));
}
ok("worktree creation reaches its controllable await", existsSync(createdMarker));
eq("cancelling the parked launch resolves as starting",
	requestCancel(pi, spawnId, "model").kind, "cancelled-starting");
writeFileSync(releaseMarker, "release\n");
let spawnError: unknown;
try {
	await spawnPromise;
} catch (error) {
	spawnError = error;
} finally {
	capacity.releaseClaim(spawnId);
}
ok("the resumed boundary throws requester-aware CancelLaunch",
	spawnError instanceof capacity.CancelLaunch && spawnError.requester === "model");
const worktreeDir = join(repo, `.cancel-wt-${spawnSpec.slug}-${spawnId}`);
ok("cancelled starting spawn rolls back the fresh worktree", !existsSync(worktreeDir));
eq("cancelled starting spawn registers no child, ledger entry, or claim", [
	state.running.has(spawnId),
	state.ledger.has(spawnId),
	capacity.findPendingLaunch(spawnId),
], [false, false, undefined]);
const branch = execFileSync("git", ["branch", "--list", `pi/${spawnSpec.slug}-${spawnId}`], {
	cwd: repo,
	encoding: "utf8",
}).trim();
eq("worktree rollback removes its fresh branch", branch, "");

capacity.clearQueueForShutdown();
const failureId = "fail0001";
const failureSpec: SpawnSpec = {
	...spawnSpec,
	id: failureId,
	slug: "failure",
	name: "failing worktree cancellation",
};
capacity.admitLaunch(failureSpec);
const failurePromise = runSpawnLaunch(pi, failureSpec);
for (let tries = 0; tries < 500 && !existsSync(failureMarker); tries++) {
	await new Promise((resolve) => setTimeout(resolve, 10));
}
ok("failing worktree creation reaches its controllable await", existsSync(failureMarker));
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
ok("a tombstone dominates an error from the awaited create step",
	failureError instanceof capacity.CancelLaunch && failureError.requester === "model");

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
const cleanupPromise = runSpawnLaunch(pi, cleanupSpec);
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
ok("cancellation preserves a rollback-failure warning on CancelLaunch",
	cleanupError instanceof capacity.CancelLaunch &&
	cleanupError.cleanupFailure?.includes("intentional cleanup failure") === true &&
	cleanupError.cleanupFailure.includes("remove") === true);
const leakedWorktree = join(repo, `.cancel-wt-${cleanupSpec.slug}-${cleanupId}`);
ok("the warning corresponds to the worktree left by failed cleanup", existsSync(leakedWorktree));
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
let resumeError: unknown;
try {
	await runResumeLaunch(pi, resumeSpec);
} catch (error) {
	resumeError = error;
} finally {
	capacity.releaseClaim(resumeId);
}
ok("cancelled resume reaches the same requester-aware boundary",
	resumeError instanceof capacity.CancelLaunch && resumeError.requester === "user");
eq("cancelled resume preserves the earlier session file byte-for-byte",
	readFileSync(sessionPath, "utf8"), originalSession);
eq("cancelled resume registers no new run", [state.running.has(resumeId), state.ledger.has(resumeId)], [false, false]);

capacity.clearQueueForShutdown();
state.resetForShutdown();
rmSync(root, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
