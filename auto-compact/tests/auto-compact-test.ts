import type { CompactOptions, ContextUsage, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutoCompactConfig } from "../../shared/auto-compact-config.ts";
import { AUTO_COMPACT_STATUS_KEY } from "../../shared/status-keys.ts";
import { registerAutoCompact } from "../index.ts";

let pass = 0;
let fail = 0;

function eq(label: string, got: unknown, want: unknown): void {
	const actual = JSON.stringify(got);
	const expected = JSON.stringify(want);
	if (actual === expected) {
		pass++;
		console.log(`  ok  ${label}`);
	} else {
		fail++;
		console.log(`  FAIL ${label}: got ${actual}, want ${expected}`);
	}
}

type Handler = (event: any, ctx: any) => void | Promise<void>;

function fakePi(): {
	on: (type: string, handler: Handler) => void;
	emit: (type: string, event: unknown, ctx: unknown) => void;
	emitAsync: (type: string, event: unknown, ctx: unknown) => Promise<void>;
} {
	const handlers = new Map<string, Handler[]>();
	return {
		on(type, handler): void {
			const registered = handlers.get(type) ?? [];
			registered.push(handler);
			handlers.set(type, registered);
		},
		emit(type, event, ctx): void {
			for (const handler of handlers.get(type) ?? []) void handler(event, ctx);
		},
		async emitAsync(type, event, ctx): Promise<void> {
			for (const handler of handlers.get(type) ?? []) await handler(event, ctx);
		},
	};
}

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
	const pi = fakePi();
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
		selectModel: (model: FakeModel | undefined) => {
			state.model = model;
			pi.emit("model_select", { type: "model_select", model }, ctx);
		},
	};
}

for (const tokens of [179_999, 180_000]) {
	const boundary = harness({
		usage: { tokens, contextWindow: 200_000, percent: (tokens / 200_000) * 100 },
	});
	boundary.settle();
	eq(
		`the settled handler compacts only at or above the resolved threshold (${tokens})`,
		boundary.compactions.length,
		tokens >= 180_000 ? 1 : 0,
	);
}

const unknown = harness();
unknown.state.usage = undefined;
unknown.settle();
unknown.state.usage = { tokens: null, contextWindow: 200_000, percent: null };
unknown.settle();
eq("unknown usage never triggers", unknown.compactions.length, 0);
eq("unknown usage stays silent", unknown.notifications, []);

const tiny: FakeModel = { id: "tiny-model", provider: "openai", contextWindow: 128_000 };
const nativeDidNotCompact = harness({
	usage: { tokens: 120_000, contextWindow: 128_000, percent: 93.75 },
	model: tiny,
});
nativeDidNotCompact.settle();
nativeDidNotCompact.settle();
eq("high settled usage compacts even when pi was expected to compact first", nativeDidNotCompact.compactions.length, 1);
eq(
	"high settled usage posts a single info notification without a speculative native warning",
	nativeDidNotCompact.notifications.map(({ level }) => level),
	["info"],
);

const nativeWarn = harness({
	usage: { tokens: null, contextWindow: 128_000, percent: null },
	model: { id: "tiny-model", provider: "openai", contextWindow: 999_999 },
});
nativeWarn.pi.emit(
	"session_compact",
	{ type: "session_compact", reason: "threshold", fromExtension: false },
	nativeWarn.ctx,
);
nativeWarn.settle();
eq("post-native unknown usage does not duplicate compaction", nativeWarn.compactions.length, 0);
eq("an observed native threshold compaction warns once with the usage-derived threshold", nativeWarn.notifications, [
	{
		message:
			"Auto-compact: Pi's native compaction ran before Auto Compact could evaluate the 115k threshold for tiny-model. If this happens repeatedly, the threshold may be at or past Pi's native compaction point.",
		level: "warning",
	},
]);
nativeWarn.pi.emit(
	"session_compact",
	{ type: "session_compact", reason: "threshold", fromExtension: false },
	nativeWarn.ctx,
);
eq("repeated native compaction for the same model stays quiet", nativeWarn.notifications.length, 1);
nativeWarn.selectModel({ id: "tiny-sibling", provider: "openai", contextWindow: 128_000 });
nativeWarn.pi.emit(
	"session_compact",
	{ type: "session_compact", reason: "threshold", fromExtension: true },
	nativeWarn.ctx,
);
eq("each model warns independently regardless of who supplied the summary", nativeWarn.notifications.length, 2);

const nonThresholdCompact = harness({ model: tiny });
nonThresholdCompact.pi.emit(
	"session_compact",
	{ type: "session_compact", reason: "manual", fromExtension: false },
	nonThresholdCompact.ctx,
);
nonThresholdCompact.pi.emit(
	"session_compact",
	{ type: "session_compact", reason: "overflow", fromExtension: false },
	nonThresholdCompact.ctx,
);
eq("manual and overflow compactions do not imply native threshold preemption", nonThresholdCompact.notifications, []);

const workflow = harness();
workflow.endRun("toolUse");
workflow.endRun("stop");
eq("multi-turn and queued continuations do not compact before settlement", workflow.compactions.length, 0);
workflow.settle();
eq("fully settled workflow compacts exactly once", workflow.compactions.length, 1);

const race = harness();
race.state.idle = false;
race.settle();
race.state.idle = true;
race.state.pending = true;
race.settle();
eq("non-idle and pending-message races do not compact", race.compactions.length, 0);
race.state.pending = false;
race.settle();
eq("safe idle boundary compacts", race.compactions.length, 1);

const inFlight = harness();
inFlight.settle();
inFlight.settle();
eq("in-flight compaction suppresses duplicate requests", inFlight.compactions.length, 1);
eq("trigger notification is posted once", inFlight.notifications, [
	{ message: "Context at 180k/200k (90%) — auto-compacting.", level: "info" },
]);
inFlight.compactions[0]?.onComplete?.({} as never);
eq("successful completion adds no extra notification", inFlight.notifications.length, 1);
inFlight.state.usage = { tokens: null, contextWindow: 200_000, percent: null };
inFlight.settle();
eq("stale post-compaction usage cannot retrigger", inFlight.compactions.length, 1);
inFlight.state.usage = { tokens: 181_000, contextWindow: 200_000, percent: 90.5 };
inFlight.settle();
eq("a later completed run with fresh high usage can compact", inFlight.compactions.length, 2);

// The settlement hold is what keeps print/json teardown from racing an in-flight compaction.
const holdSuccess = harness();
let laterHandlerRan = false;
holdSuccess.pi.on("agent_settled", () => {
	laterHandlerRan = true;
});
const holdSettlement = holdSuccess.settleAsync();
eq("later settlement handlers are held while compaction runs", laterHandlerRan, false);
holdSuccess.compactions[0]?.onComplete?.({} as never);
await holdSettlement;
eq("later settlement handlers are released after compaction completes", laterHandlerRan, true);

const holdFailure = harness();
let failureHandlerRan = false;
holdFailure.pi.on("agent_settled", () => {
	failureHandlerRan = true;
});
const failureSettlement = holdFailure.settleAsync();
holdFailure.compactions[0]?.onError?.(new Error("summary failed"));
await failureSettlement;
eq("failure releases the settlement hold", failureHandlerRan, true);
eq("failure is reported before the hold releases", holdFailure.notifications.at(-1)?.level, "error");

const aborted = harness();
aborted.endRun("aborted");
aborted.settle();
eq("aborted run defers compaction", aborted.compactions.length, 0);
eq("aborted run posts the deferred notification", aborted.notifications, [
	{
		message:
			"Context at 180k/200k (90%) — auto-compaction deferred after the aborted run; it will run after the next completed run.",
		level: "info",
	},
]);
aborted.endRun("stop");
aborted.settle();
eq("next completed run compacts normally", aborted.compactions.length, 1);

const latch = harness({ model: { id: "regular-model", provider: "openai", contextWindow: 200_000 } });
latch.settle();
latch.compactions[0]?.onError?.(new Error("Nothing to compact"));
eq("failure is surfaced and latches auto-compaction off", latch.notifications.at(-1), {
	message:
		"Auto-compaction failed: Nothing to compact. Auto-compaction is disabled until the next successful compaction or model switch.",
	level: "error",
});
eq("failure publishes the paused status", latch.statuses.get(AUTO_COMPACT_STATUS_KEY), "auto-compact paused");
latch.settle();
eq("failure latch prevents a retry loop", latch.compactions.length, 1);
latch.pi.emit(
	"session_compact",
	{ type: "session_compact", reason: "threshold", fromExtension: false },
	latch.ctx,
);
eq("native fallback after an extension failure does not warn", latch.notifications.filter(({ level }) => level === "warning"), []);
eq("clearing the latch clears the paused status", latch.statuses.has(AUTO_COMPACT_STATUS_KEY), false);
latch.settle();
eq("any successful compaction clears the failure latch", latch.compactions.length, 2);
latch.compactions[1]?.onError?.(new Error("failed again"));
latch.pi.emit("model_select", { type: "model_select", model: tiny }, latch.ctx);
eq("model switch clears the paused status", latch.statuses.has(AUTO_COMPACT_STATUS_KEY), false);
latch.settle();
eq("model switch clears the failure latch", latch.compactions.length, 3);

const cancelled = harness();
cancelled.settle();
cancelled.compactions[0]?.onError?.(new Error("Compaction cancelled"));
eq("cancellation is reported as an info pause, not a failure", cancelled.notifications.at(-1), {
	message:
		"Compaction cancelled — auto-compaction paused until the next successful compaction or model switch.",
	level: "info",
});
eq("cancellation publishes the paused status", cancelled.statuses.get(AUTO_COMPACT_STATUS_KEY), "auto-compact paused");
cancelled.settle();
eq("cancellation engages the latch so a declined compaction is not re-requested", cancelled.compactions.length, 1);

const shutdown = harness();
shutdown.settle();
shutdown.pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, shutdown.ctx);
let postShutdownErrorThrew = false;
try {
	shutdown.compactions[0]?.onError?.(new Error("cancelled during shutdown"));
} catch {
	postShutdownErrorThrew = true;
}
eq("late compaction failure after shutdown does not use stale context", postShutdownErrorThrew, false);
eq("late compaction failure after shutdown adds no notification", shutdown.notifications.length, 1);
eq("late compaction failure after shutdown publishes no status", shutdown.statuses.has(AUTO_COMPACT_STATUS_KEY), false);

const disabled = harness({ config: { enabled: false }, model: tiny });
disabled.pi.emit(
	"session_compact",
	{ type: "session_compact", reason: "threshold", fromExtension: false },
	disabled.ctx,
);
disabled.endRun("aborted");
disabled.settle();
eq("disabled extension never compacts", disabled.compactions.length, 0);
eq("disabled extension posts no notifications or warnings", disabled.notifications, []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
