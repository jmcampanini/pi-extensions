// Unit tests for registerActivityRecorder — the child-side event wiring that
// produces every liveness snapshot. The recorder is the SOLE producer feeding
// the status machine, the widget, subagent_status, and the result economics,
// so its handler bodies need a committed regression gate, not just one-time
// e2e verification. It takes pi's ExtensionAPI as `import type` only, so a
// stub object with a handler registry and a manual emit() drives it under
// plain node. The single lifecycle test replays the design's section-3 event
// table in order and asserts the snapshot that lands ON DISK — the file is
// the only thing the parent ever sees.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTestEventHarness } from "../../shared/test-event-harness.ts";
import { readActivityFile, registerActivityRecorder, type ActivitySnapshot } from "../activity.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ctx stand-ins: the recorder reads only ctx.model?.id and ctx.getContextUsage().
const usage = { tokens: 84_000, contextWindow: 200_000, percent: 42 };
const ctxFull = { model: { id: "prov/model" }, getContextUsage: () => usage };
const ctxNoUsage = { model: { id: "prov/model" }, getContextUsage: () => undefined };
const ctxPostCompact = {
	model: { id: "prov/model" },
	getContextUsage: () => ({ tokens: null, contextWindow: 200_000, percent: null }),
};
const ctxOtherModel = { model: { id: "prov/other" }, getContextUsage: () => usage };

const dir = mkdtempSync(join(tmpdir(), "subagents-recorder-"));
const activityFile = join(dir, "child.jsonl.activity");

after(() => {
	rmSync(dir, { recursive: true, force: true });
});

function read(): ActivitySnapshot {
	const result = readActivityFile(activityFile, "run1");
	assert.ok(result.kind === "valid", `expected a valid on-disk snapshot, got ${JSON.stringify(result)}`);
	return result.snapshot;
}

describe("registerActivityRecorder", () => {
	it("records every lifecycle event's snapshot on disk in order", () => {
		// ── registration: snapshot #1 proves liveness before any run ─────────
		const pi = createTestEventHarness();
		const beforeRegister = Date.now();
		registerActivityRecorder(pi as unknown as ExtensionAPI, { runId: "run1", activityFile });
		let s = read();
		assert.strictEqual(s.sequence, 1, "initial write: sequence 1");
		assert.strictEqual(s.runId, "run1", "initial write: runId stamped");
		assert.strictEqual(s.pid, process.pid, "initial write: pid is this process");
		assert.deepStrictEqual(
			{ inRun: s.inRun, runsCompleted: s.runsCompleted, activeTools: s.activeTools, modelId: s.modelId, context: s.context, costUsd: s.costUsd },
			{ inRun: false, runsCompleted: 0, activeTools: [], modelId: null, context: null, costUsd: 0 },
			"initial write: idle empty state");
		assert.ok(s.updatedAt >= beforeRegister && s.updatedAt <= Date.now(),
			"initial write: updatedAt stamped from the child clock");

		// ── session_start: model + context refresh ───────────────────────────
		pi.emit("session_start", { reason: "start" }, ctxNoUsage);
		s = read();
		assert.strictEqual(s.sequence, 2, "session_start: sequence bumps");
		assert.strictEqual(s.modelId, "prov/model", "session_start: model recorded");
		assert.strictEqual(s.context, null, "session_start: undefined usage stays null, never 0");

		// ── agent_start: the run opener ──────────────────────────────────────
		pi.emit("agent_start", {}, ctxFull);
		s = read();
		assert.strictEqual(s.inRun, true, "agent_start: inRun flips true");
		assert.strictEqual(s.sequence, 3, "agent_start: sequence bumps");

		// ── tool start/end: the parallel tool map ────────────────────────────
		pi.emit("tool_execution_start", { toolCallId: "t1", toolName: "bash" }, ctxFull);
		pi.emit("tool_execution_start", { toolCallId: "t2", toolName: "read" }, ctxFull);
		s = read();
		assert.deepStrictEqual(
			s.activeTools.map((t) => `${t.toolCallId}:${t.name}`), ["t1:bash", "t2:read"],
			"parallel tools: both recorded, insertion order");
		assert.ok(s.activeTools.every((t) => t.startedAt >= beforeRegister),
			"tool start stamps a child-clock startedAt");

		pi.emit("tool_execution_end", { toolCallId: "t1", toolName: "bash" }, ctxFull);
		assert.deepStrictEqual(read().activeTools.map((t) => t.toolCallId), ["t2"],
			"end removes only its own tool");
		pi.emit("tool_execution_end", { toolCallId: "t2", toolName: "read" }, ctxFull);
		assert.deepStrictEqual(read().activeTools, [], "all ends leave the map empty");

		// ── turn_end: assistant-narrowed cost accumulation ───────────────────
		pi.emit("turn_end", { message: { role: "assistant", usage: { cost: { total: 0.25 } } } }, ctxFull);
		s = read();
		assert.strictEqual(s.costUsd, 0.25, "assistant turn_end accumulates cost");
		assert.deepStrictEqual(s.context, { tokens: 84_000, window: 200_000, percent: 42 },
			"assistant turn_end refreshes context");

		const sequenceBeforeUserTurn = read().sequence;
		pi.emit("turn_end", { message: { role: "user", usage: { cost: { total: 99 } } } }, ctxFull);
		assert.strictEqual(read().sequence, sequenceBeforeUserTurn, "non-assistant turn_end writes nothing at all");
		assert.strictEqual(read().costUsd, 0.25, "non-assistant cost never counted");

		pi.emit("turn_end", { message: { role: "assistant" } }, ctxFull);
		assert.strictEqual(read().costUsd, 0.25, "assistant turn without usage sums harmlessly");

		// The non-finite guard: hostile or broken cost values must never poison the
		// accumulator (JSON could not even carry the poisoned sum — see the parser).
		pi.emit("turn_end", { message: { role: "assistant", usage: { cost: { total: Number.POSITIVE_INFINITY } } } }, ctxFull);
		pi.emit("turn_end", { message: { role: "assistant", usage: { cost: { total: Number.NaN } } } }, ctxFull);
		pi.emit("turn_end", { message: { role: "assistant", usage: { cost: { total: "9" } } } }, ctxFull);
		assert.strictEqual(read().costUsd, 0.25, "non-finite and non-number costs are ignored");

		pi.emit("turn_end", { message: { role: "assistant", usage: { cost: { total: 0.05 } } } }, ctxFull);
		assert.ok(Math.abs(read().costUsd - 0.3) < 1e-9, "a later assistant turn keeps accumulating");

		// ── agent_settled: the run closer ────────────────────────────────────
		pi.emit("tool_execution_start", { toolCallId: "dangling", toolName: "bash" }, ctxFull);
		pi.emit("agent_settled", {}, ctxPostCompact);
		s = read();
		assert.strictEqual(s.inRun, false, "settled: inRun false");
		assert.strictEqual(s.runsCompleted, 1, "settled: runsCompleted increments");
		assert.deepStrictEqual(s.activeTools, [], "settled: dangling tools cleared defensively");
		assert.deepStrictEqual(s.context, { tokens: null, window: 200_000, percent: null },
			"settled: post-compaction nulls survive as null, never 0");

		// ── model_select: keeps the percent denominator honest ───────────────
		pi.emit("model_select", { model: { id: "prov/other" } }, ctxOtherModel);
		s = read();
		assert.strictEqual(s.modelId, "prov/other", "model_select: model updated");
		assert.deepStrictEqual(s.context, { tokens: 84_000, window: 200_000, percent: 42 },
			"model_select: context refreshed");

		// ── session_shutdown: the final write ────────────────────────────────
		// ctx.shutdown() from a tool is deferred until agent_settled, so the only
		// real dangling-start path is a tool loop aborted via a thrown error — the
		// final write clears it and lands inRun: false.
		pi.emit("agent_start", {}, ctxFull);
		pi.emit("tool_execution_start", { toolCallId: "d1", toolName: "bash" }, ctxFull);
		s = read();
		assert.strictEqual(s.activeTools.length, 1, "aborted-loop dangling entry present before shutdown");
		assert.strictEqual(s.inRun, true, "mid-run before shutdown: inRun true");
		pi.emit("session_shutdown", { reason: "quit" }, ctxFull);
		s = read();
		assert.strictEqual(s.inRun, false, "shutdown: final write lands inRun false");
		assert.deepStrictEqual(s.activeTools, [], "shutdown: dangling tools cleared");
		assert.strictEqual(s.runsCompleted, 1, "shutdown: run history preserved");
	});

	// ── in-pane /reload: a fresh registration resets per-process counters ────
	// The parent-side (updatedAt, sequence) ordering and the everSawRun latch
	// absorb this — pinned in activity-test.ts and status-test.ts; here we pin
	// only what the fresh process actually writes.
	it("a fresh registration resets per-process counters", () => {
		const piReloaded = createTestEventHarness();
		registerActivityRecorder(piReloaded as unknown as ExtensionAPI, { runId: "run1", activityFile });
		const s = read();
		assert.strictEqual(s.sequence, 1, "reload: fresh process restarts at sequence 1");
		assert.deepStrictEqual({ runs: s.runsCompleted, cost: s.costUsd }, { runs: 0, cost: 0 },
			"reload: runsCompleted and cost reset to 0");
	});
});
