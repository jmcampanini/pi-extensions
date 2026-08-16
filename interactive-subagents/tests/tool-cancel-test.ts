import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
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

beforeEach(reset);
after(reset);

let registered: ToolDefinition | undefined;
const fakePi = {
	registerTool(tool: ToolDefinition): void {
		registered = tool;
	},
	sendMessage(): void {},
} as unknown as ExtensionAPI;
registerSubagentCancelTool(fakePi);
assert.ok(registered, "subagent_cancel did not register");
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

describe("subagent_cancel", () => {
	// Registration and schema are the model-facing control contract.
	it("tool registers its canonical name and label", () => {
		assert.deepStrictEqual([tool.name, tool.label], ["subagent_cancel", "Cancel Subagent"]);
	});

	const schema = tool.parameters as {
		type?: string;
		required?: string[];
		properties?: { id?: { type?: string; description?: string } };
	};

	it("tool schema requires one string id", () => {
		assert.deepStrictEqual({
			type: schema.type,
			required: schema.required,
			idType: schema.properties?.id?.type,
		}, {
			type: "object",
			required: ["id"],
			idType: "string",
		});
	});

	it("id schema points callers at the stable id returned by launch and status tools", () => {
		assert.ok(Boolean(schema.properties?.id?.description?.includes("stable short id") &&
			schema.properties.id.description.includes("subagent_status") &&
			schema.properties.id.description.includes("subagent_spawn/subagent_resume")));
	});

	const description = tool.description ?? "";

	it("description says lifecycle state is resolved at execution time", () => {
		assert.ok(description.includes("lifecycle state is resolved at execution time") &&
			description.includes("do not choose a cancel/stop variant"));
	});

	it("description defines cancelled as no eventual result", () => {
		assert.ok(description.includes("Result `cancelled`") && description.includes("no result will ever arrive"));
	});

	it("description defines stopping as asynchronous with self-arriving notice", () => {
		assert.ok(description.includes("Result `stopping`") &&
			description.includes("stopped notice arrives on its own like any result"));
	});

	it("description warns about partial work, kept worktrees, and interactive humans", () => {
		assert.ok(description.includes("leave partial work") && description.includes("worktrees are kept") &&
			description.includes("autoExit: false") && description.includes("human working in their pane"));
	});

	// Every success result carries a protocol word and enough standalone prose.
	it("cancelling a queued launch reports count-aware cancelled prose", async () => {
		state.running.set("blocker0", runningChild("blocker0", "Capacity blocker"));
		capacity.admitLaunch(spawnSpec("queue001", "Queued task"));
		const queuedResult = await execute("queue001");
		assert.deepStrictEqual(queuedResult.details, {
			id: "queue001",
			status: "cancelled",
			outcome: "cancelled-queued",
		}, "queued tool result has cancelled details");
		assert.deepStrictEqual(queuedResult.content, [{
			type: "text",
			text: "Sub-agent \"Queued task\" (id queue001, agent worker) was cancelled before it started. " +
				"Result: cancelled. It never ran and no result will arrive for it. Currently 1 running, 0 queued.",
		}], "queued result prose is complete and count-aware");
	});

	it("cancelling a starting launch unwinds it without a run or result", async () => {
		capacity.admitLaunch(spawnSpec("start001", "Starting task"));
		const startingResult = await execute("start001");
		assert.deepStrictEqual(startingResult.details, {
			id: "start001",
			status: "cancelled",
			outcome: "cancelled-starting",
		}, "starting tool result has cancelled details");
		assert.deepStrictEqual(startingResult.content, [{
			type: "text",
			text: "Sub-agent \"Starting task\" (id start001, agent worker) was cancelled while starting. " +
				"Result: cancelled. Its launch is being unwound, it will not run, and no result will arrive for it. " +
				"Currently 0 running, 0 queued.",
		}], "starting result promises unwind, no run, and no result");
	});

	it("stopping a running child is immediate, attributed, and idempotent", async () => {
		const running = runningChild("running1", "Running task");
		state.running.set(running.id, running);
		const stoppingResult = await execute(running.id);
		assert.deepStrictEqual(stoppingResult.details, {
			id: running.id,
			status: "stopping",
			outcome: "stopping",
		}, "running tool result has stopping details");
		assert.deepStrictEqual(stoppingResult.content, [{
			type: "text",
			text: "Sub-agent \"Running task\" (id running1, agent worker) was asked to stop. Result: stopping. " +
				"Its stopped notice will arrive on its own. Partial work may remain.",
		}], "running result explains asynchronous notice and retained partial work");
		assert.deepStrictEqual(
			[running.stopRequester, running.abort.signal.aborted],
			["model", true],
			"execute performs the immediate model-attributed stop");
		const repeatResult = await execute(running.id);
		assert.deepStrictEqual(repeatResult.details, {
			id: running.id,
			status: "stopping",
			outcome: "already-stopping",
		}, "idempotent repeat remains a stopping success");
		assert.deepStrictEqual(repeatResult.content, [{
			type: "text",
			text: "Sub-agent \"Running task\" (id running1, agent worker) is already being stopped. Result: stopping. " +
				"Its stopped notice will still arrive on its own. Partial work may remain.",
		}], "repeat prose says the stopped notice still arrives on its own");
	});

	it("running worktree result says that its worktree is retained", async () => {
		const worktreeRunning = runningChild("running2", "Worktree task");
		worktreeRunning.worktree = {
			dir: "/repo/worktree",
			branch: "pi/worktree",
			baseCommit: "base",
			parentCwd: "/repo",
		};
		state.running.set(worktreeRunning.id, worktreeRunning);
		const worktreeStopping = await execute(worktreeRunning.id);
		assert.ok(worktreeStopping.content[0]?.type === "text" &&
			worktreeStopping.content[0].text.includes("Its worktree is kept so it can be inspected or resumed."));
	});

	// Wrong lifecycle beliefs are errors with distinct corrective prose.
	it("finished delivery cannot be revoked", async () => {
		delivery("deliver1", "Finished task", false);
		await assert.rejects(() => execute("deliver1"), (error) =>
			String(error).includes("has already finished. Its result is on its way and cannot be revoked; wait for it."));
	});

	it("stopped delivery names the stopped notice", async () => {
		delivery("deliver2", "Stopped task", true);
		await assert.rejects(() => execute("deliver2"), (error) =>
			String(error).includes("has already stopped. Its stopped notice is on its way and cannot be revoked; wait for it."));
	});

	it("tombstoned id says no result will arrive", async () => {
		capacity.recordCancellation("cancel01", "user");
		await assert.rejects(() => execute("cancel01"), (error) =>
			String(error).includes("was already cancelled. No result will arrive for it."));
	});

	it("completed id says its result was delivered", async () => {
		state.ledger.set("complete", { sessionFile: "/sessions/complete.jsonl", name: "Completed task" });
		await assert.rejects(() => execute("complete"), (error) =>
			String(error).includes("already finished and its result was delivered; there is nothing to cancel."));
	});

	it("unknown id points at subagent_status", async () => {
		await assert.rejects(() => execute("missing1"), (error) =>
			String(error).includes("No sub-agent with id missing1. Use subagent_status to list unresolved sub-agents."));
	});

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

	it("call renderer follows the subagent tool family grammar with native tokens", () => {
		themeCalls.length = 0;
		const callOutput = tool.renderCall?.({ id: "abc12345" }, markedTheme, renderContext(false)).render(100).join("\n").trimEnd() ?? "";
		assert.strictEqual(callOutput,
			"<toolTitle><b>subagent cancel</b></toolTitle><muted> · </muted><accent>abc12345</accent>",
			"call renderer matches the subagent tool family grammar");
		assert.deepStrictEqual(themeCalls, ["toolTitle", "muted", "accent"],
			"call renderer touches only native title, separator, and argument tokens");
	});

	it("call renderer strips terminal controls and flattens whitespace", () => {
		const hostileCallOutput = tool.renderCall?.(
			{ id: "abc\u001b]52;c;Y2xpcGJvYXJk\u000712345\n" },
			markedTheme,
			renderContext(false),
		).render(100).join("\n") ?? "";
		assert.ok(!hostileCallOutput.includes("\u001b]52") && hostileCallOutput.includes("abc12345"));
	});

	const renderResult = tool.renderResult;
	assert.ok(renderResult, "subagent_cancel did not register a result renderer");

	it("success renderer uses plain tool-output text", () => {
		themeCalls.length = 0;
		const successOutput = renderResult(
			{ content: [{ type: "text", text: "Result: stopping." }], details: {} },
			{ expanded: false, isPartial: false },
			markedTheme,
			renderContext(false),
		).render(100).join("\n").trimEnd();
		assert.deepStrictEqual([successOutput, themeCalls],
			["<toolOutput>Result: stopping.</toolOutput>", ["toolOutput"]]);
	});

	it("error renderer strips terminal controls and uses the error token", () => {
		themeCalls.length = 0;
		const hostileErrorOutput = renderResult(
			{ content: [{ type: "text", text: "Bad\u001b]52;c;Y2xpcGJvYXJk\u0007 id" }], details: {} },
			{ expanded: false, isPartial: false },
			markedTheme,
			renderContext(true),
		).render(100).join("\n").trimEnd();
		assert.deepStrictEqual(
			[stripVTControlCharacters(hostileErrorOutput), hostileErrorOutput.includes("\u001b]52"), themeCalls],
			["<error>Bad id</error>", false, ["error"]]);
	});

	it("empty error rendering has a useful fallback", () => {
		themeCalls.length = 0;
		const fallbackErrorOutput = renderResult(
			{ content: [], details: {} },
			{ expanded: false, isPartial: false },
			markedTheme,
			renderContext(true),
		).render(100).join("\n").trimEnd();
		assert.deepStrictEqual([fallbackErrorOutput, themeCalls],
			["<error>Unable to cancel sub-agent.</error>", ["error"]]);
	});
});
