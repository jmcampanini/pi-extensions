// End-to-end test with a stand-in tool on PATH: a bash script named `claude`
// parses `--settings`, invokes claude-hook.mjs with fixture payloads exactly
// as the real tool would (prompt-start, tool-start/end, turn-complete
// carrying a final message), then exits. The launch and resume commands are
// the REAL profile-built ones, run in isolated tmux panes without a login,
// and the assertions read the sidecars through the same readers the
// supervisor uses - the whole launch-to-result lifecycle, no login required.
import { readActivityFile } from "../activity.ts";
import { claudeCodeProfile, readExternalResult, readExternalSessionId } from "../harnesses.ts";
import { stageLaunchScript } from "../tmux.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

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

try {
	execFileSync("tmux", ["-V"], { stdio: "ignore" });
} catch {
	console.log("  SKIP tmux is not installed");
	console.log("\n0 passed, 0 failed (skipped)");
	process.exit(0);
}

const sandbox = join(process.cwd(), ".sandbox");
mkdirSync(sandbox, { recursive: true });
const root = mkdtempSync(join(sandbox, "claude harness e2e-"));
const binDir = join(root, "bin");
const workDir = join(root, "work");
const anchor = join(root, "child.jsonl");
const argsFile = join(root, "claude-args");
const socketName = `pi-claude-e2e-${process.pid}-${Date.now()}`;
const sessionName = "claude-harness-e2e";
const RUN_ID = "a55ba067";
const SESSION_ID = "sess-e2e-1234";
const FINAL = "The default branch is main.";
const RESUMED = "Confirmed again: main.";

const savedEnv = {
	PATH: process.env.PATH,
	TMUX: process.env.TMUX,
	TMUX_PANE: process.env.TMUX_PANE,
	FAKE_CLAUDE_ARGS: process.env.FAKE_CLAUDE_ARGS,
	FAKE_SESSION_ID: process.env.FAKE_SESSION_ID,
	FAKE_FINAL_MESSAGE_JSON: process.env.FAKE_FINAL_MESSAGE_JSON,
};

function isolatedTmux(args: string[]): string {
	return execFileSync("tmux", ["-L", socketName, "-f", "/dev/null", ...args], { encoding: "utf8" });
}

function restore(name: keyof typeof savedEnv): void {
	const value = savedEnv[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

/** Stage and run a command with the same remain-on-exit guard as a real child pane. */
function runInPane(command: string, scriptName: string): string {
	const scriptPath = join(root, scriptName);
	stageLaunchScript(command, scriptPath);
	return isolatedTmux([
		"new-window",
		"-d",
		"-t",
		sessionName,
		"-P",
		"-F",
		"#{pane_id}",
		"-e",
		"PI_SUBAGENT_LAUNCH=1",
		"-e",
		`FAKE_FINAL_MESSAGE_JSON=${process.env.FAKE_FINAL_MESSAGE_JSON ?? ""}`,
		"--",
		"bash",
		scriptPath,
	]).trim();
}

async function waitForDeadPane(paneId: string): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt++) {
		if (isolatedTmux(["display-message", "-p", "-t", paneId, "#{pane_dead}"]).trim() === "1") return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`pane ${paneId} did not become dead`);
}

async function assertCleanDeadPane(label: string, paneId: string): Promise<void> {
	await waitForDeadPane(paneId);
	eq(
		`${label} pane has remain-on-exit enabled`,
		isolatedTmux(["show-options", "-p", "-v", "-t", paneId, "remain-on-exit"]).trim(),
		"on",
	);
	const deadStatus = isolatedTmux(["display-message", "-p", "-t", paneId, "#{pane_dead_status}"]).trim();
	ok(
		`${label} pane reports a clean exit when tmux retains its status`,
		deadStatus === "0" || deadStatus === "",
	);
}

function recordedArgs(): string[] {
	return readFileSync(argsFile, "utf8").split("\0").slice(0, -1);
}

try {
	mkdirSync(binDir);
	mkdirSync(workDir);

	// The stand-in: records its argv (NUL-separated - task text contains
	// newlines), extracts each notifier command from the --settings JSON, and
	// pipes it the payload the real tool would send at that moment.
	writeFileSync(
		join(binDir, "claude"),
		`#!/bin/bash
printf '%s\\0' "$@" > "$FAKE_CLAUDE_ARGS"
settings=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--settings" ]; then settings="$arg"; fi
  prev="$arg"
done
run_hook() {
  local cmd
  cmd=$(node -e '
    const settings = JSON.parse(process.argv[1]);
    const eventByName = { "session-start": "SessionStart", "prompt-start": "UserPromptSubmit", "tool-start": "PreToolUse", "tool-end": "PostToolUse", "turn-complete": "Stop" };
    process.stdout.write(settings.hooks[eventByName[process.argv[2]]][0].hooks[0].command);
  ' "$settings" "$1")
  printf '%s' "$2" | sh -c "$cmd"
}
run_hook session-start "{\\"session_id\\":\\"$FAKE_SESSION_ID\\",\\"hook_event_name\\":\\"SessionStart\\"}"
run_hook prompt-start "{\\"session_id\\":\\"$FAKE_SESSION_ID\\",\\"hook_event_name\\":\\"UserPromptSubmit\\"}"
run_hook tool-start "{\\"session_id\\":\\"$FAKE_SESSION_ID\\",\\"tool_name\\":\\"Bash\\",\\"tool_use_id\\":\\"tu_1\\"}"
run_hook tool-end "{\\"session_id\\":\\"$FAKE_SESSION_ID\\",\\"tool_name\\":\\"Bash\\",\\"tool_use_id\\":\\"tu_1\\"}"
run_hook turn-complete "{\\"session_id\\":\\"$FAKE_SESSION_ID\\",\\"last_assistant_message\\":$FAKE_FINAL_MESSAGE_JSON}"
exit 0
`,
		{ mode: 0o755 },
	);

	process.env.PATH = `${binDir}${delimiter}${savedEnv.PATH ?? ""}`;
	process.env.FAKE_CLAUDE_ARGS = argsFile;
	process.env.FAKE_SESSION_ID = SESSION_ID;
	process.env.FAKE_FINAL_MESSAGE_JSON = JSON.stringify(FINAL);
	delete process.env.TMUX;
	delete process.env.TMUX_PANE;

	isolatedTmux([
		"new-session",
		"-d",
		"-s",
		sessionName,
		"-P",
		"-F",
		"#{pane_id}",
		"--",
		"bash",
		"-c",
		"while :; do sleep 60; done",
	]);

	// ── launch ───────────────────────────────────────────────────────────

	const TASK = "# Your task\n\nState this repository's default branch.\n\n---\nComplete your task autonomously.";
	const taskFile = join(root, "task.md");
	writeFileSync(taskFile, TASK, "utf8");

	const launch = claudeCodeProfile.buildLaunchCommand({
		cwd: workDir,
		anchor,
		runId: RUN_ID,
		autoExit: true,
		model: "test-model",
		thinking: "minimal",
		tools: "Read,Bash",
		passThrough: "--fake-flag 'quoted value'",
		taskFile,
	});
	const launchPane = runInPane(launch, "launch.sh");
	await assertCleanDeadPane("launch", launchPane);

	const launchArgs = recordedArgs();
	ok("model passed verbatim", launchArgs.includes("--model") && launchArgs.includes("test-model"));
	ok("thinking mapped to --effort low", launchArgs.includes("--effort") && launchArgs.includes("low"));
	ok("allowed tools passed through", launchArgs.includes("--allowedTools") && launchArgs.includes("Read,Bash"));
	ok("pass-through flags arrive as real argv", launchArgs.includes("--fake-flag") && launchArgs.includes("quoted value"));
	eq("the task text arrives as the final argument", launchArgs[launchArgs.length - 1], TASK);

	const launchActivity = readActivityFile(`${anchor}.activity`, RUN_ID);
	eq("activity snapshot is valid and owned", launchActivity.kind, "valid");
	if (launchActivity.kind === "valid") {
		eq("one completed run recorded", launchActivity.snapshot.runsCompleted, 1);
		eq("idle after the turn", launchActivity.snapshot.inRun, false);
		eq("no active tools left behind", launchActivity.snapshot.activeTools, []);
	}
	eq("result sidecar holds the final message", readExternalResult(anchor), FINAL);
	eq("session-id sidecar holds the tool's session", readExternalSessionId(anchor), SESSION_ID);
	eq("completion marker written for the autonomous child", JSON.parse(readFileSync(`${anchor}.exit`, "utf8")), { type: "done" });

	// ── resume ───────────────────────────────────────────────────────────
	// Simulate what tool-resume.ts does between runs: consume the marker, clear
	// the stale result and activity, keep harness.json (it holds the resume id).

	rmSync(`${anchor}.exit`, { force: true });
	rmSync(`${anchor}.result`, { force: true });
	rmSync(`${anchor}.activity`, { force: true });

	const messageFile = join(root, "resume-msg.md");
	writeFileSync(messageFile, "Please confirm once more.", "utf8");
	process.env.FAKE_FINAL_MESSAGE_JSON = JSON.stringify(RESUMED);
	const RESUME_RUN_ID = "b66cb178";
	const resume = claudeCodeProfile.buildResumeCommand({
		cwd: workDir,
		anchor,
		runId: RESUME_RUN_ID,
		autoExit: true,
		model: "test-model",
		tools: "Read,Bash",
		messageFile,
		resumeSessionId: readExternalSessionId(anchor)!,
	});
	const resumePane = runInPane(resume, "resume.sh");
	await assertCleanDeadPane("resume", resumePane);

	const resumeArgs = recordedArgs();
	eq("resume reopens the recorded session", resumeArgs.slice(0, 2), ["--resume", SESSION_ID]);
	eq("the follow-up message arrives as the final argument", resumeArgs[resumeArgs.length - 1], "Please confirm once more.");
	const resumeActivity = readActivityFile(`${anchor}.activity`, RESUME_RUN_ID);
	eq("resumed run owns a fresh snapshot", resumeActivity.kind, "valid");
	eq("resumed result overwrites the old one", readExternalResult(anchor), RESUMED);
	ok("resumed autonomous run writes the marker again", existsSync(`${anchor}.exit`));
} catch (error) {
	fail++;
	console.log(`  FAIL claude harness e2e setup: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
	try { isolatedTmux(["kill-server"]); } catch {}
	restore("PATH");
	restore("TMUX");
	restore("TMUX_PANE");
	restore("FAKE_CLAUDE_ARGS");
	restore("FAKE_SESSION_ID");
	restore("FAKE_FINAL_MESSAGE_JSON");
	rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
