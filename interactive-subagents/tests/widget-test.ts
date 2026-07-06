import { formatElapsed, formatRunningWidgetLines, stripAgentPrefix } from "../widget.ts";

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown) {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}:\n    got  ${g}\n    want ${w}`); }
}

// elapsed formatting
eq("mm:ss", formatElapsed(83), "01:23");
eq("h:mm:ss past an hour", formatElapsed(3723), "1:02:03");

// prefix strip: exact type + separator only
eq("strips 'Scout: Auth'", stripAgentPrefix("Scout: Auth", "scout"), "Auth");
eq("strips dash separator", stripAgentPrefix("worker - quick fix", "worker"), "quick fix");
eq("keeps non-matching prefix", stripAgentPrefix("Scouting: Auth", "scout"), "Scouting: Auth");
eq("keeps name without separator", stripAgentPrefix("Scout Auth", "scout"), "Scout Auth");
eq("keeps name when strip would empty it", stripAgentPrefix("scout: ", "scout"), "scout: ");
eq("no agent, no strip", stripAgentPrefix("Scout: Auth", undefined), "Scout: Auth");

// full rows at a comfortable width
const rows = [
	{ name: "Scout: Auth", agent: "scout", elapsedSeconds: 23 },
	{ name: "quick fix", agent: "worker", elapsedSeconds: 4 },
];
const lines = formatRunningWidgetLines(rows, 60);
eq("border rule + child rows, no footer", lines.length, 3);
eq("top rule spans width", lines[0], "─".repeat(60));
eq("row 1", lines[1], " [scout]   Auth" + " ".repeat(60 - 15 - 6) + "00:23 ");
eq("row 2", lines[2], " [worker]  quick fix" + " ".repeat(60 - 20 - 6) + "00:04 ");
eq("rows exactly width wide", lines.every((l) => l.length === 60), true);

// style hooks wrap ONLY the clock and the rule; layout math stays plain
const styled = formatRunningWidgetLines(rows, 60, { dim: (t) => `<D>${t}</D>`, border: (t) => `<B>${t}</B>` });
eq("border styled", styled[0], `<B>${"─".repeat(60)}</B>`);
eq("clock styled + trailing space", styled[1].endsWith("<D>00:23</D> "), true);
eq("styled row plain-length preserved", styled[1].replace("<D>", "").replace("</D>", "").length, 60);

// narrow width: name truncates, tag + clock survive
const narrow = formatRunningWidgetLines(
	[{ name: "a very long task name that cannot possibly fit", agent: "scout", elapsedSeconds: 61 }], 30);
eq("narrow keeps clock one off the edge", narrow[1].endsWith("01:01 "), true);
eq("narrow keeps tag", narrow[1].startsWith(" [scout]"), true);
eq("narrow truncates with ellipsis", narrow[1].includes("…"), true);
eq("narrow row fits width", narrow[1].length <= 30, true);

// bare (pre-worker resume) row: blank tag column, still aligned
const mixed = formatRunningWidgetLines(
	[{ name: "old resume", agent: undefined, elapsedSeconds: 10 },
	 { name: "Auth", agent: "scout", elapsedSeconds: 20 }], 50);
eq("blank tag pads to column", mixed[1].startsWith(" " + " ".repeat(7) + "  old resume"), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
