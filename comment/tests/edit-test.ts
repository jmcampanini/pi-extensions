import type { ActionTui } from "../../fuzzy-explorer/actions.ts";
import { editTextExternally } from "../index.ts";

let pass = 0;
let fail = 0;

function eq(label: string, got: unknown, want: unknown): void {
	const actual = JSON.stringify(got);
	const expected = JSON.stringify(want);
	if (actual === expected) {
		pass++;
		console.log(`  ok  ${label}`);
	} else {
		fail++;
		console.log(`  FAIL ${label}: got ${actual}, want ${expected}`);
	}
}

function fakeTui(): { tui: ActionTui; calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		tui: {
			stop: () => calls.push("stop"),
			start: () => calls.push("start"),
			requestRender: (force?: boolean) => calls.push(`render(${force === true})`),
		},
	};
}

// The fake editor is `sh -c '<script>'`; the temp file arrives as $0.
async function main(): Promise<void> {
	{
		const { tui, calls } = fakeTui();
		const outcome = await editTextExternally(tui, "sh -c 'printf \" world\" >> \"$0\"'", "hello");
		eq("successful edit returns the file text", outcome, { exitCode: 0, text: "hello world" });
		eq("successful edit restarts the TUI after stopping it", calls, ["stop", "start", "render(true)"]);
	}

	{
		const { tui, calls } = fakeTui();
		const outcome = await editTextExternally(tui, "sh -c 'exit 3'", "hello");
		eq("non-zero exit returns only the exit code", outcome, { exitCode: 3 });
		eq("non-zero exit restarts the TUI", calls, ["stop", "start", "render(true)"]);
	}

	{
		const { tui, calls } = fakeTui();
		const outcome = await editTextExternally(tui, "pi-comment-test-missing-editor", "hello");
		eq("spawn failure reports an error", [outcome.exitCode, outcome.error !== undefined], [null, true]);
		eq("spawn failure restarts the TUI", calls, ["stop", "start", "render(true)"]);
	}

	{
		const { tui, calls } = fakeTui();
		const outcome = await editTextExternally(tui, "\"unclosed", "hello");
		eq("unparseable editor command reports an error", [outcome.exitCode, outcome.error !== undefined], [null, true]);
		eq("unparseable editor command never touches the TUI", calls, []);
	}

	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail === 0 ? 0 : 1);
}

void main();
