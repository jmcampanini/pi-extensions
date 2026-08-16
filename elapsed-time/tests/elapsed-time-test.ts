import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ELAPSED_TIME_STATUS_KEY } from "../../shared/status-keys.ts";
import {
	formatElapsed,
	registerElapsedTime,
	type ElapsedTimeClock,
} from "../index.ts";

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

type Handler = (event: any, ctx: any) => void;

function fakePi(): {
	api: ExtensionAPI;
	emit(type: string, event: unknown, ctx: unknown): void;
} {
	const handlers = new Map<string, Handler[]>();
	return {
		api: {
			on(type: string, handler: Handler): void {
				const registered = handlers.get(type) ?? [];
				registered.push(handler);
				handlers.set(type, registered);
			},
		} as unknown as ExtensionAPI,
		emit(type, event, ctx): void {
			for (const handler of handlers.get(type) ?? []) handler(event, ctx);
		},
	};
}

class FakeClock implements ElapsedTimeClock {
	nowMs = 0;
	lastIntervalMs: number | undefined;
	private nextTimer = 1;
	private readonly timers = new Map<number, () => void>();
	readonly clearedTimers: number[] = [];

	now = (): number => this.nowMs;

	setInterval(callback: () => void, milliseconds: number): number {
		this.lastIntervalMs = milliseconds;
		const timer = this.nextTimer++;
		this.timers.set(timer, callback);
		return timer;
	}

	clearInterval(handle: object | number): void {
		const timer = handle as number;
		this.clearedTimers.push(timer);
		this.timers.delete(timer);
	}

	fireTimers(): void {
		for (const callback of [...this.timers.values()]) callback();
	}

	activeTimerCount(): number {
		return this.timers.size;
	}
}

function harness(hasUI = true): {
	pi: ReturnType<typeof fakePi>;
	clock: FakeClock;
	ctx: unknown;
	statuses: Array<[string, string | undefined]>;
	themeTokens: string[];
} {
	const pi = fakePi();
	const clock = new FakeClock();
	const statuses: Array<[string, string | undefined]> = [];
	const themeTokens: string[] = [];
	const ctx = {
		hasUI,
		ui: {
			theme: {
				fg: (token: string, text: string) => {
					themeTokens.push(token);
					return text;
				},
			},
			setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
		},
	};
	registerElapsedTime(pi.api, clock);
	return { pi, clock, ctx, statuses, themeTokens };
}

for (const [label, milliseconds, expected] of [
	["zero", 0, "00:00"],
	["floors partial seconds", 59_999, "00:59"],
	["minute boundary", 60_000, "01:00"],
	["under an hour", 3_599_000, "59:59"],
	["hour boundary", 3_600_000, "1:00:00"],
	["hours retain padded minutes and seconds", 3_723_000, "1:02:03"],
	["negative values clamp to zero", -1_000, "00:00"],
	["non-finite values become zero", Number.NaN, "00:00"],
] as const) {
	eq(`format ${label}`, formatElapsed(milliseconds), expected);
}

const run = harness();
run.clock.nowMs = 1_000;
run.pi.emit("agent_start", { type: "agent_start" }, run.ctx);
eq("run starts with an immediate zero status", run.statuses, [
	[ELAPSED_TIME_STATUS_KEY, "◷ 00:00"],
]);
eq("run starts one refresh timer", run.clock.activeTimerCount(), 1);
eq("refresh interval is one second", run.clock.lastIntervalMs, 1000);

run.clock.nowMs = 62_500;
run.clock.fireTimers();
eq("tick derives elapsed time from the start timestamp", run.statuses.at(-1), [
	ELAPSED_TIME_STATUS_KEY,
	"◷ 01:01",
]);

run.pi.emit("agent_start", { type: "agent_start" }, run.ctx);
eq("continuation does not add another timer", run.clock.activeTimerCount(), 1);
run.clock.nowMs = 66_000;
run.pi.emit("agent_settled", { type: "agent_settled" }, run.ctx);
eq("settlement freezes the complete busy period", run.statuses.at(-1), [
	ELAPSED_TIME_STATUS_KEY,
	"✓ 01:05",
]);
eq("settlement stops refreshing", run.clock.activeTimerCount(), 0);
eq("elapsed status applies no dedicated color", run.themeTokens, []);

const statusCountAfterSettlement = run.statuses.length;
run.clock.nowMs = 90_000;
run.clock.fireTimers();
eq("a settled status does not keep changing", run.statuses.length, statusCountAfterSettlement);

run.clock.nowMs = 100_000;
run.pi.emit("agent_start", { type: "agent_start" }, run.ctx);
run.clock.nowMs = 102_100;
run.pi.emit("agent_settled", { type: "agent_settled" }, run.ctx);
eq("a later interaction starts a fresh measurement", run.statuses.at(-1), [
	ELAPSED_TIME_STATUS_KEY,
	"✓ 00:02",
]);

run.pi.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, run.ctx);
eq("shutdown clears the footer status", run.statuses.at(-1), [ELAPSED_TIME_STATUS_KEY, undefined]);

const interrupted = harness();
interrupted.pi.emit("agent_start", { type: "agent_start" }, interrupted.ctx);
interrupted.pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, interrupted.ctx);
eq("shutdown stops an active timer", interrupted.clock.activeTimerCount(), 0);
eq("shutdown clears an active status", interrupted.statuses.at(-1), [ELAPSED_TIME_STATUS_KEY, undefined]);

const headless = harness(false);
headless.pi.emit("agent_start", { type: "agent_start" }, headless.ctx);
headless.clock.nowMs = 5_000;
headless.pi.emit("agent_settled", { type: "agent_settled" }, headless.ctx);
eq("headless runs create no timers", headless.clock.activeTimerCount(), 0);
eq("headless runs create no statuses", headless.statuses, []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
