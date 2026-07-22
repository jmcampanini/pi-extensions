import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "subagents-running-command-"));

const state = await import("../state.ts");
const capacity = await import("../capacity.ts");
const command = await import("../command-status.ts");
type LifecycleWidgetRow = import("../running-widget.ts").LifecycleWidgetRow;
type RunningSubagent = import("../state.ts").RunningSubagent;
type SpawnSpec = import("../capacity.ts").SpawnSpec;
type PickerComponent = { render(width: number): string[]; handleInput(data: string): void };

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

const formatterRows: LifecycleWidgetRow[] = Array.from({ length: 12 }, (_, index) => ({
	id: `row-${index + 1}`,
	lifecycle: index === 10 ? "delivering" : index === 11 ? "queued" : "running",
	startedAt: index,
	name: `task ${index + 1}`,
	agent: index === 2 ? undefined : index === 3 ? "code-reviewer" : "worker",
	harness: index === 0 ? "claude-code" : undefined,
	elapsedSeconds: index,
	interactive: index === 0,
	worktree: index === 1,
	external: index === 0,
	status: index === 10 ? "delivering" : index === 11 ? "queued" : "active",
}));
const formatted = command.formatStatusPickerLines(formatterRows, 0, 0, 120, {
	agent: (text) => `<D>${text}</D>`,
	marker: (text) => `<M>${text}</M>`,
});
eq("picker height is bounded to ten detailed rows", formatted.length, 15);
ok("picker shows unbracketed dim identifiers, brighter markers, and exact harness",
	formatted.some((line) => line.includes("<D>worker</D>        <M>i x</M> task 1 · active · harness claude-code")));
ok("picker never wraps agent identifiers in square brackets", !formatted.some((line) => line.includes("[worker]")));
ok("first viewport includes row 10 but not row 11",
	formatted.some((line) => line.includes("task 10")) && !formatted.some((line) => line.includes("task 11")));
eq("picker reports its first scroll window", formatted[12], " 1–10 of 12");
const scrolled = command.formatStatusPickerLines(formatterRows, 11, 2, 100);
ok("later viewport reaches every hidden lifecycle row",
	scrolled.some((line) => line.includes("task 11 · delivering")) && scrolled.some((line) => line.includes("task 12 · queued")));
eq("picker reports its last scroll window", scrolled[12], " 3–12 of 12");
ok("queued selection advertises only its valid cancel action",
	scrolled[13].includes("x: cancel queued launch") && !scrolled[13].includes("enter: visit"));
const startingLines = command.formatStatusPickerLines([{
	id: "setup",
	lifecycle: "pending",
	startedAt: 0,
	name: "setup task",
	elapsedSeconds: 1,
	status: "starting",
}], 0, 0, 80);
ok("pending launch uses only the user-facing starting term",
	startingLines.join("\n").includes("starting")
		&& !startingLines.join("\n").includes("pending")
		&& !startingLines.join("\n").includes("launching"));
let pickerWidthViolations = 0;
for (let width = -2; width <= 90; width++) {
	for (const line of command.formatStatusPickerLines(formatterRows, 11, 2, width)) {
		if (visibleWidth(line) > Math.max(0, width)) pickerWidthViolations++;
	}
}
eq("picker never exceeds terminal width", pickerWidthViolations, 0);
const mixedElapsed = command.formatStatusPickerLines([
	{ ...formatterRows[0], id: "under-hour", elapsedSeconds: 3_599 },
	{ ...formatterRows[0], id: "over-hour", elapsedSeconds: 3_600 },
], 0, 0, 100);
eq("mixed elapsed widths keep agent and marker columns aligned",
	[mixedElapsed[2].indexOf("worker"), mixedElapsed[3].indexOf("worker"), mixedElapsed[2].indexOf("ix"), mixedElapsed[3].indexOf("ix")],
	[10, 10, 17, 17]);

let handler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
let registeredCommand = "";
const sent: Array<{ customType?: string }> = [];
const fakePi = {
	registerCommand(name: string, options: { handler: typeof handler }): void {
		registeredCommand = name;
		handler = options.handler;
	},
	sendMessage(message: { customType?: string }): void {
		sent.push(message);
	},
} as unknown as ExtensionAPI;
const focusCalls: Array<{ paneId: string; zoom: boolean }> = [];
command.registerSubagentStatusCommand(fakePi, (paneId, options) => {
	focusCalls.push({ paneId, zoom: options?.zoom ?? false });
});
eq("command registers the clean-break status name", registeredCommand, "subagent-status");

const notifications: Array<{ message: string; level: string }> = [];
let renderedDuringStep: string[] = [];
type Step = string | ((component: PickerComponent) => void);
function contextForSteps(steps: Step[]): ExtensionContext {
	return {
		hasUI: true,
		ui: {
			notify(message: string, level: string): void {
				notifications.push({ message, level });
			},
			async custom(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => PickerComponent): Promise<unknown> {
				let result: unknown;
				let doneCalls = 0;
				const component = factory(
					{ requestRender(): void {} },
					{ fg: (_token: string, text: string) => text, bold: (text: string) => text },
					{},
					(value) => { result = value; doneCalls++; },
				);
				for (const step of steps) {
					if (typeof step === "string") component.handleInput(step);
					else step(component);
				}
				(contextForSteps as unknown as { lastDoneCalls?: number }).lastDoneCalls = doneCalls;
				return result;
			},
		},
	} as unknown as ExtensionContext;
}

function runningChild(id: string): RunningSubagent {
	return {
		id,
		name: `${id} task`,
		agent: "worker",
		paneId: `%${id}`,
		sessionFile: `/sessions/${id}.jsonl`,
		startTime: Date.now() - 1_000,
		skipEntries: 0,
		autoExit: true,
		abort: new AbortController(),
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
		context: "fresh",
		autoExit: true,
		useWorktree: false,
		cwd: "/repo",
		parentCwd: "/repo",
		parentSessionFile: "/parent.jsonl",
		base: "/base",
		slug: id,
	};
}

function reset(): void {
	state.running.clear();
	state.delivering.clear();
	capacity.clearQueueForShutdown();
	for (const id of ["pending", "queued", ...Array.from({ length: 9 }, (_, i) => `fill-${i}`)]) {
		capacity.releaseClaim(id);
	}
	notifications.length = 0;
	focusCalls.length = 0;
	sent.length = 0;
	renderedDuringStep = [];
}

reset();
const first = runningChild("first");
const selected = runningChild("selected");
state.running.set(first.id, first);
state.running.set(selected.id, selected);
await handler?.("", contextForSteps([
	"j",
	(component) => {
		state.delivering.set("delivery", {
			id: "delivery",
			name: "delivery task",
			startedAt: Date.now() - 2_000,
			elapsedSeconds: 2,
			forked: false,
			interactive: false,
			worktree: false,
		});
		selected.startTime = Date.now() - 61_000;
		renderedDuringStep = component.render(100);
	},
	"x",
]));
ok("live picker adds higher-priority rows while open", renderedDuringStep.some((line) => line.includes("delivery task")));
ok("live picker refreshes elapsed clocks", renderedDuringStep.some((line) => line.includes("01:01") || line.includes("01:00")));
eq("selection stays anchored by id after live reprioritization",
	[selected.stoppedByUser, selected.abort.signal.aborted, first.abort.signal.aborted], [true, true, false]);

reset();
const beforeRemoved = runningChild("before-removed");
const removed = runningChild("removed");
const afterRemoved = runningChild("after-removed");
state.running.set(beforeRemoved.id, beforeRemoved);
state.running.set(removed.id, removed);
state.running.set(afterRemoved.id, afterRemoved);
await handler?.("", contextForSteps([
	"j",
	() => { state.running.delete(removed.id); },
	"x",
]));
eq("removed selection falls back to the nearest row",
	[beforeRemoved.abort.signal.aborted, afterRemoved.abort.signal.aborted], [false, true]);

reset();
const visit = runningChild("visit-me");
state.running.set(visit.id, visit);
await handler?.("", contextForSteps(["\r"]));
eq("enter preserves the visit action", focusCalls, [{ paneId: "%visit-me", zoom: false }]);

reset();
const zoom = runningChild("zoom-me");
state.running.set(zoom.id, zoom);
await handler?.("", contextForSteps(["z"]));
eq("z preserves the visit-and-zoom action", focusCalls, [{ paneId: "%zoom-me", zoom: true }]);

reset();
for (let index = 0; index < 9; index++) capacity.admitLaunch(spawnSpec(`fill-${index}`));
capacity.admitLaunch(spawnSpec("queued"));
for (let index = 0; index < 9; index++) capacity.releaseClaim(`fill-${index}`);
await handler?.("", contextForSteps(["x"]));
eq("x cancels a queued launch", capacity.queuedCount(), 0);
eq("queued cancellation keeps its model notification", sent.map((message) => message.customType), ["subagent_queue_cancelled"]);

reset();
state.delivering.set("delivery", {
	id: "delivery",
	name: "delivery task",
	startedAt: Date.now() - 2_000,
	elapsedSeconds: 2,
	forked: false,
	interactive: false,
	worktree: false,
});
await handler?.("", contextForSteps(["x", "\x1b"]));
eq("delivering rows ignore invalid x and remain visible until Escape",
	(contextForSteps as unknown as { lastDoneCalls?: number }).lastDoneCalls, 1);

reset();
capacity.admitLaunch(spawnSpec("pending"));
await handler?.("", contextForSteps(["x", "\x1b"]));
eq("starting pending rows ignore invalid x and remain visible until Escape",
	(contextForSteps as unknown as { lastDoneCalls?: number }).lastDoneCalls, 1);
capacity.releaseClaim("pending");
reset();
state.resetForShutdown();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
