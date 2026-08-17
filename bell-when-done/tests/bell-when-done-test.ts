import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTestEventHarness } from "../../shared/test-event-harness.ts";
import { registerBellWhenDone, type BellIO } from "../index.ts";

function harness(env: BellIO["env"]) {
	const pi = createTestEventHarness();
	const writes: string[] = [];
	registerBellWhenDone(
		pi as unknown as ExtensionAPI,
		{
			env,
			write: (text) => {
				writes.push(text);
			},
		},
	);
	return { emit: pi.emit, writes };
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
