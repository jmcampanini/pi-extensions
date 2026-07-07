import { formatBannerLine } from "../banner.ts";

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown) {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}:\n    got  ${g}\n    want ${w}`); }
}

const HUMAN_MODE = "⚠ human driving — next completed turn exits & reports to parent";
const auto = { name: "recon", agent: "scout", autoExit: true, humanDriving: false };
const interactive = { name: "recon", agent: "scout", autoExit: false, humanDriving: false };
const human = { name: "recon", agent: "scout", autoExit: true, humanDriving: true };

// the three mode states at a comfortable width; the rule fills exactly
const autoBody = "─ SUBAGENT · recon [scout] · auto-exit ";
eq("auto-exit line", formatBannerLine(auto, 72), autoBody + "─".repeat(72 - autoBody.length));
const interactiveBody = "─ SUBAGENT · recon [scout] · interactive ";
eq("interactive line", formatBannerLine(interactive, 72), interactiveBody + "─".repeat(72 - interactiveBody.length));
const humanBody = `─ SUBAGENT · recon [scout] · ${HUMAN_MODE} `;
eq("human-driving line", formatBannerLine(human, 100), humanBody + "─".repeat(100 - humanBody.length));
eq("auto-exit line exactly width wide", formatBannerLine(auto, 72).length, 72);
eq("human-driving line exactly width wide", formatBannerLine(human, 100).length, 100);

// no agent → no bracket segment at all
const bare = { name: "recon", autoExit: true, humanDriving: false };
const bareBody = "─ SUBAGENT · recon · auto-exit ";
eq("agent missing drops the bracket segment", formatBannerLine(bare, 60), bareBody + "─".repeat(60 - bareBody.length));

// name exactly fills the width: full name kept, trailing rule dropped
eq("exact fit keeps full name, drops rule", formatBannerLine(auto, 38), "─ SUBAGENT · recon [scout] · auto-exit");
eq("one leftover column: lone space, no dash", formatBannerLine(auto, 39), "─ SUBAGENT · recon [scout] · auto-exit ");

// narrow width: the name gives way (ellipsis), tag and mode survive
const narrow = formatBannerLine(
	{ name: "a very long task name that cannot possibly fit", agent: "scout", autoExit: true, humanDriving: false }, 40);
eq("narrow clips the name with ellipsis", narrow, "─ SUBAGENT · a very… [scout] · auto-exit");
eq("narrow line fits width", narrow.length <= 40, true);

// the line never exceeds the width, all the way down to degenerate sizes
let allFit = true;
for (let width = 0; width <= 90; width++) {
	if (formatBannerLine(auto, width).length > width) allFit = false;
	if (formatBannerLine(human, width).length > width) allFit = false;
}
eq("line never exceeds width (0..90, both modes)", allFit, true);

// style hooks wrap the rule and the mode; layout math stays plain
const markers = { dim: (t: string) => `<D>${t}</D>`, border: (t: string) => `<B>${t}</B>`, warn: (t: string) => `<W>${t}</W>` };
const strip = (line: string) => line.replace(/<\/?[DBW]>/g, "");
const styled = formatBannerLine(auto, 72, markers);
eq("leading rule dash styled as border", styled.startsWith("<B>─</B> SUBAGENT · "), true);
eq("identity segment stays unstyled", styled.includes(" SUBAGENT · recon [scout] · "), true);
eq("auto-exit mode dimmed", styled.includes("· <D>auto-exit</D> "), true);
eq("trailing rule styled as border", styled.endsWith(`<B>${"─".repeat(72 - autoBody.length)}</B>`), true);
eq("styled output lays out identically", strip(styled), formatBannerLine(auto, 72));
const styledHuman = formatBannerLine(human, 100, markers);
eq("human-driving mode warn-wrapped whole", styledHuman.includes(`<W>${HUMAN_MODE}</W>`), true);
eq("styled human line lays out identically", strip(styledHuman), formatBannerLine(human, 100));
eq("styled narrow clip lays out identically",
	strip(formatBannerLine(human, 45, markers)), formatBannerLine(human, 45));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
