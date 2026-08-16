import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSubagentResultEnvelope } from "../../shared/subagent-envelope.ts";
import {
	buildSubagentResultEnvelope,
	buildSubagentResultMessage,
	type SubagentResultMessage,
	type SubagentResultStatus,
} from "../result-content.ts";

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

describe("buildSubagentResultMessage", () => {
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

	it("completed envelope uses canonical verdict, identity, capability, and metric order", () => {
		assert.ok(completed.content.startsWith(completedHead));
	});

	it("response range extracts only the sanitized child result", () => {
		assert.strictEqual(
			completed.details.expanded.response && completed.content.slice(
				completed.details.expanded.response.start,
				completed.details.expanded.response.end,
			),
			"The command completed successfully.\n\nNo further action was needed.");
	});

	it("model content strips terminal controls", () => {
		assert.strictEqual(completed.content.includes("\x1b]52"), false);
	});

	it("builder derives completed action", () => {
		assert.strictEqual(completed.content.includes(
			'Resume: subagent_resume({ id: "15c3f450", message: "..." })'), true);
	});

	it("builder keeps content and details identity/capabilities consistent", () => {
		assert.deepStrictEqual({
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
	});

	it("builder retains details-only completion telemetry", () => {
		assert.deepStrictEqual({
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
	});

	const failed = buildSubagentResultMessage({
		...base,
		status: "failed",
		response: "Partial output.",
		failureReason: "exit code 23",
		exitCode: 23,
		reason: "exited",
	});

	it("failure is hoisted directly below status", () => {
		assert.deepStrictEqual(failed.content.split("\n").slice(0, 4), [
			"Subagent result",
			"Status: failed",
			"Failure: exit code 23",
			"Name: expanded result check",
		]);
	});

	it("failed builder derives retry guidance", () => {
		assert.strictEqual(failed.content.includes(
			'Retry: subagent_resume({ id: "15c3f450", message: "<guidance>" })'), true);
	});

	it("failed presentation prefers partial output", () => {
		assert.strictEqual(failed.details.presentation.preview, "Partial output.");
	});

	it("failed expanded details retain failure and exact response offsets", () => {
		assert.deepStrictEqual({
			failureReason: failed.details.expanded.failureReason,
			response: failed.details.expanded.response && failed.content.slice(
				failed.details.expanded.response.start,
				failed.details.expanded.response.end,
			),
		}, { failureReason: "exit code 23", response: "Partial output." });
	});

	const stopped = buildSubagentResultMessage({
		...base,
		status: "stopped",
		notice: "Stopped by the user. Do not treat this as a subagent failure.",
		stopRequester: "user",
		exitCode: 130,
		reason: "stopped",
		resultTokens: undefined,
	});

	it("notice is hoisted directly below status", () => {
		assert.deepStrictEqual(stopped.content.split("\n").slice(0, 4), [
			"Subagent result",
			"Status: stopped",
			"Notice: Stopped by the user. Do not treat this as a subagent failure.",
			"Name: expanded result check",
		]);
	});

	it("stopped envelope has full model, effort, mode, tools, and metric parity", () => {
		assert.ok(["Model: provider/model", "Effort: high", "Mode: forked · interactive · worktree", "Tools: read,edit,bash",
			"Elapsed: 3m 3s", "Context: 78k tokens", "Cost: $0.92"].every((line) => stopped.content.includes(line)));
	});

	it("stopped envelope naturally omits response and result tokens", () => {
		assert.strictEqual(stopped.content.includes("<result>") || stopped.content.includes("Result:"), false);
	});

	it("stopped details carry the same root field set", () => {
		assert.deepStrictEqual({
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
	});

	it("stopped presentation retains requester-specific fixed prose", () => {
		assert.strictEqual(stopped.details.presentation.preview,
			"Stopped by the user — no final result. Partial work may remain; expand for resume and worktree details.");
	});

	it("builder preserves compacted context telemetry only in details", () => {
		const compacted = buildSubagentResultMessage({
			...base,
			status: "completed",
			response: "Context was compacted.",
			contextTokens: null,
		});
		assert.deepStrictEqual({
			details: compacted.details.contextTokens,
			envelopeHasContext: compacted.content.includes("Context:"),
		}, { details: null, envelopeHasContext: false });
	});

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

	it("external envelope names the harness", () => {
		assert.strictEqual(external.content.includes("Harness: claude-code"), true);
	});

	it("external session line is a resume reference", () => {
		assert.strictEqual(external.content.includes(
			"Session ref: /sessions/child.jsonl (pass as sessionPath to subagent_resume if the id is no longer known; not a readable file)"), true);
	});

	it("default capabilities are omitted", () => {
		assert.strictEqual(["Model:", "Effort:", "Mode:", "Tools:"].some((line) =>
			external.content.includes(line)), false);
	});
});

describe("buildSubagentResultEnvelope", () => {
	it("result envelopes reject whitespace in agent identifiers", () => {
		assert.throws(() => buildSubagentResultEnvelope({
			status: "stopped",
			name: "invalid agent",
			agent: "code reviewer",
			id: "badagent",
			elapsed: "1s",
			action: "Resume",
			actionMessage: "...",
			sessionFile: "/sessions/invalid.jsonl",
		}), /whitespace/);
	});
});

describe("parseSubagentResultEnvelope", () => {
	it("every status round trips its flags and optional capability fields", () => {
		for (const status of ["completed", "failed", "stopped"] as const) {
			for (const present of [false, true]) {
				const message = matrixResult(status, present);
				const parsed = parseSubagentResultEnvelope(message.content);
				assert.strictEqual(
					parsed?.fields.find((field) => field.key === "status")?.value, status,
					`${status} flags ${present ? "on" : "off"} round trip status`);
				assert.strictEqual(
					parsed?.fields.some((field) => field.key === "mode"), present,
					`${status} flags ${present ? "on" : "off"} mode optionality`);
				assert.strictEqual(
					["model", "effort", "tools", "context", "cost"].every((key) =>
						parsed?.fields.some((field) => field.key === key) === present), true,
					`${status} optional fields ${present ? "present" : "absent"}`);
			}
		}
	});

	const roundTrip = parseSubagentResultEnvelope(
		buildSubagentResultMessage({ ...base, status: "completed", response }).content,
	);

	it("round trip recovers the response without markers", () => {
		assert.strictEqual(roundTrip?.response,
			"The command completed successfully.\n\nNo further action was needed.");
	});

	it("round trip preserves canonical head and tail order", () => {
		assert.deepStrictEqual(roundTrip?.fields.map((field) => field.key), [
			"status", "name", "agent", "id", "model", "effort", "mode", "tools", "elapsed", "context", "result", "cost",
			"resume", "session", "worktree",
		]);
	});

	it("non-envelope content is rejected", () => {
		assert.strictEqual(parseSubagentResultEnvelope("ordinary custom message body"), undefined);
	});
});
