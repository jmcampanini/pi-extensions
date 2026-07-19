// Unit tests for launch.ts — the single place child launch commands are built.
// The exact command bytes matter: the E2E suite greps launch scripts for
// `--model '...'` / `--thinking '...'`, and the sentinel suffix must match
// protocol.ts's SENTINEL_REGEX.
import {
	buildChildEnv,
	buildLaunchCommand,
	type LaunchMeta,
	readLaunchMeta,
	slugify,
	writeLaunchMeta,
} from "../launch.ts";
import { SENTINEL_ECHO_SUFFIX, SENTINEL_REGEX } from "../protocol.ts";
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
function throws(label: string, fn: () => unknown, contains: string) {
	try { fn(); fail++; console.log(`  FAIL ${label}: expected throw`); }
	catch (error) {
		if (String(error).includes(contains)) { pass++; console.log(`  ok  ${label}`); }
		else { fail++; console.log(`  FAIL ${label}: ${String(error)}`); }
	}
}

// PI_CODING_AGENT_DIR must not leak into the env-prefix assertions below.
delete process.env.PI_CODING_AGENT_DIR;

// ── buildChildEnv ────────────────────────────────────────────────────────

eq(
	"env prefix, auto-exit on",
	buildChildEnv({
		PI_SUBAGENT_SESSION: "/tmp/s.jsonl",
		PI_SUBAGENT_NAME: "Worker",
		PI_SUBAGENT_ID: "a55ba067",
		PI_SUBAGENT_ACTIVITY_FILE: "/tmp/s.jsonl.activity",
		PI_SUBAGENT_AUTO_EXIT: "1",
	}),
	"PI_SUBAGENT_SESSION='/tmp/s.jsonl' PI_SUBAGENT_NAME='Worker' PI_SUBAGENT_ID='a55ba067' PI_SUBAGENT_ACTIVITY_FILE='/tmp/s.jsonl.activity' PI_SUBAGENT_AUTO_EXIT='1'",
);
eq(
	"env prefix, interactive (no auto-exit var at all)",
	buildChildEnv({
		PI_SUBAGENT_SESSION: "/tmp/s.jsonl",
		PI_SUBAGENT_NAME: "It's me",
		PI_SUBAGENT_ID: "a55ba067",
		PI_SUBAGENT_ACTIVITY_FILE: "/tmp/s.jsonl.activity",
		PI_SUBAGENT_AUTO_EXIT: undefined,
	}),
	"PI_SUBAGENT_SESSION='/tmp/s.jsonl' PI_SUBAGENT_NAME='It'\\''s me' PI_SUBAGENT_ID='a55ba067' PI_SUBAGENT_ACTIVITY_FILE='/tmp/s.jsonl.activity'",
);

process.env.PI_CODING_AGENT_DIR = "/custom/root";
ok(
	"custom config root is propagated first",
	buildChildEnv({
		PI_SUBAGENT_SESSION: "/s",
		PI_SUBAGENT_NAME: "n",
		PI_SUBAGENT_ID: "a55ba067",
		PI_SUBAGENT_ACTIVITY_FILE: "/s.activity",
	}).startsWith("PI_CODING_AGENT_DIR='/custom/root' "),
);
delete process.env.PI_CODING_AGENT_DIR;
throws("child env rejects an invalid agent identifier", () => buildChildEnv({
	PI_SUBAGENT_SESSION: "/s",
	PI_SUBAGENT_NAME: "n",
	PI_SUBAGENT_ID: "a55ba067",
	PI_SUBAGENT_ACTIVITY_FILE: "/s.activity",
	PI_SUBAGENT_AGENT: "code reviewer",
}), "whitespace");

// ── buildLaunchCommand ───────────────────────────────────────────────────

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
ok("cd comes first", full.startsWith("cd '/work/dir' && PI_SUBAGENT_SESSION="));
ok("has --session", full.includes("pi --session '/s.jsonl'"));
ok("has -e implant.ts", full.includes("-e '") && full.includes("implant.ts'"));
ok("has --model (e2e greps this)", full.includes("--model 'openai-codex/gpt-5.5'"));
ok("has --thinking (e2e greps this)", full.includes("--thinking 'low'"));
ok("has --append-system-prompt", full.includes("--append-system-prompt '/sp.md'"));
ok("control tools are unioned into --tools", full.includes("--tools 'read,bash,subagent_done,caller_ping'"));
ok("prompt arg before sentinel", full.includes("'@/task.md' ; echo"));
ok("ends with the sentinel suffix", full.endsWith(SENTINEL_ECHO_SUFFIX));
ok("typed command does NOT match the poller regex (quote-split)", !SENTINEL_REGEX.test(full));

// harness-pass-through applies to pi children too: appended VERBATIM (no
// quoting) between the named flags and the prompt argument.
const withPassThrough = buildLaunchCommand({
	cwd: null,
	env: "E='1'",
	sessionFile: "/s.jsonl",
	tools: "read",
	passThrough: "--no-color --foo 'bar baz'",
	promptArg: "'@/task.md'",
});
ok(
	"pass-through sits verbatim before the prompt arg",
	withPassThrough.includes("--tools 'read,subagent_done,caller_ping' --no-color --foo 'bar baz' '@/task.md'"),
);

const minimal = buildLaunchCommand({
	cwd: null,
	env: "E='1'",
	sessionFile: "/s.jsonl",
	promptArg: "",
});
eq(
	"minimal resume: no cd, no flags, no prompt",
	minimal,
	"E='1' pi --session '/s.jsonl' -e '" + full.split("-e '")[1].split("'")[0] + "'" + SENTINEL_ECHO_SUFFIX,
);

// ── .meta round trip ─────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), "subagents-launch-"));
const sessionFile = join(dir, "child.jsonl");
const meta: LaunchMeta = { name: "Worker", agent: "worker", tools: "read", model: "p/m", thinking: "low", systemPromptFile: "/sp.md", autoExit: true, context: "forked" };
writeLaunchMeta(sessionFile, meta);
eq("meta round-trips", readLaunchMeta(sessionFile), meta);
eq("missing meta = {}", readLaunchMeta(join(dir, "nope.jsonl")), {});
writeFileSync(`${sessionFile}.meta`, "{corrupt", "utf8");
eq("corrupt meta = {}", readLaunchMeta(sessionFile), {});
const invalidSession = join(dir, "invalid.jsonl");
throws("invalid metadata is rejected before writing", () => writeLaunchMeta(invalidSession, {
	name: "Invalid",
	agent: "code reviewer",
}), "whitespace");
eq("invalid metadata write creates no sidecar", existsSync(`${invalidSession}.meta`), false);
writeFileSync(`${invalidSession}.meta`, JSON.stringify({ name: "Invalid", agent: "code reviewer" }), "utf8");
throws("tampered metadata agent is rejected on read", () => readLaunchMeta(invalidSession), "whitespace");

// External children extend the meta with harness identity and the cwd (they
// have no session header to read the directory back from on resume).
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
eq("external meta round-trips", readLaunchMeta(sessionFile), externalMeta);

// ── slugify ──────────────────────────────────────────────────────────────

eq("slugify basics", slugify("Auth Flow: part 2!"), "auth-flow-part-2");
eq("slugify empty falls back", slugify("™™™"), "subagent");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
