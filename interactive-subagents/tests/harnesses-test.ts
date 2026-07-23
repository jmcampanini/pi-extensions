// Unit tests for harnesses.ts — the external-tool profile seam. The exact
// command bytes matter: the pane runs them verbatim.
import {
	CLAUDE_HOOK_PATH,
	claudeCodeProfile,
	claudeLifecycleSettings,
	clearExternalResult,
	externalHarnessNames,
	externalResultPath,
	externalSessionIdPath,
	harnessProfile,
	isExternalHarness,
	readExternalResult,
	readExternalSessionId,
	requireHarnessProfile,
	validHarnessValues,
} from "../harnesses.ts";
import { shellQuote } from "../tmux.ts";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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
function throws(label: string, fn: () => void, includes: string) {
	try {
		fn();
		fail++; console.log(`  FAIL ${label}: did not throw`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes(includes)) { pass++; console.log(`  ok  ${label}`); }
		else { fail++; console.log(`  FAIL ${label}: message ${JSON.stringify(message)} lacks ${JSON.stringify(includes)}`); }
	}
}

// ── the registry ─────────────────────────────────────────────────────────

eq("claude-code is the only registered profile", externalHarnessNames(), ["claude-code"]);
eq("valid harness values include pi", validHarnessValues(), ["pi", "claude-code"]);
eq("pi is not an external harness", isExternalHarness("pi"), false);
eq("claude-code is an external harness", isExternalHarness("claude-code"), true);
ok("lookup finds the profile", harnessProfile("claude-code") === claudeCodeProfile);
ok("lookup misses unknown names", harnessProfile("codex") === undefined);
throws("require fails loud on unknown names", () => requireHarnessProfile("codex"), 'Unknown harness "codex"');

// ── the effort mapping ───────────────────────────────────────────────────
// Verified against Claude Code 2.1.214: --effort accepts exactly low,
// medium, high, xhigh, max, and only WARNS on anything else — so the
// profile must reject unmappable values itself.

eq("minimal maps down to low", claudeCodeProfile.mapEffort("minimal"), "low");
eq("low passes through", claudeCodeProfile.mapEffort("low"), "low");
eq("medium passes through", claudeCodeProfile.mapEffort("medium"), "medium");
eq("high passes through", claudeCodeProfile.mapEffort("high"), "high");
eq("xhigh passes through", claudeCodeProfile.mapEffort("xhigh"), "xhigh");
eq("max passes through", claudeCodeProfile.mapEffort("max"), "max");
throws("off is unmappable", () => claudeCodeProfile.mapEffort("off"), 'Thinking level "off" has no claude-code effort mapping');
throws("unknown levels are unmappable", () => claudeCodeProfile.mapEffort("ultra"), "mappable levels: minimal, low, medium, high, xhigh, max");

// ── the tools mapping ────────────────────────────────────────────────────

eq("tools pass through trimmed", claudeCodeProfile.mapTools("  Read,Edit,Bash  "), "Read,Edit,Bash");

// ── the completion instructions ──────────────────────────────────────────

const auto = claudeCodeProfile.completionInstruction(true);
const human = claudeCodeProfile.completionInstruction(false);
ok("autonomous instruction promises auto-close", auto.includes("closes automatically"));
ok("human instruction explains close-to-end", human.includes("ends when they close it"));
for (const [label, text] of [["autonomous", auto], ["human", human]] as const) {
	ok(`${label} instruction never names pi control tools`, !text.includes("subagent_done") && !text.includes("caller_ping"));
}

// ── the lifecycle settings JSON ──────────────────────────────────────────

const ANCHOR = "/tmp/anchor's.jsonl";
const RUN_ID = "a55ba067";
const hookCmd = (event: string, extra = "") =>
	`node ${shellQuote(CLAUDE_HOOK_PATH)} ${event} ${shellQuote(ANCHOR)} ${shellQuote(RUN_ID)}${extra}`;
const expectedSettings = (autoExit: boolean) =>
	JSON.stringify({
		hooks: {
			SessionStart: [{ hooks: [{ type: "command", command: hookCmd("session-start") }] }],
			UserPromptSubmit: [{ hooks: [{ type: "command", command: hookCmd("prompt-start") }] }],
			PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hookCmd("tool-start") }] }],
			PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hookCmd("tool-end") }] }],
			Stop: [{ hooks: [{ type: "command", command: hookCmd("turn-complete", autoExit ? " --auto-exit" : "") }] }],
		},
	});
eq("settings JSON, autonomous", claudeLifecycleSettings(ANCHOR, RUN_ID, true), expectedSettings(true));
eq("settings JSON, human-driven omits --auto-exit", claudeLifecycleSettings(ANCHOR, RUN_ID, false), expectedSettings(false));

// ── the launch command, byte-exact ───────────────────────────────────────

const full = claudeCodeProfile.buildLaunchCommand({
	cwd: "/work/dir",
	anchor: ANCHOR,
	runId: RUN_ID,
	autoExit: true,
	model: "claude-haiku-4-5",
	thinking: "minimal",
	tools: "Read,Bash",
	systemPromptFile: "/sp.md",
	passThrough: "--permission-mode acceptEdits",
	taskFile: "/task.md",
});
eq(
	"full launch command",
	full,
	"cd '/work/dir' && " +
		`claude --settings ${shellQuote(expectedSettings(true))} ` +
		"--model 'claude-haiku-4-5' --effort 'low' --allowedTools 'Read,Bash' " +
		"--append-system-prompt-file '/sp.md' " +
		"--permission-mode acceptEdits " +
		`"$(cat '/task.md')"`,
);

const minimalLaunch = claudeCodeProfile.buildLaunchCommand({
	cwd: "/w",
	anchor: ANCHOR,
	runId: RUN_ID,
	autoExit: false,
	taskFile: "/t.md",
});
eq(
	"minimal launch: settings and task only",
	minimalLaunch,
	`cd '/w' && claude --settings ${shellQuote(expectedSettings(false))} "$(cat '/t.md')"`,
);
throws("launch without a task file fails loud", () =>
	claudeCodeProfile.buildLaunchCommand({ cwd: "/w", anchor: ANCHOR, runId: RUN_ID, autoExit: true }), "needs a task file");
throws("launch validates the effort mapping itself", () =>
	claudeCodeProfile.buildLaunchCommand({
		cwd: "/w", anchor: ANCHOR, runId: RUN_ID, autoExit: true, thinking: "off", taskFile: "/t.md",
	}), "no claude-code effort mapping");

// ── the resume command, byte-exact ───────────────────────────────────────

const resume = claudeCodeProfile.buildResumeCommand({
	cwd: "/work/dir",
	anchor: ANCHOR,
	runId: RUN_ID,
	autoExit: true,
	model: "claude-haiku-4-5",
	tools: "Read,Bash",
	systemPromptFile: "/sp.md",
	passThrough: "--permission-mode acceptEdits",
	messageFile: "/msg.md",
	resumeSessionId: "sess-1234",
});
eq(
	"full resume command",
	resume,
	"cd '/work/dir' && claude --resume 'sess-1234' " +
		`--settings ${shellQuote(expectedSettings(true))} ` +
		"--model 'claude-haiku-4-5' --allowedTools 'Read,Bash' " +
		"--append-system-prompt-file '/sp.md' " +
		"--permission-mode acceptEdits " +
		`"$(cat '/msg.md')"`,
);

const humanResume = claudeCodeProfile.buildResumeCommand({
	cwd: "/w",
	anchor: ANCHOR,
	runId: RUN_ID,
	autoExit: false,
	resumeSessionId: "sess-1234",
});
eq(
	"message-free human resume: no trailing prompt",
	humanResume,
	`cd '/w' && claude --resume 'sess-1234' --settings ${shellQuote(expectedSettings(false))}`,
);
throws("resume without a session id fails loud", () =>
	claudeCodeProfile.buildResumeCommand({ cwd: "/w", anchor: ANCHOR, runId: RUN_ID, autoExit: true }), "needs the recorded session id");

// ── the external sidecar readers ─────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), "subagents-harness-"));
const anchor = join(dir, "child.jsonl");
eq("result path convention", externalResultPath(anchor), `${anchor}.result`);
eq("session-id path convention", externalSessionIdPath(anchor), `${anchor}.harness.json`);

eq("missing result reads null", readExternalResult(anchor), null);
writeFileSync(externalResultPath(anchor), "   \n", "utf8");
eq("blank result reads null", readExternalResult(anchor), null);
writeFileSync(externalResultPath(anchor), "The default branch is main.\n\nVerified.", "utf8");
eq("result reads verbatim", readExternalResult(anchor), "The default branch is main.\n\nVerified.");
clearExternalResult(anchor);
ok("clear removes the result file", !existsSync(externalResultPath(anchor)));
clearExternalResult(anchor); // idempotent on a missing file

eq("missing session id reads null", readExternalSessionId(anchor), null);
writeFileSync(externalSessionIdPath(anchor), "{corrupt", "utf8");
eq("corrupt session id reads null", readExternalSessionId(anchor), null);
writeFileSync(externalSessionIdPath(anchor), JSON.stringify({ sessionId: "" }), "utf8");
eq("empty session id reads null", readExternalSessionId(anchor), null);
writeFileSync(externalSessionIdPath(anchor), JSON.stringify({ sessionId: "sess-1234" }), "utf8");
eq("session id round-trips", readExternalSessionId(anchor), "sess-1234");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
