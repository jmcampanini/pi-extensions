import { tmpdir } from "node:os";
import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { ChildHandle, ChildOutcome, StartChildInput } from "./launch.ts";
import { SubagentRegistry } from "./registry.ts";
import { completionPrefix } from "./result.ts";
import { type ParentSession, type RunDeps, runSubagent } from "./run.ts";
import { DEFAULT_SUBAGENT_SETTINGS } from "./settings.ts";

function fakeChild(sessionFile: string | undefined = "/sessions/child.jsonl") {
	let finish!: (outcome: ChildOutcome) => void;
	const done = new Promise<ChildOutcome>((resolve) => {
		finish = resolve;
	});
	const abort = vi.fn();
	const handle: ChildHandle = { sessionFile, done, abort };
	return { handle, finish, abort };
}

function parentSession(overrides: Partial<ParentSession> = {}): ParentSession {
	return {
		cwd: process.cwd(),
		model: { provider: "openai-codex", id: "gpt-6-luna", name: "GPT-6 Luna" } as Model<any>,
		credentials: undefined,
		thinkingLevel: "low",
		scopedModels: [],
		availableModels: [],
		activeTools: ["read", "bash", "subagent", "codemode"],
		projectTrusted: true,
		sessionFile: "/sessions/parent.jsonl",
		leafId: "leaf",
		branch: [],
		...overrides,
	};
}

function fakeDeps(handle: ChildHandle, overrides: Partial<RunDeps> = {}) {
	const started: StartChildInput[] = [];
	const deps: RunDeps = {
		settings: DEFAULT_SUBAGENT_SETTINGS,
		flags: { extensions: [], noExtensions: false },
		registry: new SubagentRegistry(),
		startChild: async (input) => {
			started.push(input);
			return handle;
		},
		createWorktree: async (request) => ({ path: `/wt/${request.slug}`, branch: `pi/${request.slug}` }),
		deliver: vi.fn(),
		notify: vi.fn(),
		trust: { storedDecision: () => null, requiresTrust: () => false },
		selfDir: "/ext/subagent",
		now: () => 1_000,
		...overrides,
	};
	return { deps, started };
}

const completed = (text: string): ChildOutcome => ({ status: "completed", text, durationMs: 1_500 });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("runSubagent in the background", () => {
	it("returns as soon as the child runs, then delivers the completion message", async () => {
		const child = fakeChild();
		const { deps } = fakeDeps(child.handle);

		const result = await runSubagent({ params: { task: "Summarize the repo", title: "Summary" }, toolCallId: "call-1", signal: undefined, onUpdate: undefined, parent: parentSession() }, deps);

		expect(result.content[0]).toEqual({ type: "text", text: expect.stringContaining('Started subagent "Summary"') });
		expect(result.details?.status).toBe("running");
		expect(deps.registry.running()).toHaveLength(1);
		expect(deps.deliver).not.toHaveBeenCalled();

		child.finish(completed("All good."));
		await flush();

		const message = (deps.deliver as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
		expect(message.startsWith(`${completionPrefix("Summary")} completed`)).toBe(true);
		expect(message).toContain("All good.");
		expect(deps.registry.get(result.details!.id)?.status).toBe("completed");
	});

	it("tells the user when a report cannot be delivered", async () => {
		const child = fakeChild();
		const { deps } = fakeDeps(child.handle, {
			deliver: () => {
				throw new Error("outbox closed");
			},
		});

		await runSubagent({ params: { task: "t", title: "Flaky" }, toolCallId: "c", signal: undefined, onUpdate: undefined, parent: parentSession() }, deps);
		child.finish(completed("x"));
		await flush();

		expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining('Subagent "Flaky"'));
	});
});

describe("runSubagent in the foreground", () => {
	it("waits for the child and returns its report with the final details", async () => {
		const child = fakeChild();
		const { deps } = fakeDeps(child.handle);
		const updates: string[] = [];

		const pending = runSubagent({ params: { task: "t", mode: "foreground" }, toolCallId: "c", signal: undefined, onUpdate: (partial) => {
			const block = partial.content[0];
			if (block?.type === "text") updates.push(block.text);
		}, parent: parentSession() }, deps);
		await flush();
		deps.registry.get(deps.registry.list()[0]!.id);
		child.finish(completed("Report body"));
		const result = await pending;

		expect(result.content[0]).toEqual({ type: "text", text: "Report body" });
		expect(result.isError).toBeUndefined();
		expect(result.details?.status).toBe("completed");
		expect(result.details?.durationMs).toBe(0);
	});

	it("marks a failed or cancelled child as an error and leads with the reason", async () => {
		const child = fakeChild();
		const { deps } = fakeDeps(child.handle);

		const pending = runSubagent({ params: { task: "t", mode: "foreground" }, toolCallId: "c", signal: undefined, onUpdate: undefined, parent: parentSession() }, deps);
		child.finish({ status: "failed", text: "", error: "401 unauthorized", durationMs: 10 });
		const result = await pending;

		expect(result.isError).toBe(true);
		expect(result.content[0]).toEqual({ type: "text", text: expect.stringMatching(/^Subagent failed: 401 unauthorized/) });
	});

	it("truncates a long report and says where the rest is", async () => {
		const child = fakeChild();
		const { deps } = fakeDeps(child.handle, { settings: { ...DEFAULT_SUBAGENT_SETTINGS, resultMaxChars: 5 } });

		const pending = runSubagent({ params: { task: "t", mode: "foreground" }, toolCallId: "c", signal: undefined, onUpdate: undefined, parent: parentSession() }, deps);
		child.finish(completed("0123456789"));
		const result = await pending;

		expect(result.content[0]).toEqual({ type: "text", text: expect.stringContaining("01234\n\n[Result truncated. The full transcript is in the child session file: /sessions/child.jsonl.]") });
	});
});

describe("what the child is started with", () => {
	it("gives the child the parent's active tools minus subagent, the parent's trust, and the fork source when asked", async () => {
		const child = fakeChild();
		const { deps, started } = fakeDeps(child.handle);

		await runSubagent({ params: { task: "t", context: "fork", effort: "high" }, toolCallId: "call-7", signal: undefined, onUpdate: undefined, parent: parentSession({ projectTrusted: false }) }, deps);

		expect(started[0]).toMatchObject({
			cwd: process.cwd(),
			task: "t",
			thinkingLevel: "high",
			tools: ["read", "bash", "codemode"],
			projectTrusted: false,
			parentSessionFile: "/sessions/parent.jsonl",
			fork: { source: { parentSessionFile: "/sessions/parent.jsonl", leafId: "leaf", branch: [] }, toolCallId: "call-7" },
			selfDir: "/ext/subagent",
		});
	});

	it("hands the parent's credential store to the child", async () => {
		const child = fakeChild();
		const { deps, started } = fakeDeps(child.handle);
		const credentials = { shared: true } as unknown as NonNullable<ParentSession["credentials"]>;

		await runSubagent({ params: { task: "t" }, toolCallId: "c", signal: undefined, onUpdate: undefined, parent: parentSession({ credentials }) }, deps);

		expect(started[0]?.credentials).toBe(credentials);
	});

	it("resolves a model reference against scoped models first and fails clearly when it is ambiguous", async () => {
		const child = fakeChild();
		const luna = { provider: "openai-codex", id: "gpt-6-luna", name: "GPT-6 Luna" } as Model<any>;
		const sol = { provider: "openai-codex", id: "gpt-6-sol", name: "GPT-6 Sol" } as Model<any>;
		const { deps, started } = fakeDeps(child.handle);
		const parent = parentSession({ scopedModels: [luna], availableModels: [luna, sol] });

		await runSubagent({ params: { task: "t", model: "sol" }, toolCallId: "c", signal: undefined, onUpdate: undefined, parent }, deps);
		expect(started[0]?.model).toBe(sol);

		const unscoped = parentSession({ scopedModels: [], availableModels: [luna, sol] });
		await expect(runSubagent({ params: { task: "t", model: "gpt-6" }, toolCallId: "c", signal: undefined, onUpdate: undefined, parent: unscoped }, deps)).rejects.toThrow(/matches/);
	});

	it("gives a worktree the trust of the directory it was created from, not the parent's", async () => {
		const child = fakeChild();
		const { deps, started } = fakeDeps(child.handle, { trust: { storedDecision: () => false, requiresTrust: () => true } });

		await runSubagent({ params: { task: "t", cwd: tmpdir(), isolation: "worktree" }, toolCallId: "c", signal: undefined, onUpdate: undefined, parent: parentSession({ projectTrusted: true }) }, deps);

		expect(started[0]?.cwd).toBe("/wt/t");
		expect(started[0]?.projectTrusted).toBe(false);
	});

	it("runs the child in a new worktree and records it", async () => {
		const child = fakeChild();
		const { deps, started } = fakeDeps(child.handle);

		const result = await runSubagent({ params: { task: "Fix the tests", isolation: "worktree", from: "main" }, toolCallId: "c", signal: undefined, onUpdate: undefined, parent: parentSession() }, deps);

		expect(started[0]?.cwd).toBe("/wt/fix-the-tests");
		expect(started[0]?.projectTrusted).toBe(true);
		expect(result.details?.worktree).toEqual({ path: "/wt/fix-the-tests", branch: "pi/fix-the-tests" });
		expect(result.content[0]).toEqual({ type: "text", text: expect.stringContaining("worktree /wt/fix-the-tests on branch pi/fix-the-tests") });
	});
});

describe("cancellation", () => {
	it("does not start a child when the call is already cancelled, and names a worktree it had created", async () => {
		const child = fakeChild();
		const { deps, started } = fakeDeps(child.handle);
		const controller = new AbortController();
		controller.abort();

		await expect(runSubagent({ params: { task: "t", isolation: "worktree" }, toolCallId: "c", signal: controller.signal, onUpdate: undefined, parent: parentSession() }, deps)).rejects.toThrow(/cancelled before the subagent started; worktree \/wt\/t on branch pi\/t was left in place/);
		expect(started).toHaveLength(0);
	});

	it("aborts a child whose start was cancelled while it was still launching", async () => {
		const child = fakeChild();
		let release!: () => void;
		const { deps } = fakeDeps(child.handle, {
			startChild: () =>
				new Promise((resolve) => {
					release = () => resolve(child.handle);
				}),
		});
		const controller = new AbortController();

		const pending = runSubagent({ params: { task: "t", mode: "foreground" }, toolCallId: "c", signal: controller.signal, onUpdate: undefined, parent: parentSession() }, deps);
		await flush();
		controller.abort();
		release();
		await flush();

		expect(child.abort).toHaveBeenCalledTimes(1);
		child.finish({ status: "cancelled", text: "", error: "the subagent was aborted", durationMs: 1 });
		expect((await pending).isError).toBe(true);
	});

	it("stops listening to the turn's signal once a foreground child has finished, and once a background child is running", async () => {
		const background = fakeChild();
		const foreground = fakeChild();
		const controller = new AbortController();
		const { deps: backgroundDeps } = fakeDeps(background.handle);
		const { deps: foregroundDeps } = fakeDeps(foreground.handle);

		await runSubagent({ params: { task: "t" }, toolCallId: "c", signal: controller.signal, onUpdate: undefined, parent: parentSession() }, backgroundDeps);
		const pending = runSubagent({ params: { task: "t", mode: "foreground" }, toolCallId: "c", signal: controller.signal, onUpdate: undefined, parent: parentSession() }, foregroundDeps);
		foreground.finish(completed("done"));
		await pending;
		controller.abort();

		expect(background.abort).not.toHaveBeenCalled();
		expect(foreground.abort).not.toHaveBeenCalled();
	});
});
