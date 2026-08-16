import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { clampStyled, fitText } from "../text-fit.ts";

const wide = "界界界";

// The issue-93 defect: a cut inside a background-styled card line must never
// reset the background. `[0m` (reset all) and `[49m` (reset bg) are the two
// sequences that would; a cut may only close fg color and text attributes.
const styled = "\x1b[1m\x1b[35mReview Gibson CmdK\x1b[39m\x1b[22m";

describe("fitText", () => {
	const styledCut = fitText(styled, 7);

	it("fitting text passes through unchanged", () => {
		assert.strictEqual(fitText("subagent", 20), "subagent");
	});

	it("exact-width text passes through unchanged", () => {
		assert.strictEqual(fitText("subagent", 8), "subagent");
	});

	it("plain overflow cuts and appends the ellipsis", () => {
		assert.strictEqual(fitText("Review Gibson CmdK", 7), "Review…");
	});

	it("plain cuts introduce no escape codes", () => {
		assert.strictEqual(fitText("Review Gibson CmdK", 7).includes("\x1b"), false);
	});

	it("a custom ellipsis is honored", () => {
		assert.strictEqual(fitText("Review Gibson CmdK", 7, ""), "Review ");
	});

	it("zero width is empty", () => {
		assert.strictEqual(fitText("subagent", 0), "");
	});

	it("negative width is empty", () => {
		assert.strictEqual(fitText("subagent", -3), "");
	});

	it("width one shows only the ellipsis", () => {
		assert.strictEqual(fitText("subagent", 1), "…");
	});

	it("wide graphemes never straddle the cut", () => {
		assert.strictEqual(visibleWidth(fitText(wide, 4)) <= 4, true);
	});

	it("wide grapheme cut keeps whole characters", () => {
		assert.strictEqual(stripVTControlCharacters(fitText(wide, 4)), "界…");
	});

	it("styled cuts stay within width", () => {
		assert.strictEqual(visibleWidth(styledCut), 7);
	});

	it("styled cuts keep their opening styles", () => {
		assert.strictEqual(styledCut.startsWith("\x1b[1m\x1b[35m"), true);
	});

	it("styled cuts never reset the enclosing background", () => {
		assert.strictEqual(styledCut.includes("\x1b[0m") || styledCut.includes("49m"), false);
	});

	it("styled cuts close dangling attributes before the ellipsis", () => {
		assert.strictEqual(styledCut.includes("\x1b[39;22;23;24;27;29m…"), true);
	});
});

describe("clampStyled", () => {
	const clamped = clampStyled(styled, 7);

	it("clamp cuts styled lines to width", () => {
		assert.strictEqual(visibleWidth(clamped), 7);
	});

	it("clamp adds no ellipsis", () => {
		assert.strictEqual(stripVTControlCharacters(clamped), "Review ");
	});

	it("clamp closes dangling attributes without touching the background", () => {
		assert.strictEqual(clamped.endsWith("\x1b[39;22;23;24;27;29m"), true);
	});

	it("clamp passes fitting styled lines through unchanged", () => {
		assert.strictEqual(clampStyled(styled, 40), styled);
	});

	it("clamp zero width is empty", () => {
		assert.strictEqual(clampStyled(styled, 0), "");
	});
});
