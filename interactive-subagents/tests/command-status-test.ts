import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "subagents-running-command-"));

const state = await import("../state.ts");
const capacity = await import("../capacity.ts");
const command = await import("../command-status.ts");
const runningWidget = await import("../running-widget.ts");
type LifecycleWidgetRow = import("../running-widget.ts").LifecycleWidgetRow;
type RunningSubagent = import("../state.ts").RunningSubagent;
type SpawnSpec = import("../capacity.ts").SpawnSpec;
type PickerComponent = { render(width: number): string[]; handleInput(data: string): void };

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

describe("formatStatusPickerLines", () => {
	const formatted = command.formatStatusPickerLines(formatterRows, 0, 0, 120, {
		agent: (text) => `<A>${text}</A>`,
		marker: (text) => `<M>${text}</M>`,
	});
	const scrolled = command.formatStatusPickerLines(formatterRows, 11, 2, 100);

	it("picker height is bounded to ten detailed rows", () => {
		assert.strictEqual(formatted.length, 15);
	});

	it("picker omits the redundant row-count heading", () => {
		assert.ok(!formatted.some((line) => line.includes("Sub-agents (")));
	});

	it("picker leaves a blank line before its controls", () => {
		assert.strictEqual(formatted[12], "");
	});

	it("picker shows unbracketed styled identifiers and alphabetic markers", () => {
		assert.ok(formatted.some((line) => line.includes("<A>worker</A>        <M>ei </M> task 1")));
	});

	it("picker reuses the compact widget's right-aligned activity telemetry", () => {
		assert.ok(formatted.some((line) => line.includes("bash 29s · active ·  84k · 00:00 ")));
	});

	it("picker moves the selected exact harness into the action footer", () => {
		assert.ok(formatted[13].includes("harness claude-code")
			&& !formatted.slice(2, 12).some((line) => line.includes("harness claude-code")));
	});

	it("picker puts direct actions before navigation help", () => {
		assert.ok(formatted[13].indexOf("enter: visit") < formatted[13].indexOf("↑/↓"));
	});

	it("picker drops selected harness detail before direct actions at narrow widths", () => {
		const narrowExternal = command.formatStatusPickerLines([formatterRows[0]], 0, 0, 60);
		assert.ok(narrowExternal.at(-2)?.includes("enter: visit") === true
			&& narrowExternal.at(-2)?.includes("harness claude-code") === false);
	});

	it("picker never wraps agent identifiers in square brackets", () => {
		assert.ok(!formatted.some((line) => line.includes("[worker]")));
	});

	it("first viewport includes row 10 but not row 11", () => {
		assert.ok(formatted.some((line) => line.includes("task 10")) && !formatted.some((line) => line.includes("task 11")));
	});

	it("picker reports its first scroll window", () => {
		assert.strictEqual(formatted[11], " 1–10 of 12");
	});

	it("later viewport reaches every hidden lifecycle row", () => {
		assert.ok(scrolled.some((line) => line.includes("task 11") && line.includes("delivering"))
			&& scrolled.some((line) => line.includes("task 12") && line.includes("queued")));
	});

	it("picker reports its last scroll window", () => {
		assert.strictEqual(scrolled[11], " 3–12 of 12");
	});

	it("queued selection advertises only its valid cancel action", () => {
		assert.ok(scrolled[13].includes("x: cancel queued launch") && !scrolled[13].includes("enter: visit"));
	});

	it("pending launch uses only the user-facing starting term and offers cancellation", () => {
		const startingLines = command.formatStatusPickerLines([{
			id: "setup",
			lifecycle: "pending",
			startedAt: 0,
			name: "setup task",
			elapsedSeconds: 1,
			status: "starting",
		}], 0, 0, 80);
		assert.ok(startingLines.join("\n").includes("starting")
			&& startingLines.join("\n").includes("x: cancel launch")
			&& !startingLines.join("\n").includes("pending")
			&& !startingLines.join("\n").includes("launching"));
	});

	it("stopped delivery explains that its stopped notice is on the way", () => {
		const stoppedDeliveryLines = command.formatStatusPickerLines([{
			id: "stopped-delivery",
			lifecycle: "delivering",
			startedAt: 0,
			name: "stopped task",
			elapsedSeconds: 1,
			status: "stopped",
		}], 0, 0, 100);
		assert.ok(stoppedDeliveryLines.join("\n").includes("stopped; its stopped notice is on its way"));
	});

	it("picker never exceeds terminal width", () => {
		for (let width = -2; width <= 90; width++) {
			for (const line of command.formatStatusPickerLines(formatterRows, 11, 2, width)) {
				assert.ok(visibleWidth(line) <= Math.max(0, width), `picker width ${width} never overflows`);
			}
		}
	});

	it("mixed elapsed widths keep agent and marker columns aligned while clocks stay right", () => {
		const mixedElapsed = command.formatStatusPickerLines([
			{ ...formatterRows[0], id: "under-hour", elapsedSeconds: 3_599 },
			{ ...formatterRows[0], id: "over-hour", elapsedSeconds: 3_600 },
		], 0, 0, 100);
		assert.deepStrictEqual(
			[mixedElapsed[1].indexOf("worker"), mixedElapsed[2].indexOf("worker"), mixedElapsed[1].indexOf("ei"), mixedElapsed[2].indexOf("ei")],
			[2, 2, 9, 9]);
		assert.ok(mixedElapsed[1].endsWith("  59:59 ") && mixedElapsed[2].endsWith("1:00:00 "),
			"mixed elapsed clocks stay on the far-right edge");
	});
});

describe("registerSubagentStatusCommand", () => {
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

	const notifications: Array<{ message: string; level: string }> = [];
	const widgetTransitions: Array<{ key: string; content: unknown }> = [];
	let widgetTransitionCountDuringPicker = 0;
	let renderedDuringStep: string[] = [];
	type Step = string | ((component: PickerComponent) => void);
	type TestTheme = { fg: (token: string, text: string) => string; bold: (text: string) => string };
	const identityTheme: TestTheme = {
		fg: (_token, text) => text,
		bold: (text) => text,
	};
	function contextForSteps(steps: Step[], theme: TestTheme = identityTheme): ExtensionContext {
		const context = {
			hasUI: true,
			ui: {
				notify(message: string, level: string): void {
					notifications.push({ message, level });
				},
				setWidget(key: string, content: unknown): void {
					widgetTransitions.push({ key, content });
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
		state.setLatestCtx(context);
		return context;
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
		widgetTransitions.length = 0;
		widgetTransitionCountDuringPicker = 0;
		renderedDuringStep = [];
	}

	beforeEach(reset);

	after(() => {
		reset();
		state.resetForShutdown();
	});

	it("command registers the clean-break status name", () => {
		assert.strictEqual(registeredCommand, "subagent-status");
	});

	it("picker suppresses the compact widget while open and renders semantic-token styling", async () => {
		const styled = runningChild("styled");
		styled.harness = "claude-code";
		const stalledAt = Date.now() - 60_001;
		styled.activity = { watchdogStartMs: stalledAt, problemSinceMs: stalledAt };
		state.running.set(styled.id, styled);
		await handler?.("", contextForSteps([
			(component) => {
				runningWidget.updateRunningWidget();
				widgetTransitionCountDuringPicker = widgetTransitions.length;
				renderedDuringStep = component.render(100);
			},
			"\x1b",
		], {
			fg: (token, text) => `<${token}>${text}</${token}>`,
			bold: (text) => text,
		}));
		assert.deepStrictEqual(
			[
				widgetTransitionCountDuringPicker,
				...widgetTransitions.map(({ key, content }) => [key, content === undefined ? "clear" : typeof content]),
			],
			[1, ["interactive-subagents", "clear"], ["interactive-subagents", "function"]],
			"picker clears the compact widget, suppresses live repaints, then restores it");
		assert.ok(renderedDuringStep.some((line) => line.includes("styled task") && !line.includes("<accent>styled task</accent>")),
			"picker task text matches the compact widget instead of using accent styling");
		assert.ok(renderedDuringStep.some((line) => line.includes("<muted>worker</muted>")),
			"picker agent identifiers use the muted semantic token");
		assert.ok(renderedDuringStep.some((line) => line.includes("<muted>e</muted>")),
			"picker external marker uses e with the muted semantic token");
		assert.ok(renderedDuringStep.some((line) => line.includes("<warning>stalled")),
			"picker stalled state uses the warning semantic token");
		assert.ok(renderedDuringStep.some((line) => line.includes("<muted> harness claude-code</muted>")),
			"picker selected harness detail uses the muted semantic token");
	});

	it("picker restores the compact widget when the custom UI throws", async () => {
		const pickerFailure = runningChild("picker-failure");
		state.running.set(pickerFailure.id, pickerFailure);
		const failingContext = contextForSteps([]);
		(failingContext.ui as unknown as { custom: () => Promise<never> }).custom = async () => {
			throw new Error("picker failed");
		};
		let pickerFailureSurfaced = false;
		try {
			await handler?.("", failingContext);
		} catch {
			pickerFailureSurfaced = true;
		}
		assert.deepStrictEqual(
			[
				pickerFailureSurfaced,
				...widgetTransitions.map(({ content }) => content === undefined ? "clear" : typeof content),
			],
			[true, "clear", "function"]);
	});

	it("live picker refreshes open rows and keeps selection anchored by id", async () => {
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
					stopped: false,
				});
				selected.startTime = Date.now() - 61_000;
				renderedDuringStep = component.render(100);
			},
			"x",
		]));
		assert.ok(renderedDuringStep.some((line) => line.includes("delivery task")),
			"live picker adds higher-priority rows while open");
		assert.ok(renderedDuringStep.some((line) => line.includes("01:01") || line.includes("01:00")),
			"live picker refreshes elapsed clocks");
		assert.deepStrictEqual(
			[selected.stopRequester, selected.abort.signal.aborted, first.abort.signal.aborted], ["user", true, false],
			"selection stays anchored by id after live reprioritization");
	});

	it("removed selection falls back to the nearest row", async () => {
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
		assert.deepStrictEqual(
			[beforeRemoved.abort.signal.aborted, afterRemoved.abort.signal.aborted], [false, true]);
	});

	it("enter preserves the visit action", async () => {
		const visit = runningChild("visit-me");
		state.running.set(visit.id, visit);
		await handler?.("", contextForSteps(["\r"]));
		assert.deepStrictEqual(focusCalls, [{ paneId: "%visit-me", zoom: false }]);
	});

	it("z preserves the visit-and-zoom action", async () => {
		const zoom = runningChild("zoom-me");
		state.running.set(zoom.id, zoom);
		await handler?.("", contextForSteps(["z"]));
		assert.deepStrictEqual(focusCalls, [{ paneId: "%zoom-me", zoom: true }]);
	});

	it("x routes queued cancellation through the shared primitive", async () => {
		for (let index = 0; index < 9; index++) capacity.admitLaunch(spawnSpec(`fill-${index}`));
		capacity.admitLaunch(spawnSpec("queued"));
		for (let index = 0; index < 9; index++) capacity.releaseClaim(`fill-${index}`);
		await handler?.("", contextForSteps(["x"]));
		assert.deepStrictEqual(
			[capacity.queuedCount(), capacity.cancellationFor("queued")?.requester], [0, "user"],
			"x routes queued cancellation through the shared primitive");
		assert.deepStrictEqual(sent.map((message) => message.customType), ["subagent_queue_cancelled"],
			"queued cancellation keeps its model notification");
	});

	it("delivering rows ignore invalid x and remain visible until Escape", async () => {
		state.delivering.set("delivery", {
			id: "delivery",
			name: "delivery task",
			startedAt: Date.now() - 2_000,
			elapsedSeconds: 2,
			forked: false,
			interactive: false,
			worktree: false,
			stopped: false,
		});
		await handler?.("", contextForSteps(["x", "\x1b"]));
		assert.strictEqual((contextForSteps as unknown as { lastDoneCalls?: number }).lastDoneCalls, 1);
	});

	it("x routes a starting pending row through the shared primitive", async () => {
		capacity.admitLaunch(spawnSpec("pending"));
		await handler?.("", contextForSteps(["x"]));
		assert.deepStrictEqual(
			[
				(contextForSteps as unknown as { lastDoneCalls?: number }).lastDoneCalls,
				capacity.cancellationFor("pending")?.requester,
			],
			[1, "user"]);
		capacity.releaseClaim("pending");
	});
});
