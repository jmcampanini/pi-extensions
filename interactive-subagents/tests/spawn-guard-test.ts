import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join, relative } from "node:path";

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown): void {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}:\n    got  ${g}\n    want ${w}`); }
}
function ok(label: string, condition: boolean): void {
	if (condition) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}`); }
}

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

type CapacityModule = typeof import("../capacity.ts");
type StateModule = typeof import("../state.ts");
let capacity: CapacityModule | undefined;
let state: StateModule | undefined;

try {
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

	const [spawnModule, capacityModule, stateModule] = await Promise.all([
		import("../tool-spawn.ts"),
		import("../capacity.ts"),
		import("../state.ts"),
	]);
	capacity = capacityModule;
	state = stateModule;

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
	ok("registerSubagentSpawnTool registers subagent_spawn", spawnTool?.name === "subagent_spawn");
	if (!spawnTool) throw new Error("subagent_spawn was not registered");
	const registeredSpawnTool = spawnTool;

	const schema = registeredSpawnTool.parameters as {
		properties?: { context?: { description?: string } };
	};
	const contextDescription = schema.properties?.context?.description ?? "";
	const promptGuidelines = (registeredSpawnTool as ToolDefinition & { promptGuidelines?: string[] }).promptGuidelines?.join("\n") ?? "";
	for (const phrase of ["external sub-agents are new-only", "requires the Pi harness"]) {
		ok(`context parameter advertises ${JSON.stringify(phrase)}`, contextDescription.includes(phrase));
		ok(`prompt guidelines advertise ${JSON.stringify(phrase)}`, promptGuidelines.includes(phrase));
	}

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
	const assertNoLaunchState = (stage: string): void => {
		eq(`${stage} leaves the launch queue empty`, capacityModule.queuedCount(), 0);
		eq(`${stage} leaves no launch claim`, capacityModule.pendingLaunchCount(), 0);
		eq(`${stage} leaves no running child`, stateModule.running.size, 0);
	};
	const assertNoFilesystemSideEffects = (stage: string): void => {
		eq(`${stage} creates no files or directories`, treeEntries(root), baselineTree);
		ok(`${stage} creates no session artifacts`, !existsSync(artifactRoot));
		ok(`${stage} creates no child session or metadata`, !existsSync(generatedSessionsRoot));
		ok(`${stage} creates no worktree`, !existsSync(worktreeProbe));
	};

	eq(
		"explicit forked context on an external agent reports the planned runtime guard",
		await thrownMessage(() => execute("claude-code")),
		'Agent "claude-code" runs on the external harness "claude-code" - external sub-agents are new-only: a pi conversation cannot be transplanted into a different tool. Use context "new".',
	);
	assertNoLaunchState("external guard");
	assertNoFilesystemSideEffects("external guard");
	eq(
		"external guard checks tmux availability but creates no pane",
		tmuxCalls(),
		["display-message\t-p\t#{version}"],
	);

	selectedParentSessionFile = missingParentSessionFile;
	eq(
		"pi forked positive control reaches the missing parent-session-file-on-disk guard",
		await thrownMessage(() => execute("pi-agent")),
		"Cannot fork yet: the parent session file has not been written to disk. Try again after this reply, or use context 'new'.",
	);
	assertNoLaunchState("pi positive control");
	assertNoFilesystemSideEffects("pi positive control");
	eq(
		"pi positive control also creates no pane",
		tmuxCalls(),
		[
			"display-message\t-p\t#{version}",
			"display-message\t-p\t#{version}",
		],
	);
} catch (error) {
	fail++;
	console.log(`  FAIL unexpected test error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
	if (capacity) {
		capacity.clearQueueForShutdown();
		for (const pending of capacity.pendingLaunches()) capacity.releaseClaim(pending.spec.id);
	}
	if (state) {
		state.resetForShutdown();
		state.ledger.clear();
	}
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
