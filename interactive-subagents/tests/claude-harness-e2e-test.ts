// End-to-end test with a stand-in tool on PATH: a bash script named `claude`
// parses `--settings`, invokes claude-hook.mjs with fixture payloads exactly
// as the real tool would (prompt-start, tool-start/end, turn-complete
// carrying a final message), then exits. The launch and resume commands are
// the REAL profile-built ones, run through bash like a pane would run them,
// and the assertions read the sidecars through the same readers the
// supervisor uses - the whole launch-to-result lifecycle, no login required.
import { readActivityFile } from "../activity.ts";
import { claudeCodeProfile, readExternalResult, readExternalSessionId } from "../harnesses.ts";
import { SENTINEL_REGEX } from "../protocol.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const dir = mkdtempSync(join(tmpdir(), "subagents-e2e-"));
const binDir = join(dir, "bin");
const workDir = join(dir, "work");
const anchor = join(dir, "child.jsonl");
const argsFile = join(dir, "claude-args");
const RUN_ID = "a55ba067";
const SESSION_ID = "sess-e2e-1234";
const FINAL = "The default branch is main.";
const RESUMED = "Confirmed again: main.";

execFileSync("mkdir", ["-p", binDir, workDir]);

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

const env = {
	...process.env,
	PATH: `${binDir}:${process.env.PATH}`,
	FAKE_CLAUDE_ARGS: argsFile,
	FAKE_SESSION_ID: SESSION_ID,
	FAKE_FINAL_MESSAGE_JSON: JSON.stringify(FINAL),
};

/** Stage and run a command the way a pane would: `bash <script>`. */
function runInPane(command: string, scriptName: string): string {
	const scriptPath = join(dir, scriptName);
	writeFileSync(scriptPath, "#!/bin/bash\n" + command + "\n", { mode: 0o755 });
	return execFileSync("bash", [scriptPath], { encoding: "utf8", env });
}

function recordedArgs(): string[] {
	return readFileSync(argsFile, "utf8").split("\0").slice(0, -1);
}

// ── launch ───────────────────────────────────────────────────────────────

const TASK = "# Your task\n\nState this repository's default branch.\n\n---\nComplete your task autonomously.";
const taskFile = join(dir, "task.md");
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
const launchOutput = runInPane(launch, "launch.sh");

const sentinel = launchOutput.match(SENTINEL_REGEX);
ok("sentinel appears in the pane output", sentinel !== null);
eq("sentinel reports exit 0", sentinel?.[1], "0");

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

// ── resume ───────────────────────────────────────────────────────────────
// Simulate what tool-resume.ts does between runs: consume the marker, clear
// the stale result and activity, keep harness.json (it holds the resume id).

rmSync(`${anchor}.exit`, { force: true });
rmSync(`${anchor}.result`, { force: true });
rmSync(`${anchor}.activity`, { force: true });

const messageFile = join(dir, "resume-msg.md");
writeFileSync(messageFile, "Please confirm once more.", "utf8");
env.FAKE_FINAL_MESSAGE_JSON = JSON.stringify(RESUMED);
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
const resumeOutput = runInPane(resume, "resume.sh");

ok("resume output carries the sentinel", SENTINEL_REGEX.test(resumeOutput));
const resumeArgs = recordedArgs();
eq("resume reopens the recorded session", resumeArgs.slice(0, 2), ["--resume", SESSION_ID]);
eq("the follow-up message arrives as the final argument", resumeArgs[resumeArgs.length - 1], "Please confirm once more.");
const resumeActivity = readActivityFile(`${anchor}.activity`, RESUME_RUN_ID);
eq("resumed run owns a fresh snapshot", resumeActivity.kind, "valid");
eq("resumed result overwrites the old one", readExternalResult(anchor), RESUMED);
ok("resumed autonomous run writes the marker again", existsSync(`${anchor}.exit`));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
