import { parseSubagentResultEnvelope } from "../../shared/subagent-envelope.ts";
import {
	buildSubagentResultEnvelope,
	buildSubagentResultMessage,
	type SubagentResultMessage,
	type SubagentResultStatus,
} from "../result-content.ts";

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown): void {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}:\n    got  ${g}\n    want ${w}`); }
}
function ok(label: string, value: boolean): void {
	eq(label, value, true);
}
function throws(label: string, fn: () => unknown, contains: string): void {
	try { fn(); fail++; console.log(`  FAIL ${label}: expected throw`); }
	catch (error) {
		if (String(error).includes(contains)) { pass++; console.log(`  ok  ${label}`); }
		else { fail++; console.log(`  FAIL ${label}: ${String(error)}`); }
	}
}

const base = {
	name: "expanded\nresult check",
	agent: "worker",
	id: "15c3f450",
	forked: true,
	interactive: true,
	worktree: true,
	model: "provider/model",
	effort: "high",
	tools: "read,edit,bash",
	elapsedSeconds: 183,
	contextTokens: 78_000,
	contextWindow: 200_000,
	resultTokens: 551,
	costUsd: 0.92,
	exitCode: 0,
	reason: "done",
	sessionFile: "/sessions/child.jsonl",
	worktreeDir: "/repo/worktree",
	worktreeBranch: "pi/check",
	worktreeStatus: "kept",
	worktreeNote: "Worktree: kept at /repo/worktree on branch pi/check.",
} as const;
const response = "The command completed successfully.\n\nNo further action was needed.\x1b]52;c;Zm9v\x07";
const completed = buildSubagentResultMessage({ ...base, status: "completed", response });
const completedHead = [
	"Subagent result",
	"Status: completed",
	"Name: expanded result check",
	"Agent: worker",
	"ID: 15c3f450",
	"Model: provider/model",
	"Effort: high",
	"Mode: forked · interactive · worktree",
	"Tools: read,edit,bash",
	"Elapsed: 3m 3s",
	"Context: 78k tokens",
	"Result: ~551 tokens",
	"Cost: $0.92",
].join("\n");
ok("completed envelope uses canonical verdict, identity, capability, and metric order",
	completed.content.startsWith(completedHead));
eq("response range extracts only the sanitized child result",
	completed.details.expanded.response && completed.content.slice(
		completed.details.expanded.response.start,
		completed.details.expanded.response.end,
	),
	"The command completed successfully.\n\nNo further action was needed.");
eq("model content strips terminal controls", completed.content.includes("\x1b]52"), false);
eq("builder derives completed action", completed.content.includes(
	'Resume: subagent_resume({ id: "15c3f450", message: "..." })'), true);
eq("builder keeps content and details identity/capabilities consistent", {
	model: completed.details.model,
	effort: completed.details.effort,
	tools: completed.details.tools,
	forked: completed.details.forked,
	interactive: completed.details.interactive,
	worktree: completed.details.worktree,
}, {
	model: base.model,
	effort: base.effort,
	tools: base.tools,
	forked: true,
	interactive: true,
	worktree: true,
});
eq("builder retains details-only completion telemetry", {
	exitCode: completed.details.exitCode,
	reason: completed.details.reason,
	contextWindow: completed.details.contextWindow,
	worktreeDir: completed.details.worktreeDir,
	worktreeBranch: completed.details.worktreeBranch,
	worktreeStatus: completed.details.worktreeStatus,
}, {
	exitCode: 0,
	reason: "done",
	contextWindow: 200_000,
	worktreeDir: "/repo/worktree",
	worktreeBranch: "pi/check",
	worktreeStatus: "kept",
});

const failed = buildSubagentResultMessage({
	...base,
	status: "failed",
	response: "Partial output.",
	failureReason: "exit code 23",
	exitCode: 23,
	reason: "exited",
});
eq("failure is hoisted directly below status", failed.content.split("\n").slice(0, 4), [
	"Subagent result",
	"Status: failed",
	"Failure: exit code 23",
	"Name: expanded result check",
]);
eq("failed builder derives retry guidance", failed.content.includes(
	'Retry: subagent_resume({ id: "15c3f450", message: "<guidance>" })'), true);
eq("failed presentation prefers partial output", failed.details.presentation.preview, "Partial output.");
eq("failed expanded details retain failure and exact response offsets", {
	failureReason: failed.details.expanded.failureReason,
	response: failed.details.expanded.response && failed.content.slice(
		failed.details.expanded.response.start,
		failed.details.expanded.response.end,
	),
}, { failureReason: "exit code 23", response: "Partial output." });

const stopped = buildSubagentResultMessage({
	...base,
	status: "stopped",
	notice: "Stopped by the user. Do not treat this as a subagent failure.",
	stopRequester: "user",
	exitCode: 130,
	reason: "stopped",
	resultTokens: undefined,
});
eq("notice is hoisted directly below status", stopped.content.split("\n").slice(0, 4), [
	"Subagent result",
	"Status: stopped",
	"Notice: Stopped by the user. Do not treat this as a subagent failure.",
	"Name: expanded result check",
]);
ok("stopped envelope has full model, effort, mode, tools, and metric parity",
	["Model: provider/model", "Effort: high", "Mode: forked · interactive · worktree", "Tools: read,edit,bash",
		"Elapsed: 3m 3s", "Context: 78k tokens", "Cost: $0.92"].every((line) => stopped.content.includes(line)));
eq("stopped envelope naturally omits response and result tokens",
	stopped.content.includes("<result>") || stopped.content.includes("Result:"), false);
eq("stopped details carry the same root field set", {
	model: stopped.details.model,
	effort: stopped.details.effort,
	tools: stopped.details.tools,
	exitCode: stopped.details.exitCode,
	reason: stopped.details.reason,
	contextWindow: stopped.details.contextWindow,
	worktree: stopped.details.worktree,
}, {
	model: base.model,
	effort: base.effort,
	tools: base.tools,
	exitCode: 130,
	reason: "stopped",
	contextWindow: 200_000,
	worktree: true,
});
eq("stopped presentation retains requester-specific fixed prose", stopped.details.presentation.preview,
	"Stopped by the user — no final result. Partial work may remain; expand for resume and worktree details.");

const compacted = buildSubagentResultMessage({
	...base,
	status: "completed",
	response: "Context was compacted.",
	contextTokens: null,
});
eq("builder preserves compacted context telemetry only in details", {
	details: compacted.details.contextTokens,
	envelopeHasContext: compacted.content.includes("Context:"),
}, { details: null, envelopeHasContext: false });

function matrixResult(status: SubagentResultStatus, present: boolean): SubagentResultMessage {
	const common = {
		name: `matrix ${status}`,
		agent: "worker",
		id: `id-${status}`,
		forked: present,
		interactive: present,
		worktree: present,
		model: present ? "model" : undefined,
		effort: present ? "low" : undefined,
		tools: present ? "read" : undefined,
		elapsedSeconds: 1,
		contextTokens: present ? 10 : undefined,
		contextWindow: present ? 100 : undefined,
		resultTokens: status !== "stopped" && present ? 2 : undefined,
		costUsd: present ? 0.01 : undefined,
		exitCode: status === "failed" ? 1 : 0,
		reason: status,
		sessionFile: `/sessions/${status}.jsonl`,
	};
	if (status === "completed") return buildSubagentResultMessage({ ...common, status, response: "done" });
	if (status === "failed") return buildSubagentResultMessage({ ...common, status, failureReason: "failed" });
	return buildSubagentResultMessage({ ...common, status, notice: "stopped", stopRequester: "model" });
}
for (const status of ["completed", "failed", "stopped"] as const) {
	for (const present of [false, true]) {
		const message = matrixResult(status, present);
		const parsed = parseSubagentResultEnvelope(message.content);
		eq(`${status} flags ${present ? "on" : "off"} round trip status`,
			parsed?.fields.find((field) => field.key === "status")?.value, status);
		eq(`${status} flags ${present ? "on" : "off"} mode optionality`,
			parsed?.fields.some((field) => field.key === "mode"), present);
		eq(`${status} optional fields ${present ? "present" : "absent"}`,
			["model", "effort", "tools", "context", "cost"].every((key) =>
				parsed?.fields.some((field) => field.key === key) === present), true);
	}
}

const roundTrip = parseSubagentResultEnvelope(completed.content);
eq("round trip recovers the response without markers", roundTrip?.response,
	"The command completed successfully.\n\nNo further action was needed.");
eq("round trip preserves canonical head and tail order", roundTrip?.fields.map((field) => field.key), [
	"status", "name", "agent", "id", "model", "effort", "mode", "tools", "elapsed", "context", "result", "cost",
	"resume", "session", "worktree",
]);

const external = buildSubagentResultMessage({
	...base,
	status: "completed",
	name: "branch check",
	agent: "ext",
	harness: "claude-code",
	id: "abcd1234",
	response: "The default branch is main.",
	model: undefined,
	effort: undefined,
	forked: false,
	interactive: false,
	worktree: false,
	tools: undefined,
	worktreeNote: undefined,
});
eq("external envelope names the harness", external.content.includes("Harness: claude-code"), true);
eq("external session line is a resume reference", external.content.includes(
	"Session ref: /sessions/child.jsonl (pass as sessionPath to subagent_resume if the id is no longer known; not a readable file)"), true);
eq("default capabilities are omitted", ["Model:", "Effort:", "Mode:", "Tools:"].some((line) =>
	external.content.includes(line)), false);

throws("result envelopes reject whitespace in agent identifiers", () => buildSubagentResultEnvelope({
	status: "stopped",
	name: "invalid agent",
	agent: "code reviewer",
	id: "badagent",
	elapsed: "1s",
	action: "Resume",
	actionMessage: "...",
	sessionFile: "/sessions/invalid.jsonl",
}), "whitespace");
eq("non-envelope content is rejected", parseSubagentResultEnvelope("ordinary custom message body"), undefined);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
