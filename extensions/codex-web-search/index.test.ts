import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, ExtensionAPI, InputSource, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import codexWebSearch from "./index.ts";

type Codex = { answer?: string; code?: number; stderr?: string };

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(codex: Codex = { answer: "## Answer\nNode 24 shipped.\n\n## Sources\n- [Node](https://nodejs.org)" }) {
	const cwd = mkdtempSync(join(tmpdir(), "codex-web-search-"));
	dirs.push(cwd);
	const runs: { command: string; args: string[] }[] = [];
	let tool: ToolDefinition | undefined;
	const handlers = new Map<string, (event: unknown) => void>();
	const api = {
		on: (event: string, handler: (event: unknown) => void) => {
			handlers.set(event, handler);
		},
		registerTool: (definition: ToolDefinition) => {
			tool = definition;
		},
		exec: async (command: string, args: string[]): Promise<ExecResult> => {
			runs.push({ command, args });
			const outputPath = args[args.indexOf("--output-last-message") + 1]!;
			if (codex.answer !== undefined) writeFileSync(outputPath, codex.answer);
			return { stdout: "", stderr: codex.stderr ?? "", code: codex.code ?? 0, killed: false, truncated: false };
		},
	} as unknown as ExtensionAPI;
	codexWebSearch(api);

	return {
		cwd,
		runs,
		queue: (text: string, source: InputSource = "interactive") =>
			handlers.get("input")?.({ type: "input", text, source, streamingBehavior: "followUp" }),
		deliver: (text: string) =>
			handlers.get("message_start")?.({
				type: "message_start",
				message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
			}),
		prompt: (text: string, source: InputSource = "interactive") => {
			handlers.get("input")?.({ type: "input", text, source });
			handlers.get("message_start")?.({
				type: "message_start",
				message: { role: "user", content: text, timestamp: 0 },
			});
		},
		search: async (params: { query: string; extract?: string; effort?: string }) => {
			const result = await tool!.execute("call-1", params as never, undefined, undefined, { cwd } as never);
			const first = result.content[0];
			return first?.type === "text" ? first.text : "";
		},
	};
}

const prompt = (args: string[]) => args.at(-1)!;
const flagValues = (args: string[], flag: string) => args.flatMap((arg, i) => (args[i - 1] === flag ? [arg] : []));

describe("web_search", () => {
	it("runs codex exec with GPT-6 Luna in Fast mode and returns the saved answer", async () => {
		const test = setup();

		const text = await test.search({ query: "node 24 release date" });

		expect(test.runs).toHaveLength(1);
		const { command, args } = test.runs[0]!;
		expect(command).toBe("codex");
		expect(args[0]).toBe("exec");
		expect(flagValues(args, "--model")).toEqual(["gpt-6-luna"]);
		expect(flagValues(args, "--config")).toEqual(
			expect.arrayContaining([
				"features.fast_mode=true",
				'service_tier="fast"',
				"sandbox_workspace_write.network_access=true",
				'approval_policy="never"',
				'model_reasoning_effort="medium"',
			]),
		);
		expect(prompt(args)).toMatch(/Search query:\nnode 24 release date$/);
		expect(prompt(args)).not.toContain("Extraction instruction:\n");

		const saved = readdirSync(join(test.cwd, ".codex-web-search")).sort();
		expect(saved).toHaveLength(2);
		expect(saved[0]).toMatch(/^\d{12}-[0-9a-f]+-prompt\.md$/);
		expect(saved[1]).toBe(saved[0]!.replace("-prompt.md", "-response.md"));
		const responsePath = join(test.cwd, ".codex-web-search", saved[1]!);
		expect(flagValues(args, "--output-last-message")).toEqual([responsePath]);
		expect(readFileSync(join(test.cwd, ".codex-web-search", saved[0]!), "utf8")).toBe(`${prompt(args)}\n`);
		expect(text).toBe(
			`Saved path: ${responsePath}\n\n## Answer\nNode 24 shipped.\n\n## Sources\n- [Node](https://nodejs.org)`,
		);
	});

	it("passes the extraction instruction and reasoning effort to codex", async () => {
		const test = setup();

		await test.search({ query: "vitest releases", extract: "just the version numbers", effort: "high" });

		const { args } = test.runs[0]!;
		expect(prompt(args)).toMatch(
			/Search query:\nvitest releases\n\nExtraction instruction:\njust the version numbers$/,
		);
		expect(flagValues(args, "--config")).toContain('model_reasoning_effort="high"');
	});

	it.each([
		"https://github.com/earendil-works/pi/issues/123",
		"github.com/org/repo/pull/7 review",
		"earendil-works/pi#4744",
		"pi issue #12",
		"vitest pr 4744",
	])("refuses a lookup of a specific GitHub issue or pull request: %s", async (query) => {
		const test = setup();

		await expect(test.search({ query })).rejects.toThrow(/use gh for that instead.*force-web/);

		expect(test.runs).toEqual([]);
	});

	it("searches a short issue number, which is more likely an HTTP status than an issue", async () => {
		const test = setup();

		await test.search({ query: "nginx issue 404" });

		expect(test.runs).toHaveLength(1);
	});

	it("allows a GitHub issue lookup only for the turn the person typed force-web", async () => {
		const test = setup();

		test.prompt("look up pi#4744 FORCE-WEB please");
		await test.search({ query: "earendil-works/pi#4744 force-web" });
		expect(prompt(test.runs[0]!.args)).toMatch(/Search query:\nearendil-works\/pi#4744$/);

		test.prompt("now the next one");
		await expect(test.search({ query: "earendil-works/pi#4745" })).rejects.toThrow(/use gh/);

		test.prompt("force-web earendil-works/pi#4745", "extension");
		await expect(test.search({ query: "earendil-works/pi#4745" })).rejects.toThrow(/use gh/);

		test.prompt("force-web", "rpc");
		await test.search({ query: "earendil-works/pi#4745" });
		expect(test.runs).toHaveLength(2);
	});

	it("applies force-web from a queued prompt only once Pi delivers that prompt", async () => {
		const test = setup();

		test.prompt("force-web look up pi#4744");
		test.queue("then summarize it");
		await test.search({ query: "earendil-works/pi#4744" });
		expect(test.runs).toHaveLength(1);

		test.deliver("then summarize it");
		test.queue("force-web look up pi#4745");
		await expect(test.search({ query: "earendil-works/pi#4745" })).rejects.toThrow(/use gh/);

		test.deliver("force-web look up pi#4745");
		await test.search({ query: "earendil-works/pi#4745" });
		expect(test.runs).toHaveLength(2);
	});

	it("does not grant force-web for any copy of a message an extension queued twice", async () => {
		const test = setup();

		test.queue("force-web look up pi#4744", "extension");
		test.queue("force-web look up pi#4744", "extension");

		test.deliver("force-web look up pi#4744");
		await expect(test.search({ query: "earendil-works/pi#4744" })).rejects.toThrow(/use gh/);
		test.deliver("force-web look up pi#4744");
		await expect(test.search({ query: "earendil-works/pi#4744" })).rejects.toThrow(/use gh/);
	});

	it("rejects a query that is empty once force-web is removed", async () => {
		const test = setup();

		await expect(test.search({ query: "  force-web " })).rejects.toThrow("web_search needs a non-empty query.");

		expect(test.runs).toEqual([]);
	});

	it("reports a failed codex exec with the end of its stderr", async () => {
		const test = setup({ code: 2, stderr: "error: model gpt-6-luna not available\n" });

		await expect(test.search({ query: "anything" })).rejects.toThrow(
			"codex exec failed (exit 2): error: model gpt-6-luna not available",
		);
	});

	it("reports a codex exec that wrote no answer", async () => {
		const test = setup({ answer: "  \n" });

		await expect(test.search({ query: "anything" })).rejects.toThrow("codex exec returned no answer.");
	});

	it("truncates a long answer and points to the saved file for the rest", async () => {
		const lines = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`);
		const test = setup({ answer: lines.join("\n") });

		const text = await test.search({ query: "long" });

		expect(text).toContain("line 2000\n");
		expect(text).not.toContain("line 2001");
		expect(text).toMatch(/\[Answer truncated to 2000 of 2500 lines .*Read the saved path for the rest\.\]$/);
		const responsePath = text.match(/^Saved path: (.+)$/m)![1]!;
		expect(readFileSync(responsePath, "utf8")).toBe(lines.join("\n"));
	});
});
