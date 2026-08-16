import { visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { clampStyled, fitText } from "../text-fit.ts";

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown): void {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}:\n    got  ${g}\n    want ${w}`); }
}

eq("fitting text passes through unchanged", fitText("subagent", 20), "subagent");
eq("exact-width text passes through unchanged", fitText("subagent", 8), "subagent");
eq("plain overflow cuts and appends the ellipsis", fitText("Review Gibson CmdK", 7), "Review…");
eq("plain cuts introduce no escape codes", fitText("Review Gibson CmdK", 7).includes("\x1b"), false);
eq("a custom ellipsis is honored", fitText("Review Gibson CmdK", 7, ""), "Review ");
eq("zero width is empty", fitText("subagent", 0), "");
eq("negative width is empty", fitText("subagent", -3), "");
eq("width one shows only the ellipsis", fitText("subagent", 1), "…");

const wide = "界界界";
eq("wide graphemes never straddle the cut", visibleWidth(fitText(wide, 4)) <= 4, true);
eq("wide grapheme cut keeps whole characters", stripVTControlCharacters(fitText(wide, 4)), "界…");

// The issue-93 defect: a cut inside a background-styled card line must never
// reset the background. `[0m` (reset all) and `[49m` (reset bg) are the two
// sequences that would; a cut may only close fg color and text attributes.
const styled = "\x1b[1m\x1b[35mReview Gibson CmdK\x1b[39m\x1b[22m";
const styledCut = fitText(styled, 7);
eq("styled cuts stay within width", visibleWidth(styledCut), 7);
eq("styled cuts keep their opening styles", styledCut.startsWith("\x1b[1m\x1b[35m"), true);
eq("styled cuts never reset the enclosing background", styledCut.includes("\x1b[0m") || styledCut.includes("49m"), false);
eq("styled cuts close dangling attributes before the ellipsis", styledCut.includes("\x1b[39;22;23;24;27;29m…"), true);

const clamped = clampStyled(styled, 7);
eq("clamp cuts styled lines to width", visibleWidth(clamped), 7);
eq("clamp adds no ellipsis", stripVTControlCharacters(clamped), "Review ");
eq("clamp closes dangling attributes without touching the background", clamped.endsWith("\x1b[39;22;23;24;27;29m"), true);
eq("clamp passes fitting styled lines through unchanged", clampStyled(styled, 40), styled);
eq("clamp zero width is empty", clampStyled(styled, 0), "");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
