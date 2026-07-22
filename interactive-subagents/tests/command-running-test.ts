import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "subagents-running-command-"));

const state = await import("../state.ts");
const capacity = await import("../capacity.ts");
const command = await import("../command-running.ts");
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
	toolName: index === 0 ? "bash" : undefined,
	toolElapsedSeconds: index === 0 ? 29 : undefined,
	contextTokens: index === 0 ? 84_000 : undefined,
}));
const formatted = command.formatRunningPickerLines(formatterRows, 0, 0, 120, {
	agent: (text) => `<A>${text}</A>`,
	marker: (text) => `<M>${text}</M>`,
});
eq("picker height is bounded to ten detailed rows", formatted.length, 15);
ok("picker shows unbracketed styled identifiers and alphabetic markers",
	formatted.some((line) => line.includes("<A>worker</A>        <M>ei </M> task 1")));
ok("picker reuses the compact widget's right-aligned activity telemetry",
	formatted.some((line) => line.includes("bash 29s · active ·  84k · 00:00 ")));
ok("picker moves the selected exact harness into the action footer",
	formatted[13].includes("harness claude-code")
		&& !formatted.slice(2, 12).some((line) => line.includes("harness claude-code")));
ok("picker puts direct actions before navigation help",
	formatted[13].indexOf("enter: visit") < formatted[13].indexOf("↑/↓"));
const narrowExternal = command.formatRunningPickerLines([formatterRows[0]], 0, 0, 60);
ok("picker drops selected harness detail before direct actions at narrow widths",
	narrowExternal.at(-2)?.includes("enter: visit") === true
		&& narrowExternal.at(-2)?.includes("harness claude-code") === false);
ok("picker never wraps agent identifiers in square brackets", !formatted.some((line) => line.includes("[worker]")));
ok("first viewport includes row 10 but not row 11",
	formatted.some((line) => line.includes("task 10")) && !formatted.some((line) => line.includes("task 11")));
eq("picker reports its first scroll window", formatted[12], " 1–10 of 12");
const scrolled = command.formatRunningPickerLines(formatterRows, 11, 2, 100);
ok("later viewport reaches every hidden lifecycle row",
	scrolled.some((line) => line.includes("task 11") && line.includes("delivering"))
		&& scrolled.some((line) => line.includes("task 12") && line.includes("queued")));
eq("picker reports its last scroll window", scrolled[12], " 3–12 of 12");
ok("queued selection advertises only its valid cancel action",
	scrolled[13].includes("x: cancel queued launch") && !scrolled[13].includes("enter: visit"));
const startingLines = command.formatRunningPickerLines([{
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
	for (const line of command.formatRunningPickerLines(formatterRows, 11, 2, width)) {
		if (visibleWidth(line) > Math.max(0, width)) pickerWidthViolations++;
	}
}
eq("picker never exceeds terminal width", pickerWidthViolations, 0);
const mixedElapsed = command.formatRunningPickerLines([
	{ ...formatterRows[0], id: "under-hour", elapsedSeconds: 3_599 },
	{ ...formatterRows[0], id: "over-hour", elapsedSeconds: 3_600 },
], 0, 0, 100);
eq("mixed elapsed widths keep agent and marker columns aligned while clocks stay right",
	[mixedElapsed[2].indexOf("worker"), mixedElapsed[3].indexOf("worker"), mixedElapsed[2].indexOf("ei"), mixedElapsed[3].indexOf("ei")],
	[2, 2, 9, 9]);
ok("mixed elapsed clocks stay on the far-right edge",
	mixedElapsed[2].endsWith("  59:59 ") && mixedElapsed[3].endsWith("1:00:00 "));

let handler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
const sent: Array<{ customType?: string }> = [];
const fakePi = {
	registerCommand(_name: string, options: { handler: typeof handler }): void {
		handler = options.handler;
	},
	sendMessage(message: { customType?: string }): void {
		sent.push(message);
	},
} as unknown as ExtensionAPI;
const focusCalls: Array<{ paneId: string; zoom: boolean }> = [];
command.registerSubagentRunningCommand(fakePi, (paneId, options) => {
	focusCalls.push({ paneId, zoom: options?.zoom ?? false });
});

const notifications: Array<{ message: string; level: string }> = [];
let renderedDuringStep: string[] = [];
type Step = string | ((component: PickerComponent) => void);
type TestTheme = { fg: (token: string, text: string) => string; bold: (text: string) => string };
const identityTheme: TestTheme = {
	fg: (_token, text) => text,
	bold: (text) => text,
};
function contextForSteps(steps: Step[], theme: TestTheme = identityTheme): ExtensionContext {
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
					theme,
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
const styled = runningChild("styled");
styled.harness = "claude-code";
const stalledAt = Date.now() - 60_001;
styled.activity = { watchdogStartMs: stalledAt, problemSinceMs: stalledAt };
state.running.set(styled.id, styled);
await handler?.("", contextForSteps([
	(component) => { renderedDuringStep = component.render(100); },
	"\x1b",
], {
	fg: (token, text) => `<${token}>${text}</${token}>`,
	bold: (text) => text,
}));
ok("picker agent identifiers use the muted semantic token",
	renderedDuringStep.some((line) => line.includes("<muted>worker</muted>")));
ok("picker external marker uses e with the muted semantic token",
	renderedDuringStep.some((line) => line.includes("<muted>e</muted>")));
ok("picker stalled state uses the warning semantic token",
	renderedDuringStep.some((line) => line.includes("<warning>stalled")));
ok("picker selected harness detail uses the muted semantic token",
	renderedDuringStep.some((line) => line.includes("<muted> harness claude-code</muted>")));

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
