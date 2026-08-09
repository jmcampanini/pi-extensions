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
eq("discovery and status register only their canonical tool names", registered.map((tool) => tool.name), [
	"subagent_available",
	"subagent_status",
]);
const availableTool = registered[0] as ToolDefinition;
const statusTool = registered[1] as ToolDefinition;
eq("canonical available label is registered", availableTool.label, "Available Subagents");
eq("canonical status label is registered", statusTool.label, "Subagent Status");

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
eq("available model content contains definition details and effective configuration only", availableText,
	"• scout (project, forked, interactive, worktree) — Maps relevant code paths before implementation begins.\n" +
	"  config: source project · inherits model · context forked · interactive · worktree · harness pi\n" +
	"• worker (default) — Builds focused changes and verifies them.\n" +
	"  config: source global · inherits model · context new · autonomous · shared checkout · harness pi");
ok("available model content excludes launched names, ids, and runtime states",
	!availableText.includes("RUNTIME STATUS SENTINEL") &&
	!availableText.includes("liveonly") &&
	!/\b(?:starting|active|waiting|stalled|delivering|queued)\b/.test(availableText));
const availableDetails = availableResult.details as AvailableToolDetails;
eq("available result carries versioned presentation details", availableDetails.presentation.version, 1);
eq("available details preserve the sorted definition inventory", availableDetails.presentation.inventory.map((entry) => entry.name), [
	"scout",
	"worker",
]);
eq("available details carry both definition directories", availableDetails.presentation.dirs, {
	global: join(globalRoot, "subagents"),
	project: join(cwd, ".pi", "subagents"),
});
ok("pi agents carry no external capability markers", !availableText.includes("external:") && !availableText.includes("new-only"));
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
eq("external available model content advertises new-only everywhere needed", externalAvailableText,
	"• claude-code (external: claude-code, new-only) — Direct means Claude Code runs through its native harness.\n" +
	"  config: source global · model claude-opus-4-8 · context new-only · autonomous · shared checkout · external: claude-code · pass-through --permission-mode auto");
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
eq("empty status has one exact model-facing sentence", emptyStatusText, "No unresolved subagents.");
const emptyStatusDetails = emptyStatusResult.details as StatusToolDetails;
eq("empty status still carries versioned custom-renderer details", emptyStatusDetails.presentation, {
	version: 1,
	entries: [],
});

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

const availableCallOutput = availableTool.renderCall?.({}, markedTheme, renderContext(false)).render(100).join("\n") ?? "";
ok("available call title uses bold tool-title styling",
	availableCallOutput.includes("\x1b[31m\x1b[1msubagent available"));
const availableRenderer = availableTool.renderResult as RenderResult;
themeCalls.length = 0;
const collapsedAvailable = availableRenderer(
	availableResult,
	{ expanded: false, isPartial: false },
	markedTheme,
	renderContext(false),
);
const collapsedAvailableOutput = collapsedAvailable.render(120).join("\n");
const collapsedAvailablePlain = stripVTControlCharacters(collapsedAvailableOutput);
ok("collapsed available card shows compact definition markers and description headlines",
	collapsedAvailablePlain.includes("scout · project · forked · interactive · worktree — Fast reconnaissance.") &&
	collapsedAvailablePlain.includes("worker · default — General implementation."));
ok("collapsed available card omits expanded details", !collapsedAvailablePlain.includes("Maps relevant code paths"));
ok("collapsed pi cards carry no external capability markers", !collapsedAvailablePlain.includes("external:") && !collapsedAvailablePlain.includes("new-only"));
ok("collapsed available card uses semantic name, metadata, preview, and hint tokens",
	["accent", "muted", "dim"].every((token) => themeCalls.includes(token)));

themeCalls.length = 0;
const expandedAvailable = availableRenderer(
	availableResult,
	{ expanded: true, isPartial: false },
	markedTheme,
	renderContext(true),
);
const expandedAvailablePlain = stripVTControlCharacters(expandedAvailable.render(120).join("\n"));
ok("expanded available card uses the versioned inventory for full details",
	expandedAvailablePlain.includes("Maps relevant code paths before implementation begins.") &&
	expandedAvailablePlain.includes("inherits model") &&
	expandedAvailablePlain.includes("forked · interactive · worktree"));
ok("expanded available card suppresses command-only header and footer",
	!expandedAvailablePlain.includes("Sub-agents · 2") && !expandedAvailablePlain.includes("dismiss"));
ok("expanded available card uses semantic accent, metadata, output, tertiary, and warning tokens",
	["accent", "muted", "toolOutput", "dim", "warning"].every((token) => themeCalls.includes(token)));
ok("expanded pi cards carry no external capability markers", !expandedAvailablePlain.includes("external:") && !expandedAvailablePlain.includes("new-only"));

themeCalls.length = 0;
const collapsedExternal = availableRenderer(
	externalAvailableResult,
	{ expanded: false, isPartial: false },
	markedTheme,
	renderContext(false),
);
const collapsedExternalPlain = stripVTControlCharacters(collapsedExternal.render(120).join("\n"));
ok("collapsed external card advertises the harness and new-only capability",
	collapsedExternalPlain.includes("claude-code · external: claude-code · new-only — Direct Claude Code handoff."));
const expandedExternal = availableRenderer(
	externalAvailableResult,
	{ expanded: true, isPartial: false },
	markedTheme,
	renderContext(true),
);
const expandedExternalPlain = stripVTControlCharacters(expandedExternal.render(120).join("\n"));
ok("expanded external overview marks new-only beside the harness",
	expandedExternalPlain.includes("claude-code · new-only · pass-through: --permission-mode auto"));
ok("expanded external overview warning-paints capability metadata", themeCalls.includes("warning"));
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
ok("expanded available card shows the full description when details are absent",
	stripVTControlCharacters(fallbackDescriptionCard.render(120).join("\n")).includes("Use this second sentence for routing."));
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
	eq(`expanded available card is display-width safe for hostile CJK data at width ${width}`,
		hostileAvailableCard.render(width).every((line) => visibleWidth(line) <= width), true);
}
ok("expanded available card strips repository-controlled terminal sequences",
	!hostileAvailableCard.render(80).join("\n").includes("\x1b]52") &&
	!hostileAvailableCard.render(80).join("\n").includes("\x1b[2J"));
for (const width of [0, 1, 2, 8, 20, 40, 80, 120]) {
	eq(`available collapsed and expanded rendering fit width ${width}`,
		[collapsedAvailable, expandedAvailable].every((component) =>
			component.render(width).every((line) => visibleWidth(line) <= width)), true);
}
themeCalls.length = 0;
const staleAvailable = availableRenderer(
	{ ...availableResult, details: { presentation: { ...availableDetails.presentation, version: 2 } } },
	{ expanded: false, isPartial: false },
	markedTheme,
	renderContext(false),
);
eq("unknown available presentation versions fall back to model content",
	plainRendered(staleAvailable.render(200).join("\n")), availableText);
ok("available fallback content uses the semantic tool-output token", themeCalls.includes("toolOutput"));

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
eq("a fourth unresolved launch claims the last capacity slot",
	capacity.admitLaunch(spawnSpec("starting1", "Prepare workspace")).status, "run");
eq("the next unresolved launch enters the capacity queue",
	capacity.admitLaunch(spawnSpec("queued01", "Queued migration")).status, "queued");
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
eq("status entries follow the exact attention order across lifecycle and capacity state",
	entries.map((entry) => [entry.id, entry.state]), [
		["delivery1", "delivering"],
		["stalled1", "stalled"],
		["waiting1", "waiting"],
		["starting1", "starting"],
		["active01", "active"],
		["queued01", "queued"],
	]);
const activeEntry = entries.find((entry) => entry.id === "active01");
eq("active status exposes structured elapsed, context, and cost telemetry", activeEntry && {
	elapsedSeconds: activeEntry.elapsedSeconds,
	contextTokens: activeEntry.contextTokens,
	contextWindow: activeEntry.contextWindow,
	costUsd: activeEntry.costUsd,
}, {
	elapsedSeconds: 120,
	contextTokens: 12_345,
	contextWindow: 128_000,
	costUsd: 1.25,
});
ok("active model guidance reports current tool timing and run economics",
	Boolean(activeEntry?.description.includes("running bash for 10s") &&
	activeEntry.description.includes("context 12k/128k tokens") &&
	activeEntry.description.includes("cost this run $1.25") &&
	activeEntry.description.includes("elapsed 2m 0s")));
const deliveringEntry = entries.find((entry) => entry.state === "delivering");
const stalledEntry = entries.find((entry) => entry.state === "stalled");
eq("stalled status preserves structured last-known telemetry", stalledEntry && {
	contextTokens: stalledEntry.contextTokens,
	contextWindow: stalledEntry.contextWindow,
	costUsd: stalledEntry.costUsd,
}, {
	contextTokens: 54_321,
	contextWindow: 128_000,
	costUsd: 2.75,
});
ok("stalled guidance labels last-known context and cost honestly",
	Boolean(stalledEntry?.description.includes("last reported context 54k/128k tokens") &&
	stalledEntry.description.includes("last reported cost this run $2.75")));
const startingEntry = entries.find((entry) => entry.state === "starting");
const queuedEntry = entries.find((entry) => entry.state === "queued");
ok("stopped delivery stays model-facing delivering and queues its stopped notice",
	Boolean(deliveringEntry?.state === "delivering" &&
	deliveringEntry.description.includes("stopped after 1m 35s") &&
	deliveringEntry.description.includes("its stopped notice is queued and arrives on its own — end your turn to receive it")));
ok("stalled guidance prevents false failure conclusions and offers cancellation",
	Boolean(stalledEntry?.description.includes("this is a warning, not a failure") &&
	stalledEntry.description.includes("inspect its pane through /subagent-status") &&
	stalledEntry.description.includes("subagent_cancel")));
ok("starting and queued guidance says work proceeds on its own or can be cancelled",
	Boolean(startingEntry?.description.includes("subagent_cancel") &&
	startingEntry.description.includes("it proceeds on its own") &&
	queuedEntry?.description.includes("position 1 of 1") &&
	queuedEntry.description.includes("starts automatically when capacity frees") &&
	queuedEntry.description.includes("subagent_cancel")));
eq("queued status carries its machine-readable queue position", queuedEntry?.queuePosition, 1);

eq("model-facing status format remains byte-for-byte unchanged", status.formatStatusModelText([{
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
const statusText = status.formatStatusModelText(entries);
const [statusRowsBlock, statusReminder] = statusText.split("\n\n");
const statusLines = statusRowsBlock.split("\n");
eq("flat status emits exactly one ungrouped row per unresolved id", statusLines.length, entries.length);
ok("every flat status row is ID-first with agent, name, and exact state in order",
	statusLines.every((line, index) => line.startsWith(
		`• id ${entries[index].id} | agent ${entries[index].agent} | name "${entries[index].name}" | ${entries[index].state} — `,
	)));
eq("unresolved status ends with the standing end-your-turn reminder",
	statusReminder, "Results arrive on their own; if you are only waiting, end your turn.");
eq("empty status reports no unresolved subagents without the reminder",
	status.formatStatusModelText([]), "No unresolved subagents.");
ok("flat status contains no aggregate summary or lifecycle group headings",
	statusLines.every((line) => line.startsWith("• id ")) &&
	!["Summary:", "Total:", "Running subagents:", "Queued subagents:", "Unresolved subagents:"].some((heading) =>
		statusText.includes(heading)));

const liveStatusResult = await statusTool.execute("status-live", {}, undefined, undefined, {} as ExtensionContext);
const liveStatusDetails = liveStatusResult.details as StatusToolDetails;
eq("registered status execution preserves the attention order in versioned details",
	[liveStatusDetails.presentation.version, liveStatusDetails.presentation.entries.map((entry) => entry.id)], [
		1,
		["delivery1", "stalled1", "waiting1", "starting1", "active01", "queued01"],
	]);
const liveStatusText = liveStatusResult.content.find((part) => part.type === "text")?.text ?? "";
eq("registered status content is exactly the unchanged model formatter output",
	liveStatusText, status.formatStatusModelText(liveStatusDetails.presentation.entries));
ok("registered status execution keeps the same ID-first flat model format",
	liveStatusText.split("\n\n")[0].split("\n").every((line) => line.startsWith("• id ")));
const statusRenderResult = {
	...liveStatusResult,
	content: [{ type: "text" as const, text: statusText }],
	details: { presentation: { version: 1 as const, entries } },
};

themeCalls.length = 0;
const statusCallOutput = statusTool.renderCall?.({}, markedTheme, renderContext(false)).render(100).join("\n") ?? "";
ok("collapsed status call keeps the configured expansion hint beside its bold tool title",
	statusCallOutput.includes("\x1b[31m\x1b[1msubagent status") &&
	stripVTControlCharacters(statusCallOutput).includes("subagent status (") &&
	stripVTControlCharacters(statusCallOutput).trimEnd().endsWith("to expand)") &&
	themeCalls.includes("dim"));
const expandedStatusCallOutput = statusTool.renderCall?.({}, markedTheme, renderContext(true)).render(100).join("\n") ?? "";
eq("expanded status call removes the expansion hint",
	stripVTControlCharacters(expandedStatusCallOutput).trimEnd(), "subagent status");
eq("status call resolves Pi's configured expansion binding",
	readFileSync(new URL("../tool-status.ts", import.meta.url), "utf8").includes('keyHint("app.tools.expand", "to expand")'), true);
const statusRenderer = statusTool.renderResult as RenderResult;
themeCalls.length = 0;
const collapsedStatus = statusRenderer(
	statusRenderResult,
	{ expanded: false, isPartial: false },
	markedTheme,
	renderContext(false),
);
const collapsedStatusOutput = collapsedStatus.render(160).join("\n");
const collapsedStatusPlain = stripVTControlCharacters(collapsedStatusOutput);
eq("status rows follow one blank line after the call heading", collapsedStatusPlain.split("\n")[0], "");
eq("collapsed status uses concise unlabeled ID-first dot grammar",
	collapsedStatusPlain.split("\n")[1].trimEnd(), "delivery1 · reviewer · Completed audit · delivering");
ok("collapsed status shows every concise row while hiding verbose guidance",
	entries.every((entry) => collapsedStatusPlain.includes(entry.id)) &&
	collapsedStatusPlain.split("\n").length === entries.length + 1 &&
	!collapsedStatusPlain.includes("arrives on its own") &&
	!collapsedStatusPlain.includes("id delivery1") &&
	!collapsedStatusPlain.includes("agent reviewer") &&
	!collapsedStatusPlain.includes("|"));
eq("collapsed status accents only the task name while muting identity, separators, and ordinary state",
	collapsedStatusOutput.split("\n")[1].trimEnd(),
	"\x1b[33mdelivery1\x1b[0m\x1b[33m · \x1b[0m\x1b[33mreviewer\x1b[0m\x1b[33m · \x1b[0m" +
	"\x1b[32mCompleted audit\x1b[0m\x1b[33m · \x1b[0m\x1b[33mdelivering\x1b[0m");
ok("collapsed status reserves warning styling for stalled state",
	["accent", "muted", "warning"].every((token) => themeCalls.includes(token)) &&
	collapsedStatusOutput.includes("\x1b[33m · \x1b[0m\x1b[35mstalled\x1b[0m"));

themeCalls.length = 0;
const expandedStatus = statusRenderer(
	statusRenderResult,
	{ expanded: true, isPartial: false },
	markedTheme,
	renderContext(true),
);
const expandedStatusPlain = stripVTControlCharacters(expandedStatus.render(180).join("\n"));
ok("expanded status keeps the heading spacer, concise cores, and descriptions without group headings",
	expandedStatusPlain.startsWith("\ndelivery1 · reviewer · Completed audit · delivering — stopped after") &&
	expandedStatusPlain.includes("running bash for 10s") &&
	expandedStatusPlain.includes("starts automatically when capacity frees") &&
	!expandedStatusPlain.includes("Summary:"));
ok("expanded status body uses the semantic tool-output token", themeCalls.includes("toolOutput"));
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
	eq(`expanded status card is display-width safe for hostile CJK data at width ${width}`,
		hostileStatus.render(width).every((line) => visibleWidth(line) <= width), true);
}
ok("expanded status card sanitizes terminal sequences and inline whitespace",
	!hostileStatus.render(160).join("\n").includes("\x1b]52") &&
	!hostileStatus.render(160).join("\n").includes("\x1b[2J") &&
	plainRendered(hostileStatus.render(160).join("\n")).includes("reviewer root"));
for (const width of [0, 1, 2, 8, 20, 40, 80, 120]) {
	eq(`status collapsed and expanded rendering fit width ${width}`,
		[collapsedStatus, expandedStatus].every((component) =>
			component.render(width).every((line) => visibleWidth(line) <= width)), true);
}
themeCalls.length = 0;
const renderedEmptyStatus = statusRenderer(
	emptyStatusResult,
	{ expanded: false, isPartial: false },
	markedTheme,
	renderContext(false),
);
eq("custom status renderer keeps the heading spacer before empty output",
	plainRendered(renderedEmptyStatus.render(80).join("\n")), "\nNo unresolved subagents.");
ok("empty custom status output uses semantic tool-output styling", themeCalls.includes("toolOutput"));
themeCalls.length = 0;
const staleStatus = statusRenderer(
	{ ...statusRenderResult, details: { presentation: { version: 2, entries } } },
	{ expanded: false, isPartial: false },
	markedTheme,
	renderContext(false),
);
eq("unknown status presentation versions keep the heading spacer before flat model content",
	plainRendered(staleStatus.render(500).join("\n")), `\n${statusText}`);
ok("status fallback content uses the semantic tool-output token", themeCalls.includes("toolOutput"));

state.running.clear();
state.delivering.clear();
capacity.releaseClaim("starting1");
capacity.cancelQueued("queued01");
capacity.clearQueueForShutdown();
state.resetForShutdown();
rmSync(testRoot, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
