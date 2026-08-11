import type { CompactOptions, ContextUsage, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutoCompactConfig } from "../config.ts";
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
	mode?: "tui" | "rpc" | "json" | "print";
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
	const ctx = {
		mode: options.mode ?? "tui",
		get model() {
			return state.model;
		},
		getContextUsage: () => state.usage,
		isIdle: () => state.idle,
		hasPendingMessages: () => state.pending,
		compact: (compactOptions: CompactOptions = {}) => compactions.push(compactOptions),
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
		},
	};

	registerAutoCompact(pi as unknown as ExtensionAPI, { ...DEFAULT_CONFIG, ...options.config });

	return {
		pi,
		state,
		ctx,
		compactions,
		notifications,
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

const thresholds = [
	{ contextWindow: 200_000, threshold: 180_000, rule: "90% class" },
	{ contextWindow: 272_000, threshold: 244_800, rule: "90% class" },
	{ contextWindow: 300_000, threshold: 270_000, rule: "inclusive windowMax boundary" },
	{ contextWindow: 300_001, threshold: 210_001, rule: "70% class just past the boundary" },
	{ contextWindow: 372_000, threshold: 260_400, rule: "70% class" },
	{ contextWindow: 400_000, threshold: 280_000, rule: "70% class" },
	{ contextWindow: 1_000_000, threshold: 400_000, rule: "token default" },
];
for (const { contextWindow, threshold, rule } of thresholds) {
	for (const tokens of [threshold - 1, threshold]) {
		const test = harness({
			usage: { tokens, contextWindow, percent: (tokens / contextWindow) * 100 },
		});
		test.settle();
		eq(
			`${tokens} of ${contextWindow} (${rule}) triggers only at or above the threshold`,
			test.compactions.length,
			tokens >= threshold ? 1 : 0,
		);
	}
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
eq("high settled usage does not post a speculative native warning", nativeDidNotCompact.notifications, [
	{ message: "Context at 120k/128k (94%) — auto-compacting.", level: "info" },
]);

const nativeWarn = harness({
	usage: { tokens: null, contextWindow: 128_000, percent: null },
	model: tiny,
});
nativeWarn.pi.emit(
	"session_compact",
	{ type: "session_compact", reason: "threshold", fromExtension: false },
	nativeWarn.ctx,
);
nativeWarn.settle();
eq("post-native unknown usage does not duplicate compaction", nativeWarn.compactions.length, 0);
eq("an observed native threshold compaction warns once", nativeWarn.notifications, [
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
workflow.pi.emit("turn_end", { type: "turn_end" }, workflow.ctx);
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

for (const mode of ["tui", "rpc"] as const) {
	const interactiveMode = harness({ mode });
	let laterSettlementHandlerRan = false;
	interactiveMode.pi.on("agent_settled", () => {
		laterSettlementHandlerRan = true;
	});
	const settlement = interactiveMode.settleAsync();
	eq(`${mode} mode holds later settlement handlers during compaction`, laterSettlementHandlerRan, false);
	interactiveMode.compactions[0]?.onComplete?.({} as never);
	await settlement;
	eq(`${mode} mode releases later settlement handlers after compaction`, laterSettlementHandlerRan, true);
}

const printMode = harness({ mode: "print" });
let printModeCanTearDown = false;
const printModeSettlement = printMode.settleAsync().then(() => {
	printModeCanTearDown = true;
});
eq("print mode requests compaction before settlement returns", printMode.compactions.length, 1);
eq("print mode cannot tear down during compaction", printModeCanTearDown, false);
printMode.compactions[0]?.onComplete?.({} as never);
await printModeSettlement;
eq("print mode can tear down after compaction completes", printModeCanTearDown, true);

const jsonMode = harness({ mode: "json" });
let jsonModeCanTearDown = false;
const jsonModeSettlement = jsonMode.settleAsync().then(() => {
	jsonModeCanTearDown = true;
});
eq("JSON mode cannot tear down during compaction", jsonModeCanTearDown, false);
jsonMode.compactions[0]?.onError?.(new Error("summary failed"));
await jsonModeSettlement;
eq("JSON mode can tear down after compaction fails", jsonModeCanTearDown, true);
eq("JSON mode reports failure before teardown", jsonMode.notifications.at(-1)?.level, "error");

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
latch.settle();
eq("failure latch prevents a retry loop", latch.compactions.length, 1);
latch.pi.emit(
	"session_compact",
	{ type: "session_compact", reason: "threshold", fromExtension: false },
	latch.ctx,
);
eq("native fallback after an extension failure does not warn", latch.notifications.filter(({ level }) => level === "warning"), []);
latch.settle();
eq("any successful compaction clears the failure latch", latch.compactions.length, 2);
latch.compactions[1]?.onError?.(new Error("failed again"));
latch.pi.emit("model_select", { type: "model_select", model: tiny }, latch.ctx);
latch.settle();
eq("model switch clears the failure latch", latch.compactions.length, 3);

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
