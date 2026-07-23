import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

const configDir = mkdtempSync(join(tmpdir(), "subagents-running-widget-"));
writeFileSync(join(configDir, "subagents.json"), '{"maxConcurrentSubagents":5,"widgetMaxRows":5}');
process.env.PI_CODING_AGENT_DIR = configDir;

const state = await import("../state.ts");
const capacity = await import("../capacity.ts");
const controller = await import("../running-widget.ts");
type RunningSubagent = import("../state.ts").RunningSubagent;
type SpawnSpec = import("../capacity.ts").SpawnSpec;
type ResumeSpec = import("../capacity.ts").ResumeSpec;
type ActivitySnapshot = import("../activity.ts").ActivitySnapshot;

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

const NOW = 100_000;
const worktree = { dir: "/repo/wt", branch: "pi/test", baseCommit: "abc", parentCwd: "/repo" };

function snapshot(inRun: boolean, runsCompleted: number): ActivitySnapshot {
	return {
		version: 1,
		runId: "run",
		pid: 1,
		sequence: 1,
		updatedAt: NOW,
		inRun,
		runsCompleted,
		activeTools: [],
		modelId: null,
		context: null,
		costUsd: 0,
	};
}

function runningChild(id: string, status: "active" | "waiting" | "starting" | "stalled"): RunningSubagent {
	const activity = status === "stalled"
		? { watchdogStartMs: NOW - 60_000, problemSinceMs: NOW - 60_000 }
		: status === "active"
			? { watchdogStartMs: NOW - 10_000, snapshot: snapshot(true, 0), acceptedAtMs: NOW }
			: status === "waiting"
				? { watchdogStartMs: NOW - 10_000, snapshot: snapshot(false, 1), everSawRun: true }
				: { watchdogStartMs: NOW - 1_000, snapshot: snapshot(false, 0) };
	return {
		id,
		name: `${id} task`,
		agent: id === "active" ? "code-reviewer" : "worker",
		paneId: `%${id}`,
		sessionFile: `/sessions/${id}.jsonl`,
		startTime: NOW - 10_000,
		skipEntries: 0,
		autoExit: id !== "waiting",
		context: id === "stalled" ? "forked" : "new",
		worktree: id === "starting" ? worktree : undefined,
		harness: id === "active" ? "claude-code" : undefined,
		abort: new AbortController(),
		expectsRun: true,
		activity,
	};
}

function resumeSpec(id: string): ResumeSpec {
	return {
		kind: "resume",
		id,
		sessionPath: `/sessions/${id}.jsonl`,
		name: `${id} task`,
		agent: "resumer",
		harness: "pi",
		autoExit: true,
		context: "new",
		cwd: "/repo",
		cwdFromWorktree: false,
		base: "/base",
		slug: id,
		expectsRun: true,
	};
}

function spawnSpec(id: string): SpawnSpec {
	return {
		kind: "spawn",
		id,
		name: `${id} task`,
		task: "task",
		agentName: "worker",
		harness: "pi",
		agentBody: "",
		context: "new",
		autoExit: true,
		useWorktree: false,
		cwd: "/repo",
		parentCwd: "/repo",
		parentSessionFile: "/parent.jsonl",
		base: "/base",
		slug: id,
	};
}

state.running.clear();
state.delivering.clear();
capacity.clearQueueForShutdown();

const laterActive = runningChild("later-active", "active");
laterActive.startTime = NOW - 1_000;
const earlierActive = runningChild("earlier-active", "active");
earlierActive.startTime = NOW - 2_000;
state.running.set(laterActive.id, laterActive);
state.running.set(earlierActive.id, earlierActive);
eq("launch time breaks ties within a status bucket",
	controller.collectLifecycleWidgetRows(NOW).map((row) => row.id),
	["earlier-active", "later-active"]);
state.running.clear();

// Insert running rows in the inverse of their desired attention order.
for (const status of ["active", "starting", "waiting", "stalled"] as const) {
	const child = runningChild(status, status);
	state.running.set(child.id, child);
}
state.delivering.set("delivery", {
	id: "delivery",
	name: "delivery task",
	agent: "worker",
	harness: "claude-code",
	startedAt: NOW - 20_000,
	elapsedSeconds: 20,
	forked: true,
	interactive: true,
	worktree: false,
});
capacity.admitLaunch(resumeSpec("pending"));
capacity.admitLaunch(spawnSpec("queued"));

const rows = controller.collectLifecycleWidgetRows(NOW);
eq("attention priority overrides source lifecycle order",
	rows.map((row) => [row.id, row.status]),
	[
		["delivery", "delivering"],
		["stalled", "stalled"],
		["waiting", "waiting"],
		["starting", "starting"],
		["pending", "starting"],
		["active", "active"],
		["queued", "queued"],
	]);
eq("running flags remain derived after priority sorting",
	rows.filter((row) => row.lifecycle === "running").map((row) => [row.id, row.forked, row.interactive, row.worktree, row.external]),
	[
		["stalled", true, false, false, false],
		["waiting", false, true, false, false],
		["starting", false, false, true, false],
		["active", false, false, false, true],
	]);
eq("external harness remains separate detailed metadata",
	[rows[0].name, rows[0].harness, rows[5].name, rows[5].harness],
	["delivery task", "claude-code", "active task", "claude-code"]);

const compact = controller.compactWidgetSnapshot(NOW);
eq("configured cap selects the priority prefix", compact.rows.map((row) => row.id),
	["delivery", "stalled", "waiting", "starting", "pending"]);
eq("hidden subtype counts derive only from hidden rows",
	[compact.totalRows, compact.hiddenRows, compact.hiddenStalledRows, compact.hiddenWaitingRows, compact.hiddenQueuedRows],
	[7, 2, 0, 0, 1]);
const compactOne = controller.compactWidgetSnapshot(NOW, 1);
eq("hidden summary categories count stalled, waiting, and queued only",
	[compactOne.hiddenRows, compactOne.hiddenStalledRows, compactOne.hiddenWaitingRows, compactOne.hiddenQueuedRows],
	[6, 1, 1, 1]);

let widgetFactory: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
let cleared = false;
const context = {
	hasUI: true,
	ui: {
		setWidget(_key: string, content: unknown): void {
			if (content === undefined) cleared = true;
			else widgetFactory = content as typeof widgetFactory;
		},
	},
} as unknown as ExtensionContext;
state.setLatestCtx(context);
controller.updateRunningWidget();
const identityTheme = { fg: (_token: string, text: string) => text };
const rendered = widgetFactory?.({}, identityTheme).render(100) ?? [];
eq("widget renders five detailed rows plus rule and conditional summary", rendered.length, 7);
ok("compact identifiers are unbracketed and full", rendered.some((line) => line.includes("worker") && !line.includes("[worker]")));
ok("compact external rows use e instead of exact harness suffixes",
	rendered.some((line) => line.includes("efi  delivery task")) && !rendered.some((line) => line.includes("claude-code")));
const semanticTheme = { fg: (token: string, text: string) => `<${token}>${text}</${token}>` };
const semanticRendered = widgetFactory?.({}, semanticTheme).render(100) ?? [];
ok("compact agent identifiers use the muted semantic token",
	semanticRendered.some((line) => line.includes("<muted>worker</muted>")));
ok("compact marker letters use the muted semantic token",
	semanticRendered.some((line) => line.includes("<muted>efi </muted> delivery task")));
eq("summary reports hidden and hidden-queued counts only",
	rendered.at(-1), " +2 more · 1 queued · /subagent-status");
ok("every controller-rendered line is terminal-width safe", rendered.every((line) => visibleWidth(line) <= 100));

// Drop below the cap: the summary line must disappear entirely.
state.running.delete("active");
capacity.cancelQueued("queued");
controller.updateRunningWidget();
const belowCap = widgetFactory?.({}, identityTheme).render(100) ?? [];
eq("summary disappears when no rows are hidden", belowCap.length, 6);
ok("no command hint remains without overflow", !belowCap.some((line) => line.includes("/subagent-status")));

state.running.clear();
state.delivering.clear();
capacity.releaseClaim("pending");
controller.updateRunningWidget();
eq("empty lifecycle state removes the widget", cleared, true);

const retainedInvalidClaim = resumeSpec("retained-invalid");
capacity.admitLaunch(retainedInvalidClaim);
retainedInvalidClaim.agent = "code reviewer";
const validDuringReload = runningChild("valid-during-reload", "active");
state.running.set(validDuringReload.id, validDuringReload);
eq("invalid retained claims are quarantined from lifecycle projection",
	controller.collectLifecycleWidgetRows(NOW).map((row) => row.id), ["valid-during-reload"]);
eq("quarantined claims do not keep an empty pending row alive", capacity.pendingLaunchCount(), 0);
controller.updateRunningWidget();
ok("a valid child still renders beside a quarantined retained claim",
	(widgetFactory?.({}, identityTheme).render(100) ?? []).some((line) => line.includes("valid-during-reload task")));
capacity.releaseClaim("retained-invalid");
state.running.clear();
state.resetForShutdown();
capacity.clearQueueForShutdown();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
