import type { CompactOptions, ContextUsage, ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

interface Harness {
	pi: ReturnType<typeof fakePi>;
	state: {
		usage: ContextUsage | undefined;
		idle: boolean;
		pending: boolean;
	};
	ctx: unknown;
	compactions: CompactOptions[];
	notifications: Array<{ message: string; level: string }>;
	settle: () => void;
	settleAsync: () => Promise<void>;
	endRun: (stopReason: string) => void;
}

function harness(options: {
	thresholdPercent?: number;
	enabled?: boolean;
	usage?: ContextUsage | undefined;
	mode?: "tui" | "rpc" | "json" | "print";
} = {}): Harness {
	const pi = fakePi();
	const state = {
		usage: options.usage ?? { tokens: 140_000, contextWindow: 200_000, percent: 70 },
		idle: true,
		pending: false,
	};
	const compactions: CompactOptions[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const ctx = {
		mode: options.mode ?? "tui",
		getContextUsage: () => state.usage,
		isIdle: () => state.idle,
		hasPendingMessages: () => state.pending,
		compact: (compactOptions: CompactOptions = {}) => compactions.push(compactOptions),
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
		},
	};

	registerAutoCompact(pi as unknown as ExtensionAPI, {
		thresholdPercent: options.thresholdPercent ?? 70,
		enabled: options.enabled ?? true,
	});

	return {
		pi,
		state,
		ctx,
		compactions,
		notifications,
		settle: () => pi.emit("agent_settled", { type: "agent_settled" }, ctx),
		settleAsync: () => pi.emitAsync("agent_settled", { type: "agent_settled" }, ctx),
		endRun: (stopReason) =>
			pi.emit(
				"agent_end",
				{
					type: "agent_end",
					messages: [{ role: "user" }, { role: "assistant", stopReason }],
				},
				ctx,
			),
	};
}

for (const contextWindow of [200_000, 372_000, 1_000_000]) {
	for (const percent of [69, 70, 71]) {
		const test = harness({
			usage: {
				tokens: Math.round((contextWindow * percent) / 100),
				contextWindow,
				percent,
			},
		});
		test.settle();
		eq(
			`${percent}% of ${contextWindow} triggers only at or above 70%`,
			test.compactions.length,
			percent >= 70 ? 1 : 0,
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
	{ message: "Context at 70% — auto-compacting.", level: "info" },
]);
inFlight.compactions[0]?.onComplete?.({} as never);
eq("successful completion adds no extra notification", inFlight.notifications.length, 1);
inFlight.state.usage = { tokens: null, contextWindow: 200_000, percent: null };
inFlight.settle();
eq("stale post-compaction usage cannot retrigger", inFlight.compactions.length, 1);
inFlight.state.usage = { tokens: 142_000, contextWindow: 200_000, percent: 71 };
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
		message: "Context at 70% — auto-compaction deferred after the aborted run; it will run after the next completed run.",
		level: "info",
	},
]);
aborted.endRun("stop");
aborted.settle();
eq("next completed run compacts normally", aborted.compactions.length, 1);

const latch = harness();
latch.settle();
latch.compactions[0]?.onError?.(new Error("Nothing to compact"));
eq("failure is surfaced and latches percentage compaction off", latch.notifications.at(-1), {
	message:
		"Auto-compaction failed: Nothing to compact. Percentage auto-compaction is disabled until the next successful compaction or model switch.",
	level: "error",
});
latch.settle();
eq("failure latch prevents a retry loop", latch.compactions.length, 1);
latch.pi.emit("session_compact", { type: "session_compact", reason: "manual" }, latch.ctx);
latch.settle();
eq("any successful compaction clears the failure latch", latch.compactions.length, 2);
latch.compactions[1]?.onError?.(new Error("failed again"));
latch.pi.emit("model_select", { type: "model_select" }, latch.ctx);
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

const disabled = harness({ enabled: false });
disabled.endRun("aborted");
disabled.settle();
eq("disabled extension never compacts", disabled.compactions.length, 0);
eq("disabled extension does not post deferred notifications", disabled.notifications, []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
