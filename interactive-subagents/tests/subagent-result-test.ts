import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderSubagentLaunchResult } from "../subagent-result.ts";

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown) {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}:\n    got  ${g}\n    want ${w}`); }
}

const started = {
	content: [{ type: "text", text: "Sub-agent started. Its result will arrive automatically - do not poll." }],
};
for (const tool of ["subagent", "subagent_resume"]) {
	let renderedError = false;
	const component = renderSubagentLaunchResult(started, false, () => {
		renderedError = true;
		return { invalidate() {}, render: () => ["unexpected"] };
	});
	eq(`${tool} success renders no result lines`, component.render(80), []);
	eq(`${tool} success does not construct error output`, renderedError, false);
}

const errorText = "Launch failed clearly.\nFix tmux and retry.";
for (const tool of ["subagent", "subagent_resume"]) {
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

const directory = fileURLToPath(new URL("..", import.meta.url));
const subagentSource = readFileSync(`${directory}/tool-subagent.ts`, "utf8");
const resumeSource = readFileSync(`${directory}/tool-resume.ts`, "utf8");
eq("subagent uses the shared result renderer", subagentSource.includes("renderSubagentLaunchResult(result, context.isError"), true);
eq("subagent_resume uses the shared result renderer", resumeSource.includes("renderSubagentLaunchResult(result, context.isError"), true);
eq(
	"subagent model-facing launch instruction remains in execute",
	subagentSource.includes('"Its result will arrive automatically \u2014 do not poll; continue with other work or end your turn."'),
	true,
);
eq(
	"subagent_resume model-facing launch instruction remains in execute",
	resumeSource.includes('text: `Resumed sub-agent "${name}" (id ${id}). Its result will arrive automatically \u2014 do not poll.`'),
	true,
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
