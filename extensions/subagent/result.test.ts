import { describe, expect, it } from "vitest";
import { deriveTitle, formatCompletionMessage, truncateResult } from "./result.ts";

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
	it("names the subagent, where it worked, and the truncation when the result was cut", () => {
		const message = formatCompletionMessage({
			id: "ab12cd",
			title: "Audit tests",
			status: "completed",
			model: "openai-codex/gpt-6-luna",
			cwd: "/wt/app",
			durationMs: 65_000,
			result: "# Findings\n- one",
			truncated: true,
			sessionFile: "/sessions/child.jsonl",
			worktree: { path: "/wt/app", branch: "pi/audit-tests" },
		});

		expect(message).toContain('Subagent "Audit tests" completed (id ab12cd, openai-codex/gpt-6-luna, 1m 5s).');
		expect(message).toContain("Worktree /wt/app on branch pi/audit-tests; it was left in place.");
		expect(message).toContain("# Findings\n- one");
		expect(message).toContain("[Result truncated. The full transcript is in the child session file: /sessions/child.jsonl.]");
	});

	it("reports the error and a placeholder when a failed child produced nothing", () => {
		const message = formatCompletionMessage({ id: "x", title: "t", status: "failed", model: "m", cwd: "/c", durationMs: 10, result: "", truncated: false, error: "boom" });
		expect(message).toContain("Error: boom");
		expect(message).toContain("(the subagent produced no final text)");
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
