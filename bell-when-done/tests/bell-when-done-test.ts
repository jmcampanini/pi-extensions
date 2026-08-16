import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBellWhenDone, type BellIO } from "../index.ts";

type Handler = (event: any, ctx: any) => void;

function harness(env: BellIO["env"]): {
	emit(type: string, event: unknown, ctx: unknown): void;
	writes: string[];
} {
	const handlers = new Map<string, Handler[]>();
	const writes: string[] = [];
	registerBellWhenDone(
		{
			on(type: string, handler: Handler): void {
				const registered = handlers.get(type) ?? [];
				registered.push(handler);
				handlers.set(type, registered);
			},
		} as unknown as ExtensionAPI,
		{
			env,
			write: (text) => {
				writes.push(text);
			},
		},
	);
	return {
		emit(type, event, ctx): void {
			for (const handler of handlers.get(type) ?? []) handler(event, ctx);
		},
		writes,
	};
}

const settled = { type: "agent_settled" };

describe("registerBellWhenDone", () => {
	it("settling in tui rings the bell once per settled run", () => {
		const tui = harness({});
		tui.emit("agent_settled", settled, { mode: "tui" });
		assert.deepStrictEqual(tui.writes, ["\x07"], "settling in tui rings the bell once");
		tui.emit("agent_settled", settled, { mode: "tui" });
		assert.deepStrictEqual(tui.writes, ["\x07", "\x07"], "each settled run rings its own bell");
		tui.emit("agent_end", { type: "agent_end", messages: [] }, { mode: "tui" });
		assert.strictEqual(tui.writes.length, 2, "loop ends within a run do not ring");
	});

	it("non-tui modes stay silent", () => {
		for (const mode of ["rpc", "json", "print"]) {
			const run = harness({});
			run.emit("agent_settled", settled, { mode });
			assert.deepStrictEqual(run.writes, [], `${mode} mode stays silent`);
		}
	});

	it("subagent children never ring", () => {
		const subagent = harness({ PI_SUBAGENT_SESSION: "/tmp/subagent/session.jsonl" });
		subagent.emit("agent_settled", settled, { mode: "tui" });
		assert.deepStrictEqual(subagent.writes, []);
	});
});
