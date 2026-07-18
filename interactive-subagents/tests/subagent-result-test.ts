import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderSubagentLaunchResult } from "../subagent-result.ts";

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown): void {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}:\n    got  ${g}\n    want ${w}`); }
}

const started = {
	content: [{ type: "text", text: "Sub-agent started. Its result will arrive automatically - do not poll." }],
};
for (const tool of ["subagent_spawn", "subagent_resume"]) {
	let renderedError = false;
	const component = renderSubagentLaunchResult(started, false, () => {
		renderedError = true;
		return { invalidate() {}, render: () => ["unexpected"] };
	});
	eq(`${tool} success renders no result lines`, component.render(80), []);
	eq(`${tool} success does not construct error output`, renderedError, false);
}

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
	eq(`${tool} error text is passed through unchanged`, styledError, errorText);
	eq(`${tool} error remains visibly renderable`, error.render(100), [`ERROR: ${errorText}`]);
}

let sanitizedError = "";
renderSubagentLaunchResult(
	{ content: [{ type: "text", text: "Failed\x1b]52;c;Zm9v\x07 clearly.\0" }] },
	true,
	(text) => {
		sanitizedError = text;
		return { invalidate() {}, render: () => [text] };
	},
);
eq("error terminal controls are removed before rendering", sanitizedError, "Failed clearly.");

const directory = fileURLToPath(new URL("..", import.meta.url));
const spawnSource = readFileSync(`${directory}/tool-spawn.ts`, "utf8");
const resumeSource = readFileSync(`${directory}/tool-resume.ts`, "utf8");
eq("subagent_spawn uses the shared result renderer", spawnSource.includes("renderSubagentLaunchResult(result, context.isError"), true);
eq("subagent_resume uses the shared result renderer", resumeSource.includes("renderSubagentLaunchResult(result, context.isError"), true);
eq(
	"subagent_spawn limits parallel encouragement to independent bounded tasks",
	spawnSource.includes("are independent, bounded, and able to proceed concurrently."),
	true,
);
eq(
	"subagent_spawn guidance keeps unsuitable tasks in the parent",
	spawnSource.includes("Keep trivial tasks, tightly coupled or sequential work, and critical-path blockers in the parent."),
	true,
);
eq(
	"subagent_spawn guidance prohibits overlapping parallel write scopes",
	spawnSource.includes("Never give parallel sub-agents overlapping write scopes in the same checkout"),
	true,
);
eq(
	"subagent_spawn model-facing launch instruction remains in execute",
	spawnSource.includes('"Its result will arrive automatically \u2014 do not poll; continue with other work or end your turn."'),
	true,
);
eq(
	"subagent_resume model-facing launch instruction remains in execute",
	resumeSource.includes('text: `Resumed sub-agent "${name}" (id ${id}). Its result will arrive automatically \u2014 do not poll.`'),
	true,
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
