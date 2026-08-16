import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ELAPSED_TIME_STATUS_KEY } from "../../shared/status-keys.ts";
import { createTestEventHarness } from "../../shared/test-event-harness.ts";
import {
	formatElapsed,
	registerElapsedTime,
	type ElapsedTimeClock,
} from "../index.ts";

function fakePi() {
	const events = createTestEventHarness();
	return { api: events as unknown as ExtensionAPI, emit: events.emit };
}

class FakeClock implements ElapsedTimeClock {
	nowMs = 0;
	lastIntervalMs: number | undefined;
	private nextTimer = 1;
	private readonly timers = new Map<number, () => void>();

	now = () => this.nowMs;

	setInterval(callback: () => void, milliseconds: number) {
		this.lastIntervalMs = milliseconds;
		const timer = this.nextTimer++;
		this.timers.set(timer, callback);
		return timer;
	}

	clearInterval(handle: object | number) {
		this.timers.delete(handle as number);
	}

	fireTimers() {
		for (const callback of [...this.timers.values()]) callback();
	}

	activeTimerCount() {
		return this.timers.size;
	}
}

function harness(hasUI = true) {
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

describe("formatElapsed", () => {
	it("formats elapsed milliseconds across boundaries and clamps invalid input", () => {
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
			assert.strictEqual(formatElapsed(milliseconds), expected, `format ${label}`);
		}
	});
});

describe("registerElapsedTime", () => {
	it("tracks a run from start through settlement, later runs, and shutdown", () => {
		const run = harness();
		run.clock.nowMs = 1_000;
		run.pi.emit("agent_start", { type: "agent_start" }, run.ctx);
		assert.deepStrictEqual(run.statuses, [
			[ELAPSED_TIME_STATUS_KEY, "◷ 00:00"],
		], "run starts with an immediate zero status");
		assert.strictEqual(run.clock.activeTimerCount(), 1, "run starts one refresh timer");
		assert.strictEqual(run.clock.lastIntervalMs, 1000, "refresh interval is one second");

		run.clock.nowMs = 62_500;
		run.clock.fireTimers();
		assert.deepStrictEqual(run.statuses.at(-1), [
			ELAPSED_TIME_STATUS_KEY,
			"◷ 01:01",
		], "tick derives elapsed time from the start timestamp");

		run.pi.emit("agent_start", { type: "agent_start" }, run.ctx);
		assert.strictEqual(run.clock.activeTimerCount(), 1, "continuation does not add another timer");
		run.clock.nowMs = 66_000;
		run.pi.emit("agent_settled", { type: "agent_settled" }, run.ctx);
		assert.deepStrictEqual(run.statuses.at(-1), [
			ELAPSED_TIME_STATUS_KEY,
			"✓ 01:05",
		], "settlement freezes the complete busy period");
		assert.strictEqual(run.clock.activeTimerCount(), 0, "settlement stops refreshing");
		assert.deepStrictEqual(run.themeTokens, [], "elapsed status applies no dedicated color");

		const statusCountAfterSettlement = run.statuses.length;
		run.clock.nowMs = 90_000;
		run.clock.fireTimers();
		assert.strictEqual(run.statuses.length, statusCountAfterSettlement, "a settled status does not keep changing");

		run.clock.nowMs = 100_000;
		run.pi.emit("agent_start", { type: "agent_start" }, run.ctx);
		run.clock.nowMs = 102_100;
		run.pi.emit("agent_settled", { type: "agent_settled" }, run.ctx);
		assert.deepStrictEqual(run.statuses.at(-1), [
			ELAPSED_TIME_STATUS_KEY,
			"✓ 00:02",
		], "a later interaction starts a fresh measurement");

		run.pi.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, run.ctx);
		assert.deepStrictEqual(
			run.statuses.at(-1),
			[ELAPSED_TIME_STATUS_KEY, undefined],
			"shutdown clears the footer status",
		);
	});

	it("shutdown stops an active run", () => {
		const interrupted = harness();
		interrupted.pi.emit("agent_start", { type: "agent_start" }, interrupted.ctx);
		interrupted.pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, interrupted.ctx);
		assert.strictEqual(interrupted.clock.activeTimerCount(), 0, "shutdown stops an active timer");
		assert.deepStrictEqual(
			interrupted.statuses.at(-1),
			[ELAPSED_TIME_STATUS_KEY, undefined],
			"shutdown clears an active status",
		);
	});

	it("headless runs create no timers or statuses", () => {
		const headless = harness(false);
		headless.pi.emit("agent_start", { type: "agent_start" }, headless.ctx);
		headless.clock.nowMs = 5_000;
		headless.pi.emit("agent_settled", { type: "agent_settled" }, headless.ctx);
		assert.strictEqual(headless.clock.activeTimerCount(), 0, "headless runs create no timers");
		assert.deepStrictEqual(headless.statuses, [], "headless runs create no statuses");
	});
});
