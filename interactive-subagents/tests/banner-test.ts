import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatBannerLine } from "../banner.ts";

const HUMAN_MODE = "⚠ human driving — next completed turn exits & reports to parent";
const auto = { name: "recon", agent: "scout", autoExit: true, humanDriving: false };
const interactive = { name: "recon", agent: "scout", autoExit: false, humanDriving: false };
const human = { name: "recon", agent: "scout", autoExit: true, humanDriving: true };

describe("formatBannerLine", () => {
	const autoBody = "─ SUBAGENT · recon [scout] · auto-exit ";

	it("auto-exit line fills the width with the rule", () => {
		assert.strictEqual(formatBannerLine(auto, 72), autoBody + "─".repeat(72 - autoBody.length));
	});

	it("interactive line fills the width with the rule", () => {
		const interactiveBody = "─ SUBAGENT · recon [scout] · interactive ";
		assert.strictEqual(formatBannerLine(interactive, 72), interactiveBody + "─".repeat(72 - interactiveBody.length));
	});

	it("human-driving line fills the width with the rule", () => {
		const humanBody = `─ SUBAGENT · recon [scout] · ${HUMAN_MODE} `;
		assert.strictEqual(formatBannerLine(human, 100), humanBody + "─".repeat(100 - humanBody.length));
	});

	it("auto-exit line exactly width wide", () => {
		assert.strictEqual(formatBannerLine(auto, 72).length, 72);
	});

	it("human-driving line exactly width wide", () => {
		assert.strictEqual(formatBannerLine(human, 100).length, 100);
	});

	it("agent missing drops the bracket segment", () => {
		const bare = { name: "recon", autoExit: true, humanDriving: false };
		const bareBody = "─ SUBAGENT · recon · auto-exit ";
		assert.strictEqual(formatBannerLine(bare, 60), bareBody + "─".repeat(60 - bareBody.length));
	});

	it("exact fit keeps full name, drops rule", () => {
		assert.strictEqual(formatBannerLine(auto, 38), "─ SUBAGENT · recon [scout] · auto-exit");
	});

	it("one leftover column: lone space, no dash", () => {
		assert.strictEqual(formatBannerLine(auto, 39), "─ SUBAGENT · recon [scout] · auto-exit ");
	});

	it("narrow width clips the name with an ellipsis while tag and mode survive", () => {
		const narrow = formatBannerLine(
			{ name: "a very long task name that cannot possibly fit", agent: "scout", autoExit: true, humanDriving: false }, 40);
		assert.strictEqual(narrow, "─ SUBAGENT · a very… [scout] · auto-exit", "narrow clips the name with ellipsis");
		assert.strictEqual(narrow.length <= 40, true, "narrow line fits width");
	});

	it("line never exceeds width from 0 through 90 in both modes", () => {
		for (let width = 0; width <= 90; width++) {
			assert.ok(formatBannerLine(auto, width).length <= width, `auto line fits width ${width}`);
			assert.ok(formatBannerLine(human, width).length <= width, `human line fits width ${width}`);
		}
	});

	// style hooks wrap the rule and the mode; layout math stays plain
	const markers = { dim: (t: string) => `<D>${t}</D>`, border: (t: string) => `<B>${t}</B>`, warn: (t: string) => `<W>${t}</W>` };
	const strip = (line: string) => line.replace(/<\/?[DBW]>/g, "");
	const styled = formatBannerLine(auto, 72, markers);
	const styledHuman = formatBannerLine(human, 100, markers);

	it("leading rule dash styled as border", () => {
		assert.strictEqual(styled.startsWith("<B>─</B> SUBAGENT · "), true);
	});

	it("identity segment stays unstyled", () => {
		assert.strictEqual(styled.includes(" SUBAGENT · recon [scout] · "), true);
	});

	it("auto-exit mode dimmed", () => {
		assert.strictEqual(styled.includes("· <D>auto-exit</D> "), true);
	});

	it("trailing rule styled as border", () => {
		assert.strictEqual(styled.endsWith(`<B>${"─".repeat(72 - autoBody.length)}</B>`), true);
	});

	it("styled output lays out identically", () => {
		assert.strictEqual(strip(styled), formatBannerLine(auto, 72));
	});

	it("human-driving mode warn-wrapped whole", () => {
		assert.strictEqual(styledHuman.includes(`<W>${HUMAN_MODE}</W>`), true);
	});

	it("styled human line lays out identically", () => {
		assert.strictEqual(strip(styledHuman), formatBannerLine(human, 100));
	});

	it("styled narrow clip lays out identically", () => {
		assert.strictEqual(strip(formatBannerLine(human, 45, markers)), formatBannerLine(human, 45));
	});

	it("banner sanitizes hostile generated identity", () => {
		const hostileIdentity = formatBannerLine(
			{
				name: "safe\x1b]52;c;Zm9v\x07 name\0",
				agent: "worker\x1b[2J",
				autoExit: true,
				humanDriving: false,
			},
			70,
		);
		assert.strictEqual(hostileIdentity.includes("\x1b"), false, "banner removes generated terminal controls");
		assert.strictEqual(hostileIdentity.includes("safe name [worker]"), true, "banner preserves safe generated identity");
	});
});
