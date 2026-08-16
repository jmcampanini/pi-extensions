// End-to-end test with a stand-in tool on PATH: a bash script named `claude`
// parses `--settings`, invokes claude-hook.mjs with fixture payloads exactly
// as the real tool would (prompt-start, tool-start/end, turn-complete
// carrying a final message), then exits. The launch and resume commands are
// the REAL profile-built ones, run in isolated tmux panes without a login,
// and the assertions read the sidecars through the same readers the
// supervisor uses - the whole launch-to-result lifecycle, no login required.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readActivityFile } from "../activity.ts";
import { claudeCodeProfile, readExternalResult, readExternalSessionId } from "../harnesses.ts";
import { stageLaunchScript } from "../tmux.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

let tmuxAvailable = true;
try {
	execFileSync("tmux", ["-V"], { stdio: "ignore" });
} catch {
	tmuxAvailable = false;
}

describe("claude-code harness end to end", () => {
	if (!tmuxAvailable) {
		it("real profile launch and resume commands drive the full sidecar lifecycle",
			{ skip: "tmux is not installed" }, () => {});
		return;
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

	after(() => {
		try { isolatedTmux(["kill-server"]); } catch {}
		restore("PATH");
		restore("TMUX");
		restore("TMUX_PANE");
		restore("FAKE_CLAUDE_ARGS");
		restore("FAKE_SESSION_ID");
		restore("FAKE_FINAL_MESSAGE_JSON");
		rmSync(root, { recursive: true, force: true });
	});

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
		assert.strictEqual(
			isolatedTmux(["show-options", "-p", "-v", "-t", paneId, "remain-on-exit"]).trim(),
			"on",
			`${label} pane has remain-on-exit enabled`,
		);
		const deadStatus = isolatedTmux(["display-message", "-p", "-t", paneId, "#{pane_dead_status}"]).trim();
		assert.ok(
			deadStatus === "0" || deadStatus === "",
			`${label} pane reports a clean exit when tmux retains its status`,
		);
	}

	function recordedArgs(): string[] {
		return readFileSync(argsFile, "utf8").split("\0").slice(0, -1);
	}

	it("real profile launch and resume commands drive the full sidecar lifecycle", async () => {
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
		assert.ok(launchArgs.includes("--model") && launchArgs.includes("test-model"), "model passed verbatim");
		assert.ok(launchArgs.includes("--effort") && launchArgs.includes("low"), "thinking mapped to --effort low");
		assert.ok(launchArgs.includes("--allowedTools") && launchArgs.includes("Read,Bash"), "allowed tools passed through");
		assert.ok(launchArgs.includes("--fake-flag") && launchArgs.includes("quoted value"), "pass-through flags arrive as real argv");
		assert.strictEqual(launchArgs[launchArgs.length - 1], TASK, "the task text arrives as the final argument");

		const launchActivity = readActivityFile(`${anchor}.activity`, RUN_ID);
		assert.ok(launchActivity.kind === "valid", "activity snapshot is valid and owned");
		assert.strictEqual(launchActivity.snapshot.runsCompleted, 1, "one completed run recorded");
		assert.strictEqual(launchActivity.snapshot.inRun, false, "idle after the turn");
		assert.deepStrictEqual(launchActivity.snapshot.activeTools, [], "no active tools left behind");
		assert.strictEqual(readExternalResult(anchor), FINAL, "result sidecar holds the final message");
		assert.strictEqual(readExternalSessionId(anchor), SESSION_ID, "session-id sidecar holds the tool's session");
		assert.deepStrictEqual(JSON.parse(readFileSync(`${anchor}.exit`, "utf8")), { type: "done" },
			"completion marker written for the autonomous child");

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
		assert.deepStrictEqual(resumeArgs.slice(0, 2), ["--resume", SESSION_ID], "resume reopens the recorded session");
		assert.strictEqual(resumeArgs[resumeArgs.length - 1], "Please confirm once more.",
			"the follow-up message arrives as the final argument");
		const resumeActivity = readActivityFile(`${anchor}.activity`, RESUME_RUN_ID);
		assert.strictEqual(resumeActivity.kind, "valid", "resumed run owns a fresh snapshot");
		assert.strictEqual(readExternalResult(anchor), RESUMED, "resumed result overwrites the old one");
		assert.ok(existsSync(`${anchor}.exit`), "resumed autonomous run writes the marker again");
	});
});
