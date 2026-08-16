import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
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

after(() => {
	state.running.clear();
	state.delivering.clear();
	state.resetForShutdown();
	capacity.clearQueueForShutdown();
	for (const pending of capacity.pendingLaunches()) capacity.releaseClaim(pending.spec.id);
});

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

describe("running widget", () => {
	it("projects lifecycle rows by attention priority and renders within the configured cap", () => {
		state.running.clear();
		state.delivering.clear();
		capacity.clearQueueForShutdown();

		const laterActive = runningChild("later-active", "active");
		laterActive.startTime = NOW - 1_000;
		const earlierActive = runningChild("earlier-active", "active");
		earlierActive.startTime = NOW - 2_000;
		state.running.set(laterActive.id, laterActive);
		state.running.set(earlierActive.id, earlierActive);
		assert.deepStrictEqual(
			controller.collectLifecycleWidgetRows(NOW).map((row) => row.id),
			["earlier-active", "later-active"],
			"launch time breaks ties within a status bucket");
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
			stopped: true,
		});
		capacity.admitLaunch(resumeSpec("pending"));
		capacity.admitLaunch(spawnSpec("queued"));

		const rows = controller.collectLifecycleWidgetRows(NOW);
		assert.deepStrictEqual(
			rows.map((row) => [row.id, row.status]),
			[
				["delivery", "stopped"],
				["stalled", "stalled"],
				["waiting", "waiting"],
				["starting", "starting"],
				["pending", "starting"],
				["active", "active"],
				["queued", "queued"],
			],
			"attention priority overrides source lifecycle order");
		assert.deepStrictEqual(
			rows.filter((row) => row.lifecycle === "running").map((row) => [row.id, row.forked, row.interactive, row.worktree, row.external]),
			[
				["stalled", true, false, false, false],
				["waiting", false, true, false, false],
				["starting", false, false, true, false],
				["active", false, false, false, true],
			],
			"running flags remain derived after priority sorting");
		assert.deepStrictEqual(
			[rows[0].name, rows[0].harness, rows[5].name, rows[5].harness],
			["delivery task", "claude-code", "active task", "claude-code"],
			"external harness remains separate detailed metadata");

		const compact = controller.compactWidgetSnapshot(NOW);
		assert.deepStrictEqual(compact.rows.map((row) => row.id),
			["delivery", "stalled", "waiting", "starting", "pending"],
			"configured cap selects the priority prefix");
		assert.deepStrictEqual(
			[compact.totalRows, compact.hiddenRows, compact.hiddenStalledRows, compact.hiddenWaitingRows, compact.hiddenQueuedRows],
			[7, 2, 0, 0, 1],
			"hidden subtype counts derive only from hidden rows");
		const compactOne = controller.compactWidgetSnapshot(NOW, 1);
		assert.deepStrictEqual(
			[compactOne.hiddenRows, compactOne.hiddenStalledRows, compactOne.hiddenWaitingRows, compactOne.hiddenQueuedRows],
			[6, 1, 1, 1],
			"hidden summary categories count stalled, waiting, and queued only");

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
		assert.strictEqual(rendered.length, 7,
			"widget renders five detailed rows plus rule and conditional summary");
		assert.ok(rendered.some((line) => line.includes("worker") && !line.includes("[worker]")),
			"compact identifiers are unbracketed and full");
		assert.ok(rendered.some((line) => line.includes("efi  delivery task") && line.includes("stopped"))
			&& !rendered.some((line) => line.includes("claude-code")),
			"compact stopped deliveries use stopped while keeping compact external markers");
		const semanticTheme = { fg: (token: string, text: string) => `<${token}>${text}</${token}>` };
		const semanticRendered = widgetFactory?.({}, semanticTheme).render(100) ?? [];
		assert.ok(semanticRendered.some((line) => line.includes("<muted>worker</muted>")),
			"compact agent identifiers use the muted semantic token");
		assert.ok(semanticRendered.some((line) => line.includes("<muted>efi </muted> delivery task")),
			"compact marker letters use the muted semantic token");
		assert.strictEqual(rendered.at(-1), " +2 more · 1 queued · /subagent-status",
			"summary reports hidden and hidden-queued counts only");
		assert.ok(rendered.every((line) => visibleWidth(line) <= 100),
			"every controller-rendered line is terminal-width safe");

		// Drop below the cap: the summary line must disappear entirely.
		state.running.delete("active");
		capacity.cancelQueued("queued");
		controller.updateRunningWidget();
		const belowCap = widgetFactory?.({}, identityTheme).render(100) ?? [];
		assert.strictEqual(belowCap.length, 6, "summary disappears when no rows are hidden");
		assert.ok(!belowCap.some((line) => line.includes("/subagent-status")),
			"no command hint remains without overflow");

		state.running.clear();
		state.delivering.clear();
		capacity.releaseClaim("pending");
		controller.updateRunningWidget();
		assert.strictEqual(cleared, true, "empty lifecycle state removes the widget");

		const retainedInvalidClaim = resumeSpec("retained-invalid");
		capacity.admitLaunch(retainedInvalidClaim);
		retainedInvalidClaim.agent = "code reviewer";
		const validDuringReload = runningChild("valid-during-reload", "active");
		state.running.set(validDuringReload.id, validDuringReload);
		assert.deepStrictEqual(
			controller.collectLifecycleWidgetRows(NOW).map((row) => row.id), ["valid-during-reload"],
			"invalid retained claims are quarantined from lifecycle projection");
		assert.strictEqual(capacity.pendingLaunchCount(), 0,
			"quarantined claims do not keep an empty pending row alive");
		controller.updateRunningWidget();
		assert.ok(
			(widgetFactory?.({}, identityTheme).render(100) ?? []).some((line) => line.includes("valid-during-reload task")),
			"a valid child still renders beside a quarantined retained claim");
	});
});
