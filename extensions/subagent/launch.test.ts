import { describe, expect, it } from "vitest";
import { childOutcome, summarizeArgs } from "./launch.ts";

const source = (last: { stopReason?: string; errorMessage?: string } | undefined, text = "done") => ({
	messages: [{ role: "user" }, ...(last ? [{ role: "assistant", ...last }] : [])],
	getLastAssistantText: () => text,
});

describe("childOutcome", () => {
	it("reports a provider error recorded on the last assistant message as a failure", () => {
		expect(childOutcome(source({ stopReason: "error", errorMessage: "401 unauthorized" }), "completed", undefined, 5)).toEqual({ status: "failed", error: "401 unauthorized", text: "done", durationMs: 5 });
	});

	it("reports an aborted last message as cancelled and a clean stop as completed", () => {
		expect(childOutcome(source({ stopReason: "aborted" }), "completed", undefined, 5).status).toBe("cancelled");
		expect(childOutcome(source({ stopReason: "stop" }), "completed", undefined, 5)).toEqual({ status: "completed", error: undefined, text: "done", durationMs: 5 });
	});

	it("keeps a thrown failure's status and message", () => {
		expect(childOutcome(source(undefined, ""), "failed", "boom", 1)).toEqual({ status: "failed", error: "boom", text: "", durationMs: 1 });
	});
});

describe("summarizeArgs", () => {
	it("shows the first line of the most descriptive argument, shortened", () => {
		expect(summarizeArgs({ command: "ls -la\nsecond" })).toBe("ls -la");
		expect(summarizeArgs({ path: "a".repeat(120) })).toHaveLength(100);
		expect(summarizeArgs("nope")).toBe("");
	});
});
