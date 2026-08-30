// Unit tests for harnesses.ts - the external-tool profile seam. The exact
// command bytes matter: the pane runs them verbatim.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "subagents-harness-"));

after(() => {
	rmSync(dir, { recursive: true, force: true });
});

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

describe("harness registry", () => {
	it("claude-code is the only registered profile", () => {
		assert.deepStrictEqual(externalHarnessNames(), ["claude-code"]);
	});

	it("valid harness values include pi", () => {
		assert.deepStrictEqual(validHarnessValues(), ["pi", "claude-code"]);
	});

	it("pi is not an external harness", () => {
		assert.strictEqual(isExternalHarness("pi"), false);
	});

	it("claude-code is an external harness", () => {
		assert.strictEqual(isExternalHarness("claude-code"), true);
	});

	it("lookup finds the profile", () => {
		assert.ok(harnessProfile("claude-code") === claudeCodeProfile);
	});

	it("lookup misses unknown names", () => {
		assert.ok(harnessProfile("codex") === undefined);
	});

	it("require fails loud on unknown names", () => {
		assert.throws(() => requireHarnessProfile("codex"), /Unknown harness "codex"/);
	});
});

// Verified against Claude Code 2.1.214: --effort accepts exactly low,
// medium, high, xhigh, max, and only WARNS on anything else - so the
// profile must reject unmappable values itself.
describe("claudeCodeProfile.mapEffort", () => {
	it("minimal maps down to low", () => {
		assert.strictEqual(claudeCodeProfile.mapEffort("minimal"), "low");
	});

	it("low passes through", () => {
		assert.strictEqual(claudeCodeProfile.mapEffort("low"), "low");
	});

	it("medium passes through", () => {
		assert.strictEqual(claudeCodeProfile.mapEffort("medium"), "medium");
	});

	it("high passes through", () => {
		assert.strictEqual(claudeCodeProfile.mapEffort("high"), "high");
	});

	it("xhigh passes through", () => {
		assert.strictEqual(claudeCodeProfile.mapEffort("xhigh"), "xhigh");
	});

	it("max passes through", () => {
		assert.strictEqual(claudeCodeProfile.mapEffort("max"), "max");
	});

	it("off is unmappable", () => {
		assert.throws(
			() => claudeCodeProfile.mapEffort("off"),
			/Thinking level "off" has no claude-code effort mapping/,
		);
	});

	it("unknown levels are unmappable", () => {
		assert.throws(
			() => claudeCodeProfile.mapEffort("ultra"),
			/mappable levels: minimal, low, medium, high, xhigh, max/,
		);
	});
});

describe("claudeCodeProfile.mapTools", () => {
	it("tools pass through trimmed", () => {
		assert.strictEqual(claudeCodeProfile.mapTools("  Read,Edit,Bash  "), "Read,Edit,Bash");
	});
});

describe("claudeCodeProfile.completionInstruction", () => {
	const auto = claudeCodeProfile.completionInstruction(true);
	const human = claudeCodeProfile.completionInstruction(false);

	it("autonomous instruction promises auto-close", () => {
		assert.ok(auto.includes("closes automatically"));
	});

	it("human instruction explains close-to-end", () => {
		assert.ok(human.includes("ends when they close it"));
	});

	it("instructions never name pi control tools", () => {
		for (const [label, text] of [["autonomous", auto], ["human", human]] as const) {
			assert.ok(
				!text.includes("subagent_done") && !text.includes("caller_ping"),
				`${label} instruction never names pi control tools`,
			);
		}
	});
});

describe("claudeLifecycleSettings", () => {
	it("settings JSON, autonomous", () => {
		assert.strictEqual(claudeLifecycleSettings(ANCHOR, RUN_ID, true), expectedSettings(true));
	});

	it("settings JSON, human-driven omits --auto-exit", () => {
		assert.strictEqual(claudeLifecycleSettings(ANCHOR, RUN_ID, false), expectedSettings(false));
	});
});

describe("claudeCodeProfile.buildLaunchCommand", () => {
	it("full launch command", () => {
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
		assert.strictEqual(
			full,
			"cd '/work/dir' && " +
				`claude --settings ${shellQuote(expectedSettings(true))} ` +
				"--model 'claude-haiku-4-5' --effort 'low' --allowedTools 'Read,Bash' " +
				"--append-system-prompt-file '/sp.md' " +
				"--permission-mode acceptEdits " +
				`"$(cat '/task.md')"`,
		);
	});

	it("minimal launch: settings and task only", () => {
		const minimalLaunch = claudeCodeProfile.buildLaunchCommand({
			cwd: "/w",
			anchor: ANCHOR,
			runId: RUN_ID,
			autoExit: false,
			taskFile: "/t.md",
		});
		assert.strictEqual(
			minimalLaunch,
			`cd '/w' && claude --settings ${shellQuote(expectedSettings(false))} "$(cat '/t.md')"`,
		);
	});

	it("launch without a task file fails loud", () => {
		assert.throws(
			() => claudeCodeProfile.buildLaunchCommand({ cwd: "/w", anchor: ANCHOR, runId: RUN_ID, autoExit: true }),
			/needs a task file/,
		);
	});

	it("launch validates the effort mapping itself", () => {
		assert.throws(
			() => claudeCodeProfile.buildLaunchCommand({
				cwd: "/w", anchor: ANCHOR, runId: RUN_ID, autoExit: true, thinking: "off", taskFile: "/t.md",
			}),
			/no claude-code effort mapping/,
		);
	});
});

describe("claudeCodeProfile.buildResumeCommand", () => {
	it("full resume command", () => {
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
		assert.strictEqual(
			resume,
			"cd '/work/dir' && claude --resume 'sess-1234' " +
				`--settings ${shellQuote(expectedSettings(true))} ` +
				"--model 'claude-haiku-4-5' --allowedTools 'Read,Bash' " +
				"--append-system-prompt-file '/sp.md' " +
				"--permission-mode acceptEdits " +
				`"$(cat '/msg.md')"`,
		);
	});

	it("message-free human resume: no trailing prompt", () => {
		const humanResume = claudeCodeProfile.buildResumeCommand({
			cwd: "/w",
			anchor: ANCHOR,
			runId: RUN_ID,
			autoExit: false,
			resumeSessionId: "sess-1234",
		});
		assert.strictEqual(
			humanResume,
			`cd '/w' && claude --resume 'sess-1234' --settings ${shellQuote(expectedSettings(false))}`,
		);
	});

	it("resume without a session id fails loud", () => {
		assert.throws(
			() => claudeCodeProfile.buildResumeCommand({ cwd: "/w", anchor: ANCHOR, runId: RUN_ID, autoExit: true }),
			/needs the recorded session id/,
		);
	});
});

describe("external sidecar readers", () => {
	const anchor = join(dir, "child.jsonl");

	it("result path convention", () => {
		assert.strictEqual(externalResultPath(anchor), `${anchor}.result`);
	});

	it("session-id path convention", () => {
		assert.strictEqual(externalSessionIdPath(anchor), `${anchor}.harness.json`);
	});

	it("result sidecar reads verbatim and clears idempotently", () => {
		assert.strictEqual(readExternalResult(anchor), null, "missing result reads null");
		writeFileSync(externalResultPath(anchor), "   \n", "utf8");
		assert.strictEqual(readExternalResult(anchor), null, "blank result reads null");
		writeFileSync(externalResultPath(anchor), "The default branch is main.\n\nVerified.", "utf8");
		assert.strictEqual(readExternalResult(anchor), "The default branch is main.\n\nVerified.", "result reads verbatim");
		clearExternalResult(anchor);
		assert.ok(!existsSync(externalResultPath(anchor)), "clear removes the result file");
		clearExternalResult(anchor); // idempotent on a missing file
	});

	it("session-id sidecar tolerates corruption and round-trips", () => {
		assert.strictEqual(readExternalSessionId(anchor), null, "missing session id reads null");
		writeFileSync(externalSessionIdPath(anchor), "{corrupt", "utf8");
		assert.strictEqual(readExternalSessionId(anchor), null, "corrupt session id reads null");
		writeFileSync(externalSessionIdPath(anchor), JSON.stringify({ sessionId: "" }), "utf8");
		assert.strictEqual(readExternalSessionId(anchor), null, "empty session id reads null");
		writeFileSync(externalSessionIdPath(anchor), JSON.stringify({ sessionId: "sess-1234" }), "utf8");
		assert.strictEqual(readExternalSessionId(anchor), "sess-1234", "session id round-trips");
	});
});
