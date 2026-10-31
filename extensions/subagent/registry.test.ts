import { describe, expect, it, vi } from "vitest";
import { type ChildRecord, SubagentRegistry, summarize } from "./registry.ts";

const record = (id: string, startedAt: number, status: ChildRecord["status"] = "running"): ChildRecord => ({
	id,
	title: `child ${id}`,
	task: "do it",
	mode: "background",
	context: "fresh",
	status,
	model: "p/m",
	effort: "low",
	cwd: "/repo",
	startedAt,
	progress: [],
	abort: vi.fn(),
});

describe("SubagentRegistry", () => {
	it("lists children oldest first and filters the running ones", () => {
		const registry = new SubagentRegistry();
		registry.add(record("b", 20));
		registry.add(record("a", 10, "completed"));

		expect(registry.list().map((child) => child.id)).toEqual(["a", "b"]);
		expect(registry.running().map((child) => child.id)).toEqual(["b"]);
	});

	it("tells listeners when a child is added or updated, but not on progress", () => {
		const registry = new SubagentRegistry();
		const listener = vi.fn();
		registry.subscribe(listener);

		registry.add(record("a", 1));
		registry.addProgress("a", "read x");
		registry.update("a", { status: "completed" });

		expect(listener).toHaveBeenCalledTimes(2);
		expect(registry.get("a")?.progress).toEqual(["read x"]);
		expect(registry.get("a")?.status).toBe("completed");
	});

	it("keeps only the newest progress lines", () => {
		const registry = new SubagentRegistry();
		registry.add(record("a", 1));

		for (let i = 0; i < 25; i++) registry.addProgress("a", `line ${i}`);

		const progress = registry.get("a")!.progress;
		expect(progress).toHaveLength(20);
		expect(progress[0]).toBe("line 5");
		expect(progress[19]).toBe("line 24");
	});

	it("aborts only the running children", () => {
		const registry = new SubagentRegistry();
		const running = record("a", 1);
		const finished = record("b", 2, "failed");
		registry.add(running);
		registry.add(finished);

		registry.abortAll();

		expect(running.abort).toHaveBeenCalledTimes(1);
		expect(finished.abort).not.toHaveBeenCalled();
	});
});

describe("summarize", () => {
	it("leaves the task, result, progress, timestamps, and abort handle out of the summary", () => {
		const summary = summarize({ ...record("a", 1), result: "long", worktree: { path: "/wt", branch: "pi/x" } });

		expect(summary).toEqual({ id: "a", title: "child a", mode: "background", context: "fresh", status: "running", model: "p/m", effort: "low", cwd: "/repo", worktree: { path: "/wt", branch: "pi/x" }, sessionFile: undefined, error: undefined });
	});
});
