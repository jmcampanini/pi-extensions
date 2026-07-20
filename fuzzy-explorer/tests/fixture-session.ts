import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface FixtureSession {
	sessionFile: string;
	fullOutputPath: string;
	missingFullOutputPath: string;
	activeEntryIds: string[];
	abandonedEntryIds: string[];
}

const usage = {
	input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Build a deterministic branched transcript used by unit and tmux smoke tests. */
export function buildFixtureSession(directory: string, additionalMessages = 0): FixtureSession {
	rmSync(directory, { recursive: true, force: true });
	mkdirSync(directory, { recursive: true });
	const sessionFile = join(directory, "fuzzy-explorer-fixture.jsonl");
	const fullOutputPath = join(directory, "surviving-full-output.txt");
	const missingFullOutputPath = join(directory, "missing-full-output.txt");
	writeFileSync(fullOutputPath, "full output that is deliberately not searchable\n", "utf8");

	const entries: Record<string, unknown>[] = [{
		type: "session", version: 3, id: "11111111-2222-4333-8444-555555555555",
		timestamp: "2026-01-01T00:00:00.000Z", cwd: resolve("."),
	}];
	const add = (entry: Record<string, unknown>): void => { entries.push(entry); };
	const base = (id: string, parentId: string | null, second: number) => ({
		id, parentId, timestamp: `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`,
	});

	add({ ...base("00000001", null, 1), type: "message", message: {
		role: "user", content: "active root asks about src/config.ts", timestamp: 1,
	} });

	// This child path is abandoned when the later branch_summary points back to the root.
	add({ ...base("a0000001", "00000001", 2), type: "message", message: {
		role: "user", content: "ABANDONED_SECRET_NEVER_INDEX", timestamp: 2,
	} });
	add({ ...base("a0000002", "a0000001", 3), type: "message", message: {
		role: "assistant", content: [{ type: "text", text: "abandoned assistant text" }],
		api: "openai-completions", provider: "openai", model: "fixture", usage, stopReason: "stop", timestamp: 3,
	} });

	add({ ...base("00000002", "00000001", 4), type: "branch_summary", fromId: "a0000002",
		summary: "Returned from an abandoned experiment." });
	add({ ...base("00000003", "00000002", 5), type: "message", message: {
		role: "assistant",
		content: [
			{ type: "text", text: "I will inspect the active configuration." },
			{ type: "thinking", thinking: "HIDDEN_THINKING_NEVER_INDEX" },
			{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "src/config.ts", offset: 12 } },
		],
		api: "openai-completions", provider: "openai", model: "fixture", usage, stopReason: "toolUse", timestamp: 5,
	} });
	add({ ...base("00000004", "00000003", 6), type: "message", message: {
		role: "toolResult", toolCallId: "call-read", toolName: "read",
		content: [{ type: "text", text: "STORED_RESULT_ONLY_NEEDLE\nexport const fixture = true;" }],
		details: {}, isError: false, timestamp: 6,
	} });
	add({ ...base("00000005", "00000004", 7), type: "label", targetId: "00000003", label: "configuration checkpoint" });

	add({ ...base("00000006", "00000005", 8), type: "message", message: {
		role: "assistant", content: [{ type: "toolCall", id: "call-truncated", name: "grep", arguments: {
			pattern: "needle", path: "src", line: 42,
		} }], api: "openai-completions", provider: "openai", model: "fixture", usage, stopReason: "toolUse", timestamp: 8,
	} });
	add({ ...base("00000007", "00000006", 9), type: "message", message: {
		role: "toolResult", toolCallId: "call-truncated", toolName: "grep",
		content: [{ type: "text", text: "src/large.ts:42:stored truncated needle" }], isError: false, timestamp: 9,
		details: { fullOutputPath, truncation: {
			content: "src/large.ts:42:stored truncated needle", truncated: true, truncatedBy: "lines",
			totalLines: 5000, totalBytes: 100000, outputLines: 1, outputBytes: 45,
			lastLinePartial: false, firstLineExceedsLimit: false, maxLines: 1, maxBytes: 50000,
		} },
	} });

	add({ ...base("00000008", "00000007", 10), type: "message", message: {
		role: "assistant", content: [{ type: "toolCall", id: "call-gone", name: "read", arguments: { path: "gone.log" } }],
		api: "openai-completions", provider: "openai", model: "fixture", usage, stopReason: "toolUse", timestamp: 10,
	} });
	add({ ...base("00000009", "00000008", 11), type: "message", message: {
		role: "toolResult", toolCallId: "call-gone", toolName: "read",
		content: [{ type: "text", text: "last stored lines only" }], isError: true, timestamp: 11,
		details: { fullOutputPath: missingFullOutputPath, truncation: {
			content: "last stored lines only", truncated: true, truncatedBy: "bytes", totalLines: 9000,
			totalBytes: 900000, outputLines: 1, outputBytes: 22, lastLinePartial: false,
			firstLineExceedsLimit: false, maxLines: 2000, maxBytes: 22,
		} },
	} });

	add({ ...base("0000000a", "00000009", 12), type: "message", message: {
		role: "toolResult", toolCallId: "orphan-call", toolName: "mystery",
		content: [{ type: "text", text: "orphan result remains visible" }], isError: false, timestamp: 12,
	} });
	add({ ...base("0000000b", "0000000a", 13), type: "message", message: {
		role: "bashExecution", command: "printf bash-fixture", output: "bash-fixture", exitCode: 0,
		cancelled: false, truncated: false, timestamp: 13,
	} });
	add({ ...base("0000000c", "0000000b", 14), type: "message", message: {
		role: "custom", customType: "fixture-card", content: "visible custom message", display: true, timestamp: 14,
	} });
	add({ ...base("0000000d", "0000000c", 15), type: "custom_message", customType: "fixture-entry",
		content: "visible custom entry message", display: true });
	add({ ...base("0000000e", "0000000d", 16), type: "custom_message", customType: "fixture-hidden",
		content: "HIDDEN_CUSTOM_NEVER_INDEX", display: false });
	add({ ...base("0000000f", "0000000e", 17), type: "compaction", summary: "Compaction summary fixture text.",
		firstKeptEntryId: "00000001", tokensBefore: 12345 });
	add({ ...base("00000010", "0000000f", 18), type: "message", message: {
		role: "user", content: [{ type: "text", text: "latest active user block" }, {
			type: "image", data: "BASE64_IMAGE_NEVER_INDEX", mimeType: "image/png",
		}], timestamp: 18,
	} });

	let parentId = "00000010";
	for (let index = 0; index < additionalMessages; index++) {
		const id = (0x100 + index).toString(16).padStart(8, "0");
		const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 1) + index * 1000).toISOString();
		add({ id, parentId, timestamp, type: "message", message: {
			role: "user", content: `large-session-row-${String(index).padStart(5, "0")}`,
			timestamp: Date.parse(timestamp),
		} });
		parentId = id;
	}

	writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
	return {
		sessionFile,
		fullOutputPath,
		missingFullOutputPath,
		activeEntryIds: entries.slice(1).map((entry) => String(entry.id)).filter((id) => !id.startsWith("a")),
		abandonedEntryIds: ["a0000001", "a0000002"],
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const fixture = buildFixtureSession(
		resolve(process.argv[2] ?? ".sandbox/fuzzy-explorer-fixture"),
		Number(process.argv[3] ?? 0),
	);
	console.log(JSON.stringify(fixture));
}
