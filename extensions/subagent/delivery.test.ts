import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canAcceptPrompt, createOutbox } from "./delivery.ts";

describe("canAcceptPrompt", () => {
	it("accepts when idle, or when a turn is streaming with a live signal", () => {
		expect(canAcceptPrompt({ isIdle: () => true, signal: undefined })).toBe(true);
		expect(canAcceptPrompt({ isIdle: () => false, signal: new AbortController().signal })).toBe(true);
	});

	it("refuses while busy without a live signal, which is how compaction looks to an extension", () => {
		const aborted = new AbortController();
		aborted.abort();
		expect(canAcceptPrompt({ isIdle: () => false, signal: undefined })).toBe(false);
		expect(canAcceptPrompt({ isIdle: () => false, signal: aborted.signal })).toBe(false);
	});
});

describe("createOutbox", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	const deps = (acceptable: () => boolean) => ({ canAccept: acceptable, send: vi.fn(), park: vi.fn(), notifyStuck: vi.fn(), pollMs: 50, deadlineMs: 1_000, now: () => Date.now() });

	it("sends a report at once when the parent accepts prompts", () => {
		const d = deps(() => true);
		const outbox = createOutbox(d);

		outbox.push("report one");

		expect(d.send).toHaveBeenCalledWith("report one");
	});

	it("holds reports while the parent is busy and sends them together once it is not", () => {
		let acceptable = false;
		const d = deps(() => acceptable);
		const outbox = createOutbox(d);

		outbox.push("report one");
		outbox.push("report two");
		vi.advanceTimersByTime(120);
		expect(d.send).not.toHaveBeenCalled();

		acceptable = true;
		vi.advanceTimersByTime(50);

		expect(d.send).toHaveBeenCalledTimes(1);
		expect(d.send).toHaveBeenCalledWith("report one\n\nreport two");
	});

	it("flushes early when asked, without waiting for the next poll", () => {
		let acceptable = false;
		const d = deps(() => acceptable);
		const outbox = createOutbox(d);
		outbox.push("report");

		acceptable = true;
		outbox.flush();

		expect(d.send).toHaveBeenCalledWith("report");
	});

	it("parks reports and tells the user when the parent stays busy past the deadline", () => {
		const d = deps(() => false);
		const outbox = createOutbox(d);

		outbox.push("report one");
		outbox.push("report two");
		vi.advanceTimersByTime(1_100);

		expect(d.send).not.toHaveBeenCalled();
		expect(d.notifyStuck).toHaveBeenCalledWith(2);
		expect(d.park.mock.calls.map((call) => call[0])).toEqual(["report one", "report two"]);
	});

	it("drops everything once closed", () => {
		const d = deps(() => false);
		const outbox = createOutbox(d);
		outbox.push("report");

		outbox.close();
		vi.advanceTimersByTime(2_000);
		outbox.push("late");

		expect(d.send).not.toHaveBeenCalled();
		expect(d.park).not.toHaveBeenCalled();
	});
});
