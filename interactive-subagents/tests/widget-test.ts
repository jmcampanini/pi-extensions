import { FORK_MARK, WORKTREE_MARK, formatElapsed, formatRunningWidgetLines, stripAgentPrefix } from "../widget.ts";

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
eq(
	"prefix stripping removes terminal controls first",
	stripAgentPrefix("Scout: Au\x1b]52;c;Zm9v\x07th\0", "scout\x1b[2J"),
	"Auth",
);

// full rows at a comfortable width
const rows = [
	{ name: "Scout: Auth", agent: "scout", elapsedSeconds: 23 },
	{ name: "quick fix", agent: "worker", elapsedSeconds: 4 },
];
const lines = formatRunningWidgetLines(rows, 60);
eq("border rule + child rows, no footer", lines.length, 3);
eq("top rule spans width", lines[0], "─".repeat(60));
eq("row 1", lines[1], " [scout]     Auth" + " ".repeat(60 - 17 - 6) + "00:23 ");
eq("row 2", lines[2], " [worker]    quick fix" + " ".repeat(60 - 22 - 6) + "00:04 ");
eq("rows exactly width wide", lines.every((l) => l.length === 60), true);

// style hooks wrap ONLY the clock, the state slot, and the rule; layout math
// stays plain
const styled = formatRunningWidgetLines(rows, 60, { dim: (t) => `<D>${t}</D>`, border: (t) => `<B>${t}</B>` });
eq("border styled", styled[0], `<B>${"─".repeat(60)}</B>`);
eq("clock styled + trailing space", styled[1].endsWith("<D>00:23</D> "), true);
eq("styled row plain-length preserved", styled[1].replaceAll("<D>", "").replaceAll("</D>", "").length, 60);

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
eq("blank tag pads to column", mixed[1].startsWith(" ".repeat(12) + "old resume"), true);

// state slot: fixed fork + worktree columns between the tag and the name,
// blank when a state doesn't apply, so names align across rows
const stateRows = [
	{ name: "Auth", agent: "scout", elapsedSeconds: 23, forked: true, worktree: true },
	{ name: "quick fix", agent: "worker", elapsedSeconds: 4 },
	{ name: "API review", agent: "judge", elapsedSeconds: 72, worktree: true },
];
const stateLines = formatRunningWidgetLines(stateRows, 60);
eq("forked worktree row shows both marks", stateLines[1],
	` [scout]  ${FORK_MARK}${WORKTREE_MARK} Auth` + " ".repeat(37) + "00:23 ");
eq("stateless row gets a blank slot, name still aligned", stateLines[2],
	" [worker]    quick fix" + " ".repeat(32) + "00:04 ");
eq("worktree-only row leaves the fork column blank", stateLines[3],
	` [judge]   ${WORKTREE_MARK} API review` + " ".repeat(31) + "01:12 ");
eq("state rows exactly width wide", stateLines.every((l) => l.length === 60), true);

// without a slot hook the marks fall back to dim; layout math stays plain
const stateStyled = formatRunningWidgetLines(stateRows, 60, { dim: (t) => `<D>${t}</D>` });
eq("mark slot falls back to dim", stateStyled[1].includes(`<D>${FORK_MARK}${WORKTREE_MARK}</D> Auth`), true);
eq("styled state row plain-length preserved",
	stateStyled[1].replaceAll("<D>", "").replaceAll("</D>", "").length, 60);

// a dedicated slot hook wins over dim, so pi can render the marks fainter
const slotStyled = formatRunningWidgetLines(stateRows, 60,
	{ dim: (t) => `<D>${t}</D>`, slot: (t) => `<S>${t}</S>` });
eq("slot hook styles the marks", slotStyled[1].includes(`<S>${FORK_MARK}${WORKTREE_MARK}</S> Auth`), true);
eq("clock still uses dim", slotStyled[1].endsWith("<D>00:23</D> "), true);

// narrow width with a state slot: icons survive, the name gives way
const narrowState = formatRunningWidgetLines(
	[{ name: "a very long task name that cannot possibly fit", agent: "scout", elapsedSeconds: 61, forked: true }], 30);
eq("narrow keeps the state slot", narrowState[1].includes(` [scout] ${FORK_MARK}  `), true);
eq("narrow state row truncates with ellipsis", narrowState[1].includes("…"), true);
eq("narrow state row fits width", narrowState[1].length <= 30, true);

const hostileRow = formatRunningWidgetLines(
	[{ name: "safe\x1b]52;c;Zm9v\x07 name\0", agent: "worker\x1b[2J", elapsedSeconds: 1 }],
	50,
);
eq("widget removes input terminal controls", hostileRow.join("").includes("\x1b"), false);
eq("widget preserves safe identity text", hostileRow[1].includes("[worker]    safe name"), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
