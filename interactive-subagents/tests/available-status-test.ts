// The registration, tool executions, and shared launch/delivery state below
// stay at module scope in their original order: each tool execution snapshots
// the mutable running/queue state at its point in the sequence.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
	initTheme,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

const sandboxRoot = join(process.cwd(), ".sandbox");
mkdirSync(sandboxRoot, { recursive: true });
const testRoot = mkdtempSync(join(sandboxRoot, "available-status-test-"));
const globalRoot = join(testRoot, "global");
const cwd = join(testRoot, "project");
mkdirSync(join(globalRoot, "subagents"), { recursive: true });
mkdirSync(join(cwd, ".pi", "subagents"), { recursive: true });
writeFileSync(join(globalRoot, "subagents.json"), '{"maxConcurrentSubagents":4}');
process.env.PI_CODING_AGENT_DIR = globalRoot;

writeFileSync(
	join(globalRoot, "subagents", "worker.md"),
	"---\ndescription: General implementation.\ndetails: Builds focused changes and verifies them.\n---\nWorker prompt.\n",
);
writeFileSync(
	join(cwd, ".pi", "subagents", "scout.md"),
	"---\ndescription: Fast reconnaissance. Use for bounded discovery.\ndetails: Maps relevant code paths before implementation begins.\ncontext: forked\nauto-exit: false\nworktree: true\n---\nScout prompt.\n",
);

const state = await import("../state.ts");
const capacity = await import("../capacity.ts");
const available = await import("../tool-available.ts");
const status = await import("../tool-status.ts");
type ActivitySnapshot = import("../activity.ts").ActivitySnapshot;
type AgentInfo = import("../agents.ts").AgentInfo;
type RunningSubagent = import("../state.ts").RunningSubagent;
type SpawnSpec = import("../capacity.ts").SpawnSpec;
type AvailableToolDetails = import("../tool-available.ts").AvailableToolDetails;
type StatusToolDetails = import("../tool-status.ts").StatusToolDetails;

after(() => {
	state.running.clear();
	state.delivering.clear();
	capacity.releaseClaim("starting1");
	capacity.cancelQueued("queued01");
	capacity.clearQueueForShutdown();
	state.resetForShutdown();
	rmSync(testRoot, { recursive: true, force: true });
});

function plainRendered(text: string): string {
	return stripVTControlCharacters(text).split("\n").map((line) => line.trimEnd()).join("\n");
}

function runningChild(id: string, name: string, overrides: Partial<RunningSubagent> = {}): RunningSubagent {
	return {
		id,
		name,
		agent: "worker",
		paneId: `%${id}`,
		sessionFile: join(testRoot, `${id}.jsonl`),
		startTime: Date.now() - 1_000,
		skipEntries: 0,
		autoExit: true,
		abort: new AbortController(),
		expectsRun: true,
		...overrides,
	};
}

function spawnSpec(id: string, name: string): SpawnSpec {
	return {
		kind: "spawn",
		id,
		name,
		task: `${name} task`,
		agentName: "worker",
		harness: "pi",
		agentBody: "Worker prompt.",
		context: "new",
		autoExit: true,
		useWorktree: false,
		cwd,
		parentCwd: cwd,
		parentSessionFile: join(testRoot, "parent.jsonl"),
		base: testRoot,
		slug: id,
	};
}

const registered: ToolDefinition[] = [];
const fakePi = {
	registerTool(tool: ToolDefinition): void {
		registered.push(tool);
	},
} as unknown as ExtensionAPI;
available.registerSubagentAvailableTool(fakePi);
status.registerSubagentStatusTool(fakePi);
const availableTool = registered[0] as ToolDefinition;
const statusTool = registered[1] as ToolDefinition;

state.running.set("liveonly", runningChild("liveonly", "RUNTIME STATUS SENTINEL"));
const availableContext = {
	cwd,
	modelRegistry: {
		getAll: () => [],
		hasConfiguredAuth: () => false,
	},
} as unknown as ExtensionContext;
const availableResult = await availableTool.execute("available-call", {}, undefined, undefined, availableContext);
const availableText = availableResult.content.find((part) => part.type === "text")?.text ?? "";
const availableDetails = availableResult.details as AvailableToolDetails;
const externalAgent: AgentInfo = {
	name: "claude-code",
	source: "global",
	description: "Direct Claude Code handoff.",
	details: "Direct means Claude Code runs through its native harness.",
	filePath: join(globalRoot, "subagents", "claude-code.md"),
	requestedModels: ["claude-opus-4-8"],
	resolvedModel: "claude-opus-4-8",
	context: "new",
	autoExit: true,
	worktree: false,
	harness: "claude-code",
	harnessPassThrough: "--permission-mode auto",
	problems: [],
};
const externalAvailableText = available.formatAvailableModelText([externalAgent]);
const externalAvailableResult = {
	...availableResult,
	content: [{ type: "text" as const, text: externalAvailableText }],
	details: {
		presentation: {
			version: 1 as const,
			inventory: [externalAgent],
			dirs: availableDetails.presentation.dirs,
		},
	},
};
state.running.clear();

const emptyStatusResult = await statusTool.execute("status-empty", {}, undefined, undefined, {} as ExtensionContext);
const emptyStatusText = emptyStatusResult.content.find((part) => part.type === "text")?.text ?? "";
const emptyStatusDetails = emptyStatusResult.details as StatusToolDetails;

initTheme(undefined, false);
const themeCalls: string[] = [];
const colorCode: Record<string, number> = {
	toolTitle: 31,
	accent: 32,
	muted: 33,
	dim: 2,
	warning: 35,
	error: 31,
	borderMuted: 90,
	toolOutput: 36,
};
const markedTheme = {
	fg(token: string, text: string): string {
		themeCalls.push(token);
		return `\x1b[${colorCode[token] ?? 37}m${text}\x1b[0m`;
	},
	bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
	italic: (text: string) => `\x1b[3m${text}\x1b[0m`,
} as unknown as Theme;
type RenderResult = NonNullable<ToolDefinition["renderResult"]>;
type RenderContext = Parameters<RenderResult>[3];
function renderContext(expanded: boolean): RenderContext {
	return {
		args: {},
		toolCallId: "render-call",
		invalidate(): void {},
		lastComponent: undefined,
		state: {},
		cwd,
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded,
		showImages: false,
		isError: false,
	};
}
const availableRenderer = availableTool.renderResult as RenderResult;

const NOW = Date.now();
function snapshot(overrides: Partial<ActivitySnapshot>): ActivitySnapshot {
	return {
		version: 1,
		runId: "run",
		pid: 1,
		sequence: 1,
		updatedAt: 500_000,
		inRun: false,
		runsCompleted: 0,
		activeTools: [],
		modelId: "model",
		context: null,
		costUsd: 0,
		...overrides,
	};
}

state.running.set("active01", runningChild("active01", "Implement parser", {
	agent: "worker",
	startTime: NOW - 120_000,
	activity: {
		watchdogStartMs: NOW - 120_000,
		acceptedAtMs: NOW - 4_000,
		everSawRun: true,
		snapshot: snapshot({
			inRun: true,
			activeTools: [{ toolCallId: "tool-1", name: "bash", startedAt: 494_000 }],
			context: { tokens: 12_345, window: 128_000, percent: 9.6 },
			costUsd: 1.25,
		}),
	},
}));
state.running.set("waiting1", runningChild("waiting1", "Await approval", {
	agent: "reviewer",
	autoExit: false,
	startTime: NOW - 80_000,
	activity: {
		watchdogStartMs: NOW - 80_000,
		everSawRun: true,
		snapshot: snapshot({ runsCompleted: 1 }),
	},
}));
state.running.set("stalled1", runningChild("stalled1", "Recover liveness", {
	agent: "scout",
	startTime: NOW - 70_000,
	activity: {
		watchdogStartMs: NOW - 70_000,
		acceptedAtMs: NOW - 65_000,
		problemSinceMs: NOW - 60_000,
		lastProblemKind: "invalid",
		snapshot: snapshot({
			context: { tokens: 54_321, window: 128_000, percent: 42.4 },
			costUsd: 2.75,
		}),
	},
}));
const startingAdmit = capacity.admitLaunch(spawnSpec("starting1", "Prepare workspace"));
const queuedAdmit = capacity.admitLaunch(spawnSpec("queued01", "Queued migration"));
const pending = capacity.pendingLaunches().find((entry) => entry.spec.id === "starting1");
if (pending) pending.claimedAt = NOW - 5_000;
const queued = capacity.findQueued("queued01");
if (queued) queued.queuedAt = NOW - 7_000;
state.delivering.set("delivery1", {
	id: "delivery1",
	name: "Completed audit",
	agent: "reviewer",
	startedAt: NOW - 95_000,
	elapsedSeconds: 95,
	forked: false,
	interactive: false,
	worktree: false,
	stopped: true,
});

const entries = status.collectStatusEntries(NOW);
const statusText = status.formatStatusModelText(entries);
const liveStatusResult = await statusTool.execute("status-live", {}, undefined, undefined, {} as ExtensionContext);
const liveStatusDetails = liveStatusResult.details as StatusToolDetails;
const liveStatusText = liveStatusResult.content.find((part) => part.type === "text")?.text ?? "";
const statusRenderResult = {
	...liveStatusResult,
	content: [{ type: "text" as const, text: statusText }],
	details: { presentation: { version: 1 as const, entries } },
};
const statusRenderer = statusTool.renderResult as RenderResult;

describe("tool registration", () => {
	it("discovery and status register only their canonical tool names and labels", () => {
		assert.deepStrictEqual(registered.map((tool) => tool.name), [
			"subagent_available",
			"subagent_status",
		], "discovery and status register only their canonical tool names");
		assert.strictEqual(availableTool.label, "Available Subagents", "canonical available label is registered");
		assert.strictEqual(statusTool.label, "Subagent Status", "canonical status label is registered");
	});
});

describe("subagent_available", () => {
	it("model content contains definition details and effective configuration only", () => {
		assert.strictEqual(availableText,
			"• scout (project, forked, interactive, worktree) — Maps relevant code paths before implementation begins.\n" +
			"  config: source project · inherits model · context forked · interactive · worktree · harness pi\n" +
			"• worker (default) — Builds focused changes and verifies them.\n" +
			"  config: source global · inherits model · context new · autonomous · shared checkout · harness pi",
			"available model content contains definition details and effective configuration only");
		assert.ok(!availableText.includes("RUNTIME STATUS SENTINEL") &&
			!availableText.includes("liveonly") &&
			!/\b(?:starting|active|waiting|stalled|delivering|queued)\b/.test(availableText),
			"available model content excludes launched names, ids, and runtime states");
	});

	it("result carries versioned presentation details for the sorted inventory", () => {
		assert.strictEqual(availableDetails.presentation.version, 1,
			"available result carries versioned presentation details");
		assert.deepStrictEqual(availableDetails.presentation.inventory.map((entry) => entry.name), [
			"scout",
			"worker",
		], "available details preserve the sorted definition inventory");
		assert.deepStrictEqual(availableDetails.presentation.dirs, {
			global: join(globalRoot, "subagents"),
			project: join(cwd, ".pi", "subagents"),
		}, "available details carry both definition directories");
		assert.ok(!availableText.includes("external:") && !availableText.includes("new-only"),
			"pi agents carry no external capability markers");
	});

	it("external model content advertises new-only everywhere needed", () => {
		assert.strictEqual(externalAvailableText,
			"• claude-code (external: claude-code, new-only) — Direct means Claude Code runs through its native harness.\n" +
			"  config: source global · model claude-opus-4-8 · context new-only · autonomous · shared checkout · external: claude-code · pass-through --permission-mode auto");
	});

	it("available call title uses bold tool-title styling", () => {
		const availableCallOutput = availableTool.renderCall?.({}, markedTheme, renderContext(false)).render(100).join("\n") ?? "";
		assert.ok(availableCallOutput.includes("\x1b[31m\x1b[1msubagent available"));
	});

	it("collapsed available card shows compact markers and headlines with semantic tokens", () => {
		themeCalls.length = 0;
		const collapsedAvailable = availableRenderer(
			availableResult,
			{ expanded: false, isPartial: false },
			markedTheme,
			renderContext(false),
		);
		const collapsedAvailablePlain = stripVTControlCharacters(collapsedAvailable.render(120).join("\n"));
		assert.ok(collapsedAvailablePlain.includes("scout · project · forked · interactive · worktree — Fast reconnaissance.") &&
			collapsedAvailablePlain.includes("worker · default — General implementation."),
			"collapsed available card shows compact definition markers and description headlines");
		assert.ok(!collapsedAvailablePlain.includes("Maps relevant code paths"),
			"collapsed available card omits expanded details");
		assert.ok(!collapsedAvailablePlain.includes("external:") && !collapsedAvailablePlain.includes("new-only"),
			"collapsed pi cards carry no external capability markers");
		assert.ok(["accent", "muted", "dim"].every((token) => themeCalls.includes(token)),
			"collapsed available card uses semantic name, metadata, preview, and hint tokens");
	});

	it("expanded available card uses the versioned inventory with semantic tokens", () => {
		themeCalls.length = 0;
		const expandedAvailable = availableRenderer(
			availableResult,
			{ expanded: true, isPartial: false },
			markedTheme,
			renderContext(true),
		);
		const expandedAvailablePlain = stripVTControlCharacters(expandedAvailable.render(120).join("\n"));
		assert.ok(expandedAvailablePlain.includes("Maps relevant code paths before implementation begins.") &&
			expandedAvailablePlain.includes("inherits model") &&
			expandedAvailablePlain.includes("forked · interactive · worktree"),
			"expanded available card uses the versioned inventory for full details");
		assert.ok(!expandedAvailablePlain.includes("Sub-agents · 2") && !expandedAvailablePlain.includes("dismiss"),
			"expanded available card suppresses command-only header and footer");
		assert.ok(["accent", "muted", "toolOutput", "dim", "warning"].every((token) => themeCalls.includes(token)),
			"expanded available card uses semantic accent, metadata, output, tertiary, and warning tokens");
		assert.ok(!expandedAvailablePlain.includes("external:") && !expandedAvailablePlain.includes("new-only"),
			"expanded pi cards carry no external capability markers");
	});

	it("external cards advertise the harness and new-only capability", () => {
		themeCalls.length = 0;
		const collapsedExternal = availableRenderer(
			externalAvailableResult,
			{ expanded: false, isPartial: false },
			markedTheme,
			renderContext(false),
		);
		const collapsedExternalPlain = stripVTControlCharacters(collapsedExternal.render(120).join("\n"));
		assert.ok(collapsedExternalPlain.includes("claude-code · external: claude-code · new-only — Direct Claude Code handoff."),
			"collapsed external card advertises the harness and new-only capability");
		const expandedExternal = availableRenderer(
			externalAvailableResult,
			{ expanded: true, isPartial: false },
			markedTheme,
			renderContext(true),
		);
		const expandedExternalPlain = stripVTControlCharacters(expandedExternal.render(120).join("\n"));
		assert.ok(expandedExternalPlain.includes("claude-code · new-only · pass-through: --permission-mode auto"),
			"expanded external overview marks new-only beside the harness");
		assert.ok(themeCalls.includes("warning"),
			"expanded external overview warning-paints capability metadata");
	});

	it("expanded available card shows the full description when details are absent", () => {
		const fallbackDescriptionInventory = availableDetails.presentation.inventory.map((agent) => agent.name === "worker"
			? { ...agent, description: "General implementation. Use this second sentence for routing.", details: undefined }
			: agent);
		const fallbackDescriptionCard = availableRenderer(
			{
				...availableResult,
				details: { presentation: { ...availableDetails.presentation, inventory: fallbackDescriptionInventory } },
			},
			{ expanded: true, isPartial: false },
			markedTheme,
			renderContext(true),
		);
		assert.ok(stripVTControlCharacters(fallbackDescriptionCard.render(120).join("\n")).includes("Use this second sentence for routing."));
	});

	it("expanded available card is display-width safe and strips hostile sequences", () => {
		const hostileAvailableInventory = [{
			...availableDetails.presentation.inventory[0],
			name: `${"界".repeat(10)}\x1b]52;c;Y2xpcGJvYXJk\x07`,
			description: "Description\x1b]52;c;Y2xpcGJvYXJk\x07 remains safe.",
			details: "Details\x1b[2J remain safe.",
			resolvedModel: "provider/model\x1b]52;c;Y2xpcGJvYXJk\x07",
			thinking: "high\x1b[2J",
			tools: "read\x1b]52;c;Y2xpcGJvYXJk\x07,bash",
			harness: "claude-code\x1b]52;c;Y2xpcGJvYXJk\x07",
			harnessPassThrough: "--flag\x1b[2J",
			problems: ["problem\x1b]52;c;Y2xpcGJvYXJk\x07"],
		}];
		const hostileAvailableCard = availableRenderer(
			{
				...availableResult,
				details: { presentation: { ...availableDetails.presentation, inventory: hostileAvailableInventory } },
			},
			{ expanded: true, isPartial: false },
			markedTheme,
			renderContext(true),
		);
		for (const width of [1, 2, 8, 20, 40]) {
			assert.strictEqual(hostileAvailableCard.render(width).every((line) => visibleWidth(line) <= width), true,
				`expanded available card is display-width safe for hostile CJK data at width ${width}`);
		}
		assert.ok(!hostileAvailableCard.render(80).join("\n").includes("\x1b]52") &&
			!hostileAvailableCard.render(80).join("\n").includes("\x1b[2J"),
			"expanded available card strips repository-controlled terminal sequences");
	});

	it("collapsed and expanded rendering fit every width", () => {
		const collapsedAvailable = availableRenderer(
			availableResult,
			{ expanded: false, isPartial: false },
			markedTheme,
			renderContext(false),
		);
		const expandedAvailable = availableRenderer(
			availableResult,
			{ expanded: true, isPartial: false },
			markedTheme,
			renderContext(true),
		);
		for (const width of [0, 1, 2, 8, 20, 40, 80, 120]) {
			assert.strictEqual(
				[collapsedAvailable, expandedAvailable].every((component) =>
					component.render(width).every((line) => visibleWidth(line) <= width)), true,
				`available collapsed and expanded rendering fit width ${width}`);
		}
	});

	it("unknown presentation versions fall back to model content", () => {
		themeCalls.length = 0;
		const staleAvailable = availableRenderer(
			{ ...availableResult, details: { presentation: { ...availableDetails.presentation, version: 2 } } },
			{ expanded: false, isPartial: false },
			markedTheme,
			renderContext(false),
		);
		assert.strictEqual(plainRendered(staleAvailable.render(200).join("\n")), availableText,
			"unknown available presentation versions fall back to model content");
		assert.ok(themeCalls.includes("toolOutput"), "available fallback content uses the semantic tool-output token");
	});
});

describe("subagent_status", () => {
	it("empty status has one exact model-facing sentence with versioned details", () => {
		assert.strictEqual(emptyStatusText, "No unresolved subagents.",
			"empty status has one exact model-facing sentence");
		assert.deepStrictEqual(emptyStatusDetails.presentation, {
			version: 1,
			entries: [],
		}, "empty status still carries versioned custom-renderer details");
	});

	it("launch admission fills the last capacity slot then queues", () => {
		assert.strictEqual(startingAdmit.status, "run",
			"a fourth unresolved launch claims the last capacity slot");
		assert.strictEqual(queuedAdmit.status, "queued",
			"the next unresolved launch enters the capacity queue");
	});

	it("status entries follow the exact attention order across lifecycle and capacity state", () => {
		assert.deepStrictEqual(entries.map((entry) => [entry.id, entry.state]), [
			["delivery1", "delivering"],
			["stalled1", "stalled"],
			["waiting1", "waiting"],
			["starting1", "starting"],
			["active01", "active"],
			["queued01", "queued"],
		]);
	});

	it("active status exposes structured telemetry with current-run guidance", () => {
		const activeEntry = entries.find((entry) => entry.id === "active01");
		assert.deepStrictEqual(activeEntry && {
			elapsedSeconds: activeEntry.elapsedSeconds,
			contextTokens: activeEntry.contextTokens,
			contextWindow: activeEntry.contextWindow,
			costUsd: activeEntry.costUsd,
		}, {
			elapsedSeconds: 120,
			contextTokens: 12_345,
			contextWindow: 128_000,
			costUsd: 1.25,
		}, "active status exposes structured elapsed, context, and cost telemetry");
		assert.ok(Boolean(activeEntry?.description.includes("running bash for 10s") &&
			activeEntry.description.includes("context 12k/128k tokens") &&
			activeEntry.description.includes("cost this run $1.25") &&
			activeEntry.description.includes("elapsed 2m 0s")),
			"active model guidance reports current tool timing and run economics");
	});

	it("stalled status preserves last-known telemetry with honest labels", () => {
		const stalledEntry = entries.find((entry) => entry.state === "stalled");
		assert.deepStrictEqual(stalledEntry && {
			contextTokens: stalledEntry.contextTokens,
			contextWindow: stalledEntry.contextWindow,
			costUsd: stalledEntry.costUsd,
		}, {
			contextTokens: 54_321,
			contextWindow: 128_000,
			costUsd: 2.75,
		}, "stalled status preserves structured last-known telemetry");
		assert.ok(Boolean(stalledEntry?.description.includes("last reported context 54k/128k tokens") &&
			stalledEntry.description.includes("last reported cost this run $2.75")),
			"stalled guidance labels last-known context and cost honestly");
	});

	it("delivering, stalled, starting, and queued guidance steer without false conclusions", () => {
		const deliveringEntry = entries.find((entry) => entry.state === "delivering");
		const stalledEntry = entries.find((entry) => entry.state === "stalled");
		const startingEntry = entries.find((entry) => entry.state === "starting");
		const queuedEntry = entries.find((entry) => entry.state === "queued");
		assert.ok(Boolean(deliveringEntry?.state === "delivering" &&
			deliveringEntry.description.includes("stopped after 1m 35s") &&
			deliveringEntry.description.includes("its stopped notice is queued and arrives on its own — end your turn to receive it")),
			"stopped delivery stays model-facing delivering and queues its stopped notice");
		assert.ok(Boolean(stalledEntry?.description.includes("this is a warning, not a failure") &&
			stalledEntry.description.includes("inspect its pane through /subagent-status") &&
			stalledEntry.description.includes("subagent_cancel")),
			"stalled guidance prevents false failure conclusions and offers cancellation");
		assert.ok(Boolean(startingEntry?.description.includes("subagent_cancel") &&
			startingEntry.description.includes("it proceeds on its own") &&
			queuedEntry?.description.includes("position 1 of 1") &&
			queuedEntry.description.includes("starts automatically when capacity frees") &&
			queuedEntry.description.includes("subagent_cancel")),
			"starting and queued guidance says work proceeds on its own or can be cancelled");
		assert.strictEqual(queuedEntry?.queuePosition, 1,
			"queued status carries its machine-readable queue position");
	});

	it("model-facing status format remains byte-for-byte unchanged", () => {
		assert.strictEqual(status.formatStatusModelText([{
			id: "agent 01",
			agent: "worker",
			name: "Fix \"parser\"",
			state: "active",
			description: "working\nnow",
			harness: null,
			elapsedSeconds: 1,
			contextTokens: null,
			contextWindow: null,
			costUsd: null,
			queuePosition: null,
		}]), "• id agent 01 | agent worker | name \"Fix \\\"parser\\\"\" | active — working now" +
			"\n\nResults arrive on their own; if you are only waiting, end your turn.");
	});

	it("flat status emits ID-first rows and ends with the standing reminder", () => {
		const [statusRowsBlock, statusReminder] = statusText.split("\n\n");
		const statusLines = statusRowsBlock.split("\n");
		assert.strictEqual(statusLines.length, entries.length,
			"flat status emits exactly one ungrouped row per unresolved id");
		assert.ok(statusLines.every((line, index) => line.startsWith(
			`• id ${entries[index].id} | agent ${entries[index].agent} | name "${entries[index].name}" | ${entries[index].state} — `,
		)), "every flat status row is ID-first with agent, name, and exact state in order");
		assert.strictEqual(statusReminder, "Results arrive on their own; if you are only waiting, end your turn.",
			"unresolved status ends with the standing end-your-turn reminder");
		assert.ok(statusLines.every((line) => line.startsWith("• id ")) &&
			!["Summary:", "Total:", "Running subagents:", "Queued subagents:", "Unresolved subagents:"].some((heading) =>
				statusText.includes(heading)),
			"flat status contains no aggregate summary or lifecycle group headings");
	});

	it("empty status reports no unresolved subagents without the reminder", () => {
		assert.strictEqual(status.formatStatusModelText([]), "No unresolved subagents.");
	});

	it("registered status execution preserves the attention order and unchanged model format", () => {
		assert.deepStrictEqual(
			[liveStatusDetails.presentation.version, liveStatusDetails.presentation.entries.map((entry) => entry.id)], [
				1,
				["delivery1", "stalled1", "waiting1", "starting1", "active01", "queued01"],
			], "registered status execution preserves the attention order in versioned details");
		assert.strictEqual(liveStatusText, status.formatStatusModelText(liveStatusDetails.presentation.entries),
			"registered status content is exactly the unchanged model formatter output");
		assert.ok(liveStatusText.split("\n\n")[0].split("\n").every((line) => line.startsWith("• id ")),
			"registered status execution keeps the same ID-first flat model format");
	});

	it("the status call keeps the configured expansion hint beside its bold title", () => {
		themeCalls.length = 0;
		const statusCallOutput = statusTool.renderCall?.({}, markedTheme, renderContext(false)).render(100).join("\n") ?? "";
		assert.ok(statusCallOutput.includes("\x1b[31m\x1b[1msubagent status") &&
			stripVTControlCharacters(statusCallOutput).includes("subagent status (") &&
			stripVTControlCharacters(statusCallOutput).trimEnd().endsWith("to expand)") &&
			themeCalls.includes("dim"),
			"collapsed status call keeps the configured expansion hint beside its bold tool title");
		const expandedStatusCallOutput = statusTool.renderCall?.({}, markedTheme, renderContext(true)).render(100).join("\n") ?? "";
		assert.strictEqual(stripVTControlCharacters(expandedStatusCallOutput).trimEnd(), "subagent status",
			"expanded status call removes the expansion hint");
		assert.strictEqual(
			readFileSync(new URL("../tool-status.ts", import.meta.url), "utf8").includes('keyHint("app.tools.expand", "to expand")'),
			true,
			"status call resolves Pi's configured expansion binding");
	});

	it("collapsed status shows concise ID-first rows while hiding verbose guidance", () => {
		const collapsedStatus = statusRenderer(
			statusRenderResult,
			{ expanded: false, isPartial: false },
			markedTheme,
			renderContext(false),
		);
		const collapsedStatusPlain = stripVTControlCharacters(collapsedStatus.render(160).join("\n"));
		assert.strictEqual(collapsedStatusPlain.split("\n")[0], "",
			"status rows follow one blank line after the call heading");
		assert.strictEqual(collapsedStatusPlain.split("\n")[1].trimEnd(),
			"delivery1 · reviewer · Completed audit · delivering",
			"collapsed status uses concise unlabeled ID-first dot grammar");
		assert.ok(entries.every((entry) => collapsedStatusPlain.includes(entry.id)) &&
			collapsedStatusPlain.split("\n").length === entries.length + 1 &&
			!collapsedStatusPlain.includes("arrives on its own") &&
			!collapsedStatusPlain.includes("id delivery1") &&
			!collapsedStatusPlain.includes("agent reviewer") &&
			!collapsedStatusPlain.includes("|"),
			"collapsed status shows every concise row while hiding verbose guidance");
	});

	it("collapsed status accents the task name and reserves warning styling for stalled", () => {
		themeCalls.length = 0;
		const collapsedStatus = statusRenderer(
			statusRenderResult,
			{ expanded: false, isPartial: false },
			markedTheme,
			renderContext(false),
		);
		const collapsedStatusOutput = collapsedStatus.render(160).join("\n");
		assert.strictEqual(collapsedStatusOutput.split("\n")[1].trimEnd(),
			"\x1b[33mdelivery1\x1b[0m\x1b[33m · \x1b[0m\x1b[33mreviewer\x1b[0m\x1b[33m · \x1b[0m" +
			"\x1b[32mCompleted audit\x1b[0m\x1b[33m · \x1b[0m\x1b[33mdelivering\x1b[0m",
			"collapsed status accents only the task name while muting identity, separators, and ordinary state");
		assert.ok(["accent", "muted", "warning"].every((token) => themeCalls.includes(token)) &&
			collapsedStatusOutput.includes("\x1b[33m · \x1b[0m\x1b[35mstalled\x1b[0m"),
			"collapsed status reserves warning styling for stalled state");
	});

	it("expanded status keeps concise cores and descriptions without group headings", () => {
		themeCalls.length = 0;
		const expandedStatus = statusRenderer(
			statusRenderResult,
			{ expanded: true, isPartial: false },
			markedTheme,
			renderContext(true),
		);
		const expandedStatusPlain = stripVTControlCharacters(expandedStatus.render(180).join("\n"));
		assert.ok(expandedStatusPlain.startsWith("\ndelivery1 · reviewer · Completed audit · delivering — stopped after") &&
			expandedStatusPlain.includes("running bash for 10s") &&
			expandedStatusPlain.includes("starts automatically when capacity frees") &&
			!expandedStatusPlain.includes("Summary:"),
			"expanded status keeps the heading spacer, concise cores, and descriptions without group headings");
		assert.ok(themeCalls.includes("toolOutput"), "expanded status body uses the semantic tool-output token");
	});

	it("expanded status is display-width safe and sanitizes hostile data", () => {
		const hostileStatus = statusRenderer(
			{
				...statusRenderResult,
				details: {
					presentation: {
						version: 1,
						entries: [{
							...entries[0],
							id: "delivery1\x1b]52;c;Y2xpcGJvYXJk\x07",
							agent: "reviewer\nroot\x1b[2J",
							name: `${"界".repeat(10)}\x1b]52;c;Y2xpcGJvYXJk\x07`,
							description: "finished safely\x1b[2J",
						}],
					},
				},
			},
			{ expanded: true, isPartial: false },
			markedTheme,
			renderContext(true),
		);
		for (const width of [1, 2, 8, 20, 40]) {
			assert.strictEqual(hostileStatus.render(width).every((line) => visibleWidth(line) <= width), true,
				`expanded status card is display-width safe for hostile CJK data at width ${width}`);
		}
		assert.ok(!hostileStatus.render(160).join("\n").includes("\x1b]52") &&
			!hostileStatus.render(160).join("\n").includes("\x1b[2J") &&
			plainRendered(hostileStatus.render(160).join("\n")).includes("reviewer root"),
			"expanded status card sanitizes terminal sequences and inline whitespace");
	});

	it("collapsed and expanded rendering fit every width", () => {
		const collapsedStatus = statusRenderer(
			statusRenderResult,
			{ expanded: false, isPartial: false },
			markedTheme,
			renderContext(false),
		);
		const expandedStatus = statusRenderer(
			statusRenderResult,
			{ expanded: true, isPartial: false },
			markedTheme,
			renderContext(true),
		);
		for (const width of [0, 1, 2, 8, 20, 40, 80, 120]) {
			assert.strictEqual(
				[collapsedStatus, expandedStatus].every((component) =>
					component.render(width).every((line) => visibleWidth(line) <= width)), true,
				`status collapsed and expanded rendering fit width ${width}`);
		}
	});

	it("the custom renderer keeps the heading spacer before empty output", () => {
		themeCalls.length = 0;
		const renderedEmptyStatus = statusRenderer(
			emptyStatusResult,
			{ expanded: false, isPartial: false },
			markedTheme,
			renderContext(false),
		);
		assert.strictEqual(plainRendered(renderedEmptyStatus.render(80).join("\n")), "\nNo unresolved subagents.",
			"custom status renderer keeps the heading spacer before empty output");
		assert.ok(themeCalls.includes("toolOutput"), "empty custom status output uses semantic tool-output styling");
	});

	it("unknown presentation versions keep the heading spacer before flat model content", () => {
		themeCalls.length = 0;
		const staleStatus = statusRenderer(
			{ ...statusRenderResult, details: { presentation: { version: 2, entries } } },
			{ expanded: false, isPartial: false },
			markedTheme,
			renderContext(false),
		);
		assert.strictEqual(plainRendered(staleStatus.render(500).join("\n")), `\n${statusText}`,
			"unknown status presentation versions keep the heading spacer before flat model content");
		assert.ok(themeCalls.includes("toolOutput"), "status fallback content uses the semantic tool-output token");
	});
});
