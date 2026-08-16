import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBellWhenDone, type BellIO } from "../index.ts";

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

function harness(env: BellIO["env"]): { pi: ReturnType<typeof fakePi>; writes: string[] } {
	const pi = fakePi();
	const writes: string[] = [];
	registerBellWhenDone(pi.api, {
		env,
		write: (text) => {
			writes.push(text);
		},
	});
	return { pi, writes };
}

const settled = { type: "agent_settled" };

describe("registerBellWhenDone", () => {
	it("settling in tui rings the bell once per settled run", () => {
		const tui = harness({});
		tui.pi.emit("agent_settled", settled, { mode: "tui" });
		assert.deepStrictEqual(tui.writes, ["\x07"], "settling in tui rings the bell once");
		tui.pi.emit("agent_settled", settled, { mode: "tui" });
		assert.deepStrictEqual(tui.writes, ["\x07", "\x07"], "each settled run rings its own bell");
		tui.pi.emit("agent_end", { type: "agent_end", messages: [] }, { mode: "tui" });
		assert.strictEqual(tui.writes.length, 2, "loop ends within a run do not ring");
	});

	it("non-tui modes stay silent", () => {
		for (const mode of ["rpc", "json", "print"]) {
			const run = harness({});
			run.pi.emit("agent_settled", settled, { mode });
			assert.deepStrictEqual(run.writes, [], `${mode} mode stays silent`);
		}
	});

	it("subagent children never ring", () => {
		const subagent = harness({ PI_SUBAGENT_SESSION: "/tmp/subagent/session.jsonl" });
		subagent.pi.emit("agent_settled", settled, { mode: "tui" });
		assert.deepStrictEqual(subagent.writes, []);
	});
});
