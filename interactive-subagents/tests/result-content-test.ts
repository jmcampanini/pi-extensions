import { buildSubagentResultEnvelope } from "../result-content.ts";

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown): void {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}:\n    got  ${g}\n    want ${w}`); }
}

const response = "The command completed successfully.\n\nNo further action was needed.\x1b]52;c;Zm9v\x07";
const completed = buildSubagentResultEnvelope({
	status: "completed",
	name: "expanded\nresult check",
	agent: "worker",
	id: "15c3f450",
	elapsed: "7s",
	contextTokens: 1_818,
	resultTokens: 13,
	costUsd: 0.013,
	response,
	action: "Resume",
	actionMessage: "...",
	sessionFile: "/sessions/child.jsonl",
	worktreeNote: "Worktree: kept at /repo/worktree on branch pi/check.",
});
const completedContent = [
	"Subagent result",
	"Status: completed",
	"Name: expanded result check",
	"Agent: worker",
	"ID: 15c3f450",
	"Elapsed: 7s",
	"Context: 1.8k tokens",
	"Result: ~13 tokens",
	"Cost: $0.01",
	"",
	"<result>",
	"The command completed successfully.",
	"",
	"No further action was needed.",
	"</result>",
	"",
	'Resume: subagent_resume({ id: "15c3f450", message: "..." })',
	"Session: /sessions/child.jsonl",
	"Worktree: kept at /repo/worktree on branch pi/check.",
].join("\n");
eq("completed envelope", completed.content, completedContent);
eq("response range extracts only the sanitized child result",
	completed.response && completed.content.slice(completed.response.start, completed.response.end),
	"The command completed successfully.\n\nNo further action was needed.");
eq("model content strips terminal controls", completed.content.includes("\x1b]52"), false);

const failed = buildSubagentResultEnvelope({
	status: "failed",
	name: "API review",
	agent: "reviewer",
	id: "deadbeef",
	elapsed: "2m 14s",
	contextTokens: 84_000,
	costUsd: 0.003,
	failureReason: "provider error",
	action: "Retry",
	actionMessage: "<guidance>",
	sessionFile: "/sessions/failed.jsonl",
});
eq("failed envelope has stable labeled metadata", failed.content.startsWith([
	"Subagent result",
	"Status: failed",
	"Name: API review",
	"Agent: reviewer",
	"ID: deadbeef",
	"Elapsed: 2m 14s",
	"Context: 84k tokens",
	"Cost: < $0.01",
	"Failure: provider error",
].join("\n")), true);
eq("failed envelope omits an absent result block", failed.content.includes("<result>"), false);
eq("failed envelope uses retry guidance",
	failed.content.includes('Retry: subagent_resume({ id: "deadbeef", message: "<guidance>" })'), true);

const stopped = buildSubagentResultEnvelope({
	status: "stopped",
	name: "manual task",
	agent: "",
	id: "12345678",
	elapsed: "9s",
	notice: "Stopped by the user. Do not treat this as a subagent failure.",
	action: "Resume",
	actionMessage: "...",
	sessionFile: "/sessions/stopped.jsonl",
});
eq("blank agents fall back to worker", stopped.content.includes("Agent: worker"), true);
eq("stopped envelope explains user intent",
	stopped.content.includes("Notice: Stopped by the user. Do not treat this as a subagent failure."), true);
eq("unknown economics are omitted",
	stopped.content.includes("Context:") || stopped.content.includes("Result:") || stopped.content.includes("Cost:"), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
