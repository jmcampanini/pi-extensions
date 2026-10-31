import { describe, expect, it } from "vitest";
import { backgroundStartedText, type CompletionSummary, completionPrefix, deriveTitle, formatCompletionMessage, formatForegroundReport, truncateResult } from "./result.ts";

const completed: CompletionSummary = {
	id: "ab12cd",
	title: "Audit tests",
	mode: "background",
	context: "fresh",
	status: "completed",
	model: "openai-codex/gpt-6-luna",
	effort: "low",
	cwd: "/wt/app",
	durationMs: 65_000,
	result: "# Findings\n- one",
	truncated: true,
	sessionFile: "/sessions/child.jsonl",
	worktree: { path: "/wt/app", branch: "pi/audit-tests" },
};

const failed: CompletionSummary = { ...completed, status: "failed", result: "", truncated: false, error: "boom", sessionFile: undefined, worktree: undefined };

describe("truncateResult", () => {
	it("keeps text within both limits unchanged", () => {
		expect(truncateResult("a\nb", { maxChars: 10, maxLines: 5 })).toEqual({ text: "a\nb", truncated: false });
	});

	it("cuts by lines first, then by characters, and reports it", () => {
		expect(truncateResult("1\n2\n3\n4", { maxChars: 100, maxLines: 2 })).toEqual({ text: "1\n2", truncated: true });
		expect(truncateResult("abcdef", { maxChars: 3, maxLines: 10 })).toEqual({ text: "abc", truncated: true });
	});
});

describe("formatCompletionMessage", () => {
	it("starts with the prefix the model is told to expect, then where it worked, the body, and the notes", () => {
		const message = formatCompletionMessage(completed);

		expect(message.startsWith(`${completionPrefix("Audit tests")} completed (id ab12cd, openai-codex/gpt-6-luna, 1m 5s).`)).toBe(true);
		expect(message).toContain("Worked in /wt/app.");
		expect(message).toContain("Child session: /sessions/child.jsonl");
		expect(message).toContain("# Findings\n- one");
		expect(message).toContain("[Result truncated. The full transcript is in the child session file: /sessions/child.jsonl.]");
		expect(message).toContain("Worktree /wt/app on branch pi/audit-tests was left in place.");
	});

	it("reports the error and a placeholder when a failed child produced nothing", () => {
		const message = formatCompletionMessage(failed);
		expect(message).toContain("Error: boom");
		expect(message).toContain("(the subagent produced no final text)");
	});
});

describe("formatForegroundReport", () => {
	it("gives the same body and notes as the completion message without the header lines", () => {
		const report = formatForegroundReport(completed);

		expect(report.startsWith("# Findings\n- one")).toBe(true);
		expect(report).toContain("[Result truncated. The full transcript is in the child session file: /sessions/child.jsonl.]");
		expect(report).toContain("Worktree /wt/app on branch pi/audit-tests was left in place.");
		expect(report).not.toContain("Worked in");
	});

	it("leads with the failure when the child did not complete", () => {
		expect(formatForegroundReport(failed).split("\n")[0]).toBe("Subagent failed: boom");
	});
});

describe("backgroundStartedText", () => {
	it("names the child, where it works, and the prefix its report will start with", () => {
		const text = backgroundStartedText(completed);
		expect(text).toContain('Started subagent "Audit tests" (id ab12cd)');
		expect(text).toContain("worktree /wt/app on branch pi/audit-tests");
		expect(text).toContain(completionPrefix("Audit tests"));
	});
});

describe("deriveTitle", () => {
	it("uses the title when given, else the first line of the task, shortened", () => {
		expect(deriveTitle("do the thing\nmore", undefined)).toBe("do the thing");
		expect(deriveTitle("x", "Given title")).toBe("Given title");
		expect(deriveTitle("w".repeat(80))).toHaveLength(60);
		expect(deriveTitle("   ")).toBe("subagent");
	});
});
