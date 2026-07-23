import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

process.env.PI_CODING_AGENT_DIR = join(process.cwd(), ".sandbox", "tool-cancel-test-config-do-not-create");
process.env.PI_SUBAGENT_MAX_CONCURRENT_SUBAGENTS = "1";

const state = await import("../state.ts");
const capacity = await import("../capacity.ts");
const { registerSubagentCancelTool } = await import("../tool-cancel.ts");
type RunningSubagent = import("../state.ts").RunningSubagent;
type SpawnSpec = import("../capacity.ts").SpawnSpec;

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
async function rejection(label: string, id: string, contains: string): Promise<void> {
	try {
		await execute(id);
		fail++;
		console.log(`  FAIL ${label}: expected rejection`);
	} catch (error) {
		if (String(error).includes(contains)) { pass++; console.log(`  ok  ${label}`); }
		else { fail++; console.log(`  FAIL ${label}: ${String(error)}`); }
	}
}

function spawnSpec(id: string, name: string): SpawnSpec {
	return {
		kind: "spawn",
		id,
		name,
		task: `work for ${name}`,
		agentName: "worker",
		harness: "pi",
		agentBody: "",
		context: "new",
		autoExit: true,
		useWorktree: false,
		cwd: "/repo",
		parentCwd: "/repo",
		parentSessionFile: "/sessions/parent.jsonl",
		base: "/sessions",
		slug: id,
	};
}

function runningChild(id: string, name: string): RunningSubagent {
	return {
		id,
		name,
		agent: "worker",
		paneId: `%${id}`,
		sessionFile: `/sessions/${id}.jsonl`,
		startTime: Date.now(),
		skipEntries: 0,
		autoExit: true,
		abort: new AbortController(),
		expectsRun: true,
	};
}

function delivery(id: string, name: string, stopped: boolean): void {
	const child = runningChild(id, name);
	child.agent = "reviewer";
	state.setDeliveryRecord({
		id,
		name,
		agent: child.agent,
		startedAt: child.startTime,
		elapsedSeconds: 10,
		forked: false,
		interactive: false,
		worktree: false,
		stopped,
		child,
		exit: stopped
			? { reason: "aborted", paneDead: true, capturedAt: Date.now() }
			: { reason: "exited", exitCode: 0, paneDead: true, capturedAt: Date.now() },
	} as unknown as import("../state.ts").DeliveryRecord);
}

function reset(): void {
	state.running.clear();
	state.delivering.clear();
	state.ledger.clear();
	for (const pending of capacity.pendingLaunches()) capacity.releaseClaim(pending.spec.id);
	capacity.clearQueueForShutdown();
}

let registered: ToolDefinition | undefined;
const fakePi = {
	registerTool(tool: ToolDefinition): void {
		registered = tool;
	},
	sendMessage(): void {},
} as unknown as ExtensionAPI;
registerSubagentCancelTool(fakePi);
if (!registered) throw new Error("subagent_cancel did not register");
const tool = registered;

async function execute(id: string) {
	return tool.execute(
		`cancel-${id}`,
		{ id },
		new AbortController().signal,
		() => {},
		{} as ExtensionContext,
	);
}

// Registration and schema are the model-facing control contract.
eq("tool registers its canonical name and label", [tool.name, tool.label], ["subagent_cancel", "Cancel Subagent"]);
const schema = tool.parameters as {
	type?: string;
	required?: string[];
	properties?: { id?: { type?: string; description?: string } };
};
eq("tool schema requires one string id", {
	type: schema.type,
	required: schema.required,
	idType: schema.properties?.id?.type,
}, {
	type: "object",
	required: ["id"],
	idType: "string",
});
ok("id schema points callers at the stable id returned by launch and status tools",
	Boolean(schema.properties?.id?.description?.includes("stable short id") &&
	schema.properties.id.description.includes("subagent_status") &&
	schema.properties.id.description.includes("subagent_spawn/subagent_resume")));
const description = tool.description ?? "";
ok("description says lifecycle state is resolved at execution time",
	description.includes("lifecycle state is resolved at execution time") &&
	description.includes("do not choose a cancel/stop variant"));
ok("description defines cancelled as no eventual result",
	description.includes("Result `cancelled`") && description.includes("no result will ever arrive"));
ok("description defines stopping as asynchronous and non-polling",
	description.includes("Result `stopping`") &&
	description.includes("stopped notice still arrives asynchronously") &&
	description.includes("do not poll or wait"));
ok("description warns about partial work, kept worktrees, and interactive humans",
	description.includes("leave partial work") && description.includes("worktrees are kept") &&
	description.includes("autoExit: false") && description.includes("human working in their pane"));

// Every success result carries a protocol word and enough standalone prose.
reset();
state.running.set("blocker0", runningChild("blocker0", "Capacity blocker"));
capacity.admitLaunch(spawnSpec("queue001", "Queued task"));
const queuedResult = await execute("queue001");
eq("queued tool result has cancelled details", queuedResult.details, {
	id: "queue001",
	status: "cancelled",
	outcome: "cancelled-queued",
});
eq("queued result prose is complete and count-aware",
	queuedResult.content, [{
		type: "text",
		text: "Sub-agent \"Queued task\" (id queue001, agent worker) was cancelled before it started. " +
			"Result: cancelled. It never ran and no result will arrive for it. Currently 1 running, 0 queued.",
	}]);

reset();
capacity.admitLaunch(spawnSpec("start001", "Starting task"));
const startingResult = await execute("start001");
eq("starting tool result has cancelled details", startingResult.details, {
	id: "start001",
	status: "cancelled",
	outcome: "cancelled-starting",
});
eq("starting result promises unwind, no run, and no result",
	startingResult.content, [{
		type: "text",
		text: "Sub-agent \"Starting task\" (id start001, agent worker) was cancelled while starting. " +
			"Result: cancelled. Its launch is being unwound, it will not run, and no result will arrive for it. " +
			"Currently 0 running, 0 queued.",
	}]);

reset();
const running = runningChild("running1", "Running task");
state.running.set(running.id, running);
const stoppingResult = await execute(running.id);
eq("running tool result has stopping details", stoppingResult.details, {
	id: running.id,
	status: "stopping",
	outcome: "stopping",
});
eq("running result explains asynchronous notice and retained partial work",
	stoppingResult.content, [{
		type: "text",
		text: "Sub-agent \"Running task\" (id running1, agent worker) was asked to stop. Result: stopping. " +
			"Its stopped notice will arrive asynchronously; do not poll or wait for it. Partial work may remain.",
	}]);
eq("execute performs the immediate model-attributed stop",
	[running.stopRequester, running.abort.signal.aborted], ["model", true]);
const repeatResult = await execute(running.id);
eq("idempotent repeat remains a stopping success", repeatResult.details, {
	id: running.id,
	status: "stopping",
	outcome: "already-stopping",
});
eq("repeat prose says the stopped notice still arrives and forbids polling",
	repeatResult.content, [{
		type: "text",
		text: "Sub-agent \"Running task\" (id running1, agent worker) is already being stopped. Result: stopping. " +
			"Its stopped notice will still arrive asynchronously; do not poll or wait for it. Partial work may remain.",
	}]);

reset();
const worktreeRunning = runningChild("running2", "Worktree task");
worktreeRunning.worktree = {
	dir: "/repo/worktree",
	branch: "pi/worktree",
	baseCommit: "base",
	parentCwd: "/repo",
};
state.running.set(worktreeRunning.id, worktreeRunning);
const worktreeStopping = await execute(worktreeRunning.id);
ok("running worktree result says that its worktree is retained",
	worktreeStopping.content[0]?.type === "text" &&
	worktreeStopping.content[0].text.includes("Its worktree is kept so it can be inspected or resumed."));

// Wrong lifecycle beliefs are errors with distinct corrective prose.
reset();
delivery("deliver1", "Finished task", false);
await rejection("finished delivery cannot be revoked", "deliver1",
	"has already finished. Its result is on its way and cannot be revoked; wait for it.");
reset();
delivery("deliver2", "Stopped task", true);
await rejection("stopped delivery names the stopped notice", "deliver2",
	"has already stopped. Its stopped notice is on its way and cannot be revoked; wait for it.");
reset();
capacity.recordCancellation("cancel01", "user");
await rejection("tombstoned id says no result will arrive", "cancel01",
	"was already cancelled. No result will arrive for it.");
reset();
state.ledger.set("complete", { sessionFile: "/sessions/complete.jsonl", name: "Completed task" });
await rejection("completed id says its result was delivered", "complete",
	"already finished and its result was delivered; there is nothing to cancel.");
reset();
await rejection("unknown id points at subagent_status", "missing1",
	"No sub-agent with id missing1. Use subagent_status to list unresolved sub-agents.");

// Native tool rendering uses only the required semantic tokens.
const themeCalls: string[] = [];
const markedTheme = {
	fg(token: string, text: string): string {
		themeCalls.push(token);
		return `<${token}>${text}</${token}>`;
	},
	bold(text: string): string {
		return `<b>${text}</b>`;
	},
} as unknown as Theme;
const renderContext = (isError: boolean) => ({
	args: {},
	toolCallId: "render-cancel",
	invalidate(): void {},
	lastComponent: undefined,
	state: {},
	cwd: process.cwd(),
	executionStarted: true,
	argsComplete: true,
	isPartial: false,
	expanded: false,
	showImages: false,
	isError,
}) as Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];

const callOutput = tool.renderCall?.({ id: "abc12345" }, markedTheme, renderContext(false)).render(100).join("\n").trimEnd() ?? "";
eq("call renderer uses a bold tool title and unbolded accent id",
	callOutput, "<toolTitle><b>cancel subagent</b></toolTitle> <accent>abc12345</accent>");
eq("call renderer touches only native title and argument tokens", themeCalls, ["toolTitle", "accent"]);
const hostileCallOutput = tool.renderCall?.(
	{ id: "abc\u001b]52;c;Y2xpcGJvYXJk\u000712345\n" },
	markedTheme,
	renderContext(false),
).render(100).join("\n") ?? "";
ok("call renderer strips terminal controls and flattens whitespace",
	!hostileCallOutput.includes("\u001b]52") && hostileCallOutput.includes("abc12345"));

const renderResult = tool.renderResult;
if (!renderResult) throw new Error("subagent_cancel did not register a result renderer");
themeCalls.length = 0;
const successOutput = renderResult(
	{ content: [{ type: "text", text: "Result: stopping." }], details: {} },
	{ expanded: false, isPartial: false },
	markedTheme,
	renderContext(false),
).render(100).join("\n").trimEnd();
eq("success renderer uses plain tool-output text",
	[successOutput, themeCalls], ["<toolOutput>Result: stopping.</toolOutput>", ["toolOutput"]]);

themeCalls.length = 0;
const hostileErrorOutput = renderResult(
	{ content: [{ type: "text", text: "Bad\u001b]52;c;Y2xpcGJvYXJk\u0007 id" }], details: {} },
	{ expanded: false, isPartial: false },
	markedTheme,
	renderContext(true),
).render(100).join("\n").trimEnd();
eq("error renderer strips terminal controls and uses the error token",
	[stripVTControlCharacters(hostileErrorOutput), hostileErrorOutput.includes("\u001b]52"), themeCalls],
	["<error>Bad id</error>", false, ["error"]]);

themeCalls.length = 0;
const fallbackErrorOutput = renderResult(
	{ content: [], details: {} },
	{ expanded: false, isPartial: false },
	markedTheme,
	renderContext(true),
).render(100).join("\n").trimEnd();
eq("empty error rendering has a useful fallback",
	[fallbackErrorOutput, themeCalls], ["<error>Unable to cancel sub-agent.</error>", ["error"]]);

reset();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
