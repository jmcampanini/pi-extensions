import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderSubagentLaunchResult } from "../subagent-result.ts";

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
			const error = renderSubagentLaunchResult(
				{ content: [{ type: "text", text: errorText }] },
				true,
				(text) => {
					styledError = text;
					return { invalidate() {}, render: () => [`ERROR: ${text}`] };
				},
			);
			assert.strictEqual(styledError, errorText, `${tool} error text is passed through unchanged`);
			assert.deepStrictEqual(error.render(100), [`ERROR: ${errorText}`], `${tool} error remains visibly renderable`);
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

describe("tool-spawn and tool-resume sources", () => {
	const directory = fileURLToPath(new URL("..", import.meta.url));
	const spawnSource = readFileSync(`${directory}/tool-spawn.ts`, "utf8");
	const resumeSource = readFileSync(`${directory}/tool-resume.ts`, "utf8");

	it("subagent_spawn uses the shared result renderer", () => {
		assert.strictEqual(spawnSource.includes("renderSubagentLaunchResult(result, context.isError"), true);
	});

	it("subagent_resume uses the shared result renderer", () => {
		assert.strictEqual(resumeSource.includes("renderSubagentLaunchResult(result, context.isError"), true);
	});

	it("subagent_spawn limits parallel encouragement to independent bounded tasks", () => {
		assert.strictEqual(
			spawnSource.includes("are independent, bounded, and able to proceed concurrently."),
			true,
		);
	});

	it("subagent_spawn guidance keeps unsuitable tasks in the parent", () => {
		assert.strictEqual(
			spawnSource.includes("Keep trivial tasks, tightly coupled or sequential work, and critical-path blockers in the parent."),
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
			spawnSource.includes('"Its result arrives on its own in a new turn. Continue work that needs "')
				&& spawnSource.includes('"nothing from it, or tell the user what you are waiting on and end your turn."'),
			true,
		);
	});

	it("subagent_resume model-facing launch instruction remains in execute", () => {
		assert.strictEqual(
			resumeSource.includes('`Resumed sub-agent "${name}" (id ${id}). Its result arrives on its own in a new turn. `')
				&& resumeSource.includes('"Continue work that needs nothing from it, or tell the user what you are waiting on and end your turn."'),
			true,
		);
	});
});
