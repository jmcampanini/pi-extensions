import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join, relative } from "node:path";

async function thrownMessage(run: () => Promise<unknown>): Promise<string> {
	try {
		await run();
		return "(did not throw)";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

function treeEntries(root: string): string[] {
	const entries: string[] = [];
	function visit(dir: string): void {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			entries.push(`${entry.isDirectory() ? "d" : "f"}:${relative(root, path)}`);
			if (entry.isDirectory()) visit(path);
		}
	}
	visit(root);
	return entries.sort();
}

const sandboxRoot = join(process.cwd(), ".sandbox");
mkdirSync(sandboxRoot, { recursive: true });
const root = mkdtempSync(join(sandboxRoot, "spawn-guard-test-"));
const configDir = join(root, "config");
const defsDir = join(configDir, "subagents");
const binDir = join(root, "bin");
const workDir = join(root, "work");
const sessionDir = join(root, "parent-sessions");
const parentSessionFile = join(sessionDir, "parent.jsonl");
const missingParentSessionFile = join(sessionDir, "not-written.jsonl");
const tmuxLog = join(root, "tmux-argv.log");
const worktreeProbe = join(root, "worktree-created");
const artifactRoot = join(sessionDir, "artifacts", "parent-id", "interactive-subagents");
const generatedSessionsRoot = join(configDir, "sessions");

const changedEnv = [
	"PI_CODING_AGENT_DIR",
	"PATH",
	"TMUX",
	"TMUX_PANE",
	"FAKE_TMUX_LOG",
	"PI_SUBAGENT_TEST_WORKTREE",
] as const;
const savedEnv = new Map(changedEnv.map((key) => [key, process.env[key]]));

mkdirSync(defsDir, { recursive: true });
mkdirSync(binDir, { recursive: true });
mkdirSync(workDir, { recursive: true });
mkdirSync(sessionDir, { recursive: true });
writeFileSync(parentSessionFile, "{}\n", "utf8");
writeFileSync(tmuxLog, "", "utf8");
writeFileSync(
	join(configDir, "subagents.json"),
	JSON.stringify({
		worktreeCreateCommand: 'mkdir -p "$PI_SUBAGENT_TEST_WORKTREE"; exit 1',
	}),
	"utf8",
);
writeFileSync(
	join(defsDir, "claude-code.md"),
	"---\ndescription: External guard fixture.\nharness: claude-code\n---\nExternal agent.\n",
	"utf8",
);
writeFileSync(
	join(defsDir, "pi-agent.md"),
	"---\ndescription: Pi positive control.\n---\nPi agent.\n",
	"utf8",
);
writeFileSync(
	join(binDir, "tmux"),
	`#!/bin/sh
first=1
for arg in "$@"; do
  if [ "$first" -eq 0 ]; then printf '\\t' >> "$FAKE_TMUX_LOG"; fi
  printf '%s' "$arg" >> "$FAKE_TMUX_LOG"
  first=0
done
printf '\\n' >> "$FAKE_TMUX_LOG"
if [ "$1" = "display-message" ] && [ "$2" = "-p" ] && [ "$3" = "#{version}" ]; then
  printf '3.3a\\n'
  exit 0
fi
printf 'unexpected tmux invocation\\n' >&2
exit 64
`,
	{ mode: 0o755 },
);

process.env.PI_CODING_AGENT_DIR = configDir;
process.env.PATH = `${binDir}${delimiter}${savedEnv.get("PATH") ?? ""}`;
process.env.TMUX = "fake-session";
process.env.TMUX_PANE = "%parent";
process.env.FAKE_TMUX_LOG = tmuxLog;
process.env.PI_SUBAGENT_TEST_WORKTREE = worktreeProbe;

let importedCapacity: typeof import("../capacity.ts") | undefined;
let importedState: typeof import("../state.ts") | undefined;
let cleaned = false;

function cleanup(): void {
	if (cleaned) return;
	cleaned = true;
	try {
		if (importedCapacity) {
			importedCapacity.clearQueueForShutdown();
			for (const pending of importedCapacity.pendingLaunches()) importedCapacity.releaseClaim(pending.spec.id);
		}
		if (importedState) {
			importedState.resetForShutdown();
			importedState.ledger.clear();
		}
	} finally {
		for (const [key, value] of savedEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	}
}

after(cleanup);

let spawnModule: typeof import("../tool-spawn.ts");
try {
	importedCapacity = await import("../capacity.ts");
	importedState = await import("../state.ts");
	spawnModule = await import("../tool-spawn.ts");
} catch (error) {
	cleanup();
	throw error;
}
const capacity = importedCapacity;
const state = importedState;

capacity.clearQueueForShutdown();
for (const pending of capacity.pendingLaunches()) capacity.releaseClaim(pending.spec.id);
state.resetForShutdown();
state.ledger.clear();

let spawnTool: ToolDefinition | undefined;
spawnModule.registerSubagentSpawnTool({
	registerTool(tool: ToolDefinition): void {
		spawnTool = tool;
	},
} as unknown as ExtensionAPI);
assert.ok(spawnTool, "subagent_spawn was not registered");
const registeredSpawnTool = spawnTool;

const baselineTree = treeEntries(root);
let selectedParentSessionFile = parentSessionFile;
const ctx = {
	cwd: workDir,
	modelRegistry: {},
	sessionManager: {
		getSessionFile: () => selectedParentSessionFile,
		getSessionDir: () => sessionDir,
		getSessionId: () => "parent-id",
	},
} as never;
const signal = new AbortController().signal;
const execute = (agent: string) => registeredSpawnTool.execute(
	`guard-${agent}`,
	{
		name: "Guard test",
		task: "This must not launch.",
		agent,
		context: "forked",
		worktree: true,
	},
	signal,
	() => {},
	ctx,
);
const tmuxCalls = (): string[] => readFileSync(tmuxLog, "utf8").trim().split("\n").filter(Boolean);
const assertNoLaunchSideEffects = (stage: string): void => {
	assert.strictEqual(capacity.queuedCount(), 0, `${stage} leaves the launch queue empty`);
	assert.strictEqual(capacity.pendingLaunchCount(), 0, `${stage} leaves no launch claim`);
	assert.strictEqual(state.running.size, 0, `${stage} leaves no running child`);
	assert.deepStrictEqual(treeEntries(root), baselineTree, `${stage} creates no files or directories`);
	assert.ok(!existsSync(artifactRoot), `${stage} creates no session artifacts`);
	assert.ok(!existsSync(generatedSessionsRoot), `${stage} creates no child session or metadata`);
	assert.ok(!existsSync(worktreeProbe), `${stage} creates no worktree`);
};

describe("subagent_spawn guards", () => {
	it("registerSubagentSpawnTool registers subagent_spawn", () => {
		assert.strictEqual(registeredSpawnTool.name, "subagent_spawn");
	});

	it("context parameter and prompt guidelines advertise the external-harness limits", () => {
		const schema = registeredSpawnTool.parameters as {
			properties?: { context?: { description?: string } };
		};
		const contextDescription = schema.properties?.context?.description ?? "";
		const promptGuidelines = (registeredSpawnTool as ToolDefinition & { promptGuidelines?: string[] }).promptGuidelines?.join("\n") ?? "";
		for (const phrase of ["external sub-agents are new-only", "requires the Pi harness"]) {
			assert.ok(contextDescription.includes(phrase),
				`context parameter advertises ${JSON.stringify(phrase)}`);
			assert.ok(promptGuidelines.includes(phrase),
				`prompt guidelines advertise ${JSON.stringify(phrase)}`);
		}
	});

	it("guard rejections launch nothing and leave no side effects", async () => {
		assert.strictEqual(
			await thrownMessage(() => execute("claude-code")),
			'Agent "claude-code" runs on the external harness "claude-code" - external sub-agents are new-only: a pi conversation cannot be transplanted into a different tool. Use context "new".',
			"explicit forked context on an external agent reports the planned runtime guard");
		assertNoLaunchSideEffects("external guard");
		assert.deepStrictEqual(
			tmuxCalls(),
			["display-message\t-p\t#{version}"],
			"external guard checks tmux availability but creates no pane");

		selectedParentSessionFile = missingParentSessionFile;
		assert.strictEqual(
			await thrownMessage(() => execute("pi-agent")),
			"Cannot fork yet: the parent session file has not been written to disk. Try again after this reply, or use context 'new'.",
			"pi forked positive control reaches the missing parent-session-file-on-disk guard");
		assertNoLaunchSideEffects("pi positive control");
		assert.deepStrictEqual(
			tmuxCalls(),
			[
				"display-message\t-p\t#{version}",
				"display-message\t-p\t#{version}",
			],
			"pi positive control also creates no pane");
	});
});
