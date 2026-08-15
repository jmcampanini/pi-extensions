import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RunningSubagent } from "../state.ts";

process.env.PI_CODING_AGENT_DIR = join(process.cwd(), ".sandbox", "watcher-cancel-config-do-not-create");

const { adoptRunningChildren, trackChild } = await import("../watcher.ts");
const state = await import("../state.ts");
const capacity = await import("../capacity.ts");
const { deliveryRecord, ledger, resetForShutdown, running } = state;
const { clearQueueForShutdown } = capacity;
type SpawnSpec = import("../capacity.ts").SpawnSpec;

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown): void {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}: got ${g}, want ${w}`); }
}
function ok(label: string, condition: boolean): void {
	if (condition) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}`); }
}

interface SentDetails {
	id?: string;
	reason?: string;
	exitCode?: number;
	model?: string;
	effort?: string;
	tools?: string;
	forked?: boolean;
	interactive?: boolean;
	worktree?: boolean;
	worktreeStatus?: string;
}
const sent: Array<{ customType?: string; content?: string; details?: SentDetails }> = [];
const pi = {
	sendMessage(message: { customType?: string; content?: string; details?: SentDetails }): void {
		sent.push(message);
	},
} as unknown as ExtensionAPI;

function stoppedChild(id: string, requester: "user" | "model"): RunningSubagent {
	return {
		id,
		name: `${id} task`,
		agent: "worker",
		paneId: `%missing-${id}`,
		sessionFile: `/missing/${id}.jsonl`,
		startTime: Date.now() - 1_000,
		skipEntries: 0,
		tools: "read,bash",
		model: "configured/model",
		thinking: "high",
		autoExit: false,
		context: "forked",
		abort: new AbortController(),
		stopRequester: requester,
		expectsRun: true,
		pendingExit: { reason: "aborted", exitCode: 130 },
	};
}

running.clear();
ledger.clear();
clearQueueForShutdown();

const model = stoppedChild("model001", "model");
model.worktree = {
	dir: "/missing/model001-worktree",
	branch: "pi/model001",
	baseCommit: "fixture",
	parentCwd: process.cwd(),
};
eq("model-stopped child registers before its pending exit is consumed", trackChild(pi, model).status, "tracked");
eq("model stop emits one result", sent.map((message) => [message.customType, message.details?.id, message.details?.reason]), [
	["subagent_result", "model001", "stopped"],
]);
ok("model stop notice attributes the model request",
	sent[0]?.content?.includes("Stopped because you cancelled it") === true);
eq("stopped result has completion-path capability and exit parity", {
	exitCode: sent[0]?.details?.exitCode,
	model: sent[0]?.details?.model,
	effort: sent[0]?.details?.effort,
	tools: sent[0]?.details?.tools,
	forked: sent[0]?.details?.forked,
	interactive: sent[0]?.details?.interactive,
	worktree: sent[0]?.details?.worktree,
	worktreeStatus: sent[0]?.details?.worktreeStatus,
}, {
	exitCode: 130,
	model: "configured/model",
	effort: "high",
	tools: "read,bash",
	forked: true,
	interactive: true,
	worktree: true,
	worktreeStatus: "kept",
});
ok("stopped envelope carries the same capability metadata",
	["Model: configured/model", "Effort: high", "Mode: forked · interactive · worktree", "Tools: read,bash"]
		.every((line) => sent[0]?.content?.includes(line) === true));
eq("model stop parks a stopped delivery record", deliveryRecord(model.id)?.stopped, true);

adoptRunningChildren(pi);
eq("adoption cannot duplicate an accepted stopped send", sent.length, 1);

const user = stoppedChild("user0001", "user");
trackChild(pi, user);
eq("user stop emits one additional result", sent.length, 2);
ok("user stop notice attributes the human request", sent[1]?.content?.includes("Stopped by the user") === true);
eq("both stopped children leave the running registry", running.size, 0);

resetForShutdown();
clearQueueForShutdown();
const forcedId = "forced01";
const worktreeDir = join(process.cwd(), ".sandbox", "forced-track-cancel-worktree");
rmSync(worktreeDir, { recursive: true, force: true });
mkdirSync(worktreeDir, { recursive: true });
const spec: SpawnSpec = {
	kind: "spawn",
	id: forcedId,
	name: "forced tombstone",
	task: "test",
	agentName: "worker",
	harness: "pi",
	agentBody: "",
	context: "new",
	autoExit: true,
	useWorktree: true,
	parentCwd: process.cwd(),
	parentSessionFile: "/missing/parent.jsonl",
	base: "/missing/base",
	slug: "forced",
};
capacity.admitLaunch(spec);
capacity.recordCancellation(forcedId, "model");
const forced = stoppedChild(forcedId, "model");
forced.pendingExit = undefined;
forced.worktree = {
	dir: worktreeDir,
	branch: "pi/forced",
	baseCommit: "fixture",
	parentCwd: process.cwd(),
};
const forcedResult = trackChild(pi, forced);
eq("forced track-time tombstone refuses registration", forcedResult, { status: "cancelled", requester: "model" });
eq("forced tombstone releases the claim without a result or ledger entry", [
	capacity.findPendingLaunch(forcedId),
	running.has(forcedId),
	ledger.has(forcedId),
	sent.length,
], [undefined, false, false, 2]);
ok("a possibly dirty worktree is kept on the defensive path", existsSync(worktreeDir));
rmSync(worktreeDir, { recursive: true, force: true });

resetForShutdown();
clearQueueForShutdown();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
