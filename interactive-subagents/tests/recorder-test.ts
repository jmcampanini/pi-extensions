// Unit tests for registerActivityRecorder — the child-side event wiring that
// produces every liveness snapshot. The recorder is the SOLE producer feeding
// the status machine, the widget, subagent_list, and the result economics,
// so its handler bodies need a committed regression gate, not just one-time
// e2e verification. It takes pi's ExtensionAPI as `import type` only, so a
// stub object with a handler registry and a manual emit() drives it under
// plain node. Each section replays one row of the design's section-3 event
// table and asserts the snapshot that lands ON DISK — the file is the only
// thing the parent ever sees.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readActivityFile, registerActivityRecorder, type ActivitySnapshot } from "../activity.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown) {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}: got ${g}, want ${w}`); }
}
function ok(label: string, cond: boolean) {
	if (cond) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}`); }
}

// ── the fake pi emitter ──────────────────────────────────────────────────
// registerActivityRecorder only ever calls pi.on(type, handler), so a
// Map-backed registry with a manual emit is a faithful stand-in.

type Handler = (event: unknown, ctx: unknown) => void;

function fakePi(): { on: (type: string, handler: Handler) => void; emit: (type: string, event: unknown, ctx: unknown) => void } {
	const handlers = new Map<string, Handler[]>();
	return {
		on(type: string, handler: Handler): void {
			const list = handlers.get(type) ?? [];
			list.push(handler);
			handlers.set(type, list);
		},
		emit(type: string, event: unknown, ctx: unknown): void {
			for (const handler of handlers.get(type) ?? []) handler(event, ctx);
		},
	};
}

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

function read(): ActivitySnapshot {
	const result = readActivityFile(activityFile, "run1");
	if (result.kind !== "valid") throw new Error(`expected a valid on-disk snapshot, got ${JSON.stringify(result)}`);
	return result.snapshot;
}

// ── registration: snapshot #1 proves liveness before any run ─────────────

const pi = fakePi();
const beforeRegister = Date.now();
registerActivityRecorder(pi as unknown as ExtensionAPI, { runId: "run1", activityFile });
let s = read();
eq("initial write: sequence 1", s.sequence, 1);
eq("initial write: runId stamped", s.runId, "run1");
eq("initial write: pid is this process", s.pid, process.pid);
eq("initial write: idle empty state",
	{ inRun: s.inRun, runsCompleted: s.runsCompleted, activeTools: s.activeTools, modelId: s.modelId, context: s.context, costUsd: s.costUsd },
	{ inRun: false, runsCompleted: 0, activeTools: [], modelId: null, context: null, costUsd: 0 });
ok("initial write: updatedAt stamped from the child clock", s.updatedAt >= beforeRegister && s.updatedAt <= Date.now());

// ── session_start: model + context refresh ───────────────────────────────

pi.emit("session_start", { reason: "start" }, ctxNoUsage);
s = read();
eq("session_start: sequence bumps", s.sequence, 2);
eq("session_start: model recorded", s.modelId, "prov/model");
eq("session_start: undefined usage stays null, never 0", s.context, null);

// ── agent_start: the run opener ──────────────────────────────────────────

pi.emit("agent_start", {}, ctxFull);
s = read();
eq("agent_start: inRun flips true", s.inRun, true);
eq("agent_start: sequence bumps", s.sequence, 3);

// ── tool start/end: the parallel tool map ────────────────────────────────

pi.emit("tool_execution_start", { toolCallId: "t1", toolName: "bash" }, ctxFull);
pi.emit("tool_execution_start", { toolCallId: "t2", toolName: "read" }, ctxFull);
s = read();
eq("parallel tools: both recorded, insertion order",
	s.activeTools.map((t) => `${t.toolCallId}:${t.name}`), ["t1:bash", "t2:read"]);
ok("tool start stamps a child-clock startedAt", s.activeTools.every((t) => t.startedAt >= beforeRegister));

pi.emit("tool_execution_end", { toolCallId: "t1", toolName: "bash" }, ctxFull);
eq("end removes only its own tool", read().activeTools.map((t) => t.toolCallId), ["t2"]);
pi.emit("tool_execution_end", { toolCallId: "t2", toolName: "read" }, ctxFull);
eq("all ends leave the map empty", read().activeTools, []);

// ── turn_end: assistant-narrowed cost accumulation ───────────────────────

pi.emit("turn_end", { message: { role: "assistant", usage: { cost: { total: 0.25 } } } }, ctxFull);
s = read();
eq("assistant turn_end accumulates cost", s.costUsd, 0.25);
eq("assistant turn_end refreshes context", s.context, { tokens: 84_000, window: 200_000, percent: 42 });

const sequenceBeforeUserTurn = read().sequence;
pi.emit("turn_end", { message: { role: "user", usage: { cost: { total: 99 } } } }, ctxFull);
eq("non-assistant turn_end writes nothing at all", read().sequence, sequenceBeforeUserTurn);
eq("non-assistant cost never counted", read().costUsd, 0.25);

pi.emit("turn_end", { message: { role: "assistant" } }, ctxFull);
eq("assistant turn without usage sums harmlessly", read().costUsd, 0.25);

// The non-finite guard: hostile or broken cost values must never poison the
// accumulator (JSON could not even carry the poisoned sum — see the parser).
pi.emit("turn_end", { message: { role: "assistant", usage: { cost: { total: Number.POSITIVE_INFINITY } } } }, ctxFull);
pi.emit("turn_end", { message: { role: "assistant", usage: { cost: { total: Number.NaN } } } }, ctxFull);
pi.emit("turn_end", { message: { role: "assistant", usage: { cost: { total: "9" } } } }, ctxFull);
eq("non-finite and non-number costs are ignored", read().costUsd, 0.25);

pi.emit("turn_end", { message: { role: "assistant", usage: { cost: { total: 0.05 } } } }, ctxFull);
ok("a later assistant turn keeps accumulating", Math.abs(read().costUsd - 0.3) < 1e-9);

// ── agent_settled: the run closer ────────────────────────────────────────

pi.emit("tool_execution_start", { toolCallId: "dangling", toolName: "bash" }, ctxFull);
pi.emit("agent_settled", {}, ctxPostCompact);
s = read();
eq("settled: inRun false", s.inRun, false);
eq("settled: runsCompleted increments", s.runsCompleted, 1);
eq("settled: dangling tools cleared defensively", s.activeTools, []);
eq("settled: post-compaction nulls survive as null, never 0", s.context, { tokens: null, window: 200_000, percent: null });

// ── model_select: keeps the percent denominator honest ───────────────────

pi.emit("model_select", { model: { id: "prov/other" } }, ctxOtherModel);
s = read();
eq("model_select: model updated", s.modelId, "prov/other");
eq("model_select: context refreshed", s.context, { tokens: 84_000, window: 200_000, percent: 42 });

// ── session_shutdown: the final write ────────────────────────────────────
// ctx.shutdown() from a tool is deferred until agent_settled, so the only
// real dangling-start path is a tool loop aborted via a thrown error — the
// final write clears it and lands inRun: false.

pi.emit("agent_start", {}, ctxFull);
pi.emit("tool_execution_start", { toolCallId: "d1", toolName: "bash" }, ctxFull);
s = read();
eq("aborted-loop dangling entry present before shutdown", s.activeTools.length, 1);
eq("mid-run before shutdown: inRun true", s.inRun, true);
pi.emit("session_shutdown", { reason: "quit" }, ctxFull);
s = read();
eq("shutdown: final write lands inRun false", s.inRun, false);
eq("shutdown: dangling tools cleared", s.activeTools, []);
eq("shutdown: run history preserved", s.runsCompleted, 1);

// ── in-pane /reload: a fresh registration resets per-process counters ────
// The parent-side (updatedAt, sequence) ordering and the everSawRun latch
// absorb this — pinned in activity-test.ts and status-test.ts; here we pin
// only what the fresh process actually writes.

const piReloaded = fakePi();
registerActivityRecorder(piReloaded as unknown as ExtensionAPI, { runId: "run1", activityFile });
s = read();
eq("reload: fresh process restarts at sequence 1", s.sequence, 1);
eq("reload: runsCompleted and cost reset to 0", { runs: s.runsCompleted, cost: s.costUsd }, { runs: 0, cost: 0 });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
