import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CompactOptions, ContextUsage, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutoCompactConfig } from "../../shared/auto-compact-config.ts";
import { AUTO_COMPACT_STATUS_KEY } from "../../shared/status-keys.ts";
import { createTestEventHarness } from "../../shared/test-event-harness.ts";
import { registerAutoCompact } from "../index.ts";

interface FakeModel {
	id: string;
	provider: string;
	contextWindow: number;
}

interface HarnessState {
	usage: ContextUsage | undefined;
	idle: boolean;
	pending: boolean;
	model: FakeModel | undefined;
}

const DEFAULT_CONFIG: AutoCompactConfig = {
	enabled: true,
	classes: [
		{ windowMax: 300_000, thresholdPercent: 90 },
		{ windowMax: 500_000, thresholdPercent: 70 },
	],
	default: { thresholdTokens: 400_000 },
};

function harness(options: {
	config?: Partial<AutoCompactConfig>;
	usage?: ContextUsage;
	model?: FakeModel;
} = {}) {
	const pi = createTestEventHarness<unknown, unknown, void | Promise<void>>();
	const state: HarnessState = {
		usage: options.usage ?? { tokens: 180_000, contextWindow: 200_000, percent: 90 },
		idle: true,
		pending: false,
		model: options.model,
	};
	const compactions: CompactOptions[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses = new Map<string, string>();
	const ctx = {
		hasUI: true,
		get model() {
			return state.model;
		},
		getContextUsage: () => state.usage,
		isIdle: () => state.idle,
		hasPendingMessages: () => state.pending,
		compact: (compactOptions: CompactOptions = {}) => compactions.push(compactOptions),
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
			setStatus: (key: string, text: string | undefined) => {
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
		},
	};

	registerAutoCompact(pi as unknown as ExtensionAPI, { ...DEFAULT_CONFIG, ...options.config });

	return {
		pi,
		state,
		ctx,
		compactions,
		notifications,
		statuses,
		settle: () => pi.emit("agent_settled", { type: "agent_settled" }, ctx),
		settleAsync: () => pi.emitAsync("agent_settled", { type: "agent_settled" }, ctx),
		endRun: (stopReason: string) =>
			pi.emit(
				"agent_end",
				{
					type: "agent_end",
					messages: [{ role: "user" }, { role: "assistant", stopReason }],
				},
				ctx,
			),
		recordCompaction: (reason: "threshold" | "manual" | "overflow", fromExtension = false) =>
			pi.emit("session_compact", { type: "session_compact", reason, fromExtension }, ctx),
		selectModel: (model: FakeModel | undefined) => {
			state.model = model;
			pi.emit("model_select", { type: "model_select", model }, ctx);
		},
	};
}

const tiny: FakeModel = { id: "tiny-model", provider: "openai", contextWindow: 128_000 };

describe("registerAutoCompact", () => {
	it("the settled handler compacts only at or above the resolved threshold", () => {
		for (const tokens of [179_999, 180_000]) {
			const boundary = harness({
				usage: { tokens, contextWindow: 200_000, percent: (tokens / 200_000) * 100 },
			});
			boundary.settle();
			assert.strictEqual(
				boundary.compactions.length,
				tokens >= 180_000 ? 1 : 0,
				`the settled handler compacts only at or above the resolved threshold (${tokens})`,
			);
		}
	});

	it("unknown usage never triggers or notifies", () => {
		const unknown = harness();
		unknown.state.usage = undefined;
		unknown.settle();
		unknown.state.usage = { tokens: null, contextWindow: 200_000, percent: null };
		unknown.settle();
		assert.strictEqual(unknown.compactions.length, 0, "unknown usage never triggers");
		assert.deepStrictEqual(unknown.notifications, [], "unknown usage stays silent");
	});

	it("high settled usage compacts even when pi was expected to compact first", () => {
		const nativeDidNotCompact = harness({
			usage: { tokens: 120_000, contextWindow: 128_000, percent: 93.75 },
			model: tiny,
		});
		nativeDidNotCompact.settle();
		nativeDidNotCompact.settle();
		assert.strictEqual(
			nativeDidNotCompact.compactions.length,
			1,
			"high settled usage compacts even when pi was expected to compact first",
		);
		assert.deepStrictEqual(
			nativeDidNotCompact.notifications.map(({ level }) => level),
			["info"],
			"high settled usage posts a single info notification without a speculative native warning",
		);
	});

	it("an observed native threshold compaction warns once per model", () => {
		const nativeWarn = harness({
			usage: { tokens: null, contextWindow: 128_000, percent: null },
			model: { id: "tiny-model", provider: "openai", contextWindow: 999_999 },
		});
		nativeWarn.recordCompaction("threshold");
		nativeWarn.settle();
		assert.strictEqual(nativeWarn.compactions.length, 0, "post-native unknown usage does not duplicate compaction");
		assert.deepStrictEqual(
			nativeWarn.notifications,
			[
				{
					message:
						"Auto-compact: Pi's native compaction ran before Auto Compact could evaluate the 115k threshold for tiny-model. If this happens repeatedly, the threshold may be at or past Pi's native compaction point.",
					level: "warning",
				},
			],
			"an observed native threshold compaction warns once with the usage-derived threshold",
		);
		nativeWarn.recordCompaction("threshold");
		assert.strictEqual(nativeWarn.notifications.length, 1, "repeated native compaction for the same model stays quiet");
		nativeWarn.selectModel({ id: "tiny-sibling", provider: "openai", contextWindow: 128_000 });
		nativeWarn.recordCompaction("threshold", true);
		assert.strictEqual(
			nativeWarn.notifications.length,
			2,
			"each model warns independently regardless of who supplied the summary",
		);
	});

	it("manual and overflow compactions do not imply native threshold preemption", () => {
		const nonThresholdCompact = harness({ model: tiny });
		nonThresholdCompact.recordCompaction("manual");
		nonThresholdCompact.recordCompaction("overflow");
		assert.deepStrictEqual(nonThresholdCompact.notifications, []);
	});

	it("a multi-turn workflow compacts exactly once after full settlement", () => {
		const workflow = harness();
		workflow.endRun("toolUse");
		workflow.endRun("stop");
		assert.strictEqual(
			workflow.compactions.length,
			0,
			"multi-turn and queued continuations do not compact before settlement",
		);
		workflow.settle();
		assert.strictEqual(workflow.compactions.length, 1, "fully settled workflow compacts exactly once");
	});

	it("non-idle and pending-message races defer compaction to a safe idle boundary", () => {
		const race = harness();
		race.state.idle = false;
		race.settle();
		race.state.idle = true;
		race.state.pending = true;
		race.settle();
		assert.strictEqual(race.compactions.length, 0, "non-idle and pending-message races do not compact");
		race.state.pending = false;
		race.settle();
		assert.strictEqual(race.compactions.length, 1, "safe idle boundary compacts");
	});

	it("in-flight compaction suppresses duplicates until a later run has fresh high usage", () => {
		const inFlight = harness();
		inFlight.settle();
		inFlight.settle();
		assert.strictEqual(inFlight.compactions.length, 1, "in-flight compaction suppresses duplicate requests");
		assert.deepStrictEqual(
			inFlight.notifications,
			[{ message: "Context at 180k/200k (90%) - auto-compacting.", level: "info" }],
			"trigger notification is posted once",
		);
		inFlight.compactions[0]?.onComplete?.({} as never);
		assert.strictEqual(inFlight.notifications.length, 1, "successful completion adds no extra notification");
		inFlight.state.usage = { tokens: null, contextWindow: 200_000, percent: null };
		inFlight.settle();
		assert.strictEqual(inFlight.compactions.length, 1, "stale post-compaction usage cannot retrigger");
		inFlight.state.usage = { tokens: 181_000, contextWindow: 200_000, percent: 90.5 };
		inFlight.settle();
		assert.strictEqual(inFlight.compactions.length, 2, "a later completed run with fresh high usage can compact");
	});

	// The settlement hold is what keeps print/json teardown from racing an in-flight compaction.
	it("later settlement handlers are held until compaction completes", async () => {
		const holdSuccess = harness();
		let laterHandlerRan = false;
		holdSuccess.pi.on("agent_settled", () => {
			laterHandlerRan = true;
		});
		const holdSettlement = holdSuccess.settleAsync();
		assert.strictEqual(laterHandlerRan, false, "later settlement handlers are held while compaction runs");
		holdSuccess.compactions[0]?.onComplete?.({} as never);
		await holdSettlement;
		assert.strictEqual(laterHandlerRan, true, "later settlement handlers are released after compaction completes");
	});

	it("compaction failure releases the settlement hold", async () => {
		const holdFailure = harness();
		let failureHandlerRan = false;
		holdFailure.pi.on("agent_settled", () => {
			failureHandlerRan = true;
		});
		const failureSettlement = holdFailure.settleAsync();
		holdFailure.compactions[0]?.onError?.(new Error("summary failed"));
		await failureSettlement;
		assert.strictEqual(failureHandlerRan, true, "failure releases the settlement hold");
		assert.strictEqual(holdFailure.notifications.at(-1)?.level, "error", "failure is reported before the hold releases");
	});

	it("an aborted run defers compaction until the next completed run", () => {
		const aborted = harness();
		aborted.endRun("aborted");
		aborted.settle();
		assert.strictEqual(aborted.compactions.length, 0, "aborted run defers compaction");
		assert.deepStrictEqual(
			aborted.notifications,
			[
				{
					message:
						"Context at 180k/200k (90%) - auto-compaction deferred after the aborted run; it will run after the next completed run.",
					level: "info",
				},
			],
			"aborted run posts the deferred notification",
		);
		aborted.endRun("stop");
		aborted.settle();
		assert.strictEqual(aborted.compactions.length, 1, "next completed run compacts normally");
	});

	it("compaction failure latches auto-compaction off until success or model switch", () => {
		const latch = harness({ model: { id: "regular-model", provider: "openai", contextWindow: 200_000 } });
		latch.settle();
		latch.compactions[0]?.onError?.(new Error("Nothing to compact"));
		assert.deepStrictEqual(
			latch.notifications.at(-1),
			{
				message:
					"Auto-compaction failed: Nothing to compact. Auto-compaction is disabled until the next successful compaction or model switch.",
				level: "error",
			},
			"failure is surfaced and latches auto-compaction off",
		);
		assert.strictEqual(
			latch.statuses.get(AUTO_COMPACT_STATUS_KEY),
			"auto-compact paused",
			"failure publishes the paused status",
		);
		latch.settle();
		assert.strictEqual(latch.compactions.length, 1, "failure latch prevents a retry loop");
		latch.recordCompaction("threshold");
		assert.deepStrictEqual(
			latch.notifications.filter(({ level }) => level === "warning"),
			[],
			"native fallback after an extension failure does not warn",
		);
		assert.strictEqual(latch.statuses.has(AUTO_COMPACT_STATUS_KEY), false, "clearing the latch clears the paused status");
		latch.settle();
		assert.strictEqual(latch.compactions.length, 2, "any successful compaction clears the failure latch");
		latch.compactions[1]?.onError?.(new Error("failed again"));
		latch.pi.emit("model_select", { type: "model_select", model: tiny }, latch.ctx);
		assert.strictEqual(latch.statuses.has(AUTO_COMPACT_STATUS_KEY), false, "model switch clears the paused status");
		latch.settle();
		assert.strictEqual(latch.compactions.length, 3, "model switch clears the failure latch");
	});

	it("cancellation pauses auto-compaction without reporting a failure", () => {
		const cancelled = harness();
		cancelled.settle();
		cancelled.compactions[0]?.onError?.(new Error("Compaction cancelled"));
		assert.deepStrictEqual(
			cancelled.notifications.at(-1),
			{
				message:
					"Compaction cancelled - auto-compaction paused until the next successful compaction or model switch.",
				level: "info",
			},
			"cancellation is reported as an info pause, not a failure",
		);
		assert.strictEqual(
			cancelled.statuses.get(AUTO_COMPACT_STATUS_KEY),
			"auto-compact paused",
			"cancellation publishes the paused status",
		);
		cancelled.settle();
		assert.strictEqual(
			cancelled.compactions.length,
			1,
			"cancellation engages the latch so a declined compaction is not re-requested",
		);
	});

	it("late compaction failure after shutdown is inert", () => {
		const shutdown = harness();
		shutdown.settle();
		shutdown.pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, shutdown.ctx);
		assert.doesNotThrow(
			() => shutdown.compactions[0]?.onError?.(new Error("cancelled during shutdown")),
			"late compaction failure after shutdown does not use stale context",
		);
		assert.strictEqual(shutdown.notifications.length, 1, "late compaction failure after shutdown adds no notification");
		assert.strictEqual(
			shutdown.statuses.has(AUTO_COMPACT_STATUS_KEY),
			false,
			"late compaction failure after shutdown publishes no status",
		);
	});

	it("disabled extension never compacts or notifies", () => {
		const disabled = harness({ config: { enabled: false }, model: tiny });
		disabled.recordCompaction("threshold");
		disabled.endRun("aborted");
		disabled.settle();
		assert.strictEqual(disabled.compactions.length, 0, "disabled extension never compacts");
		assert.deepStrictEqual(disabled.notifications, [], "disabled extension posts no notifications or warnings");
	});
});
