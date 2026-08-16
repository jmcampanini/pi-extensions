// Unit tests for launch.ts — the single place child launch commands are built.
// The exact command bytes matter: the E2E suite greps launch scripts for
// `--model '...'` / `--thinking '...'`.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildChildEnv,
	buildLaunchCommand,
	type LaunchMeta,
	readLaunchMeta,
	slugify,
	writeLaunchMeta,
} from "../launch.ts";
import { stageLaunchScript, supportsRequiredTmuxVersion } from "../tmux.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// PI_CODING_AGENT_DIR must not leak into the env-prefix assertions below.
delete process.env.PI_CODING_AGENT_DIR;

const dir = mkdtempSync(join(tmpdir(), "subagents-launch-"));

after(() => {
	rmSync(dir, { recursive: true, force: true });
});

function stringIncludes(contains: string): (error: unknown) => boolean {
	return (error) => String(error).includes(contains);
}

describe("buildChildEnv", () => {
	it("env prefix, auto-exit on", () => {
		assert.strictEqual(
			buildChildEnv({
				PI_SUBAGENT_SESSION: "/tmp/s.jsonl",
				PI_SUBAGENT_NAME: "Worker",
				PI_SUBAGENT_ID: "a55ba067",
				PI_SUBAGENT_ACTIVITY_FILE: "/tmp/s.jsonl.activity",
				PI_SUBAGENT_AUTO_EXIT: "1",
			}),
			"PI_SUBAGENT_SESSION='/tmp/s.jsonl' PI_SUBAGENT_NAME='Worker' PI_SUBAGENT_ID='a55ba067' PI_SUBAGENT_ACTIVITY_FILE='/tmp/s.jsonl.activity' PI_SUBAGENT_AUTO_EXIT='1'",
		);
	});

	it("env prefix, interactive (no auto-exit var at all)", () => {
		assert.strictEqual(
			buildChildEnv({
				PI_SUBAGENT_SESSION: "/tmp/s.jsonl",
				PI_SUBAGENT_NAME: "It's me",
				PI_SUBAGENT_ID: "a55ba067",
				PI_SUBAGENT_ACTIVITY_FILE: "/tmp/s.jsonl.activity",
				PI_SUBAGENT_AUTO_EXIT: undefined,
			}),
			"PI_SUBAGENT_SESSION='/tmp/s.jsonl' PI_SUBAGENT_NAME='It'\\''s me' PI_SUBAGENT_ID='a55ba067' PI_SUBAGENT_ACTIVITY_FILE='/tmp/s.jsonl.activity'",
		);
	});

	it("custom config root is propagated first", () => {
		process.env.PI_CODING_AGENT_DIR = "/custom/root";
		try {
			assert.ok(
				buildChildEnv({
					PI_SUBAGENT_SESSION: "/s",
					PI_SUBAGENT_NAME: "n",
					PI_SUBAGENT_ID: "a55ba067",
					PI_SUBAGENT_ACTIVITY_FILE: "/s.activity",
				}).startsWith("PI_CODING_AGENT_DIR='/custom/root' "),
			);
		} finally {
			delete process.env.PI_CODING_AGENT_DIR;
		}
	});

	it("child env rejects an invalid agent identifier", () => {
		assert.throws(() => buildChildEnv({
			PI_SUBAGENT_SESSION: "/s",
			PI_SUBAGENT_NAME: "n",
			PI_SUBAGENT_ID: "a55ba067",
			PI_SUBAGENT_ACTIVITY_FILE: "/s.activity",
			PI_SUBAGENT_AGENT: "code reviewer",
		}), stringIncludes("whitespace"));
	});
});

const full = buildLaunchCommand({
	cwd: "/work/dir",
	env: "PI_SUBAGENT_SESSION='/s.jsonl' PI_SUBAGENT_NAME='n'",
	sessionFile: "/s.jsonl",
	model: "openai-codex/gpt-5.5",
	thinking: "low",
	systemPromptFile: "/sp.md",
	tools: "read,bash",
	promptArg: "'@/task.md'",
});

describe("buildLaunchCommand", () => {
	it("cd comes first", () => {
		assert.ok(full.startsWith("cd '/work/dir' && PI_SUBAGENT_SESSION="));
	});

	it("has --session", () => {
		assert.ok(full.includes("pi --session '/s.jsonl'"));
	});

	it("has -e implant.ts", () => {
		assert.ok(full.includes("-e '") && full.includes("implant.ts'"));
	});

	it("has --model (e2e greps this)", () => {
		assert.ok(full.includes("--model 'openai-codex/gpt-5.5'"));
	});

	it("has --thinking (e2e greps this)", () => {
		assert.ok(full.includes("--thinking 'low'"));
	});

	it("has --append-system-prompt", () => {
		assert.ok(full.includes("--append-system-prompt '/sp.md'"));
	});

	it("control tools are unioned into --tools", () => {
		assert.ok(full.includes("--tools 'read,bash,subagent_done,caller_ping'"));
	});

	it("prompt arg is last", () => {
		assert.ok(full.endsWith("'@/task.md'"));
	});

	// harness-pass-through applies to pi children too: appended VERBATIM (no
	// quoting) between the named flags and the prompt argument.
	it("pass-through sits verbatim before the prompt arg", () => {
		const withPassThrough = buildLaunchCommand({
			cwd: null,
			env: "E='1'",
			sessionFile: "/s.jsonl",
			tools: "read",
			passThrough: "--no-color --foo 'bar baz'",
			promptArg: "'@/task.md'",
		});
		assert.ok(
			withPassThrough.includes("--tools 'read,subagent_done,caller_ping' --no-color --foo 'bar baz' '@/task.md'"),
		);
	});

	it("minimal resume: no cd, no flags, no prompt", () => {
		const minimal = buildLaunchCommand({
			cwd: null,
			env: "E='1'",
			sessionFile: "/s.jsonl",
			promptArg: "",
		});
		assert.strictEqual(
			minimal,
			"E='1' pi --session '/s.jsonl' -e '" + full.split("-e '")[1].split("'")[0] + "'",
		);
	});
});

describe("supportsRequiredTmuxVersion", () => {
	it("tmux 3.0 lacks per-pane options", () => {
		assert.strictEqual(supportsRequiredTmuxVersion("3.0"), false);
	});

	it("tmux 3.0a is the minimum", () => {
		assert.strictEqual(supportsRequiredTmuxVersion("3.0a"), true);
	});

	it("later tmux minor versions are accepted", () => {
		assert.strictEqual(supportsRequiredTmuxVersion("3.1"), true);
	});

	it("later tmux major versions are accepted", () => {
		assert.strictEqual(supportsRequiredTmuxVersion("4.0"), true);
	});

	it("unrecognized tmux versions are rejected", () => {
		assert.strictEqual(supportsRequiredTmuxVersion("master"), false);
	});
});

describe("stageLaunchScript", () => {
	it("staged script starts with guarded remain-on-exit then the exact command", () => {
		const fakeBinDir = join(dir, "bin");
		const fakeTmux = join(fakeBinDir, "tmux");
		const scriptPath = join(dir, "launch.sh");
		mkdirSync(fakeBinDir);
		writeFileSync(fakeTmux, "#!/bin/bash\nexit 0\n", { mode: 0o755 });
		const savedPath = process.env.PATH;
		try {
			process.env.PATH = `${fakeBinDir}${delimiter}${savedPath ?? ""}`;
			stageLaunchScript(full, scriptPath);
		} finally {
			if (savedPath === undefined) delete process.env.PATH;
			else process.env.PATH = savedPath;
		}
		assert.strictEqual(
			readFileSync(scriptPath, "utf8"),
			`if [ "$PI_SUBAGENT_LAUNCH" = "1" ]; then '${fakeTmux}' set-option -p -t "$TMUX_PANE" remain-on-exit on; fi\n${full}\n`,
		);
	});
});

describe("launch meta round trip", () => {
	const sessionFile = join(dir, "child.jsonl");

	it("meta round-trips", () => {
		const meta: LaunchMeta = { name: "Worker", agent: "worker", tools: "read", model: "p/m", thinking: "low", systemPromptFile: "/sp.md", autoExit: true, context: "forked" };
		writeLaunchMeta(sessionFile, meta);
		assert.deepStrictEqual(readLaunchMeta(sessionFile), meta);
	});

	it("missing meta = {}", () => {
		assert.deepStrictEqual(readLaunchMeta(join(dir, "nope.jsonl")), {});
	});

	it("corrupt meta = {}", () => {
		writeFileSync(`${sessionFile}.meta`, "{corrupt", "utf8");
		assert.deepStrictEqual(readLaunchMeta(sessionFile), {});
	});

	it("invalid metadata is rejected before writing", () => {
		const invalidSession = join(dir, "invalid.jsonl");
		assert.throws(() => writeLaunchMeta(invalidSession, {
			name: "Invalid",
			agent: "code reviewer",
		}), stringIncludes("whitespace"));
		assert.strictEqual(existsSync(`${invalidSession}.meta`), false, "invalid metadata write creates no sidecar");
	});

	it("tampered metadata agent is rejected on read", () => {
		const invalidSession = join(dir, "invalid.jsonl");
		writeFileSync(`${invalidSession}.meta`, JSON.stringify({ name: "Invalid", agent: "code reviewer" }), "utf8");
		assert.throws(() => readLaunchMeta(invalidSession), stringIncludes("whitespace"));
	});

	// External children extend the meta with harness identity and the cwd (they
	// have no session header to read the directory back from on resume).
	it("external meta round-trips", () => {
		const externalMeta: LaunchMeta = {
			name: "Ext",
			agent: "ext",
			model: "claude-haiku-4-5",
			autoExit: true,
			harness: "claude-code",
			harnessPassThrough: "--permission-mode acceptEdits",
			cwd: "/work/dir",
		};
		writeLaunchMeta(sessionFile, externalMeta);
		assert.deepStrictEqual(readLaunchMeta(sessionFile), externalMeta);
	});
});

describe("slugify", () => {
	it("slugify basics", () => {
		assert.strictEqual(slugify("Auth Flow: part 2!"), "auth-flow-part-2");
	});

	it("slugify empty falls back", () => {
		assert.strictEqual(slugify("™™™"), "subagent");
	});
});
