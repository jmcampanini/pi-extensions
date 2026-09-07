import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { renderSubagentLaunchResult } from "../subagent-result.ts";
import { registerSubagentSpawnTool } from "../tool-spawn.ts";
import { registerSubagentResumeTool } from "../tool-resume.ts";

describe("renderSubagentLaunchResult", () => {
	it("successful launches render no result lines for either tool", () => {
		const started = {
			content: [{ type: "text", text: "Sub-agent started. Its result arrives on its own in a new turn." }],
		};
		for (const tool of ["subagent_spawn", "subagent_resume"]) {
			let renderedError = false;
			const component = renderSubagentLaunchResult(started, false, () => {
				renderedError = true;
				return { invalidate() {}, render: () => ["unexpected"] };
			});
			assert.deepStrictEqual(component.render(80), [], `${tool} success renders no result lines`);
			assert.strictEqual(renderedError, false, `${tool} success does not construct error output`);
		}
	});

	it("launch errors pass through unchanged and remain visibly renderable", () => {
		const errorText = "Launch failed clearly.\nFix tmux and retry.";
		for (const tool of ["subagent_spawn", "subagent_resume"]) {
			let styledError = "";
			const error = renderSubagentLaunchResult({ content: [{ type: "text", text: errorText }] }, true, (text) => {
				styledError = text;
				return { invalidate() {}, render: () => [`ERROR: ${text}`] };
			});
			assert.strictEqual(styledError, errorText, `${tool} error text is passed through unchanged`);
			assert.deepStrictEqual(
				error.render(100),
				[`ERROR: ${errorText}`],
				`${tool} error remains visibly renderable`,
			);
		}
	});

	it("error terminal controls are removed before rendering", () => {
		let sanitizedError = "";
		renderSubagentLaunchResult(
			{ content: [{ type: "text", text: "Failed\x1b]52;c;Zm9v\x07 clearly.\0" }] },
			true,
			(text) => {
				sanitizedError = text;
				return { invalidate() {}, render: () => [text] };
			},
		);
		assert.strictEqual(sanitizedError, "Failed clearly.");
	});
});

describe("registered launch result renderers", () => {
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		registerTool(tool: ToolDefinition): void {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerSubagentSpawnTool(pi);
	registerSubagentResumeTool(pi);
	const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;

	for (const name of ["subagent_spawn", "subagent_resume"]) {
		it(`${name} hides success output and renders sanitized failures`, () => {
			const tool = tools.get(name);
			assert.ok(tool?.renderResult);
			const context = {
				args: {},
				toolCallId: "launch-result",
				invalidate(): void {},
				lastComponent: undefined,
				state: {},
				cwd: process.cwd(),
				executionStarted: true,
				argsComplete: true,
				isPartial: false,
				expanded: false,
				showImages: false,
				isError: false,
			};
			const result = {
				content: [{ type: "text" as const, text: "Launch failed\x1b]52;c;Zm9v\x07." }],
				details: {},
			};
			const options = { expanded: false, isPartial: false };

			const success = tool.renderResult(result, options, theme, context);
			const failure = tool.renderResult(result, options, theme, { ...context, isError: true });

			assert.deepStrictEqual(success?.render(80), [], "success leaves output to the delivered result message");
			assert.deepStrictEqual(
				failure?.render(80).map((line) => line.trimEnd()),
				["Launch failed."],
				"failure remains visible without terminal controls",
			);
		});
	}
});

describe("tool-spawn and tool-resume sources", () => {
	const directory = fileURLToPath(new URL("..", import.meta.url));
	const spawnSource = readFileSync(`${directory}/tool-spawn.ts`, "utf8");
	const resumeSource = readFileSync(`${directory}/tool-resume.ts`, "utf8");

	it("subagent_spawn limits parallel encouragement to independent bounded tasks", () => {
		assert.strictEqual(spawnSource.includes("are independent, bounded, and able to proceed concurrently."), true);
	});

	it("subagent_spawn guidance keeps unsuitable tasks in the parent", () => {
		assert.strictEqual(
			spawnSource.includes(
				"Keep trivial tasks, tightly coupled or sequential work, and critical-path blockers in the parent.",
			),
			true,
		);
	});

	it("subagent_spawn guidance prohibits overlapping parallel write scopes", () => {
		assert.strictEqual(
			spawnSource.includes("Never give parallel sub-agents overlapping write scopes in the same checkout"),
			true,
		);
	});

	it("subagent_spawn model-facing launch instruction remains in execute", () => {
		assert.strictEqual(
			spawnSource.includes('"Its result arrives on its own in a new turn. Continue work that needs "') &&
				spawnSource.includes('"nothing from it, or tell the user what you are waiting on and end your turn."'),
			true,
		);
	});

	it("subagent_resume model-facing launch instruction remains in execute", () => {
		assert.strictEqual(
			resumeSource.includes(
				'`Resumed sub-agent "${name}" (id ${id}). Its result arrives on its own in a new turn. `',
			) &&
				resumeSource.includes(
					'"Continue work that needs nothing from it, or tell the user what you are waiting on and end your turn."',
				),
			true,
		);
	});
});
