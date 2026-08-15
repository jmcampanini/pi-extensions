import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBellWhenDone, type BellIO } from "../index.ts";

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

const tui = harness({});
tui.pi.emit("agent_settled", settled, { mode: "tui" });
eq("settling in tui rings the bell once", tui.writes, ["\x07"]);

tui.pi.emit("agent_settled", settled, { mode: "tui" });
eq("each settled run rings its own bell", tui.writes, ["\x07", "\x07"]);

tui.pi.emit("agent_end", { type: "agent_end", messages: [] }, { mode: "tui" });
eq("loop ends within a run do not ring", tui.writes.length, 2);

for (const mode of ["rpc", "json", "print"]) {
	const run = harness({});
	run.pi.emit("agent_settled", settled, { mode });
	eq(`${mode} mode stays silent`, run.writes, []);
}

const subagent = harness({ PI_SUBAGENT_SESSION: "/tmp/subagent/session.jsonl" });
subagent.pi.emit("agent_settled", settled, { mode: "tui" });
eq("subagent children never ring", subagent.writes, []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
